import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.mjs";
import { GovernanceError } from "./errors.mjs";
import {
  createProjectContext,
  readProjectManifest
} from "./manifest.mjs";
import { buildApplyPlan } from "./planner.mjs";
import {
  renderStatusRegistry,
  validateStatusSource
} from "./status-registry.mjs";

const defaultKitRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

function interruptedError() {
  return new GovernanceError("INTERRUPTED", "工作区验证已中断");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw interruptedError();
}

function isInterrupted(error, signal) {
  return signal?.aborted
    || error?.code === "INTERRUPTED"
    || error?.code === "ABORT_ERR"
    || error?.name === "AbortError";
}

async function readExisting(filePath, signal) {
  throwIfAborted(signal);
  try {
    const content = await readFile(filePath, "utf8");
    throwIfAborted(signal);
    return content;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function listMarkdown(rootDir, relativeDir = "", signal) {
  throwIfAborted(signal);
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  throwIfAborted(signal);
  const results = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listMarkdown(rootDir, relativePath, signal));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = await readFile(path.join(rootDir, relativePath), "utf8");
      throwIfAborted(signal);
      results.push({
        path: path.join(rootDir, relativePath),
        content
      });
    }
  }
  return results;
}

export function validateRuleIds(entries, { signal } = {}) {
  const declarations = new Map();
  const pattern = /<!--\s*rule-id:\s*([A-Z0-9-]+)\s*-->/g;
  for (const entry of entries) {
    throwIfAborted(signal);
    for (const match of entry.content.matchAll(pattern)) {
      throwIfAborted(signal);
      const id = match[1];
      if (declarations.has(id)) {
        throw new GovernanceError("DUPLICATE_RULE_ID", `规则 ID 重复：${id}`, {
          id,
          firstPath: declarations.get(id),
          secondPath: entry.path
        });
      }
      declarations.set(id, entry.path);
    }
  }
  return declarations.size;
}

function stripManagedHeader(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("<!-- governance-kit:managed -->\n")) {
    return normalized;
  }
  const lines = normalized.split("\n");
  const separator = lines.indexOf("", 1);
  return separator === -1
    ? normalized
    : lines.slice(separator + 1).join("\n");
}

function sortDiagnostics(values) {
  values.sort((left, right) => {
    const byPath = (left.path ?? "").localeCompare(right.path ?? "");
    return byPath || left.code.localeCompare(right.code);
  });
}

export async function validateWorkspace({
  workspaceDir,
  kitRoot = defaultKitRoot,
  signal
}) {
  throwIfAborted(signal);
  const report = {
    valid: false,
    checks: [],
    warnings: [],
    errors: []
  };

  let manifest;
  try {
    manifest = await readProjectManifest(workspaceDir, { signal });
    throwIfAborted(signal);
  } catch (error) {
    if (isInterrupted(error, signal)) throw interruptedError();
    if (error instanceof GovernanceError) {
      report.errors.push(error.toJSON());
      return report;
    }
    throw error;
  }

  const catalog = await loadCatalog(path.resolve(kitRoot));
  throwIfAborted(signal);

  let context;
  try {
    context = await createProjectContext({
      workspaceDir,
      kitRoot,
      manifest,
      catalog,
      signal
    });
    throwIfAborted(signal);
  } catch (error) {
    if (isInterrupted(error, signal)) throw interruptedError();
    if (error instanceof GovernanceError) {
      report.errors.push(error.toJSON());
      return report;
    }
    throw error;
  }

  const plan = await buildApplyPlan(context);
  throwIfAborted(signal);

  for (const operation of plan.operations) {
    throwIfAborted(signal);
    const existing = await readExisting(operation.targetPath, signal);
    if (existing === undefined) {
      report.errors.push({
        code: "MISSING_GENERATED_FILE",
        message: "计划文件不存在",
        path: operation.targetPath
      });
      continue;
    }
    if (/\{\{[A-Z0-9_]+\}\}/.test(existing)) {
      report.errors.push({
        code: "UNRESOLVED_PLACEHOLDER",
        message: "文件包含未解析占位符",
        path: operation.targetPath
      });
    }
  }

  const ruleEntries = [];
  for (const relativeRoot of ["core", "templates", "profiles"]) {
    throwIfAborted(signal);
    ruleEntries.push(...await listMarkdown(
      path.join(context.kitRoot, relativeRoot),
      "",
      signal
    ));
  }
  try {
    throwIfAborted(signal);
    const ruleCount = validateRuleIds(ruleEntries, { signal });
    report.checks.push({ code: "RULE_IDS_VALID", count: ruleCount });
  } catch (error) {
    if (isInterrupted(error, signal)) throw interruptedError();
    if (error instanceof GovernanceError) {
      report.errors.push(error.toJSON());
    } else {
      throw error;
    }
  }

  const server = context.components.server;
  if (server) {
    throwIfAborted(signal);
    const sourcePath = path.join(server.rootDir, "docs", "status-enums.json");
    const registryPath = path.join(server.rootDir, "docs", "STATUS_ENUM_REGISTRY.md");
    try {
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      throwIfAborted(signal);
      validateStatusSource(source);
      throwIfAborted(signal);
      const actual = await readExisting(registryPath, signal);
      if (actual !== undefined) {
        const expected = renderStatusRegistry(source, { remote: false });
        if (stripManagedHeader(actual) !== expected.replaceAll("\r\n", "\n")) {
          report.errors.push({
            code: "STATUS_REGISTRY_DRIFT",
            message: "状态注册表与状态源不一致",
            path: registryPath
          });
        } else {
          report.checks.push({ code: "STATUS_REGISTRY_VALID", path: registryPath });
        }
      }
    } catch (error) {
      if (isInterrupted(error, signal)) throw interruptedError();
      if (error instanceof GovernanceError) {
        report.errors.push({ ...error.toJSON(), path: sourcePath });
      } else if (error instanceof SyntaxError) {
        report.errors.push({
          code: "INVALID_STATUS_SOURCE",
          message: "状态源不是有效 JSON",
          path: sourcePath
        });
      } else {
        throw error;
      }
    }
  }

  throwIfAborted(signal);
  sortDiagnostics(report.checks);
  sortDiagnostics(report.warnings);
  sortDiagnostics(report.errors);
  report.valid = report.errors.length === 0;
  return report;
}
