import assert from "node:assert/strict";
import test from "node:test";
import { resolveInside } from "../tooling/lib/files.mjs";
import { createProjectContext } from "../tooling/lib/manifest.mjs";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("rejects duplicate component roots across manifest fields", () => {
  assert.throws(
    () => validateSchema("governance-kit", {
      schemaVersion: 1,
      project: { name: "demo", repositoryMode: "monorepo" },
      components: {
        server: { profile: "java-springboot-mybatis", path: "." },
        admin: { profile: "react-admin", path: "./" }
      },
      contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
      generation: { conflictPolicy: "report" }
    }),
    (error) => error.code === "SCHEMA_INVALID"
      && error.details?.reason === "DUPLICATE_COMPONENT_ROOT"
  );
});

test("project context rejects real-path aliases but permits nested distinct roots", async (t) => {
  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-context-roots-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  await mkdir(path.join(workspaceDir, "apps", "admin"), { recursive: true });

  const base = {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "monorepo" },
    contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
    generation: { conflictPolicy: "report" }
  };
  const nested = await createProjectContext({
    workspaceDir,
    kitRoot,
    requireComponentDirs: true,
    manifest: {
      ...base,
      components: {
        server: { profile: "java-springboot-mybatis", path: "apps" },
        admin: { profile: "react-admin", path: "apps/admin" }
      }
    }
  });
  assert.equal(Object.keys(nested.components).length, 2);

  if (process.platform !== "win32") {
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(workspaceDir, "apps"), path.join(workspaceDir, "alias"), "dir");
    await assert.rejects(
      createProjectContext({
        workspaceDir,
        kitRoot,
        requireComponentDirs: true,
        manifest: {
          ...base,
          components: {
            server: { profile: "java-springboot-mybatis", path: "apps" },
            admin: { profile: "react-admin", path: "alias" }
          }
        }
      }),
      (error) => error.code === "DUPLICATE_COMPONENT_ROOT"
        || error.code === "UNSAFE_REAL_PATH"
    );
  }
});

test("creates project context from an in-memory manifest", async (t) => {
  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-context-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  await mkdir(path.join(workspaceDir, "server"));
  const manifest = {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "monorepo" },
    components: {
      server: { profile: "java-springboot-mybatis", path: "server" }
    },
    contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
    generation: { conflictPolicy: "report" }
  };

  const context = await createProjectContext({
    workspaceDir,
    kitRoot,
    manifest,
    requireComponentDirs: true
  });

  assert.equal(context.manifest, manifest);
  assert.equal(context.components.server.rootDir, path.join(workspaceDir, "server"));
});
