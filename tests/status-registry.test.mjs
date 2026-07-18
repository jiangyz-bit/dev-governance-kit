import assert from "node:assert/strict";
import test from "node:test";
import {
  renderStatusRegistry,
  validateStatusSource
} from "../tooling/lib/status-registry.mjs";

const validSource = {
  version: 1,
  project: "demo",
  description: "状态源",
  groups: [
    {
      name: "WorkflowStatus",
      type: "workflow_status",
      values: [
        { code: "draft", desc: "草稿", next: ["reviewing"] },
        { code: "reviewing", desc: "审核中", next: ["approved"] },
        { code: "approved", desc: "已通过", next: [] }
      ]
    }
  ]
};

test("rejects duplicate groups, codes, and unknown transitions", () => {
  assert.throws(
    () => validateStatusSource({ ...validSource, groups: [validSource.groups[0], validSource.groups[0]] }),
    (error) => error.code === "DUPLICATE_STATUS_GROUP"
  );

  const duplicateCode = structuredClone(validSource);
  duplicateCode.groups[0].values.push({ code: "draft", desc: "重复", next: [] });
  assert.throws(
    () => validateStatusSource(duplicateCode),
    (error) => error.code === "DUPLICATE_STATUS_CODE"
  );

  const unknownNext = structuredClone(validSource);
  unknownNext.groups[0].values[0].next = ["missing"];
  assert.throws(
    () => validateStatusSource(unknownNext),
    (error) => error.code === "UNKNOWN_NEXT_STATUS"
  );
});

test("renders deterministic server and remote registries", () => {
  const server = renderStatusRegistry(validSource, { remote: false });
  const repeated = renderStatusRegistry(structuredClone(validSource), { remote: false });
  const remote = renderStatusRegistry(validSource, { remote: true });
  assert.equal(server, repeated);
  assert.match(server, /Generated from `docs\/status-enums\.json`/);
  assert.match(remote, /Generated from the server repository/);
  assert.match(server, /\| `draft` \| 草稿 \| `reviewing` \|/);
  assert.notEqual(server, remote);
});

test("rendering reflects newly added source codes", () => {
  const changed = structuredClone(validSource);
  changed.groups[0].values.push({ code: "archived", desc: "已归档", next: [] });
  assert.match(renderStatusRegistry(changed, { remote: false }), /`archived`/);
});
