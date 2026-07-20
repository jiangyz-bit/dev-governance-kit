import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { resolveInitManifest, renderInitManifest } from "../tooling/lib/init-manifest.mjs";
import { validateSchema } from "../tooling/lib/schema-validator.mjs";

const components = {
  server: {
    component: "server",
    profile: "java-springboot-mybatis",
    path: "apps/server",
    confidence: "high",
    evidence: [],
    warnings: []
  },
  admin: {
    component: "admin",
    profile: "react-admin",
    path: "apps/admin",
    confidence: "high",
    evidence: [],
    warnings: []
  },
  client: {
    component: "client",
    profile: "wechat-miniprogram",
    path: "apps/client",
    confidence: "high",
    evidence: [],
    warnings: []
  }
};

function detection({
  candidates = Object.values(components),
  questions = [],
  gitMarkers = [],
  projectName = "demo",
  incomplete = false,
  empty = false,
  warnings = []
} = {}) {
  return { candidates, questions, gitMarkers, projectName, incomplete, empty, warnings };
}

function gitMarker(workspaceDir, relativePath = "") {
  return { rootDir: path.join(workspaceDir, relativePath), markerPath: ".git", type: "directory" };
}

async function workspace(t) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-init-manifest-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  return workspaceDir;
}

test("builds a valid multi-repo manifest from three selected components", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      gitMarkers: [gitMarker(workspaceDir, "apps/server"), gitMarker(workspaceDir, "apps/admin"), gitMarker(workspaceDir, "apps/client")]
    }),
    answers: {}
  });

  assert.equal(result.status, "ready");
  assert.equal(result.manifest.project.repositoryMode, "multi-repo");
  assert.equal(result.manifest.contracts.apiContractOwner, "server");
  assert.equal(result.manifest.contracts.statusRegistryOwner, "server");
  assert.doesNotThrow(() => validateSchema("governance-kit", result.manifest));
});

test("uses the first existing component as contract owner without a server", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [components.admin, components.client],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: {}
  });

  assert.equal(result.status, "ready");
  assert.equal(result.manifest.contracts.apiContractOwner, "admin");
  assert.equal(result.manifest.contracts.statusRegistryOwner, "admin");
});

test("returns needs_input for competing admin candidates", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [
        { ...components.admin, path: "apps/admin-a" },
        { ...components.admin, path: "apps/admin-b" },
        components.client
      ],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: {}
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "ADMIN_COMPONENT_UNCLEAR");
});

test("does not let yes bypass an unconfirmed Profile assumption", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [components.server],
      questions: [{
        code: "PROFILE_ASSUMPTION_UNCONFIRMED",
        component: "server",
        profile: "java-springboot-mybatis",
        missing: ["flyway"]
      }],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: { yes: true }
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "PROFILE_ASSUMPTION_UNCONFIRMED");
});

test("uses explicit answers to select components and resolve Git topology", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [
        { ...components.admin, path: "packages/admin-a" },
        { ...components.admin, path: "packages/admin-b" },
        components.client
      ],
      gitMarkers: [gitMarker(workspaceDir), gitMarker(workspaceDir, "packages/admin-a")]
    }),
    answers: {
      components: { admin: "packages/admin-b" },
      repositoryMode: "multi-repo"
    }
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(Object.keys(result.manifest.components), ["admin", "client"]);
  assert.equal(result.manifest.components.admin.path, "packages/admin-b");
  assert.equal(result.manifest.project.repositoryMode, "multi-repo");
  assert.equal(result.manifest.contracts.apiContractOwner, "admin");
});

test("keeps hybrid Git layouts blocking until the user provides a repository mode", async (t) => {
  const workspaceDir = await workspace(t);
  const input = {
    workspaceDir,
    detection: detection({
      candidates: [components.server, components.admin],
      gitMarkers: [gitMarker(workspaceDir), gitMarker(workspaceDir, "apps/admin")]
    })
  };

  const unresolved = resolveInitManifest({ ...input, answers: {} });
  assert.equal(unresolved.status, "needs_input");
  assert.equal(unresolved.questions[0].code, "REPOSITORY_MODE_UNCLEAR");

  const resolved = resolveInitManifest({ ...input, answers: { repositoryMode: "monorepo" } });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.manifest.project.repositoryMode, "monorepo");
});

test("renders byte-stable YAML with relative slash-separated component paths", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [
        { ...components.client, path: "apps\\client" },
        { ...components.admin, path: "apps\\admin" },
        { ...components.server, path: "apps\\server" }
      ],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: {}
  });

  const first = renderInitManifest(result.manifest);
  assert.equal(first, renderInitManifest(result.manifest));
  assert.match(first, /\n$/);
  assert.equal(first.includes("\r"), false);
  assert.deepEqual(Object.keys(parse(first).components), ["server", "admin", "client"]);
  assert.match(first, /path: apps\/server/);
  assert.doesNotMatch(first, /\\/);
  assert.doesNotThrow(() => validateSchema("governance-kit", parse(first)));
});

test("returns stable unsupported and incomplete results without producing a manifest", async (t) => {
  const workspaceDir = await workspace(t);
  const incomplete = resolveInitManifest({
    workspaceDir,
    detection: detection({ incomplete: true }),
    answers: {}
  });
  const empty = resolveInitManifest({
    workspaceDir,
    detection: detection({ candidates: [], empty: true }),
    answers: {}
  });

  assert.deepEqual([incomplete.status, incomplete.questions[0].code, incomplete.manifest], ["needs_input", "SCAN_INCOMPLETE", null]);
  assert.deepEqual([empty.status, empty.code, empty.manifest], ["unsupported", "NO_PROJECT_FOUND", null]);
});

test("keeps absolute component paths out of the generated manifest", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [{ ...components.client, path: "C:\\outside\\client" }],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: {}
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "COMPONENT_PATH_INVALID");
  assert.equal(result.manifest, null);
});

test("normalizes workspace-root component candidates to schema-valid dot paths", async (t) => {
  const workspaceDir = await workspace(t);
  const result = resolveInitManifest({
    workspaceDir,
    detection: detection({
      candidates: [
        { ...components.client, path: "" },
        { ...components.admin, path: "" },
        { ...components.server, path: "" }
      ],
      gitMarkers: [gitMarker(workspaceDir)]
    }),
    answers: {}
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(Object.values(result.manifest.components).map((component) => component.path), [".", ".", "."]);
  assert.doesNotThrow(() => validateSchema("governance-kit", result.manifest));
  assert.doesNotMatch(renderInitManifest(result.manifest), /\\/);
});

test("blocks nested Git repositories below selected components until repository mode is answered", async (t) => {
  const workspaceDir = await workspace(t);
  const input = {
    workspaceDir,
    detection: detection({
      candidates: [components.server, components.admin],
      gitMarkers: [gitMarker(workspaceDir), gitMarker(workspaceDir, "apps/admin/plugins/nested-repo")]
    })
  };

  for (const answers of [{}, { yes: true }]) {
    const result = resolveInitManifest({ ...input, answers });
    assert.equal(result.status, "needs_input");
    assert.equal(result.questions[0].code, "REPOSITORY_MODE_UNCLEAR");
  }

  const resolved = resolveInitManifest({ ...input, answers: { repositoryMode: "monorepo" } });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.manifest.project.repositoryMode, "monorepo");
});
