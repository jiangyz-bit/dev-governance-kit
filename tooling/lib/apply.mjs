import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeUtf8Atomic } from "./files.mjs";
import { loadProjectManifest } from "./manifest.mjs";
import { buildApplyPlan } from "./planner.mjs";

const defaultKitRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

async function readExisting(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
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

export async function applyGovernance({
  workspaceDir,
  kitRoot = defaultKitRoot,
  dryRun = false
}) {
  const context = await loadProjectManifest(workspaceDir, kitRoot);
  const plan = await buildApplyPlan(context);
  const report = emptyReport();
  const classified = [];

  for (const operation of plan.operations) {
    const existing = await readExisting(operation.targetPath);
    const classification = classify(operation, existing);
    classified.push({ operation, classification });
    report[classification.category].push(classification.entry);
  }

  if (!dryRun && report.errors.length === 0) {
    for (const { operation, classification } of classified) {
      if (classification.category === "created" || classification.category === "updated") {
        await writeUtf8Atomic(operation.targetPath, operation.content);
      }
    }
  }

  return sortReport(report);
}
