import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizePublishedVersions,
  queryPublishedVersions,
  verifyRelease
} from "../tooling/verify-release.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validPackage(overrides = {}) {
  return {
    name: "dev-governance-kit",
    version: "0.1.0",
    author: "coogle",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/jiangyz-bit/dev-governance-kit.git"
    },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/"
    },
    engines: { node: ">=20.3.0" },
    bin: {
      "dev-governance-kit": "./tooling/cli.mjs",
      "governance-kit": "./tooling/cli.mjs"
    },
    ...overrides
  };
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "tooling/verify-release.mjs",
      ...args
    ], {
      cwd: kitRoot,
      env: { ...process.env, ...env },
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

test("verifyRelease accepts an unpublished exact stable tag", () => {
  assert.deepEqual(verifyRelease({
    tag: "v0.1.0",
    packageJson: validPackage(),
    publishedVersions: []
  }), {
    ok: true,
    package: "dev-governance-kit",
    version: "0.1.0",
    tag: "v0.1.0"
  });
});

test("verifyRelease rejects mismatched, non-canonical and published tags", () => {
  for (const tag of [
    "v0.2.0",
    "0.1.0",
    "v01.1.0",
    "v0.1.0 ",
    " v0.1.0",
    "v0.1.0-beta.1",
    "v0.1.0\nignored"
  ]) {
    assert.throws(() => verifyRelease({
      tag,
      packageJson: validPackage(),
      publishedVersions: []
    }), /tag|Tag|SemVer|一致/, tag);
  }
  assert.throws(() => verifyRelease({
    tag: "v0.1.0",
    packageJson: validPackage(),
    publishedVersions: ["0.1.0"]
  }), /版本已存在/);
});

test("verifyRelease requires strict input types and published version data", () => {
  for (const input of [
    null,
    [],
    "0.1.0",
    { tag: "v0.1.0", packageJson: validPackage(), publishedVersions: null },
    { tag: "v0.1.0", packageJson: validPackage(), publishedVersions: "0.2.0" },
    { tag: "v0.1.0", packageJson: validPackage(), publishedVersions: [0] },
    { tag: "v0.1.0", packageJson: validPackage(), publishedVersions: [""] },
    { tag: "v0.1.0", packageJson: validPackage(), publishedVersions: [" garbage "] },
    {
      tag: "v0.1.0",
      packageJson: validPackage(),
      publishedVersions: [],
      unexpected: true
    }
  ]) {
    assert.throws(
      () => verifyRelease(input),
      /对象|schema|packageJson|publishedVersions|版本/
    );
  }
});

test("verifyRelease enforces all public package metadata", () => {
  const invalidPackages = [
    [{ name: "other" }, /name/],
    [{ private: false }, /private/],
    [{ author: "someone" }, /author/],
    [{ license: "Apache-2.0" }, /license/],
    [{ repository: { type: "git", url: "https://example.test/repo.git" } }, /repository/],
    [{ repository: { type: "svn", url: "https://github.com/jiangyz-bit/dev-governance-kit.git" } }, /repository/],
    [{ publishConfig: { access: "restricted", registry: "https://registry.npmjs.org/" } }, /publishConfig/],
    [{ publishConfig: { access: "public", registry: "https://mirror.invalid/" } }, /publishConfig/],
    [{ engines: { node: ">=18" } }, /engines/],
    [{ bin: { "dev-governance-kit": "./tooling/cli.mjs" } }, /bin/],
    [{ bin: {
      "dev-governance-kit": "./other.mjs",
      "governance-kit": "./tooling/cli.mjs"
    } }, /bin/],
    [{ version: "v0.1.0" }, /version/],
    [{ version: "0.1.0 " }, /version/]
  ];
  for (const [patch, expected] of invalidPackages) {
    assert.throws(() => verifyRelease({
      tag: "v0.1.0",
      packageJson: validPackage(patch),
      publishedVersions: []
    }), expected, JSON.stringify(patch));
  }
});

test("normalizePublishedVersions accepts npm string, array and empty responses", () => {
  assert.deepEqual(normalizePublishedVersions("0.1.0"), ["0.1.0"]);
  assert.deepEqual(
    normalizePublishedVersions(["0.1.0", "0.2.0-beta.1"]),
    ["0.1.0", "0.2.0-beta.1"]
  );
  assert.deepEqual(normalizePublishedVersions([]), []);
  for (const malformed of [
    null,
    {},
    [""],
    [1],
    ["0.1"],
    ["0.1.0-01"],
    [" 0.1.0"],
    ["0.1.0", "0.1.0"]
  ]) {
    assert.throws(() => normalizePublishedVersions(malformed), /registry|版本|JSON/);
  }
});

test("queryPublishedVersions distinguishes official package E404 from failures", async () => {
  const calls = [];
  const makeRunner = (result) => async (file, args, options) => {
    calls.push({ file, args, options });
    return result;
  };
  const npmCliPath = path.join("C:", "npm", "npm-cli.js");

  assert.deepEqual(await queryPublishedVersions({
    npmCliPath,
    runCommand: makeRunner({
      code: 0,
      stdout: '"0.1.0"\n',
      stderr: ""
    })
  }), ["0.1.0"]);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    npmCliPath,
    "view",
    "dev-governance-kit",
    "versions",
    "--json",
    "--registry=https://registry.npmjs.org/"
  ]);
  assert.equal(calls[0].options.shell, false);

  assert.deepEqual(await queryPublishedVersions({
    npmCliPath,
    runCommand: makeRunner({
      code: 1,
      stdout: "",
      stderr: "npm error code E404\n404 Not Found - GET https://registry.npmjs.org/dev-governance-kit - Not found"
    })
  }), []);

  for (const result of [
    { code: 1, stdout: "", stderr: "npm error code E403" },
    { code: 1, stdout: "", stderr: "npm error code E404\nhttps://registry.npmjs.org/dev-governance-kit\npermission denied" },
    { code: 1, stdout: "", stderr: "npm error code E404\n404 Not Found - GET https://evil.invalid/dev-governance-kit" },
    { code: 1, stdout: "", stderr: "network timeout" },
    { code: 0, stdout: "{malformed", stderr: "" }
  ]) {
    await assert.rejects(
      queryPublishedVersions({
        npmCliPath,
        runCommand: makeRunner(result)
      }),
      /npm registry|JSON|查询/
    );
  }
});

test("CLI strictly parses args and prints one stable JSON document", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "verify-release-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeNpm = path.join(directory, "npm-cli.js");
  await writeFile(fakeNpm, "process.stdout.write('[]\\n');\n", "utf8");

  const success = await runCli(["--tag", "v0.1.0"], {
    npm_execpath: fakeNpm
  });
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.stderr, "");
  assert.deepEqual(JSON.parse(success.stdout), {
    ok: true,
    package: "dev-governance-kit",
    version: "0.1.0",
    tag: "v0.1.0"
  });
  assert.equal(success.stdout.trim().split(/\r?\n/).length, 1);

  for (const args of [
    [],
    ["--tag"],
    ["--tag", "v0.1.0", "extra"],
    ["--unknown", "value"],
    ["--tag", "v0.1.0", "--tag", "v0.1.0"],
    ["--tag=v0.1.0"]
  ]) {
    const result = await runCli(args, { npm_execpath: fakeNpm });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^RELEASE_VERIFY_FAILED:/);
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  }
});

test("CLI failures redact paths and controls and stay bounded", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "private-secret-verify-release-")
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeNpm = path.join(directory, "npm-cli.js");
  await writeFile(fakeNpm, `
process.stderr.write(${JSON.stringify(
  `${directory}\nfile:///private/secret\u0001${"x".repeat(2000)}`
)});
process.exitCode = 1;
`, "utf8");
  const result = await runCli(["--tag", "v0.1.0"], {
    npm_execpath: fakeNpm
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^RELEASE_VERIFY_FAILED:/);
  assert.doesNotMatch(result.stderr, /private-secret-verify-release/i);
  assert.doesNotMatch(result.stderr.slice(0, -1), /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024);
});
