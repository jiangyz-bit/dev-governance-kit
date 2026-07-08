import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const serverDir = process.env.SERVER_REPO_DIR
  ? path.resolve(process.env.SERVER_REPO_DIR)
  : path.resolve(root, "..", "{{SERVER_REPO_DIR_NAME}}");
const source = JSON.parse(fs.readFileSync(path.join(serverDir, "docs", "status-enums.json"), "utf8"));
const registry = fs.readFileSync(path.join(root, "docs", "STATUS_ENUM_REGISTRY.md"), "utf8");

const requiredCodes = source.groups.flatMap((group) => group.values.map((value) => value.code));
const missing = requiredCodes.filter((code) => !registry.includes(`\`${code}\``));
if (missing.length) {
  console.error(`STATUS_ENUM_REGISTRY.md is missing codes: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("Status registry check passed.");

