import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "docs", "status-enums.json");
const registryPath = path.join(root, "docs", "STATUS_ENUM_REGISTRY.md");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const registry = fs.readFileSync(registryPath, "utf8");

function validateSource(registrySource) {
  const groupNames = new Set();
  for (const group of registrySource.groups || []) {
    if (groupNames.has(group.name)) throw new Error(`Duplicate group: ${group.name}`);
    groupNames.add(group.name);
    const codes = new Set();
    for (const value of group.values || []) {
      if (codes.has(value.code)) throw new Error(`Duplicate code in ${group.name}: ${value.code}`);
      codes.add(value.code);
    }
    for (const value of group.values || []) {
      for (const next of value.next || []) {
        if (!codes.has(next)) throw new Error(`${group.name}.${value.code} has unknown next status: ${next}`);
      }
    }
  }
}

const requiredCodes = source.groups.flatMap((group) => group.values.map((value) => value.code));
validateSource(source);

const missing = requiredCodes.filter((code) => !registry.includes(`\`${code}\``));
if (missing.length) {
  console.error(`STATUS_ENUM_REGISTRY.md is missing codes: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("Status registry check passed.");

