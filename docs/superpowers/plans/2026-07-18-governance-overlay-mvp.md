# Governance Overlay MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, idempotent Node.js CLI that validates a multi-stack project manifest and applies the existing Java, React Admin, and WeChat Mini Program governance layers to empty or existing workspaces without overwriting user-owned files.

**Architecture:** The MVP uses `governance-kit.yaml` as the workspace entry point, JSON Schema as the configuration contract, and a catalog of machine-readable Profiles and Blueprints. A pure planning layer resolves Core rules, component templates, and Profiles into file operations; a separate apply layer performs atomic writes only for new or tool-managed files, while validate reports configuration, placeholder, status-registry, and generated-file errors.

**Tech Stack:** Node.js 20+, ECMAScript modules, npm, `yaml`, `ajv`, Node.js built-in `node:test`.

## Global Constraints

- Phase one supports `java-springboot-mybatis`, `react-admin`, and `wechat-miniprogram`.
- Both `monorepo` and `multi-repo` workspace layouts must be supported.
- The workspace root must not be assumed to be a Git repository.
- The default conflict policy is `report`; user-owned or source-unknown files must never be overwritten.
- Every resolved target path must remain inside the configured workspace.
- Repeated `apply` runs with unchanged inputs must produce no further changes.
- Core owns technology-independent rules; Templates own component responsibilities; Profiles own stack-specific commands and mappings.
- The backend component remains the only status-registry source of truth.
- Existing templates remain available until composition tests prove equivalent generated output.
- No implementation for Go, Node backend, Vue, OpenAPI generation, or full project scaffolding is included in this plan.

---

## File Map

### Runtime and public entry points

- Create `package.json`: Node version, dependencies, CLI bin, and test scripts.
- Create `tooling/cli.mjs`: argument parsing and `apply` / `validate` command dispatch.
- Create `tooling/index.mjs`: stable programmatic exports.

### Configuration contracts and loading

- Create `schemas/governance-kit.schema.json`: workspace manifest contract.
- Create `schemas/profile.schema.json`: Profile contract.
- Create `schemas/blueprint.schema.json`: Blueprint contract.
- Create `tooling/lib/errors.mjs`: stable error codes and serialized diagnostics.
- Create `tooling/lib/files.mjs`: UTF-8 loading, safe path resolution, hashing, and atomic writes.
- Create `tooling/lib/schema-validator.mjs`: Ajv compilation and validation.
- Create `tooling/lib/catalog.mjs`: Profile and Blueprint discovery.
- Create `tooling/lib/manifest.mjs`: manifest loading and cross-reference checks.

### Composition and application

- Create `tooling/lib/template.mjs`: strict `{{VARIABLE}}` rendering and unresolved-placeholder detection.
- Create `tooling/lib/planner.mjs`: pure composition plan generation.
- Create `tooling/lib/apply.mjs`: dry-run, managed-file update, conflict skip, and report generation.
- Create `tooling/lib/validate.mjs`: workspace validation orchestration.
- Create `tooling/lib/status-registry.mjs`: CLI-side status source validation and expected Markdown rendering.

### Governance content

- Create `core/rules/*.md`: technology-independent rules migrated from the approved design source.
- Create `templates/shared/docs/governance/README.md`: generated governance index.
- Create `profiles/*/profile.yaml`: machine-readable metadata for the three existing Profiles.
- Create `blueprints/java-react-wechat.yaml`: first supported component combination.
- Keep existing generated-project status scripts unchanged during the compatibility window; shared packaging is phase two.

### Tests and fixtures

- Create `tests/helpers/workspace.mjs`: isolated temporary workspace helpers.
- Create `tests/schema-validator.test.mjs`: Schema and cross-reference tests.
- Create `tests/catalog.test.mjs`: catalog discovery and compatibility tests.
- Create `tests/template.test.mjs`: strict rendering tests.
- Create `tests/planner.test.mjs`: layer composition and path-safety tests.
- Create `tests/apply.test.mjs`: conflict and idempotency tests.
- Create `tests/status-registry.test.mjs`: shared status validation and rendering tests.
- Create `tests/cli.test.mjs`: end-to-end CLI tests.
- Create `tests/fixtures/monorepo/governance-kit.yaml`: monorepo fixture.
- Create `tests/fixtures/multi-repo/governance-kit.yaml`: multi-repo fixture.

---

### Task 1: Establish the Node.js package and test harness

**Files:**
- Create: `package.json`
- Create: `tooling/index.mjs`
- Create: `tests/package.test.mjs`
- Create: `package-lock.json` through `npm install`

**Interfaces:**
- Produces: npm scripts `test`, `test:unit`, and `governance-kit`; package bin `governance-kit`.
- Produces: public exports that later tasks fill without changing import paths.

- [ ] **Step 1: Write the failing package-contract test**

```js
// tests/package.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes the governance CLI and supported Node version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["governance-kit"], "./tooling/cli.mjs");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.test, "node --test tests");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/package.test.mjs`

Expected: FAIL with `ENOENT` for `package.json`.

- [ ] **Step 3: Create the package contract and public module**

```json
{
  "name": "dev-governance-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "bin": {
    "governance-kit": "./tooling/cli.mjs"
  },
  "scripts": {
    "governance-kit": "node tooling/cli.mjs",
    "test": "node --test tests",
    "test:unit": "node --test tests/*.test.mjs"
  },
  "dependencies": {
    "ajv": "8.17.1",
    "yaml": "2.8.1"
  }
}
```

```js
// tooling/index.mjs
export { applyGovernance } from "./lib/apply.mjs";
export { loadProjectManifest } from "./lib/manifest.mjs";
export { validateWorkspace } from "./lib/validate.mjs";
```

Create a temporary CLI stub so npm can resolve the declared bin before Task 7:

```js
#!/usr/bin/env node
// tooling/cli.mjs
process.stderr.write("governance-kit CLI is not initialized\n");
process.exitCode = 2;
```

- [ ] **Step 4: Install locked dependencies and run the package test**

Run: `npm install`

Expected: exit 0 and a new `package-lock.json`.

Run: `node --test --test-name-pattern="package exposes" tests/package.test.mjs`

Expected: PASS, 1 test passed.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json tooling/index.mjs tooling/cli.mjs tests/package.test.mjs
git commit -m "build: establish governance CLI package"
```

---

### Task 2: Define and validate manifests, Profiles, and Blueprints

**Files:**
- Create: `schemas/governance-kit.schema.json`
- Create: `schemas/profile.schema.json`
- Create: `schemas/blueprint.schema.json`
- Create: `tooling/lib/errors.mjs`
- Create: `tooling/lib/files.mjs`
- Create: `tooling/lib/schema-validator.mjs`
- Create: `tests/schema-validator.test.mjs`

**Interfaces:**
- Produces: `GovernanceError(code: string, message: string, details?: object)`.
- Produces: `readYamlFile(filePath: string): Promise<object>`.
- Produces: `resolveInside(rootDir: string, relativePath: string): string`.
- Produces: `validateSchema(schemaName: "governance-kit" | "profile" | "blueprint", value: object): void`.

- [ ] **Step 1: Write failing Schema and safe-path tests**

```js
// tests/schema-validator.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { validateSchema } from "../tooling/lib/schema-validator.mjs";
import { resolveInside } from "../tooling/lib/files.mjs";

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

test("rejects paths outside the workspace", () => {
  assert.throws(
    () => resolveInside("C:/workspace/demo", "../outside"),
    (error) => error.code === "UNSAFE_PATH"
  );
});
```

- [ ] **Step 2: Run the tests and verify module-not-found failures**

Run: `node --test tests/schema-validator.test.mjs`

Expected: FAIL because `schema-validator.mjs` and `files.mjs` do not exist.

- [ ] **Step 3: Create exact JSON Schemas**

`schemas/governance-kit.schema.json` must:

- require `schemaVersion`, `project`, `components`, `contracts`, and `generation`;
- set `schemaVersion` to integer constant `1`;
- restrict `repositoryMode` to `monorepo` or `multi-repo`;
- require at least one component;
- restrict component keys to `server`, `admin`, or `client`;
- require each component to contain only `profile` and `path`;
- restrict `conflictPolicy` to constant `report`;
- disallow unknown properties at every object level.

`schemas/profile.schema.json` must require:

```json
{
  "id": "java-springboot-mybatis",
  "version": 1,
  "componentTypes": ["server"],
  "commands": {
    "test": "mvn test",
    "build": "mvn package"
  },
  "capabilities": {
    "migration": "flyway",
    "dataAccess": "mybatis"
  },
  "templateVariables": {
    "LANGUAGE_AND_VERSION": "Java 21"
  }
}
```

`schemas/blueprint.schema.json` must require `id`, `version`, `components`, `defaults`, and `contracts`; component values require a `profile`; repository mode and owner fields use the same enums as the project manifest.

- [ ] **Step 4: Implement errors, UTF-8 YAML loading, safe paths, and Ajv validation**

```js
// tooling/lib/errors.mjs
export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
```

```js
// tooling/lib/files.mjs
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { GovernanceError } from "./errors.mjs";

export async function readYamlFile(filePath) {
  const source = await readFile(filePath, "utf8");
  return parse(source);
}

export function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GovernanceError("UNSAFE_PATH", `Path escapes workspace: ${relativePath}`, {
      root,
      target
    });
  }
  return target;
}

export async function writeUtf8Atomic(filePath, content) {
  const temporaryPath = `${filePath}.governance-kit.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}
```

```js
// tooling/lib/schema-validator.mjs
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
    throw new GovernanceError("UNKNOWN_SCHEMA", `Unknown schema: ${schemaName}`);
  }
  if (!validate(value)) {
    throw new GovernanceError("SCHEMA_INVALID", `${schemaName} validation failed`, {
      errors: validate.errors
    });
  }
}
```

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/schema-validator.test.mjs`

Expected: PASS, 3 tests passed.

Run: `npm test`

Expected: all current tests pass.

- [ ] **Step 6: Commit**

```powershell
git add schemas tooling/lib/errors.mjs tooling/lib/files.mjs tooling/lib/schema-validator.mjs tests/schema-validator.test.mjs
git commit -m "feat: define governance configuration contracts"
```

---

### Task 3: Add Core rules and the first machine-readable catalog

**Files:**
- Create: `core/rules/architecture.md`
- Create: `core/rules/api.md`
- Create: `core/rules/database.md`
- Create: `core/rules/security.md`
- Create: `core/rules/testing.md`
- Create: `core/rules/agent-workflow.md`
- Create: `templates/shared/docs/governance/README.md`
- Create: `profiles/java-springboot-mybatis/profile.yaml`
- Create: `profiles/react-admin/profile.yaml`
- Create: `profiles/wechat-miniprogram/profile.yaml`
- Create: `blueprints/java-react-wechat.yaml`
- Create: `tooling/lib/catalog.mjs`
- Create: `tests/catalog.test.mjs`

**Interfaces:**
- Consumes: `readYamlFile()` and `validateSchema()` from Task 2.
- Produces: `loadCatalog(kitRoot: string): Promise<{ profiles: Map<string, Profile>, blueprints: Map<string, Blueprint> }>`.
- Produces: catalog entries with internal `_sourceDir` absolute paths.

- [ ] **Step 1: Write failing catalog tests**

```js
// tests/catalog.test.mjs
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
    assert.ok(profile.componentTypes.includes(componentType));
  }
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test tests/catalog.test.mjs`

Expected: FAIL because the catalog module and YAML catalog files do not exist.

- [ ] **Step 3: Add Core rule documents**

Create one focused document per approved rule group:

- `architecture.md`: backend fact source, controller/service/data boundaries, adapters, transactions, idempotency, and component ownership.
- `api.md`: centralized clients, DTO boundaries, stable errors, compatibility, pagination, batch result semantics, and caller checks.
- `database.md`: migrations only, immutable released migrations, clean initialization, stable status codes, indexes, compatibility windows, and rollback analysis.
- `security.md`: secret separation, explicit environments, production protections, backend authorization, safe errors, and real-data prohibition.
- `testing.md`: the change-type validation matrix and evidence-based completion.
- `agent-workflow.md`: reading order, impact analysis, non-destructive Git behavior, cross-component synchronization, and final reporting.

Each file must begin with a stable rule ID prefix in its title, such as:

```markdown
# CORE-ARCH: Architecture Rules

These technology-independent rules are authoritative for every generated component.
```

Every normative Core rule must be preceded by a globally unique machine-readable marker:

```markdown
<!-- rule-id: CORE-ARCH-001 -->
- Controllers adapt HTTP requests and responses; they do not own business rules.
```

Rule IDs use `CORE-<GROUP>-<THREE_DIGITS>`. Templates and Profiles may link to a Core rule ID but must not declare a second `rule-id` marker for it.

The shared governance index must link each copied Core rule using relative paths and state that generated rule files are not edited manually.

- [ ] **Step 4: Add exact phase-one Profile metadata**

Use the existing Profile README commands and rules as the source. Each `profile.yaml` must provide all variables referenced by its selected component templates.

The Java Profile must declare:

```yaml
id: java-springboot-mybatis
version: 1
componentTypes:
  - server
commands:
  startDatabase: docker compose up -d
  start: mvn spring-boot:run
  test: mvn test
  build: mvn package
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  migration: flyway
  dataAccess: mybatis
templateVariables:
  LANGUAGE_AND_VERSION: Java 21
  WEB_FRAMEWORK: Spring Boot
  ORM_OR_DATA_ACCESS: MyBatis
  MIGRATION_TOOL: Flyway
  DATABASE: MySQL
  BUILD_TOOL: Maven
  RUNTIME: Java 21
  DATABASE_RUNTIME: Docker Compose
  START_DATABASE_COMMAND: docker compose up -d
  START_SERVER_COMMAND: mvn spring-boot:run
  TEST_COMMAND: mvn test
```

The React Profile must declare:

```yaml
id: react-admin
version: 1
componentTypes:
  - admin
commands:
  install: npm install
  start: npm run dev
  test: npm test
  typecheck: npm run typecheck
  build: npm run build
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  ui: operations-console
  language: typescript
templateVariables:
  FRONTEND_FRAMEWORK: React
  LANGUAGE: TypeScript
  BUILD_TOOL: Vite
  UI_LIBRARY: Project-selected component library
  INSTALL_COMMAND: npm install
  DEV_COMMAND: npm run dev
  TEST_COMMAND: npm test
  TYPECHECK_COMMAND: npm run typecheck
  BUILD_COMMAND: npm run build
```

The WeChat Profile must declare:

```yaml
id: wechat-miniprogram
version: 1
componentTypes:
  - client
commands:
  install: npm install
  test: npm test
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  platform: wechat-miniprogram
  publicClient: true
templateVariables:
  INSTALL_COMMAND: npm install
  TEST_COMMAND: npm test
```

These are Profile defaults for newly created projects. Applying to an existing project requires the Agent to verify that the selected Profile matches the repository's actual build files and scripts before writing; the MVP does not infer or rewrite package scripts.

- [ ] **Step 5: Add the first Blueprint and catalog loader**

```yaml
# blueprints/java-react-wechat.yaml
id: java-react-wechat
version: 1
components:
  server:
    profile: java-springboot-mybatis
  admin:
    profile: react-admin
  client:
    profile: wechat-miniprogram
defaults:
  repositoryMode: multi-repo
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
```

```js
// tooling/lib/catalog.mjs
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readYamlFile } from "./files.mjs";
import { GovernanceError } from "./errors.mjs";
import { validateSchema } from "./schema-validator.mjs";

async function loadEntries(parentDir, { fileName, schemaName }) {
  const entries = new Map();
  const items = (await readdir(parentDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const item of items) {
    const isCandidate = fileName ? item.isDirectory() : item.isFile() && item.name.endsWith(".yaml");
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
      throw new GovernanceError("DUPLICATE_CATALOG_ID", `Duplicate ${schemaName}: ${value.id}`);
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
```

- [ ] **Step 6: Run catalog and full tests**

Run: `node --test tests/catalog.test.mjs`

Expected: PASS, 2 tests passed.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add core templates/shared profiles blueprints tooling/lib/catalog.mjs tests/catalog.test.mjs
git commit -m "feat: add core rules and phase-one catalog"
```

---

### Task 4: Load project manifests and build a pure composition plan

**Files:**
- Create: `tooling/lib/manifest.mjs`
- Create: `tooling/lib/template.mjs`
- Create: `tooling/lib/planner.mjs`
- Create: `tests/template.test.mjs`
- Create: `tests/planner.test.mjs`
- Create: `tests/fixtures/multi-repo/governance-kit.yaml`
- Create: `tests/fixtures/monorepo/governance-kit.yaml`

**Interfaces:**
- Consumes: catalog maps, Schema validation, and safe-path resolution.
- Produces: `loadProjectManifest(workspaceDir: string, kitRoot: string): Promise<ProjectContext>`.
- Produces: `renderStrict(source: string, variables: Record<string, string>): string`.
- Produces: `buildApplyPlan(context: ProjectContext): Promise<ApplyPlan>`.
- `ProjectContext` uses `{ kitRoot, workspaceDir, manifest, catalog, components }`, where each `components[type]` entry is `{ type, rootDir, profile }`.
- `ApplyPlan` uses `{ context, operations }`.
- `ApplyPlan.operations` entries use `{ component, sourcePath, targetPath, content, sourceId, sourceVersion, writePolicy }`.
- `writePolicy` is `"managed"` for marked generated text and `"create-only"` for `docs/status-enums.json`.

- [ ] **Step 1: Write failing strict-template tests**

```js
// tests/template.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderStrict } from "../tooling/lib/template.mjs";

test("renders every declared variable", () => {
  assert.equal(
    renderStrict("Run {{TEST_COMMAND}} for {{PROJECT_NAME}}.", {
      TEST_COMMAND: "npm test",
      PROJECT_NAME: "demo"
    }),
    "Run npm test for demo."
  );
});

test("rejects unresolved variables", () => {
  assert.throws(
    () => renderStrict("Run {{TEST_COMMAND}} and {{BUILD_COMMAND}}.", {
      TEST_COMMAND: "npm test"
    }),
    (error) => error.code === "UNRESOLVED_VARIABLE"
      && error.details.variables.includes("BUILD_COMMAND")
  );
});
```

- [ ] **Step 2: Write failing manifest and planner tests**

The planner test must assert:

- a multi-repo fixture resolves three independent component roots;
- a monorepo fixture resolves component paths under one root;
- Core rules are planned for every component;
- server, admin, and miniprogram templates are selected correctly;
- every operation target remains inside its component root;
- no planned content contains `{{` or `}}`;
- an owner name absent from `components` fails with `UNKNOWN_CONTRACT_OWNER`;
- a Profile assigned to an unsupported component fails with `INCOMPATIBLE_PROFILE`.

Use exact fixture content:

```yaml
schemaVersion: 1
project:
  name: demo
  repositoryMode: multi-repo
components:
  server:
    profile: java-springboot-mybatis
    path: demo-server
  admin:
    profile: react-admin
    path: demo-admin
  client:
    profile: wechat-miniprogram
    path: demo-miniprogram
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
generation:
  conflictPolicy: report
```

- [ ] **Step 3: Run focused tests and verify failures**

Run: `node --test tests/template.test.mjs tests/planner.test.mjs`

Expected: FAIL because the three implementation modules do not exist.

- [ ] **Step 4: Implement strict rendering**

```js
// tooling/lib/template.mjs
import { GovernanceError } from "./errors.mjs";

const variablePattern = /\{\{([A-Z0-9_]+)\}\}/g;

export function renderStrict(source, variables) {
  const missing = new Set();
  const rendered = source.replace(variablePattern, (match, name) => {
    if (!(name in variables)) {
      missing.add(name);
      return match;
    }
    return String(variables[name]);
  });
  if (missing.size > 0) {
    throw new GovernanceError("UNRESOLVED_VARIABLE", "Template variables are unresolved", {
      variables: [...missing].sort()
    });
  }
  return rendered;
}
```

- [ ] **Step 5: Implement manifest cross-reference checks**

`loadProjectManifest()` must:

1. load `governance-kit.yaml`;
2. validate it with the project Schema;
3. load the catalog;
4. resolve each Profile;
5. verify component compatibility;
6. verify contract owners exist;
7. return absolute workspace/component paths plus the selected metadata.

Use `GovernanceError` codes:

- `PROFILE_NOT_FOUND`
- `INCOMPATIBLE_PROFILE`
- `UNKNOWN_CONTRACT_OWNER`

- [ ] **Step 6: Implement deterministic planning**

`buildApplyPlan()` must create operations in this order:

1. Core rules sorted by filename.
2. Shared template files sorted by relative path.
3. Component template files sorted by relative path.
4. Component Profile documentation.

Template variables are merged deterministically:

1. Derived workspace values:
   - `PRODUCT_NAME` = `manifest.project.name`
   - `SERVER_NAME`, `ADMIN_NAME`, and `MINIPROGRAM_NAME` = basename of the matching component path
   - `SERVER_REPO_DIR_NAME` = basename of the server component path
2. Selected Profile `templateVariables`.

Duplicate keys with unequal values fail with `VARIABLE_CONFLICT`. A variable required by a template but absent from both sources fails through `renderStrict()`.

Map the `client` component with `wechat-miniprogram` Profile to the existing `templates/miniprogram` source during the compatibility window. Add these generated metadata lines to managed Markdown content:

```markdown
<!-- governance-kit:managed -->
<!-- source-id: SOURCE_ID -->
<!-- source-version: 1 -->
```

Do not add managed markers to JSON status source files because they must remain valid JSON. Treat `docs/status-enums.json` as create-only in Task 5.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test tests/template.test.mjs tests/planner.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```powershell
git add tooling/lib/manifest.mjs tooling/lib/template.mjs tooling/lib/planner.mjs tests/template.test.mjs tests/planner.test.mjs tests/fixtures
git commit -m "feat: plan deterministic governance composition"
```

---

### Task 5: Apply plans without overwriting user-owned files

**Files:**
- Create: `tooling/lib/apply.mjs`
- Create: `tests/helpers/workspace.mjs`
- Create: `tests/apply.test.mjs`

**Interfaces:**
- Consumes: `ApplyPlan` from Task 4 and `writeUtf8Atomic()` from Task 2.
- Produces: `applyGovernance({ workspaceDir: string, kitRoot?: string, dryRun?: boolean }): Promise<ApplyReport>`; omitted `kitRoot` resolves to the repository containing `tooling/lib/apply.mjs`.
- `ApplyReport` contains arrays `created`, `updated`, `unchanged`, `conflicts`, `warnings`, and `errors`.

- [ ] **Step 1: Write failing apply tests**

```js
// tests/apply.test.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyGovernance } from "../tooling/lib/apply.mjs";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

test("dry-run reports files without writing them", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const report = await applyGovernance({ workspaceDir: workspace, dryRun: true });
  assert.ok(report.created.length > 0);
  await assert.rejects(readFile(path.join(workspace, "demo-server", "AGENTS.md"), "utf8"));
});

test("does not overwrite a user-owned AGENTS.md", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const target = path.join(workspace, "demo-server", "AGENTS.md");
  await writeFile(target, "# User rules\n", "utf8");
  const report = await applyGovernance({ workspaceDir: workspace });
  assert.ok(report.conflicts.some((entry) => entry.path === target));
  assert.equal(await readFile(target, "utf8"), "# User rules\n");
});

test("a second unchanged apply is idempotent", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const second = await applyGovernance({ workspaceDir: workspace });
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.ok(second.unchanged.length > 0);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test tests/apply.test.mjs`

Expected: FAIL because `apply.mjs` and the fixture helper do not exist.

- [ ] **Step 3: Implement isolated fixture creation**

`createFixtureWorkspace(t, fixtureName)` must:

- use `mkdtemp(path.join(tmpdir(), "governance-kit-"))`;
- register cleanup with `t.after(() => rm(root, { recursive: true, force: true }))`;
- copy the selected fixture manifest;
- create every component directory declared by that fixture;
- return the temporary workspace path.

- [ ] **Step 4: Implement classification and dry-run**

Classification rules:

```text
target absent                                  -> created
target bytes equal planned content             -> unchanged
target has managed marker and same source ID   -> updated
target is docs/status-enums.json and exists    -> conflict
all other existing targets                     -> conflict
```

Before any write:

- build the complete plan;
- classify every operation;
- return immediately when `dryRun` is true;
- stop all writes if the report contains an `error`;
- create parent directories only for operations classified `created` or `updated`.

Use `writeUtf8Atomic()` for every write. Sort each report array by path before returning it.

- [ ] **Step 5: Add source-version mismatch behavior**

If a managed target has the same source ID but a different source version:

- do not update it;
- add a `conflicts` entry with code `SOURCE_VERSION_MISMATCH`;
- include expected and actual versions;
- leave the file byte-for-byte unchanged.

Add a test that writes version `0`, runs apply, and verifies the conflict and unchanged bytes.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/apply.test.mjs`

Expected: all apply, conflict, and idempotency tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add tooling/lib/apply.mjs tests/helpers/workspace.mjs tests/apply.test.mjs
git commit -m "feat: apply governance layers safely"
```

---

### Task 6: Validate status registries and generated workspaces

**Files:**
- Create: `tooling/lib/status-registry.mjs`
- Create: `tooling/lib/validate.mjs`
- Create: `tests/status-registry.test.mjs`
- Create: `tests/validate.test.mjs`

**Interfaces:**
- Produces: `validateStatusSource(source: object): void`.
- Produces: `renderStatusRegistry(source: object, options: { remote: boolean }): string`.
- Produces: `validateWorkspace({ workspaceDir: string, kitRoot?: string }): Promise<ValidationReport>`; omitted `kitRoot` resolves to the repository containing `tooling/lib/validate.mjs`.
- `ValidationReport` contains `valid`, `checks`, `warnings`, and `errors`.

- [ ] **Step 1: Write failing status tests**

Test these exact behaviors:

- duplicate group names fail with `DUPLICATE_STATUS_GROUP`;
- duplicate codes in one group fail with `DUPLICATE_STATUS_CODE`;
- unknown `next` code fails with `UNKNOWN_NEXT_STATUS`;
- valid source renders deterministic Markdown;
- server and remote-client headings differ only in their source notice;
- changing the source then rendering produces the expected new code.

Use a compact fixture with `draft`, `reviewing`, and `approved` transitions.

- [ ] **Step 2: Write failing workspace-validation tests**

Test these exact checks:

- valid applied fixture returns `valid: true`;
- an unresolved `{{BUILD_COMMAND}}` returns `UNRESOLVED_PLACEHOLDER`;
- a missing managed file returns `MISSING_GENERATED_FILE`;
- a modified generated registry returns `STATUS_REGISTRY_DRIFT`;
- a duplicate `<!-- rule-id: CORE-ARCH-001 -->` declaration returns `DUPLICATE_RULE_ID`;
- a manifest/Profile incompatibility is returned as an error rather than an uncaught exception.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `node --test tests/status-registry.test.mjs tests/validate.test.mjs`

Expected: FAIL because both implementation modules do not exist.

- [ ] **Step 4: Implement CLI-side status validation and rendering**

Implement the duplicate and transition checks in `validateStatusSource()` and deterministic Markdown construction in `renderStatusRegistry()`. Match the current server/client output byte-for-byte so existing generated-project scripts remain the compatibility reference.

Do not modify the existing template scripts in phase one. Verify they remain directly executable with:

```powershell
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

The server script reads its local `docs/status-enums.json`. Admin and miniprogram scripts keep supporting `SERVER_REPO_DIR`, with the sibling-directory placeholder rendered during apply. Extracting one packaged implementation for generated projects is explicitly deferred to phase two.

- [ ] **Step 5: Implement workspace validation**

`validateWorkspace()` must:

1. load and cross-check the manifest;
2. build the expected apply plan without writing;
3. verify every planned managed file exists;
4. scan planned text targets for unresolved `{{[A-Z0-9_]+}}`;
5. scan `core/`, `templates/`, and `profiles/` for `<!-- rule-id: ID -->` declarations and reject duplicate IDs;
6. validate the server status source;
7. render and compare status Markdown where present;
8. return sorted structured diagnostics.

Convert `GovernanceError` instances into report errors using `error.toJSON()`. Unexpected errors must be rethrown so programmer defects are not hidden.

- [ ] **Step 6: Run focused, wrapper, and full tests**

Run: `node --test tests/status-registry.test.mjs tests/validate.test.mjs`

Expected: all focused tests pass.

Run from a generated server fixture:

```powershell
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

Expected: both commands exit 0 and the check prints `Status registry check passed.`

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add tooling/lib/status-registry.mjs tooling/lib/validate.mjs tests/status-registry.test.mjs tests/validate.test.mjs
git commit -m "feat: validate generated governance workspaces"
```

---

### Task 7: Expose apply and validate through the CLI

**Files:**
- Modify: `tooling/cli.mjs`
- Modify: `tooling/index.mjs`
- Create: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: `applyGovernance()` and `validateWorkspace()`.
- Produces commands:
  - `governance-kit apply --workspace <path> [--dry-run] [--json]`
  - `governance-kit validate --workspace <path> [--json]`
- Exit codes: `0` success, `1` validation errors or conflicts, `2` invalid CLI usage.

- [ ] **Step 1: Write failing end-to-end CLI tests**

Spawn `process.execPath` with `tooling/cli.mjs` and assert:

- `apply --dry-run --json` exits 0, reports creations, and writes nothing;
- `apply --json` exits 0 in an empty fixture and produces managed files;
- `apply --json` exits 1 when an existing user file conflicts;
- `validate --json` exits 0 after a clean apply;
- `validate --json` exits 1 after introducing registry drift;
- an unknown command exits 2 and prints usage to stderr;
- JSON mode writes exactly one valid JSON document to stdout.

- [ ] **Step 2: Run CLI tests and verify failures**

Run: `node --test tests/cli.test.mjs`

Expected: FAIL because the CLI still contains the initialization stub.

- [ ] **Step 3: Implement dependency-free argument parsing**

Accept only:

```text
apply
validate
--workspace <path>
--dry-run
--json
--help
```

Reject duplicate `--workspace`, missing values, `--dry-run` on validate, and unknown flags with exit code 2.

Default `--workspace` to `process.cwd()`. Resolve `kitRoot` from the CLI module location, not from the current working directory.

- [ ] **Step 4: Implement stable output and exit codes**

JSON output shape:

```json
{
  "command": "apply",
  "workspace": "C:/absolute/workspace",
  "ok": true,
  "report": {
    "created": [],
    "updated": [],
    "unchanged": [],
    "conflicts": [],
    "warnings": [],
    "errors": []
  }
}
```

Human-readable output must include counts for every report category and list conflicts/errors with their codes and paths.

`apply` returns exit 1 when `conflicts` or `errors` is non-empty. `validate` returns exit 1 when `valid` is false.

- [ ] **Step 5: Run CLI and full tests**

Run: `node --test tests/cli.test.mjs`

Expected: all CLI tests pass.

Run: `npm test`

Expected: all tests pass.

Run: `node tooling/cli.mjs --help`

Expected: exit 0 and usage text containing both `apply` and `validate`.

- [ ] **Step 6: Commit**

```powershell
git add tooling/cli.mjs tooling/index.mjs tests/cli.test.mjs
git commit -m "feat: expose governance apply and validate CLI"
```

---

### Task 8: Document the MVP and prove clean-workspace behavior

**Files:**
- Modify: `README.md`
- Create: `docs/MANIFEST_REFERENCE.md`
- Create: `docs/MIGRATION_FROM_V1_TEMPLATES.md`
- Modify: `tests/package.test.mjs`
- Modify: `tests/cli.test.mjs`

**Interfaces:**
- Documents the stable CLI and manifest fields created by Tasks 1–7.
- Adds final acceptance coverage without changing runtime interfaces.

- [ ] **Step 1: Add a failing documentation contract test**

Extend `tests/package.test.mjs`:

```js
test("README documents both supported workflows", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /governance-kit apply/);
  assert.match(readme, /governance-kit validate/);
  assert.match(readme, /existing project/i);
  assert.match(readme, /new project/i);
});
```

- [ ] **Step 2: Run the documentation test and verify it fails**

Run: `node --test tests/package.test.mjs`

Expected: FAIL because README does not yet document the CLI workflows.

- [ ] **Step 3: Update user and Agent documentation**

README must contain:

- the five-layer architecture;
- installation with `npm install`;
- a complete `governance-kit.yaml` example;
- dry-run before apply;
- apply and validate commands;
- conflict behavior;
- supported phase-one Profiles;
- explicit statement that `init` and additional stacks are later phases.

`docs/MANIFEST_REFERENCE.md` must document every Schema field, allowed enum, default, ownership rule, and one monorepo plus one multi-repo example.

`docs/MIGRATION_FROM_V1_TEMPLATES.md` must explain:

- existing templates remain available;
- how to create a manifest for an existing three-repository workspace;
- how dry-run classifies existing `AGENTS.md`;
- why user-owned files are reported instead of overwritten;
- how to resolve conflicts manually and rerun validate.

- [ ] **Step 4: Add final acceptance tests**

Extend `tests/cli.test.mjs` with two end-to-end tests:

1. Copy the monorepo fixture, apply twice, assert the second report has zero `created` and `updated`, then validate successfully.
2. Copy the multi-repo fixture where each component contains its own `.git` directory and the workspace root does not, apply and validate successfully, and assert no command attempted to initialize or modify Git metadata.

- [ ] **Step 5: Run fresh full verification**

Run: `npm ci`

Expected: exit 0 using the committed lockfile.

Run: `npm test`

Expected: all tests pass with zero failures.

Run:

```powershell
node tooling/cli.mjs apply --workspace tests/fixtures/multi-repo --dry-run --json
```

Expected: exit 0, valid JSON, at least one planned creation, and no fixture modifications.

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

Run: `git status --short`

Expected: only the intentional Task 8 documentation and test changes are present before commit.

- [ ] **Step 6: Commit**

```powershell
git add README.md docs/MANIFEST_REFERENCE.md docs/MIGRATION_FROM_V1_TEMPLATES.md tests/package.test.mjs tests/cli.test.mjs
git commit -m "docs: document governance overlay workflows"
```

---

## Phase-One Completion Gate

Before claiming the MVP complete, run all commands from a clean checkout or detached verification worktree:

```powershell
npm ci
npm test
node tooling/cli.mjs --help
node tooling/cli.mjs apply --workspace tests/fixtures/monorepo --dry-run --json
node tooling/cli.mjs apply --workspace tests/fixtures/multi-repo --dry-run --json
git diff --check
git status --short
```

Completion requires:

- zero test failures;
- both dry-run commands emit valid JSON and make no fixture changes;
- no unresolved `{{VARIABLE}}` exists in generated test workspaces;
- existing user files remain byte-identical after conflict scenarios;
- a second unchanged apply produces zero creations and updates;
- status registry generation and drift checks pass;
- no unexpected Git working-tree changes remain.

Phase two (additional Profiles and shared status-script packaging) and phase three (`init` plus upstream scaffold integration) require separate implementation plans after this gate passes.
