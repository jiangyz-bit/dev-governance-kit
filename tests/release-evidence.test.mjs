import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  createReleaseEvidence,
  verifyReleaseEvidence
} from "../tooling/release-evidence.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commit = "0123456789abcdef0123456789abcdef01234567";

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  assert.ok(encoded.length <= length, `tar 字段过长：${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}

function tarHeader(relativePath, content, { type = "0", linkname = "" } = {}) {
  const archivePath = `package/${relativePath}`;
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, archivePath);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  if (linkname) writeTarString(header, 157, 100, linkname);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    148,
    8,
    "ascii"
  );
  return header;
}

async function writeTarball(target, entries) {
  const chunks = [];
  for (const [relativePath, descriptorValue] of entries) {
    const descriptor = Buffer.isBuffer(descriptorValue)
      ? { content: descriptorValue, type: "0", linkname: "" }
      : descriptorValue;
    chunks.push(
      tarHeader(relativePath, descriptor.content, descriptor),
      descriptor.content
    );
    const padding = (512 - (descriptor.content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(target, gzipSync(Buffer.concat(chunks)));
}

async function fixture(t, {
  version = "0.1.1",
  entries,
  packFiles
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "release-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = `dev-governance-kit-${version}.tgz`;
  const tarball = path.join(directory, filename);
  const packageJson = Buffer.from(`${JSON.stringify({
    name: "dev-governance-kit",
    version
  })}\n`);
  const tarEntries = entries ?? [
    ["package.json", packageJson],
    ["tooling/cli.mjs", Buffer.from("#!/usr/bin/env node\n")]
  ];
  await writeTarball(tarball, tarEntries);
  const files = packFiles ?? tarEntries
    .filter(([, value]) => Buffer.isBuffer(value))
    .map(([file]) => ({ path: file }));
  const packJson = path.join(directory, "pack.json");
  await writeFile(packJson, `${JSON.stringify([{
    name: "dev-governance-kit",
    version,
    filename,
    files
  }])}\n`);
  return {
    directory,
    filename,
    tarball,
    packJson,
    output: path.join(directory, "release-evidence.json"),
    version
  };
}

async function create(t, options) {
  const current = await fixture(t, options);
  const evidence = await createReleaseEvidence({
    commit,
    packJson: current.packJson,
    directory: current.directory,
    output: current.output
  });
  return { ...current, evidence };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "tooling/release-evidence.mjs",
      ...args
    ], {
      cwd: kitRoot,
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

test("create binds a dynamic 0.1.1 tarball to sorted release evidence", async (t) => {
  const result = await create(t, {
    version: "0.1.1",
    entries: [
      ["tooling/cli.mjs", Buffer.from("export {};\n")],
      ["package.json", Buffer.from(
        '{"name":"dev-governance-kit","version":"0.1.1"}\n'
      )]
    ]
  });

  assert.deepEqual(result.evidence, {
    schemaVersion: 1,
    version: "0.1.1",
    commit,
    tarball: "dev-governance-kit-0.1.1.tgz",
    sha256: createHash("sha256")
      .update(await readFile(result.tarball))
      .digest("hex"),
    files: ["package.json", "tooling/cli.mjs"]
  });
  assert.deepEqual(
    JSON.parse(await readFile(result.output, "utf8")),
    result.evidence
  );
  assert.equal((await lstat(result.output)).isFile(), true);
});

test("create refuses an existing evidence output and leaves it unchanged", async (t) => {
  const current = await fixture(t);
  await writeFile(current.output, "user-owned\n");
  await assert.rejects(
    createReleaseEvidence({
      commit,
      packJson: current.packJson,
      directory: current.directory,
      output: current.output
    }),
    /已存在/
  );
  assert.equal(await readFile(current.output, "utf8"), "user-owned\n");
});

test("verify rejects tarball content tampering", async (t) => {
  const current = await create(t);
  await writeFile(current.tarball, Buffer.concat([
    await readFile(current.tarball),
    Buffer.from("tampered")
  ]));
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: current.output,
      tarball: current.tarball,
      expectedCommit: commit,
      expectedVersion: current.version
    }),
    /sha256/
  );
});

test("verify rejects expected commit and version mismatches", async (t) => {
  const current = await create(t);
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: current.output,
      tarball: current.tarball,
      expectedCommit: "f".repeat(40),
      expectedVersion: current.version
    }),
    /commit/
  );
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: current.output,
      tarball: current.tarball,
      expectedCommit: commit,
      expectedVersion: "0.1.2"
    }),
    /version/
  );
});

test("verify rejects evidence files and package metadata that disagree", async (t) => {
  const current = await create(t);
  const changed = structuredClone(current.evidence);
  changed.files = ["package.json"];
  await writeFile(current.output, `${JSON.stringify(changed)}\n`);
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: current.output,
      tarball: current.tarball,
      expectedCommit: commit,
      expectedVersion: current.version
    }),
    /files/
  );

  changed.files = current.evidence.files;
  changed.version = "0.1.2";
  await writeFile(current.output, `${JSON.stringify(changed)}\n`);
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: current.output,
      tarball: current.tarball,
      expectedCommit: commit,
      expectedVersion: "0.1.2"
    }),
    /package\.json.*version/
  );
});

test("verify rejects evidence path replacement and tarball basename substitution", async (t) => {
  const current = await create(t);
  const replacement = path.join(current.directory, "replacement.json");
  await writeFile(replacement, await readFile(current.output));
  const aliasParent = await mkdtemp(path.join(tmpdir(), "release-evidence-alias-"));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const directoryAlias = path.join(aliasParent, "linked-candidate");
  try {
    await symlink(
      current.directory,
      directoryAlias,
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(
      verifyReleaseEvidence({
        evidence: path.join(directoryAlias, "release-evidence.json"),
        tarball: current.tarball,
        expectedCommit: commit,
        expectedVersion: current.version
      }),
      /链接/
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.diagnostic(`当前平台不能创建目录链接：${error.code}`);
  }

  await rm(current.output);
  try {
    await symlink(replacement, current.output, "file");
    await assert.rejects(
      verifyReleaseEvidence({
        evidence: current.output,
        tarball: current.tarball,
        expectedCommit: commit,
        expectedVersion: current.version
      }),
      /链接/
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.diagnostic(`当前平台不能创建文件链接：${error.code}`);
  }

  const alternate = path.join(current.directory, "renamed.tgz");
  await writeFile(alternate, await readFile(current.tarball));
  await assert.rejects(
    verifyReleaseEvidence({
      evidence: replacement,
      tarball: alternate,
      expectedCommit: commit,
      expectedVersion: current.version
    }),
    /tarball/
  );
});

test("create rejects pack metadata that does not match actual ordinary files", async (t) => {
  const current = await fixture(t, {
    packFiles: [{ path: "package.json" }]
  });
  await assert.rejects(
    createReleaseEvidence({
      commit,
      packJson: current.packJson,
      directory: current.directory,
      output: current.output
    }),
    /files/
  );
});

test("archive validation rejects duplicate, linked, traversing and control paths", async (t) => {
  const packageJson = Buffer.from(
    '{"name":"dev-governance-kit","version":"0.1.1"}\n'
  );
  const cases = [
    {
      name: "duplicate",
      entries: [
        ["package.json", packageJson],
        ["package.json", packageJson]
      ],
      expected: /重复/
    },
    {
      name: "link",
      entries: [
        ["package.json", packageJson],
        ["linked", { content: Buffer.alloc(0), type: "2", linkname: "package.json" }]
      ],
      expected: /不支持的条目类型/
    },
    {
      name: "traversal",
      entries: [
        ["package.json", packageJson],
        ["../outside", Buffer.from("no")]
      ],
      expected: /越界|歧义/
    },
    {
      name: "control",
      entries: [
        ["package.json", packageJson],
        ["bad\u0001name", Buffer.from("no")]
      ],
      expected: /控制字符/
    }
  ];

  for (const entry of cases) {
    const current = await fixture(t, {
      entries: entry.entries,
      packFiles: [{ path: "package.json" }]
    });
    await assert.rejects(
      createReleaseEvidence({
        commit,
        packJson: current.packJson,
        directory: current.directory,
        output: current.output
      }),
      entry.expected,
      entry.name
    );
  }
});

test("CLI arguments are strict and successful output is one stable JSON document", async (t) => {
  const current = await fixture(t);
  const created = await runCli([
    "create",
    "--commit",
    commit,
    "--pack-json",
    current.packJson,
    "--directory",
    current.directory,
    "--output",
    current.output
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(created.stdout), {
    ok: true,
    mode: "create",
    evidence: current.output,
    tarball: current.filename,
    version: current.version
  });
  assert.equal(created.stderr, "");

  const verified = await runCli([
    "verify",
    "--evidence",
    current.output,
    "--tarball",
    current.tarball,
    "--expected-commit",
    commit,
    "--expected-version",
    current.version
  ]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), {
    ok: true,
    mode: "verify",
    tarball: current.filename,
    version: current.version,
    commit
  });
  assert.equal(verified.stderr, "");

  for (const args of [
    [],
    ["create", "--commit", commit],
    ["verify", "--unknown", "value"],
    ["create", "--commit", commit, "--commit", commit]
  ]) {
    const invalid = await runCli(args);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /^RELEASE_EVIDENCE_FAILED:/);
    assert.doesNotMatch(invalid.stderr, /\n\s+at\s/);
  }
});

test("CI pins official actions and defines the complete cross-platform gates", async () => {
  const workflow = await readFile(
    path.join(kitRoot, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /uses:\s*actions\/[^@\s]+@v\d+/);
  assert.equal(
    workflow.match(
      /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/g
    )?.length,
    3
  );
  assert.equal(
    workflow.match(
      /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/g
    )?.length,
    3
  );
  assert.equal(
    workflow.match(
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/g
    )?.length,
    1
  );
  assert.match(
    workflow,
    /os: \[windows-latest, ubuntu-latest, macos-latest\]/
  );
  assert.match(workflow, /node: \["20\.20\.2", "22", "24"\]/);
  assert.match(workflow, /package-smoke:[\s\S]*node-version: "24"/);
  assert.match(workflow, /npm run test:package/);
  assert.match(
    workflow,
    /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/
  );
  assert.match(workflow, /needs: \[test, package-smoke\]/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /persist-credentials: false/);
  const parsedWorkflow = (await import("yaml")).default.parse(workflow);
  const upload = parsedWorkflow.jobs["release-candidate"].steps.find((step) => (
    String(step.uses ?? "").startsWith("actions/upload-artifact@")
  ));
  assert.ok(upload, "release-candidate 必须上传 artifact");
  assert.deepEqual(
    upload.with.path.split(/\r?\n/).filter(Boolean),
    [
      "release-candidate/${{ steps.pack.outputs.filename }}",
      "release-candidate/release-evidence.json"
    ]
  );
  assert.equal(upload.with["include-hidden-files"], undefined);
  assert.doesNotMatch(upload.with.path, /(^|\/)\./m);
  assert.doesNotMatch(workflow, /\t/);
  assert.doesNotMatch(workflow, /\b0\.1\.0\b/);
});

test("candidate directory is ignored without relying on hidden artifact upload", async () => {
  const ignore = await readFile(path.join(kitRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^release-candidate\/$/m);
});

test("CLI filesystem failures redact every private path and stay bounded", async (t) => {
  const privateRoot = await mkdtemp(
    path.join(tmpdir(), "private-secret-release-evidence-")
  );
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const missingEvidence = path.join(privateRoot, "hidden evidence.json");
  const missingTarball = path.join(privateRoot, "hidden candidate.tgz");
  const existing = await create(t);
  await rm(existing.tarball);

  for (const args of [
    [
      "verify",
      "--evidence",
      missingEvidence,
      "--tarball",
      missingTarball,
      "--expected-commit",
      commit,
      "--expected-version",
      "0.1.1"
    ],
    [
      "create",
      "--commit",
      commit,
      "--pack-json",
      path.join(privateRoot, "missing pack.json"),
      "--directory",
      privateRoot,
      "--output",
      path.join(privateRoot, "missing parent", "private output.json")
    ],
    [
      "verify",
      "--evidence",
      existing.output,
      "--tarball",
      existing.tarball,
      "--expected-commit",
      commit,
      "--expected-version",
      existing.version
    ],
    [
      "create",
      "--commit",
      commit,
      "--pack-json",
      existing.packJson,
      "--directory",
      existing.directory,
      "--output",
      path.join(existing.directory, "missing parent", "private output.json")
    ]
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^RELEASE_EVIDENCE_FAILED: (verify|create):/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
    assert.doesNotMatch(result.stderr, /private-secret-release-evidence/i);
    assert.doesNotMatch(result.stderr, new RegExp(
      privateRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    ));
    assert.doesNotMatch(result.stderr, new RegExp(
      kitRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    ));
    for (const input of args.filter((value) => path.isAbsolute(value))) {
      assert.doesNotMatch(result.stderr, new RegExp(
        input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      ));
    }
    assert.doesNotMatch(
      result.stderr,
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    );
    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024);
  }
});

test("CLI tar diagnostics cannot inject tabs or C0/C1 controls", async (t) => {
  const badPath = "bad\tname";
  const packageJson = Buffer.from(
    '{"name":"dev-governance-kit","version":"0.1.1"}\n'
  );
  const current = await fixture(t, {
    entries: [
      ["package.json", packageJson],
      [badPath, Buffer.from("first")],
      [badPath, Buffer.from("second")]
    ],
    packFiles: [{ path: "package.json" }]
  });

  const result = await runCli([
    "create",
    "--commit",
    commit,
    "--pack-json",
    current.packJson,
    "--directory",
    current.directory,
    "--output",
    current.output
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^RELEASE_EVIDENCE_FAILED: create: tarball 包含重复条目：bad name\n$/
  );
  assert.doesNotMatch(
    result.stderr.slice(0, -1),
    /[\u0000-\u001f\u007f-\u009f]/
  );
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024);

  const c1 = await runCli(["create", "--bad\u0085option", "value"]);
  assert.equal(c1.code, 1);
  assert.equal(c1.stdout, "");
  assert.match(c1.stderr, /RELEASE_EVIDENCE_FAILED: create: 未知参数：--bad option/);
  assert.doesNotMatch(
    c1.stderr.slice(0, -1),
    /[\u0000-\u001f\u007f-\u009f]/
  );
});
