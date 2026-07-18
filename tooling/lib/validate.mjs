import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GovernanceError } from "./errors.mjs";
import { loadProjectManifest } from "./manifest.mjs";
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

async function listMarkdown(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const results = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listMarkdown(rootDir, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push({
        path: path.join(rootDir, relativePath),
        content: await readFile(path.join(rootDir, relativePath), "utf8")
      });
    }
  }
  return results;
}

export function validateRuleIds(entries) {
  const declarations = new Map();
  const pattern = /<!--\s*rule-id:\s*([A-Z0-9-]+)\s*-->/g;
  for (const entry of entries) {
    for (const match of entry.content.matchAll(pattern)) {
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
  return normalized.split("\n").slice(4).join("\n");
}

function sortDiagnostics(values) {
  values.sort((left, right) => {
    const byPath = (left.path ?? "").localeCompare(right.path ?? "");
    return byPath || left.code.localeCompare(right.code);
  });
}

export async function validateWorkspace({
  workspaceDir,
  kitRoot = defaultKitRoot
}) {
  const report = {
    valid: false,
    checks: [],
    warnings: [],
    errors: []
  };

  let context;
  let plan;
  try {
    context = await loadProjectManifest(workspaceDir, kitRoot);
    plan = await buildApplyPlan(context);
  } catch (error) {
    if (error instanceof GovernanceError) {
      report.errors.push(error.toJSON());
      return report;
    }
    throw error;
  }

  for (const operation of plan.operations) {
    const existing = await readExisting(operation.targetPath);
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
    ruleEntries.push(...await listMarkdown(path.join(context.kitRoot, relativeRoot)));
  }
  try {
    const ruleCount = validateRuleIds(ruleEntries);
    report.checks.push({ code: "RULE_IDS_VALID", count: ruleCount });
  } catch (error) {
    if (error instanceof GovernanceError) {
      report.errors.push(error.toJSON());
    } else {
      throw error;
    }
  }

  const server = context.components.server;
  if (server) {
    const sourcePath = path.join(server.rootDir, "docs", "status-enums.json");
    const registryPath = path.join(server.rootDir, "docs", "STATUS_ENUM_REGISTRY.md");
    try {
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      validateStatusSource(source);
      const actual = await readExisting(registryPath);
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

  sortDiagnostics(report.checks);
  sortDiagnostics(report.warnings);
  sortDiagnostics(report.errors);
  report.valid = report.errors.length === 0;
  return report;
}
