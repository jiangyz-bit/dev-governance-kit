import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSmokeProject } from "../tooling/create-smoke-project.mjs";
import {
  parsePackageSmokeArgs,
  resolveNpmCli
} from "../tooling/package-smoke.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(args, cwd = kitRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("package smoke script verifies the packed CLI", async () => {
  const result = await runNode(["tooling/package-smoke.mjs"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.source, "candidate");
  assert.equal(output.packageVersion, "0.1.0");
  assert.equal(output.initStatus, "applied");
  assert.equal(output.validateStatus, "valid");
  assert.equal(output.secondInitCreated, 0);
  assert.equal(output.secondInitUpdated, 0);
  assert.ok(output.packageFiles > 0);
  assert.equal(output.candidateVerification.source, "candidate");
  assert.equal(output.registryVerification, undefined);
});

test("smoke fixture creates a real supported Git project in a Chinese spaced path", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "治理 烟测-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, "用户 项目");

  const result = await createSmokeProject(project);

  assert.equal(result.rootDir, path.resolve(project));
  assert.match(
    await readFile(path.join(project, "demo-server", "pom.xml"), "utf8"),
    /spring-boot[\s\S]*mybatis[\s\S]*flyway/
  );
  assert.equal(
    JSON.parse(await readFile(
      path.join(project, "demo-admin", "package.json"),
      "utf8"
    )).name,
    "demo-admin"
  );
  assert.equal(
    JSON.parse(await readFile(
      path.join(project, "demo-miniprogram", "project.config.json"),
      "utf8"
    )).appid,
    "touristappid"
  );
  assert.ok(await readFile(path.join(project, ".git", "HEAD"), "utf8"));
});

test("smoke fixture refuses a non-empty directory without changing it", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "governance-nonempty-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const marker = path.join(project, "keep.txt");
  await writeFile(marker, "user data", "utf8");

  await assert.rejects(
    createSmokeProject(project),
    /目录必须为空/
  );
  assert.equal(await readFile(marker, "utf8"), "user data");
});

test("package smoke arguments require an absolute reused tarball", () => {
  assert.throws(
    () => parsePackageSmokeArgs(["--tarball", "candidate.tgz"]),
    /绝对路径/
  );
  assert.throws(
    () => parsePackageSmokeArgs(["--source", "registry"]),
    /registry.*--tarball/
  );
  assert.deepEqual(
    parsePackageSmokeArgs([
      "--tarball",
      path.resolve("candidate.tgz"),
      "--source",
      "registry"
    ]),
    {
      tarball: path.resolve("candidate.tgz"),
      source: "registry"
    }
  );
});

test("verbose JSON exposes package runtime evidence only when requested", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "governance-runtime-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, "用户 项目");
  await createSmokeProject(project);

  const verbose = await runNode([
    "tooling/cli.mjs",
    "init",
    "--workspace",
    project,
    "--yes",
    "--json",
    "--verbose"
  ]);
  assert.equal(verbose.code, 0, verbose.stderr);
  const verboseResult = JSON.parse(verbose.stdout);
  assert.equal(verboseResult.version, "0.1.0");
  assert.equal(path.resolve(verboseResult.runtime.packageRoot), kitRoot);

  const normal = await runNode([
    "tooling/cli.mjs",
    "init",
    "--workspace",
    project,
    "--yes",
    "--json"
  ]);
  assert.equal(normal.code, 0, normal.stderr);
  const normalResult = JSON.parse(normal.stdout);
  assert.equal(normalResult.version, undefined);
  assert.equal(normalResult.runtime, undefined);
});

test("an absolute registry tarball is reused with separate verification output", async (t) => {
  const packDir = await mkdtemp(path.join(tmpdir(), "governance-reuse-pack-"));
  t.after(() => rm(packDir, { recursive: true, force: true }));
  const npmCli = await resolveNpmCli();
  const packed = await runNode([
    npmCli,
    "pack",
    "--silent",
    "--pack-destination",
    packDir
  ]);
  assert.equal(packed.code, 0, packed.stderr);
  const filename = (await readdir(packDir)).find((entry) => (
    entry.endsWith(".tgz")
  ));
  assert.ok(filename, "npm pack 应生成 tgz");
  const tarball = path.resolve(packDir, filename);

  const result = await runNode([
    "tooling/package-smoke.mjs",
    "--tarball",
    tarball,
    "--source",
    "registry"
  ]);

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.source, "registry");
  assert.equal(output.registryVerification.source, "registry");
  assert.equal(output.registryVerification.packageVersion, "0.1.0");
  assert.ok(output.registryVerification.files.includes("tooling/cli.mjs"));
  assert.equal(output.candidateVerification, undefined);
});
