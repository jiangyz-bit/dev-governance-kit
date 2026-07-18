import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../tooling/lib/catalog.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("loads the three phase-one profiles and the official blueprint", async () => {
  const catalog = await loadCatalog(kitRoot);
  assert.deepEqual([...catalog.profiles.keys()].sort(), [
    "java-springboot-mybatis",
    "react-admin",
    "wechat-miniprogram"
  ]);
  assert.deepEqual([...catalog.blueprints.keys()], ["java-react-wechat"]);
});

test("blueprint profiles support their assigned component types", async () => {
  const catalog = await loadCatalog(kitRoot);
  const blueprint = catalog.blueprints.get("java-react-wechat");
  for (const [componentType, selection] of Object.entries(blueprint.components)) {
    const profile = catalog.profiles.get(selection.profile);
    assert.ok(profile, `Profile 不存在：${selection.profile}`);
    assert.ok(profile.componentTypes.includes(componentType));
  }
});

test("catalog entries expose absolute source directories", async () => {
  const catalog = await loadCatalog(kitRoot);
  for (const entry of [...catalog.profiles.values(), ...catalog.blueprints.values()]) {
    assert.ok(path.isAbsolute(entry._sourceDir));
  }
});
