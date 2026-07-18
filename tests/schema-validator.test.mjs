import assert from "node:assert/strict";
import test from "node:test";
import { resolveInside } from "../tooling/lib/files.mjs";
import { validateSchema } from "../tooling/lib/schema-validator.mjs";

test("accepts a valid project manifest", () => {
  assert.doesNotThrow(() => validateSchema("governance-kit", {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "multi-repo" },
    components: {
      server: { profile: "java-springboot-mybatis", path: "demo-server" }
    },
    contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
    generation: { conflictPolicy: "report" }
  }));
});

test("accepts valid Profile and Blueprint documents", () => {
  assert.doesNotThrow(() => validateSchema("profile", {
    id: "java-springboot-mybatis",
    version: 1,
    componentTypes: ["server"],
    commands: { test: "mvn test" },
    capabilities: { migration: "flyway" },
    templateVariables: { TEST_COMMAND: "mvn test" }
  }));
  assert.doesNotThrow(() => validateSchema("blueprint", {
    id: "java-react-wechat",
    version: 1,
    components: { server: { profile: "java-springboot-mybatis" } },
    defaults: { repositoryMode: "multi-repo" },
    contracts: { statusRegistryOwner: "server", apiContractOwner: "server" }
  }));
});

test("rejects an unsupported repository mode", () => {
  assert.throws(
    () => validateSchema("governance-kit", {
      schemaVersion: 1,
      project: { name: "demo", repositoryMode: "shared-folder" },
      components: {
        server: { profile: "java-springboot-mybatis", path: "server" }
      },
      contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
      generation: { conflictPolicy: "report" }
    }),
    (error) => error.code === "SCHEMA_INVALID"
  );
});

test("rejects unknown manifest properties", () => {
  assert.throws(
    () => validateSchema("governance-kit", {
      schemaVersion: 1,
      project: { name: "demo", repositoryMode: "monorepo", unsafe: true },
      components: {
        server: { profile: "java-springboot-mybatis", path: "server" }
      },
      contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
      generation: { conflictPolicy: "report" }
    }),
    (error) => error.code === "SCHEMA_INVALID"
  );
});

test("rejects paths outside the workspace", () => {
  assert.throws(
    () => resolveInside("C:/workspace/demo", "../outside"),
    (error) => error.code === "UNSAFE_PATH"
  );
});
