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
