import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import {
  executeInitialization,
  initializeGovernance,
  planInitialization
} from "../tooling/lib/init.mjs";
import { executeApplyPreview } from "../tooling/lib/apply-preview.mjs";
import { GovernanceError } from "../tooling/lib/errors.mjs";
import { writeUtf8Atomic } from "../tooling/lib/files.mjs";
import { renderInitManifest } from "../tooling/lib/init-manifest.mjs";
import {
  formatInitHuman,
  sanitizeTerminalText
} from "../tooling/lib/init-presenter.mjs";
import {
  collectInitAnswers,
  createPromptSession
} from "../tooling/lib/init-prompts.mjs";
import { readProjectManifest } from "../tooling/lib/manifest.mjs";
import { validateWorkspace } from "../tooling/lib/validate.mjs";
import { createProjectWorkspace } from "./helpers/project-workspace.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentRelativeDir = "demo-server";

function manifestFor(workspaceDir, {
  name = path.basename(workspaceDir),
  componentPath = componentRelativeDir
} = {}) {
  return {
    schemaVersion: 1,
    project: {
      name,
      repositoryMode: "monorepo"
    },
    components: {
      server: {
        profile: "java-springboot-mybatis",
        path: componentPath
      }
    },
    contracts: {
      statusRegistryOwner: "server",
      apiContractOwner: "server"
    },
    generation: {
      conflictPolicy: "report"
    }
  };
}

async function createSupportedWorkspace(t, {
  manifest,
  manifestSource,
  extraFiles = {}
} = {}) {
  const files = {
    [`${componentRelativeDir}/pom.xml`]: [
      "<project><dependencies>",
      "<dependency><artifactId>spring-boot</artifactId></dependency>",
      "<dependency><artifactId>mybatis</artifactId></dependency>",
      "<dependency><artifactId>flyway</artifactId></dependency>",
      "</dependencies></project>"
    ].join(""),
    ...extraFiles
  };
  const workspaceDir = await createProjectWorkspace(t, {
    directories: [".git"],
    files
  });
  if (manifestSource !== undefined) {
    await writeFile(
      path.join(workspaceDir, "governance-kit.yaml"),
      manifestSource,
      "utf8"
    );
  } else if (manifest !== undefined) {
    await writeFile(
      path.join(workspaceDir, "governance-kit.yaml"),
      renderInitManifest(manifest === true ? manifestFor(workspaceDir) : manifest),
      "utf8"
    );
  }
  return workspaceDir;
}

async function snapshotWorkspace(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const result = {};
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotWorkspace(rootDir, relativePath));
    } else if (entry.isFile()) {
      result[relativePath.replaceAll("\\", "/")] = await readFile(
        path.join(rootDir, relativePath),
        "utf8"
      );
    }
  }
  return result;
}

function firstWritablePreviewItem(plan) {
  return plan.applyPreview.operations.find(({ classification }) => (
    classification.category === "created"
    || classification.category === "updated"
  ));
}

function fileSystemError(code, errorPath) {
  return Object.assign(
    new Error(`注入文件系统错误：${code}`),
    { code, ...(errorPath ? { path: errorPath } : {}) }
  );
}

async function createKitCopy(t) {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "governance-kit-copy-"));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["blueprints", "core", "profiles", "templates"]) {
    await cp(
      path.join(kitRoot, directory),
      path.join(copyRoot, directory),
      { recursive: true }
    );
  }
  return copyRoot;
}

test("plans an absent manifest without writing it", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.equal(plan.manifestChange.category, "created");
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("uses an existing valid manifest without re-detecting", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  let detectCalls = 0;

  const plan = await planInitialization({
    workspaceDir,
    kitRoot,
    detect: async () => {
      detectCalls += 1;
      throw new Error("不应重新识别");
    }
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.manifestChange.category, "unchanged");
  assert.equal(plan.source, "existing-manifest");
  assert.equal(detectCalls, 0);
});

test("validates an existing invalid manifest before reconfigure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    manifestSource: "schemaVersion: 1\ncomponents: ["
  });
  const before = await snapshotWorkspace(workspaceDir);
  let detectCalls = 0;

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure: true,
    detect: async () => {
      detectCalls += 1;
      throw new Error("不应在无效 Manifest 后识别");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INVALID_MANIFEST");
  assert.equal(result.written.length, 0);
  assert.equal(detectCalls, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
  assert.equal("stack" in result.failed, false);
});

test("rejects a schema-incompatible manifest before reconfigure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    manifestSource: "schemaVersion: 99\nproject: {}\ncomponents: {}\n"
  });

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure: true
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INVALID_MANIFEST");
  assert.equal(result.written.length, 0);
});

test("classifies equal and changed reconfigure candidates separately", async (t) => {
  const sameWorkspace = await createSupportedWorkspace(t);
  await writeFile(
    path.join(sameWorkspace, "governance-kit.yaml"),
    renderInitManifest(manifestFor(sameWorkspace)),
    "utf8"
  );
  const changedWorkspace = await createSupportedWorkspace(t, {
    manifest: manifestFor("ignored", { name: "legacy-name" })
  });

  const same = await planInitialization({
    workspaceDir: sameWorkspace,
    kitRoot,
    reconfigure: true
  });
  const changed = await planInitialization({
    workspaceDir: changedWorkspace,
    kitRoot,
    reconfigure: true
  });

  assert.equal(same.status, "ready");
  assert.equal(same.manifestChange.category, "unchanged");
  assert.equal("diff" in same.manifestChange, false);
  assert.equal(changed.status, "ready");
  assert.equal(changed.manifestChange.category, "updated");
  assert.match(changed.manifestChange.diff, /^[-+]/m);
});

test("keeps unconfirmed existing-manifest evidence questions blocking", async (t) => {
  const workspaceDir = await createProjectWorkspace(t, {
    directories: [".git"],
    files: {
      "server/pom.xml": "<project>spring-boot mybatis</project>"
    }
  });
  const manifest = {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "monorepo" },
    components: {
      server: { profile: "java-springboot-mybatis", path: "server" }
    },
    contracts: {
      statusRegistryOwner: "server",
      apiContractOwner: "server"
    },
    generation: { conflictPolicy: "report" }
  };
  await writeFile(
    path.join(workspaceDir, "governance-kit.yaml"),
    stringify(manifest),
    "utf8"
  );

  const blocked = await planInitialization({
    workspaceDir,
    kitRoot,
    answers: { yes: true }
  });
  const confirmed = await planInitialization({
    workspaceDir,
    kitRoot,
    answers: {
      questions: {
        "PROFILE_EVIDENCE_MISMATCH:server": { confirmed: true }
      }
    }
  });

  assert.equal(blocked.status, "needs_input");
  assert.equal(blocked.code, "PROFILE_EVIDENCE_MISMATCH");
  assert.equal(confirmed.status, "ready");
});

test("maps empty workspaces to unsupported without producing a plan", async (t) => {
  const workspaceDir = await createProjectWorkspace(t);

  const result = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(result.status, "unsupported");
  assert.equal(result.code, "NO_PROJECT_FOUND");
  assert.equal(result.plan, null);
  assert.equal(result.report, null);
});

test("does not write anything when a governance target conflicts", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    extraFiles: {
      [`${componentRelativeDir}/AGENTS.md`]: "# 用户规则\n"
    }
  });
  const before = await snapshotWorkspace(workspaceDir);

  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.written.length, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("dry-run reports a static governance conflict instead of planned", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    extraFiles: {
      [`${componentRelativeDir}/AGENTS.md`]: "# 用户规则\n"
    }
  });
  const before = await snapshotWorkspace(workspaceDir);

  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    dryRun: true
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INIT_CONFLICT");
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("confirmation request reports a static governance conflict instead of needs_input", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    extraFiles: {
      [`${componentRelativeDir}/AGENTS.md`]: "# 用户规则\n"
    }
  });
  const before = await snapshotWorkspace(workspaceDir);

  const result = await initializeGovernance({
    workspaceDir,
    kitRoot
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INIT_CONFLICT");
  assert.deepEqual(result.written, []);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("normalizes expected planning filesystem errors without swallowing programming errors", async (t) => {
  for (const [hook, code] of [
    ["scan", "EACCES"],
    ["createPreview", "EPERM"],
    ["scan", "ENOENT"]
  ]) {
    const workspaceDir = await createSupportedWorkspace(t);
    const before = await snapshotWorkspace(workspaceDir);
    const result = await planInitialization({
      workspaceDir,
      kitRoot,
      [hook]: async () => {
        throw fileSystemError(
          code,
          path.join(workspaceDir, `injected-${code.toLowerCase()}`)
        );
      }
    });

    assert.equal(result.status, "conflict");
    assert.equal(result.code, code);
    assert.deepEqual(result.written, []);
    assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
  }

  const workspaceDir = await createSupportedWorkspace(t);
  await assert.rejects(
    planInitialization({
      workspaceDir,
      kitRoot,
      detect: async () => {
        throw new TypeError("注入编程错误");
      }
    }),
    (error) => error instanceof TypeError
  );
  await assert.rejects(
    planInitialization({
      workspaceDir,
      kitRoot,
      preflightTargets: async () => {
        throw new TypeError("注入预检编程错误");
      }
    }),
    (error) => error instanceof TypeError
  );
});

test("does not turn missing kit installation resources into workspace conflicts", async (t) => {
  const absentWorkspace = await createSupportedWorkspace(t);
  const existingWorkspace = await createSupportedWorkspace(t, {
    manifest: true
  });
  const missingKitRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "missing-governance-kit-parent-")),
    "not-installed"
  );
  t.after(() => rm(path.dirname(missingKitRoot), {
    recursive: true,
    force: true
  }));

  for (const workspaceDir of [absentWorkspace, existingWorkspace]) {
    await assert.rejects(
      planInitialization({
        workspaceDir,
        kitRoot: missingKitRoot
      }),
      (error) => (
        error.code === "ENOENT"
        && path.resolve(error.path).startsWith(path.resolve(missingKitRoot))
      )
    );
  }
});

test("does not turn missing packaged profiles, blueprints, or templates into conflicts", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  for (const relativeDirectory of [
    "profiles",
    "blueprints",
    path.join("templates", "shared")
  ]) {
    const copiedKitRoot = await createKitCopy(t);
    const missingDirectory = path.join(
      copiedKitRoot,
      relativeDirectory
    );
    await rm(missingDirectory, { recursive: true });

    await assert.rejects(
      planInitialization({
        workspaceDir,
        kitRoot: copiedKitRoot
      }),
      (error) => (
        error.code === "ENOENT"
        && path.resolve(error.path) === path.resolve(missingDirectory)
      )
    );
  }
});

test("does not turn packaged resource EACCES into a workspace conflict", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const copiedKitRoot = await createKitCopy(t);
  const protectedResource = path.join(
    copiedKitRoot,
    "profiles",
    "java-springboot-mybatis",
    "profile.yaml"
  );
  const injected = fileSystemError("EACCES", protectedResource);

  await assert.rejects(
    planInitialization({
      workspaceDir,
      kitRoot: copiedKitRoot,
      createContext: async () => {
        throw injected;
      }
    }),
    (error) => error === injected
  );
});

test("rethrows malformed and invalid packaged catalog entries for an existing manifest", async (t) => {
  const cases = [
    {
      name: "malformed profile YAML",
      corrupt: async (copiedKitRoot) => {
        await writeFile(
          path.join(
            copiedKitRoot,
            "profiles",
            "java-springboot-mybatis",
            "profile.yaml"
          ),
          "id: [",
          "utf8"
        );
      },
      matches: (error) => /^YAML/i.test(error?.name ?? "")
    },
    {
      name: "malformed blueprint YAML",
      corrupt: async (copiedKitRoot) => {
        await writeFile(
          path.join(copiedKitRoot, "blueprints", "java-react-wechat.yaml"),
          "id: [",
          "utf8"
        );
      },
      matches: (error) => /^YAML/i.test(error?.name ?? "")
    },
    {
      name: "schema-invalid profile",
      corrupt: async (copiedKitRoot) => {
        await writeFile(
          path.join(
            copiedKitRoot,
            "profiles",
            "java-springboot-mybatis",
            "profile.yaml"
          ),
          "id: INVALID\n",
          "utf8"
        );
      },
      matches: (error) => error?.code === "SCHEMA_INVALID"
    },
    {
      name: "duplicate profile ID",
      corrupt: async (copiedKitRoot) => {
        await cp(
          path.join(
            copiedKitRoot,
            "profiles",
            "java-springboot-mybatis"
          ),
          path.join(copiedKitRoot, "profiles", "duplicate-profile"),
          { recursive: true }
        );
      },
      matches: (error) => error?.code === "DUPLICATE_CATALOG_ID"
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const workspaceDir = await createSupportedWorkspace(t, {
        manifest: true
      });
      const copiedKitRoot = await createKitCopy(t);
      const before = await snapshotWorkspace(workspaceDir);
      await entry.corrupt(copiedKitRoot);

      await assert.rejects(
        planInitialization({
          workspaceDir,
          kitRoot: copiedKitRoot
        }),
        entry.matches
      );
      assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
    });
  }
});

test("permission preflight checks every writable target once and leaves the workspace unchanged", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspaceDir);
  const calls = [];

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    preflightTargets: async (targets) => {
      calls.push(targets);
      throw new GovernanceError("TARGET_NOT_WRITABLE", "无写入权限");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_NOT_WRITABLE");
  assert.equal(result.written.length, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(path.join(workspaceDir, "governance-kit.yaml")));
  assert.ok(calls[0].includes(path.join(workspaceDir, componentRelativeDir, "AGENTS.md")));
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("reports stale atomic temporary files in plan warnings without deleting them", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const stalePath = path.join(
    workspaceDir,
    componentRelativeDir,
    ".AGENTS.md.123.123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  await writeFile(stalePath, "保留", "utf8");

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.ok(plan.report.warnings.some((warning) => (
    warning.code === "STALE_TEMP_FILE"
    && warning.path === stalePath
    && warning.targetPath === path.join(workspaceDir, componentRelativeDir, "AGENTS.md")
  )));
  assert.equal(await readFile(stalePath, "utf8"), "保留");
});

test("still reports stale temporary files when every managed target is unchanged", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const first = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  assert.equal(first.status, "applied");
  const stalePath = path.join(
    workspaceDir,
    componentRelativeDir,
    ".AGENTS.md.123.123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  await writeFile(stalePath, "保留", "utf8");

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.equal(plan.writableTargets.length, 0);
  assert.ok(plan.report.warnings.some((warning) => (
    warning.code === "STALE_TEMP_FILE"
    && warning.path === stalePath
  )));
  assert.equal(await readFile(stalePath, "utf8"), "保留");
});

test("separates internal ready plans from public planned dry-runs", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const plan = await planInitialization({ workspaceDir, kitRoot });
  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    dryRun: true
  });

  assert.equal(plan.status, "ready");
  assert.equal(result.status, "planned");
  assert.equal(result.ok, true);
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("returns a structured prewrite conflict when a target changes after planning", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const changedTarget = firstWritablePreviewItem(plan).operation.targetPath;
  await mkdir(path.dirname(changedTarget), { recursive: true });
  await writeFile(changedTarget, "用户并发修改", "utf8");

  const result = await executeInitialization(plan);

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_CHANGED_AFTER_PREVIEW");
  assert.deepEqual(result.written, []);
  assert.equal(await readFile(changedTarget, "utf8"), "用户并发修改");
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("uses partial_failure only after a file was written", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    executePreview: async () => {
      throw new GovernanceError("INJECTED_FAILURE", "预览执行失败");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INJECTED_FAILURE");
  assert.deepEqual(result.written, []);
});

test("returns evidence-backed safe rerun recovery after a partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);

  const result = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.applied, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.written, [
    path.join(workspaceDir, "governance-kit.yaml"),
    item.operation.targetPath
  ]);
  assert.equal(result.recovery.safeToRerun, true);
  assert.equal(
    result.recovery.nextCommand,
    "npx dev-governance-kit init --verbose"
  );
});

test("detects a committed manifest when its writer throws after commit", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    writeFile: async (targetPath, content, options) => {
      await writeUtf8Atomic(targetPath, content, options);
      throw new GovernanceError(
        "INJECTED_POST_COMMIT_FAILURE",
        "提交后注入失败"
      );
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.code, "INJECTED_POST_COMMIT_FAILURE");
  assert.deepEqual(result.written, [
    path.join(workspaceDir, "governance-kit.yaml")
  ]);
  assert.equal(result.recovery.safeToRerun, true);
});

test("marks recovery unsafe when written bytes no longer match the plan", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);

  const result = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      await writeFile(item.operation.targetPath, "用户修改", "utf8");
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.recovery.safeToRerun, false);
});

test("never overwrites a user edit made after a partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);
  const first = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });
  await writeFile(item.operation.targetPath, "user edit", "utf8");
  const before = await snapshotWorkspace(workspaceDir);

  const rerun = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(first.status, "partial_failure");
  assert.equal(rerun.status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("never overwrites an edited managed body after a partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);
  const first = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });
  const managed = await readFile(item.operation.targetPath, "utf8");
  assert.match(managed, /governance-kit:managed/);
  assert.match(managed, /source-id:/);
  assert.match(managed, /source-version:/);
  await writeFile(
    item.operation.targetPath,
    `${managed.replace(/\n$/, "")}\n\n用户保留头部后的正文编辑\n`,
    "utf8"
  );
  const before = await snapshotWorkspace(workspaceDir);

  const rerun = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(first.status, "partial_failure");
  assert.equal(rerun.status, "conflict");
  assert.ok(rerun.report.conflicts.some((entry) => (
    entry.path === item.operation.targetPath
    && entry.code === "USER_FILE_CONFLICT"
  )));
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("content evidence still permits a normal managed template upgrade", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const copiedKitRoot = await createKitCopy(t);
  const first = await initializeGovernance({
    workspaceDir,
    kitRoot: copiedKitRoot,
    yes: true
  });
  assert.equal(first.status, "applied");
  const targetPath = path.join(
    workspaceDir,
    componentRelativeDir,
    "docs",
    "API_RULES.md"
  );
  assert.match(
    await readFile(targetPath, "utf8"),
    /content-hash:\s*[0-9a-f]{64}/
  );
  const templatePath = path.join(
    copiedKitRoot,
    "templates",
    "server",
    "docs",
    "API_RULES.md"
  );
  await writeFile(
    templatePath,
    `${await readFile(templatePath, "utf8")}\n升级后的受管规则。\n`,
    "utf8"
  );

  const plan = await planInitialization({
    workspaceDir,
    kitRoot: copiedKitRoot
  });
  const result = await initializeGovernance({
    workspaceDir,
    kitRoot: copiedKitRoot,
    yes: true
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.report.conflicts.length, 0);
  assert.ok(plan.report.updated.some((entry) => entry.path === targetPath));
  assert.equal(result.status, "applied");
  assert.match(await readFile(targetPath, "utf8"), /升级后的受管规则/);
});

test("reports validation failure as applied true and valid false", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    validate: async () => ({
      valid: false,
      checks: [],
      warnings: [],
      errors: [{ code: "INJECTED" }]
    })
  });

  assert.equal(result.status, "failed_validation");
  assert.equal(result.applied, true);
  assert.equal(result.valid, false);
  assert.ok(result.written.length > 0);
});

test("a second initialization is unchanged and valid", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const first = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  const second = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(first.status, "applied");
  assert.equal(second.status, "applied");
  assert.equal(second.valid, true);
  assert.equal(second.report.created.length, 0);
  assert.equal(second.report.updated.length, 0);
});

test("returns interrupted when planning is aborted between scan and detection", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const controller = new AbortController();
  const before = await snapshotWorkspace(workspaceDir);

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    signal: controller.signal,
    detect: async (options) => {
      controller.abort();
      return options.scan;
    }
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.equal(result.written.length, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("returns interrupted when existing-manifest loading aborts after its snapshot", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const controller = new AbortController();
  const before = await snapshotWorkspace(workspaceDir);

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    signal: controller.signal,
    readManifest: async (...args) => {
      controller.abort();
      return readProjectManifest(...args);
    }
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("validation honors AbortSignal with a stable INTERRUPTED error", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    validateWorkspace({
      workspaceDir,
      kitRoot,
      signal: controller.signal
    }),
    (error) => error.code === "INTERRUPTED"
  );
});

test("validation interruption after writes reports exact recovery state", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const controller = new AbortController();
  let receivedSignal;

  const result = await executeInitialization(plan, {
    signal: controller.signal,
    validate: async ({ signal }) => {
      receivedSignal = signal;
      controller.abort();
      throw new GovernanceError("INTERRUPTED", "验证中断");
    }
  });

  assert.equal(receivedSignal, controller.signal);
  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.equal(result.applied, true);
  assert.ok(result.written.length > 1);
  assert.equal(result.recovery.safeToRerun, true);
});

test("validation workspace EACCES after writes returns exact partial failure recovery", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const validationPath = path.join(workspaceDir, "validation-target");

  const result = await executeInitialization(plan, {
    validate: async () => {
      throw fileSystemError("EACCES", validationPath);
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.code, "EACCES");
  assert.equal(result.applied, true);
  assert.deepEqual(
    [...result.written].sort(),
    [...plan.writableTargets].sort()
  );
  assert.equal(result.recovery.safeToRerun, true);
});

test("validation business GovernanceError after writes returns partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    validate: async () => {
      throw new GovernanceError(
        "WORKSPACE_VALIDATION_FAILED",
        "工作区验证失败"
      );
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.code, "WORKSPACE_VALIDATION_FAILED");
  assert.deepEqual(
    [...result.written].sort(),
    [...plan.writableTargets].sort()
  );
  assert.equal(result.recovery.safeToRerun, true);
});

test("concurrent invalid Manifest YAML during validation returns unsafe partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    validate: async (options) => {
      await writeFile(
        path.join(workspaceDir, "governance-kit.yaml"),
        "schemaVersion: [",
        "utf8"
      );
      return validateWorkspace(options);
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.code, "BAD_INDENT");
  assert.deepEqual(
    [...result.written].sort(),
    [...plan.writableTargets].sort()
  );
  assert.equal(result.recovery.safeToRerun, false);
});

test("validation workspace failure without actual writes remains a conflict", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const first = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  assert.equal(first.status, "applied");
  const plan = await planInitialization({ workspaceDir, kitRoot });
  assert.deepEqual(plan.writableTargets, []);
  const before = await snapshotWorkspace(workspaceDir);

  const result = await executeInitialization(plan, {
    validate: async () => {
      throw fileSystemError(
        "EPERM",
        path.join(workspaceDir, "validation-target")
      );
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "EPERM");
  assert.deepEqual(result.written, []);
  assert.equal("recovery" in result, false);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("execution preflight receives the same signal and interrupts before writing", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const controller = new AbortController();
  const before = await snapshotWorkspace(workspaceDir);

  const result = await executeInitialization(plan, {
    signal: controller.signal,
    preflightTargets: async (_targets, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      signal.throwIfAborted();
    }
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.deepEqual(result.written, []);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("execution rethrows programming errors instead of converting them to business results", async (t) => {
  const preflightWorkspace = await createSupportedWorkspace(t);
  const preflightPlan = await planInitialization({
    workspaceDir: preflightWorkspace,
    kitRoot
  });
  const before = await snapshotWorkspace(preflightWorkspace);
  await assert.rejects(
    executeInitialization(preflightPlan, {
      preflightTargets: async () => {
        throw new TypeError("注入执行预检编程错误");
      }
    }),
    (error) => error instanceof TypeError
  );
  assert.deepEqual(await snapshotWorkspace(preflightWorkspace), before);

  const validateWorkspaceDir = await createSupportedWorkspace(t);
  const validatePlan = await planInitialization({
    workspaceDir: validateWorkspaceDir,
    kitRoot
  });
  await assert.rejects(
    executeInitialization(validatePlan, {
      validate: async () => {
        throw new TypeError("注入验证编程错误");
      }
    }),
    (error) => error instanceof TypeError
  );
});

test("execution rethrows missing kit resources discovered during validation", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const copiedKitRoot = await createKitCopy(t);
  const plan = await planInitialization({
    workspaceDir,
    kitRoot: copiedKitRoot
  });
  const missingDirectory = path.join(copiedKitRoot, "templates", "shared");
  await rm(missingDirectory, { recursive: true });

  await assert.rejects(
    executeInitialization(plan),
    (error) => (
      error.code === "ENOENT"
      && path.resolve(error.path) === path.resolve(missingDirectory)
    )
  );
});

test("execution rethrows packaged catalog validation errors discovered after planning", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const copiedKitRoot = await createKitCopy(t);
  const plan = await planInitialization({
    workspaceDir,
    kitRoot: copiedKitRoot
  });
  await writeFile(
    path.join(
      copiedKitRoot,
      "profiles",
      "java-springboot-mybatis",
      "profile.yaml"
    ),
    "id: INVALID\n",
    "utf8"
  );

  await assert.rejects(
    executeInitialization(plan),
    (error) => error?.code === "SCHEMA_INVALID"
  );
});

test("executeInitialization uses the supplied preview and never replans through apply", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  let suppliedPreview;

  const result = await executeInitialization(plan, {
    executePreview: async (preview, options) => {
      suppliedPreview = preview;
      return executeApplyPreview(preview, options);
    }
  });

  assert.equal(suppliedPreview, plan.applyPreview);
  assert.equal(result.status, "applied");
});

function noviceResult(status, overrides = {}) {
  const workspace = path.resolve("C:/demo/新 项目");
  return {
    command: "init",
    workspace,
    status,
    ok: status === "planned" || status === "applied",
    applied: status === "applied",
    valid: status === "applied",
    written: [],
    detected: [{
      component: "server",
      profile: "java-springboot-mybatis",
      path: "apps/server",
      confidence: "high",
      evidence: ["pom.xml", "spring-boot", "mybatis"]
    }],
    gitStates: [{
      rootDir: workspace,
      available: true,
      dirty: true,
      warning: null
    }],
    report: {
      created: [{
        path: path.join(workspace, "apps/server/AGENTS.md"),
        code: "CREATE_FILE"
      }],
      updated: [],
      unchanged: [],
      conflicts: [],
      warnings: [],
      errors: []
    },
    ...overrides
  };
}

test("default init output explains the plan without internal terms or absolute paths", () => {
  const result = noviceResult("planned");
  const output = formatInitHuman(result, { verbose: false });

  assert.match(output, /找到后端服务/);
  assert.match(output, /处理业务、数据和接口/);
  assert.match(output, /准备添加/);
  assert.match(output, /apps[\\/]server[\\/]AGENTS\.md/);
  assert.match(output, /不会修改你的业务代码/);
  assert.match(output, /存在未提交修改.*不会提交、回滚或清理/s);
  assert.match(output, /下一步/);
  assert.doesNotMatch(output, /Profile|repositoryMode|contract owner|confidence/);
  assert.doesNotMatch(output, /java-springboot-mybatis|CREATE_FILE/);
  assert.doesNotMatch(output, /C:[\\/]/i);
});

test("verbose init output includes evidence warnings absolute paths and internal codes", () => {
  const result = noviceResult("planned");
  result.report.warnings.push({
    code: "STALE_TEMP_FILE",
    path: path.join(result.workspace, "apps/server/.AGENTS.md.1.uuid.tmp"),
    targetPath: path.join(result.workspace, "apps/server/AGENTS.md")
  });

  const output = formatInitHuman(result, { verbose: true });

  assert.match(output, /java-springboot-mybatis/);
  assert.match(output, /pom\.xml/);
  assert.match(output, /STALE_TEMP_FILE/);
  assert.match(output, /C:[\\/]/i);
});

test("novice stale temporary warning explains manual inspection without deleting it", () => {
  const result = noviceResult("planned");
  result.report.warnings.push({
    code: "STALE_TEMP_FILE",
    path: path.join(result.workspace, "apps/server/.AGENTS.md.1.uuid.tmp")
  });

  const output = formatInitHuman(result);

  assert.match(output, /上次运行可能留下了临时文件/);
  assert.match(output, /apps[\\/]server[\\/]\.AGENTS/);
  assert.match(output, /请确认内容后再自行处理/);
  assert.doesNotMatch(output, /已经删除|已自动删除|STALE_TEMP_FILE|C:[\\/]/i);
});

for (const [status, phrase] of [
  ["planned", "还没有修改任何文件"],
  ["conflict", "没有修改任何文件"],
  ["needs_input", "需要你确认"],
  ["cancelled", "已经取消"],
  ["applied", "项目治理配置已完成"],
  ["failed_validation", "文件已经写入"],
  ["partial_failure", "只完成了一部分"],
  ["interrupted", "操作已中断"]
]) {
  test(`novice output gives an actionable explanation for ${status}`, () => {
    const result = noviceResult(status, {
      code: "INTERNAL_CODE",
      applied: ["applied", "failed_validation", "partial_failure"].includes(status),
      written: status === "partial_failure"
        ? [path.join(path.resolve("C:/demo/新 项目"), "governance-kit.yaml")]
        : []
    });
    const output = formatInitHuman(result);
    assert.match(output, new RegExp(phrase));
    assert.match(output, /下一步/);
    assert.doesNotMatch(output, /INTERNAL_CODE|C:[\\/]/i);
  });
}

function scriptedPrompt(responses) {
  const calls = [];
  return {
    calls,
    signal: new AbortController().signal,
    async choose(question) {
      calls.push({ type: "choose", question });
      return responses.shift();
    },
    async confirm(message) {
      calls.push({ type: "confirm", message });
      return /^(?:y|yes)$/i.test(String(responses.shift() ?? "").trim());
    },
    close() {}
  };
}

test("empty low-risk confirmation defaults to cancelled", async () => {
  const promptSession = scriptedPrompt([""]);
  const answers = await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [{
        code: "PROFILE_ASSUMPTION_UNCONFIRMED",
        component: "server",
        missing: ["flyway"]
      }]
    },
    promptSession
  });

  assert.equal(answers.status, "cancelled");
  assert.deepEqual(answers.answers, {});
  assert.equal(promptSession.calls.length, 1);
});

test("groups low-risk confirmations into one novice review page", async () => {
  const promptSession = scriptedPrompt(["y"]);
  const answers = await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [
        {
          code: "PROFILE_ASSUMPTION_UNCONFIRMED",
          component: "server",
          missing: ["flyway"]
        },
        {
          code: "ADMIN_ROLE_UNCLEAR",
          component: "admin",
          path: "apps/admin"
        }
      ]
    },
    promptSession
  });

  assert.equal(answers.status, "answered");
  assert.equal(answers.pagesUsed, 1);
  assert.deepEqual(answers.answers, {
    questions: {
      "PROFILE_ASSUMPTION_UNCONFIRMED:server": { confirmed: true },
      "ADMIN_ROLE_UNCLEAR:admin": { confirmed: true }
    }
  });
  assert.equal(promptSession.calls.length, 1);
  assert.match(promptSession.calls[0].message, /没有检测到数据库升级工具/);
  assert.match(promptSession.calls[0].message, /管理员使用的后台/);
  assert.doesNotMatch(promptSession.calls[0].message, /Profile|confidence/);
});

test("collects a component choice with a plain-language impact explanation", async () => {
  const promptSession = scriptedPrompt(["2"]);
  const answers = await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [{
        code: "ADMIN_COMPONENT_UNCLEAR",
        component: "admin",
        candidates: [
          { path: "apps/website", profile: "react-admin" },
          { path: "apps/console", profile: "react-admin" }
        ]
      }]
    },
    promptSession
  });

  assert.equal(answers.status, "answered");
  assert.deepEqual(answers.answers, {
    components: { admin: { path: "apps/console" } }
  });
  assert.match(promptSession.calls[0].question.message, /管理员使用的后台/);
  assert.match(promptSession.calls[0].question.message, /只决定治理文件放在哪个目录/);
  assert.doesNotMatch(promptSession.calls[0].question.message, /Profile|repositoryMode/);
});

test("explains repository layout choices without requiring Git terminology knowledge", async () => {
  const promptSession = scriptedPrompt(["1"]);
  const answers = await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [{
        code: "REPOSITORY_MODE_UNCLEAR",
        reason: "HYBRID_GIT_BOUNDARIES"
      }]
    },
    promptSession
  });

  assert.equal(answers.status, "answered");
  assert.deepEqual(answers.answers, { repositoryMode: "monorepo" });
  assert.match(promptSession.calls[0].question.message, /代码.*怎样保存/);
  assert.match(
    promptSession.calls[0].question.options[0].impact,
    /同一个 Git 仓库管理/
  );
  assert.doesNotMatch(
    promptSession.calls[0].question.message,
    /repositoryMode|monorepo|multi-repo|HYBRID/
  );
});

test("does not guess when more than three prompt pages would be required", async () => {
  const promptSession = scriptedPrompt(["1", "1", "1", "1"]);
  const questions = ["server", "admin", "client", "server"].map((component, index) => ({
    code: `${component.toUpperCase()}_COMPONENT_UNCLEAR`,
    component,
    candidates: [
      { path: `apps/${component}-${index}-a`, profile: "test" },
      { path: `apps/${component}-${index}-b`, profile: "test" }
    ]
  }));

  const result = await collectInitAnswers({
    plan: { status: "needs_input", questions },
    promptSession
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.pagesUsed, 0);
  assert.deepEqual(result.answers, {});
  assert.equal(promptSession.calls.length, 0);
});

test("prompt session maps EOF to INPUT_EOF and always supports close", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const session = createPromptSession({ input, output });
  input.end();

  await assert.rejects(
    session.confirm(),
    (error) => error.code === "INPUT_EOF"
  );
  session.close();
  session.close();
});

test("prompt session maps external abort to INTERRUPTED", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const session = createPromptSession({
    input,
    output,
    signal: controller.signal
  });
  const pending = session.confirm();
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error.code === "INTERRUPTED"
  );
  session.close();
});

test("prompt session maps Ctrl+C to INTERRUPTED", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  const session = createPromptSession({ input, output });
  const pending = session.confirm();
  input.write("\u0003");

  await assert.rejects(
    pending,
    (error) => error.code === "INTERRUPTED"
  );
  session.close();
});

for (const [code, phrase] of [
  ["INVALID_MANIFEST", "配置文件内容有误"],
  ["INIT_CONFLICT", "保留你自己的内容"],
  ["TARGET_NOT_WRITABLE", "读写权限"],
  ["UNSAFE_REAL_PATH", "路径"],
  ["TARGET_CHANGED_AFTER_PREVIEW", "其他程序"]
]) {
  test(`novice conflict output gives reason-specific action for ${code}`, () => {
    const output = formatInitHuman(noviceResult("conflict", { code }));
    assert.match(output, new RegExp(phrase));
    assert.doesNotMatch(output, new RegExp(code));
    assert.match(output, /下一步/);
  });
}

for (const [code, phrase] of [
  ["INVALID_ANSWER", "有效序号"],
  ["PROMPT_PAGE_LIMIT", "需要确认的信息较多"],
  ["UNSUPPORTED_QUESTION", "当前版本还不能处理"],
  ["UNSAFE_OPTION_DISPLAY", "无法在终端中清楚地区分"]
]) {
  test(`novice needs-input output gives reason-specific action for ${code}`, () => {
    const output = formatInitHuman(noviceResult("needs_input", { code }));
    assert.match(output, new RegExp(phrase));
    assert.doesNotMatch(output, new RegExp(code));
    if (code !== "INVALID_ANSWER") {
      assert.doesNotMatch(output, /根据屏幕上的中文提示选择/);
    }
  });
}

test("terminal display boundary neutralizes path newlines ANSI and controls", () => {
  const result = noviceResult("planned");
  result.report.created = [{
    path: path.join(
      result.workspace,
      "apps",
      "server\n伪造下一步\u001b[31m\u0000.txt"
    ),
    code: "CREATE_FILE"
  }];

  const output = formatInitHuman(result);

  assert.doesNotMatch(output, /\n伪造下一步/);
  assert.doesNotMatch(output, /[\u001b\u0000]/);
  assert.match(output, /server\\n伪造下一步\\x1b\[31m\\x00/);
  assert.doesNotMatch(output, /C:[\\/]/i);
});

test("prompt display boundary neutralizes question option and confirmation controls", async () => {
  const choicePrompt = scriptedPrompt(["1"]);
  const chosen = await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [{
        code: "ADMIN_COMPONENT_UNCLEAR",
        component: "admin",
        candidates: [{
          path: "apps/admin\n伪造选项\u001b[31m\u0085",
          profile: "react-admin"
        }]
      }]
    },
    promptSession: choicePrompt
  });
  const renderedOption = choicePrompt.calls[0].question.options[0];

  assert.equal(chosen.status, "answered");
  assert.doesNotMatch(renderedOption.label, /[\r\n\u001b\u0085]/);
  assert.match(
    renderedOption.label,
    /apps\/admin\\n伪造选项\\x1b\[31m\\x85/
  );
  assert.equal(
    chosen.answers.components.admin.path,
    "apps/admin\n伪造选项\u001b[31m\u0085"
  );

  const confirmPrompt = scriptedPrompt(["y"]);
  await collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [{
        code: "ADMIN_ROLE_UNCLEAR",
        component: "admin",
        path: "apps/admin\r\n伪造确认\u001b[2J"
      }]
    },
    promptSession: confirmPrompt
  });
  assert.doesNotMatch(
    confirmPrompt.calls[0].message,
    /[\r\u001b]|\n伪造确认/
  );
});

test("real prompt renderer sanitizes dynamic message label and impact fields", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let displayed = "";
  output.on("data", (chunk) => {
    displayed += chunk;
  });
  const session = createPromptSession({ input, output });
  const pending = session.choose({
    message: "选择目录\n伪造标题\u001b[2J",
    options: [{
      label: "apps/admin\r\n伪造选项\u0000",
      impact: "只添加治理文件\u0085伪造影响"
    }]
  });
  input.write("1\n");
  const answer = await pending;
  session.close();

  assert.equal(answer, "1");
  assert.doesNotMatch(displayed, /[\r\u001b\u0000\u0085]/);
  assert.doesNotMatch(displayed, /\n伪造标题|\n伪造选项|\n伪造影响/);
  assert.match(displayed, /选择目录\\n伪造标题\\x1b\[2J/);
  assert.match(displayed, /apps\/admin\\r\\n伪造选项\\x00/);
  assert.match(displayed, /只添加治理文件\\x85伪造影响/);
});

test("terminal encoding preserves meaningful spaces and distinguishes escaped text", () => {
  assert.equal(sanitizeTerminalText("a b"), "a b");
  assert.equal(sanitizeTerminalText("a  b"), "a  b");
  assert.notEqual(
    sanitizeTerminalText("a b"),
    sanitizeTerminalText("a  b")
  );
  assert.equal(sanitizeTerminalText("line\nbreak"), "line\\nbreak");
  assert.equal(sanitizeTerminalText("line\\nbreak"), "line\\\\nbreak");
  assert.notEqual(
    sanitizeTerminalText("line\nbreak"),
    sanitizeTerminalText("line\\nbreak")
  );
  assert.equal(
    sanitizeTerminalText(" \r\u001b\u0000\u0085 "),
    " \\r\\x1b\\x00\\x85 "
  );
});

test("presenter keeps distinct spaced paths distinguishable on one line", () => {
  const result = noviceResult("planned");
  result.report.created = [
    { path: path.join(result.workspace, "apps/a b/AGENTS.md") },
    { path: path.join(result.workspace, "apps/a  b/AGENTS.md") },
    { path: path.join(result.workspace, "apps/line\nbreak/AGENTS.md") }
  ];

  const output = formatInitHuman(result);

  assert.match(output, /apps\/a b\/AGENTS\.md/);
  assert.match(output, /apps\/a  b\/AGENTS\.md/);
  assert.match(output, /apps\/line\\nbreak\/AGENTS\.md/);
  assert.doesNotMatch(output, /\n伪造|C:[\\/]/i);
});

for (const candidates of [
  [
    { path: "", profile: "react-admin" },
    { path: "apps/admin", profile: "react-admin" }
  ],
  [
    { path: "   ", profile: "react-admin" },
    { path: "apps/admin", profile: "react-admin" }
  ],
  [
    { path: "apps/admin", profile: "react-admin" },
    { path: "apps/admin", profile: "react-admin" }
  ]
]) {
  test("does not prompt when option labels cannot be displayed uniquely", async () => {
    const promptSession = scriptedPrompt(["1"]);
    const result = await collectInitAnswers({
      plan: {
        status: "needs_input",
        questions: [{
          code: "ADMIN_COMPONENT_UNCLEAR",
          component: "admin",
          candidates
        }]
      },
      promptSession
    });

    assert.equal(result.status, "needs_input");
    assert.equal(result.code, "UNSAFE_OPTION_DISPLAY");
    assert.deepEqual(result.answers, {});
    assert.equal(promptSession.calls.length, 0);
  });
}

test("confirmation page keeps trusted multi-line layout while sanitizing fields", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let displayed = "";
  output.on("data", (chunk) => {
    displayed += chunk;
  });
  const session = createPromptSession({ input, output });
  const pending = collectInitAnswers({
    plan: {
      status: "needs_input",
      questions: [
        {
          code: "PROFILE_ASSUMPTION_UNCONFIRMED",
          component: "server",
          missing: ["flyway"]
        },
        {
          code: "ADMIN_ROLE_UNCLEAR",
          component: "admin",
          path: "apps/admin\n伪造确认"
        }
      ]
    },
    promptSession: session
  });
  input.write("y\n");
  const result = await pending;
  session.close();

  assert.equal(result.status, "answered");
  assert.match(
    displayed,
    /请复核下面的识别结果：\n- .*数据库升级工具.*\n- apps\/admin\\n伪造确认.*\n确认无误后/
  );
  assert.doesNotMatch(displayed, /\n伪造确认/);
});

test("failed validation lists actual written relative paths", () => {
  const result = noviceResult("failed_validation", {
    written: [
      path.join(path.resolve("C:/demo/新 项目"), "governance-kit.yaml"),
      path.join(path.resolve("C:/demo/新 项目"), "apps/server/AGENTS.md")
    ]
  });

  const output = formatInitHuman(result);

  assert.match(output, /已经写入：/);
  assert.match(output, /governance-kit\.yaml/);
  assert.match(output, /apps\/server\/AGENTS\.md/);
  assert.doesNotMatch(output, /C:[\\/]/i);
});

for (const [safeToRerun, phrase] of [
  [true, "可以直接重新运行"],
  [false, "先检查已经写入的文件"]
]) {
  test(`interrupted after writes uses recovery evidence (${safeToRerun})`, () => {
    const result = noviceResult("interrupted", {
      written: [
        path.join(path.resolve("C:/demo/新 项目"), "governance-kit.yaml")
      ],
      recovery: { safeToRerun },
      code: "INTERRUPTED"
    });

    const output = formatInitHuman(result);

    assert.match(output, /已经写入：/);
    assert.match(output, /governance-kit\.yaml/);
    assert.match(output, new RegExp(phrase));
    assert.doesNotMatch(output, /INTERRUPTED|C:[\\/]/i);
  });
}
