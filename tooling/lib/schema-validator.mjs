import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { GovernanceError } from "./errors.mjs";

const schemaPaths = {
  "governance-kit": new URL("../../schemas/governance-kit.schema.json", import.meta.url),
  profile: new URL("../../schemas/profile.schema.json", import.meta.url),
  blueprint: new URL("../../schemas/blueprint.schema.json", import.meta.url)
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(schemaPaths).map(([name, url]) => {
    const schema = JSON.parse(readFileSync(url, "utf8"));
    return [name, ajv.compile(schema)];
  })
);

export function validateSchema(schemaName, value) {
  const validate = validators[schemaName];
  if (!validate) {
    throw new GovernanceError("UNKNOWN_SCHEMA", `未知 Schema：${schemaName}`);
  }
  if (!validate(value)) {
    throw new GovernanceError("SCHEMA_INVALID", `${schemaName} 验证失败`, {
      errors: validate.errors
    });
  }
  if (schemaName === "governance-kit") {
    const roots = new Map();
    for (const [component, config] of Object.entries(value.components)) {
      const normalized = path.posix.resolve(
        "/",
        config.path.replaceAll("\\", "/")
      );
      const key = process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
      if (roots.has(key)) {
        throw new GovernanceError(
          "SCHEMA_INVALID",
          "governance-kit 验证失败：多个组件不能使用同一个根目录",
          {
            reason: "DUPLICATE_COMPONENT_ROOT",
            components: [roots.get(key), component],
            path: normalized
          }
        );
      }
      roots.set(key, component);
    }
  }
}
