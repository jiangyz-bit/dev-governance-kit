import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizePublishedVersions,
  queryPublishedVersions,
  sanitizeReleaseFailure,
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

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "tooling/verify-release.mjs",
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

function registryResponse(body, {
  status = 200,
  url = "https://registry.npmjs.org/dev-governance-kit",
  redirected = false,
  contentType = "application/vnd.npm.install-v1+json",
  headers = {}
} = {}) {
  const response = new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": contentType,
        ...headers
      }
    }
  );
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: redirected }
  });
  return response;
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

test("queryPublishedVersions directly reads the fixed public registry document", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return registryResponse({
      name: "dev-governance-kit",
      versions: {
        "0.2.0": {
          name: "dev-governance-kit",
          version: "0.2.0"
        },
        "0.1.0": {
          name: "dev-governance-kit",
          version: "0.1.0"
        },
        "0.3.0-beta.1": {
          name: "dev-governance-kit",
          version: "0.3.0-beta.1"
        }
      }
    });
  };

  assert.deepEqual(await queryPublishedVersions({ fetchImpl }), [
    "0.1.0",
    "0.2.0"
  ]);
  assert.equal(
    calls[0].url,
    "https://registry.npmjs.org/dev-governance-kit"
  );
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.accept.includes("json"), true);
  assert.equal("authorization" in calls[0].options.headers, false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("queryPublishedVersions accepts only an exact official 404", async () => {
  assert.deepEqual(await queryPublishedVersions({
    fetchImpl: async () => registryResponse(
      { error: "Not found" },
      { status: 404 }
    )
  }), []);

  for (const response of [
    registryResponse({ error: "permission denied" }, { status: 404 }),
    registryResponse(
      { error: "Not found", detail: "extra" },
      { status: 404 }
    ),
    registryResponse({ error: "Not found" }, { status: 403 }),
    registryResponse(
      { error: "Not found" },
      { status: 404, url: "https://evil.invalid/dev-governance-kit" }
    ),
    registryResponse(
      { error: "Not found" },
      { status: 404, redirected: true }
    )
  ]) {
    await assert.rejects(
      queryPublishedVersions({
        fetchImpl: async () => response
      }),
      /npm registry|响应|404/
    );
  }
});

test("queryPublishedVersions fails closed on malformed or contradictory data", async () => {
  const cases = [
    registryResponse("{malformed"),
    registryResponse(null),
    registryResponse({ name: "other", versions: {} }),
    registryResponse({ name: "dev-governance-kit", versions: [] }),
    registryResponse({
      name: "dev-governance-kit",
      versions: {
        " 0.1.0": {
          name: "dev-governance-kit",
          version: " 0.1.0"
        }
      }
    }),
    registryResponse({
      name: "dev-governance-kit",
      versions: {
        "0.1.0": {
          name: "other",
          version: "0.1.0"
        }
      }
    }),
    registryResponse({
      name: "dev-governance-kit",
      versions: {
        "0.1.0": {
          name: "dev-governance-kit",
          version: "0.2.0"
        }
      }
    }),
    registryResponse(
      { name: "dev-governance-kit", versions: {} },
      { contentType: "text/html" }
    ),
    registryResponse(
      { name: "dev-governance-kit", versions: {} },
      { headers: { "content-length": "9999999" } }
    )
  ];
  for (const response of cases) {
    await assert.rejects(
      queryPublishedVersions({ fetchImpl: async () => response }),
      /npm registry|JSON|SemVer|version|name|过大|结构/
    );
  }
  await assert.rejects(
    queryPublishedVersions({
      maximumResponseBytes: 32,
      fetchImpl: async () => registryResponse({
        name: "dev-governance-kit",
        versions: {}
      })
    }),
    /过大/
  );
  await assert.rejects(
    queryPublishedVersions({
      fetchImpl: async () => {
        throw new Error("network failed");
      }
    }),
    /network failed/
  );
});

test("CLI strictly rejects malformed arguments without querying the network", async () => {

  for (const args of [
    [],
    ["--tag"],
    ["--tag", "v0.1.0", "extra"],
    ["--unknown", "value"],
    ["--tag", "v0.1.0", "--tag", "v0.1.0"],
    ["--tag=v0.1.0"]
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^RELEASE_VERIFY_FAILED:/);
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  }
});

test("release failure diagnostics redact credentials paths and controls", () => {
  const source = [
    "npm registry 查询失败",
    "npm_token=Q7z",
    "Authorization: Bearer B8x",
    "Authorization='Basic C9v'",
    "https://alice:D4w@example.test/private",
    '"_authToken":"E5u"',
    "_auth=F6t",
    "password: 'G7s'",
    "token=H8r",
    "secret: I9q",
    "apiKey=J0p",
    "file:///private/secret",
    "C:\\private\\secret",
    "\u001b[31m\u0001",
    "x".repeat(2000)
  ].join(" ");
  const output = sanitizeReleaseFailure(source, []);

  assert.match(output, /npm registry 查询失败/);
  for (const secret of [
    "Q7z",
    "B8x",
    "C9v",
    "alice",
    "D4w",
    "E5u",
    "F6t",
    "G7s",
    "H8r",
    "I9q",
    "J0p"
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "i"));
  }
  assert.doesNotMatch(output, /private[\\/]secret/i);
  assert.doesNotMatch(output, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(Buffer.byteLength(output, "utf8") <= 904);
});
