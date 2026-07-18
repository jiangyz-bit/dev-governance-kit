import assert from "node:assert/strict";
import test from "node:test";
import { renderStrict } from "../tooling/lib/template.mjs";

test("renders every declared variable", () => {
  assert.equal(
    renderStrict("为 {{PROJECT_NAME}} 运行 {{TEST_COMMAND}}。", {
      TEST_COMMAND: "npm test",
      PROJECT_NAME: "demo"
    }),
    "为 demo 运行 npm test。"
  );
});

test("rejects unresolved variables", () => {
  assert.throws(
    () => renderStrict("运行 {{TEST_COMMAND}} 和 {{BUILD_COMMAND}}。", {
      TEST_COMMAND: "npm test"
    }),
    (error) => error.code === "UNRESOLVED_VARIABLE"
      && error.details.variables.includes("BUILD_COMMAND")
  );
});
