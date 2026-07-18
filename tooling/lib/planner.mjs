import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { GovernanceError } from "./errors.mjs";
import { resolveInside } from "./files.mjs";
import { renderStrict } from "./template.mjs";

const componentTemplateDirs = {
  server: "server",
  admin: "admin",
  client: "miniprogram"
};

async function listFiles(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootDir, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function managedContent(content, targetPath, sourceId, sourceVersion) {
  const extension = path.extname(targetPath).toLowerCase();
  if (extension === ".md") {
    return [
      "<!-- governance-kit:managed -->",
      `<!-- source-id: ${sourceId} -->`,
      `<!-- source-version: ${sourceVersion} -->`,
      "",
      content
    ].join("\n");
  }
  if (extension === ".mjs" || extension === ".js") {
    return [
      "// governance-kit:managed",
      `// source-id: ${sourceId}`,
      `// source-version: ${sourceVersion}`,
      "",
      content
    ].join("\n");
  }
  return content;
}

function derivedVariables(context, componentType) {
  const values = {
    PRODUCT_NAME: context.manifest.project.name
  };
  const nameVariables = {
    server: "SERVER_NAME",
    admin: "ADMIN_NAME",
    client: "MINIPROGRAM_NAME"
  };
  values[nameVariables[componentType]] = path.basename(context.components[componentType].rootDir);
  if (context.components.server) {
    values.SERVER_REPO_DIR_NAME = path.basename(context.components.server.rootDir);
  }
  return values;
}

function mergeVariables(derived, profileVariables) {
  const result = { ...derived };
  for (const [key, value] of Object.entries(profileVariables)) {
    if (key in result && result[key] !== value) {
      throw new GovernanceError("VARIABLE_CONFLICT", `模板变量值冲突：${key}`, {
        derived: result[key],
        profile: value
      });
    }
    result[key] = value;
  }
  return result;
}

async function createOperation({
  component,
  sourcePath,
  targetPath,
  sourceId,
  sourceVersion,
  variables,
  writePolicy = "managed",
  transform
}) {
  const source = await readFile(sourcePath, "utf8");
  const rendered = transform
    ? transform(source)
    : renderStrict(source, variables);
  return {
    component,
    sourcePath,
    targetPath,
    content: writePolicy === "managed"
      ? managedContent(rendered, targetPath, sourceId, sourceVersion)
      : rendered,
    sourceId,
    sourceVersion,
    writePolicy
  };
}

function renderProfileDocument(profile, readme) {
  const commands = Object.entries(profile.commands)
    .map(([name, command]) => `| \`${name}\` | \`${command}\` |`)
    .join("\n");
  return [
    `# 技术栈 Profile：${profile.id}`,
    "",
    `Profile 版本：\`${profile.version}\``,
    "",
    "## 常用命令",
    "",
    "| 名称 | 命令 |",
    "|---|---|",
    commands,
    "",
    "## 技术栈说明",
    "",
    readme.trim(),
    ""
  ].join("\n");
}

export async function buildApplyPlan(context) {
  const operations = [];
  const coreDir = path.join(context.kitRoot, "core", "rules");
  const sharedDir = path.join(context.kitRoot, "templates", "shared");
  const coreFiles = await listFiles(coreDir);
  const sharedFiles = await listFiles(sharedDir);

  for (const [componentType, component] of Object.entries(context.components)) {
    const variables = mergeVariables(
      derivedVariables(context, componentType),
      component.profile.templateVariables
    );

    for (const relativePath of coreFiles) {
      operations.push(await createOperation({
        component: componentType,
        sourcePath: path.join(coreDir, relativePath),
        targetPath: resolveInside(
          component.rootDir,
          path.join("docs", "governance", path.basename(relativePath))
        ),
        sourceId: `core:${relativePath.replaceAll("\\", "/")}`,
        sourceVersion: 1,
        variables
      }));
    }

    for (const relativePath of sharedFiles) {
      operations.push(await createOperation({
        component: componentType,
        sourcePath: path.join(sharedDir, relativePath),
        targetPath: resolveInside(component.rootDir, relativePath),
        sourceId: `shared:${relativePath.replaceAll("\\", "/")}`,
        sourceVersion: 1,
        variables
      }));
    }

    const templateDir = path.join(
      context.kitRoot,
      "templates",
      componentTemplateDirs[componentType]
    );
    for (const relativePath of await listFiles(templateDir)) {
      const isStatusSource = relativePath.replaceAll("\\", "/") === "docs/status-enums.json";
      operations.push(await createOperation({
        component: componentType,
        sourcePath: path.join(templateDir, relativePath),
        targetPath: resolveInside(component.rootDir, relativePath),
        sourceId: `component:${componentType}:${relativePath.replaceAll("\\", "/")}`,
        sourceVersion: 1,
        variables,
        writePolicy: isStatusSource ? "create-only" : "managed"
      }));
    }

    const profileReadme = path.join(component.profile._sourceDir, "README.md");
    operations.push(await createOperation({
      component: componentType,
      sourcePath: profileReadme,
      targetPath: resolveInside(component.rootDir, path.join("docs", "governance", "TECH_STACK.md")),
      sourceId: `profile:${component.profile.id}`,
      sourceVersion: component.profile.version,
      variables,
      transform: (source) => renderProfileDocument(component.profile, source)
    }));
  }

  return {
    context,
    operations
  };
}
