import { readFile } from "node:fs/promises";
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
  const lines = content.split(/\r?\n/);
  const sourceLine = lines.find((line) => line.includes("source-id:"));
  const versionLine = lines.find((line) => line.includes("source-version:"));
  if (!sourceLine || !versionLine || !content.includes("governance-kit:managed")) {
    return undefined;
  }
  const cleanValue = (line, key) => line
    .slice(line.indexOf(key) + key.length)
    .replace(/-->\s*$/, "")
    .trim();
  const sourceId = cleanValue(sourceLine, "source-id:");
  const sourceVersion = Number.parseInt(cleanValue(versionLine, "source-version:"), 10);
  if (!sourceId || !Number.isInteger(sourceVersion)) {
    return undefined;
  }
  return { sourceId, sourceVersion };
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

export async function createApplyPreview({ context, signal }) {
  throwIfAborted(signal);
  const plan = await buildApplyPlan(context);
  throwIfAborted(signal);
  const report = emptyReport();
  const operations = [];

  for (const operation of plan.operations) {
    throwIfAborted(signal);
    const snapshot = await snapshotPath(operation.targetPath);
    throwIfAborted(signal);
    const existing = snapshot.exists
      ? await readFile(operation.targetPath, "utf8")
      : undefined;
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
