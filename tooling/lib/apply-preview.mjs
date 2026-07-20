import { createHash } from "node:crypto";
import { GovernanceError } from "./errors.mjs";
import {
  assertRealPathInside,
  assertSnapshotUnchanged,
  snapshotPath,
  writeUtf8Atomic
} from "./files.mjs";
import { buildApplyPlan } from "./planner.mjs";

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new GovernanceError("INTERRUPTED", "应用执行已中断");
  }
}

function parseManagedMetadata(content) {
  const markdown = /^<!-- governance-kit:managed -->\n<!-- source-id: ([^\r\n]+) -->\n<!-- source-version: (\d+) -->(?:\n<!-- content-hash: ([0-9a-f]{64}) -->)?\n\n([\s\S]*)$/i;
  const script = /^\/\/ governance-kit:managed\n\/\/ source-id: ([^\r\n]+)\n\/\/ source-version: (\d+)(?:\n\/\/ content-hash: ([0-9a-f]{64}))?\n\n([\s\S]*)$/i;
  const match = markdown.exec(content) ?? script.exec(content);
  if (!match) return undefined;
  const sourceId = match[1].trim();
  const sourceVersion = Number.parseInt(match[2], 10);
  if (!sourceId || !Number.isInteger(sourceVersion)) {
    return undefined;
  }
  return {
    sourceId,
    sourceVersion,
    contentHash: match[3]?.toLowerCase(),
    body: match[4]
  };
}

function contentHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function reportEntry(operation, code, details = {}) {
  return {
    path: operation.targetPath,
    component: operation.component,
    sourceId: operation.sourceId,
    code,
    ...details
  };
}

function classify(operation, existing) {
  if (existing === undefined) {
    return { category: "created", entry: reportEntry(operation, "CREATE") };
  }
  if (existing === operation.content) {
    return { category: "unchanged", entry: reportEntry(operation, "UNCHANGED") };
  }
  if (operation.writePolicy === "create-only") {
    return {
      category: "conflicts",
      entry: reportEntry(operation, "CREATE_ONLY_EXISTS")
    };
  }

  const metadata = parseManagedMetadata(existing);
  if (!metadata || metadata.sourceId !== operation.sourceId) {
    return {
      category: "conflicts",
      entry: reportEntry(operation, "USER_FILE_CONFLICT")
    };
  }
  if (metadata.sourceVersion !== operation.sourceVersion) {
    return {
      category: "conflicts",
      entry: reportEntry(operation, "SOURCE_VERSION_MISMATCH", {
        expectedVersion: operation.sourceVersion,
        actualVersion: metadata.sourceVersion
      })
    };
  }
  const candidate = parseManagedMetadata(operation.content);
  const contentMatchesEvidence = metadata.contentHash
    ? contentHash(metadata.body) === metadata.contentHash
    : candidate?.body === metadata.body;
  if (!contentMatchesEvidence) {
    return {
      category: "conflicts",
      entry: reportEntry(operation, "USER_FILE_CONFLICT", {
        reason: "MANAGED_CONTENT_CHANGED"
      })
    };
  }
  return { category: "updated", entry: reportEntry(operation, "UPDATE") };
}

function emptyReport() {
  return {
    created: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    warnings: [],
    errors: []
  };
}

function sortReport(report) {
  for (const value of Object.values(report)) {
    if (Array.isArray(value)) {
      value.sort((left, right) => (left.path ?? "").localeCompare(right.path ?? ""));
    }
  }
  return report;
}

async function captureTarget(targetPath) {
  return snapshotPath(targetPath, { includeContent: true });
}

export async function createApplyPreview({
  context,
  signal,
  capturePath = captureTarget
}) {
  throwIfAborted(signal);
  const plan = await buildApplyPlan(context);
  throwIfAborted(signal);
  const report = emptyReport();
  const operations = [];

  for (const operation of plan.operations) {
    throwIfAborted(signal);
    const captured = await capturePath(operation.targetPath);
    const { content: existing, ...snapshot } = captured;
    throwIfAborted(signal);
    const classification = classify(operation, existing);
    operations.push({ operation, classification, snapshot });
    report[classification.category].push(classification.entry);
  }

  return { context, operations, report: sortReport(report) };
}

export async function assertPreviewUnchanged(preview) {
  for (const item of preview.operations) {
    await assertRealPathInside(
      preview.context.workspaceDir,
      item.operation.targetPath,
      { allowMissing: true }
    );
    await assertSnapshotUnchanged(item.snapshot);
  }
}

export async function executeApplyPreview(preview, {
  allowConflicts = true,
  writeFile = writeUtf8Atomic,
  signal
} = {}) {
  if (!allowConflicts && preview.report.conflicts.length > 0) {
    throw new GovernanceError("INIT_CONFLICT", "初始化计划存在冲突", {
      conflicts: preview.report.conflicts
    });
  }

  const written = [];
  try {
    throwIfAborted(signal);
    await assertPreviewUnchanged(preview);
    throwIfAborted(signal);

    for (const item of preview.operations) {
      if (
        item.classification.category === "created"
        || item.classification.category === "updated"
      ) {
        throwIfAborted(signal);
        await writeFile(item.operation.targetPath, item.operation.content, {
          expectedSnapshot: item.snapshot,
          rootDir: preview.context.workspaceDir,
          signal
        });
        written.push(item.operation.targetPath);
      }
    }
    return { report: preview.report, written };
  } catch (error) {
    const failure = error?.name === "AbortError" || error?.code === "ABORT_ERR"
      ? new GovernanceError("INTERRUPTED", "应用执行已中断")
      : error;
    failure.details = { ...(failure.details ?? {}), written };
    throw failure;
  }
}
