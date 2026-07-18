import { readdir } from "node:fs/promises";
import path from "node:path";
import { GovernanceError } from "./errors.mjs";
import { readYamlFile } from "./files.mjs";
import { validateSchema } from "./schema-validator.mjs";

async function loadEntries(parentDir, { fileName, schemaName }) {
  const entries = new Map();
  const items = (await readdir(parentDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const item of items) {
    const isCandidate = fileName
      ? item.isDirectory()
      : item.isFile() && item.name.endsWith(".yaml");
    if (!isCandidate) {
      continue;
    }

    const sourceDir = item.isDirectory() ? path.join(parentDir, item.name) : parentDir;
    const sourceFile = item.isDirectory()
      ? path.join(sourceDir, fileName)
      : path.join(parentDir, item.name);
    const value = await readYamlFile(sourceFile);
    validateSchema(schemaName, value);
    if (entries.has(value.id)) {
      throw new GovernanceError(
        "DUPLICATE_CATALOG_ID",
        `重复的 ${schemaName} ID：${value.id}`
      );
    }
    entries.set(value.id, { ...value, _sourceDir: sourceDir });
  }

  return entries;
}

export async function loadCatalog(kitRoot) {
  return {
    profiles: await loadEntries(path.join(kitRoot, "profiles"), {
      fileName: "profile.yaml",
      schemaName: "profile"
    }),
    blueprints: await loadEntries(path.join(kitRoot, "blueprints"), {
      fileName: "",
      schemaName: "blueprint"
    })
  };
}
