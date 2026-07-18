import { readFileSync } from "node:fs";
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
}
