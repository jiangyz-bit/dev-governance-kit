import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { detectWorkspace, validateContextEvidence } from "../tooling/lib/project-detect.mjs";
import { scanWorkspace } from "../tooling/lib/workspace-scan.mjs";
import { createProjectWorkspace } from "./helpers/project-workspace.mjs";

async function detect(t, files, options = {}) {
  const workspaceDir = await createProjectWorkspace(t, { files });
  const scan = await scanWorkspace({ workspaceDir });
  return detectWorkspace({ workspaceDir, scan, ...options });
}

test("detects Maven Spring Boot MyBatis as server", async (t) => {
  const result = await detect(t, {
    "demo-server/pom.xml": `
      <project><dependencies>
        <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><artifactId>mybatis-spring-boot-starter</artifactId></dependency>
      </dependencies></project>`
  });

  assert.deepEqual(result.candidates, [{
    component: "server",
    profile: "java-springboot-mybatis",
    path: "demo-server",
    confidence: "high",
    evidence: ["pom.xml", "spring-boot", "mybatis"],
    warnings: ["FLYWAY_NOT_DETECTED"]
  }]);
});

test("does not silently classify a plain React app as admin", async (t) => {
  const result = await detect(t, {
    "web/package.json": JSON.stringify({
      dependencies: { react: "^19.0.0" },
      devDependencies: { vite: "^6.0.0" },
      scripts: { dev: "vite" }
    }),
    "web/tsconfig.json": "{}"
  });

  assert.deepEqual(result.candidates, [{
    component: "admin",
    profile: "react-admin",
    path: "web",
    confidence: "medium",
    evidence: ["package.json", "react", "vite", "tsconfig.json"],
    warnings: []
  }]);
  assert.ok(result.questions.some((item) => item.code === "ADMIN_ROLE_UNCLEAR"));
});

test("detects a WeChat miniprogram from both marker files", async (t) => {
  const result = await detect(t, {
    "mobile/project.config.json": "{}",
    "mobile/app.json": "{}"
  });

  assert.deepEqual(result.candidates, [{
    component: "client",
    profile: "wechat-miniprogram",
    path: "mobile",
    confidence: "high",
    evidence: ["project.config.json", "app.json"],
    warnings: []
  }]);
});

test("turns a missing Profile assumption into a blocking question", async (t) => {
  const result = await detect(t, {
    "demo-server/pom.xml": "<project>spring-boot mybatis</project>"
  });

  assert.deepEqual(result.questions, [{
    code: "PROFILE_ASSUMPTION_UNCONFIRMED",
    component: "server",
    profile: "java-springboot-mybatis",
    missing: ["flyway"]
  }]);
});

test("returns structured warnings instead of crashing on invalid marker files", async (t) => {
  const result = await detect(t, {
    "admin/package.json": "{ not json",
    "server/pom.xml": "<project><dependencies>"
  });

  assert.deepEqual(result.warnings, [
    { code: "INVALID_PACKAGE_JSON", path: "admin/package.json" },
    { code: "INVALID_POM_XML", path: "server/pom.xml" }
  ]);
  assert.deepEqual(result.candidates, []);
});

test("sorts candidates and uses slash-separated paths", async (t) => {
  const result = await detect(t, {
    "z-web/package.json": JSON.stringify({ dependencies: { react: "^19" }, scripts: { dev: "vite" } }),
    "z-web/tsconfig.json": "{}",
    "a-mobile/project.config.json": "{}",
    "a-mobile/app.json": "{}"
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["a-mobile", "z-web"]);
  assert.deepEqual(result.questions, [{
    code: "ADMIN_ROLE_UNCLEAR",
    component: "admin",
    profile: "react-admin",
    path: "z-web"
  }]);
});

test("validates evidence for components from an existing manifest", async (t) => {
  const workspaceDir = await createProjectWorkspace(t, {
    files: { "server/pom.xml": "<project>spring-boot</project>" }
  });
  const result = await validateContextEvidence({
    components: {
      server: {
        type: "server",
        rootDir: path.join(workspaceDir, "server"),
        profile: { id: "java-springboot-mybatis" }
      }
    }
  });

  assert.deepEqual(result, {
    status: "needs_input",
    questions: [{
      code: "PROFILE_EVIDENCE_MISMATCH",
      component: "server",
      profile: "java-springboot-mybatis",
      missing: ["mybatis", "flyway"]
    }]
  });
});

test("stops detector and existing-manifest validation when aborted", async (t) => {
  const workspaceDir = await createProjectWorkspace(t, {
    files: { "server/pom.xml": "spring-boot mybatis" }
  });
  const scan = await scanWorkspace({ workspaceDir });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    detectWorkspace({ workspaceDir, scan, signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(
    validateContextEvidence({ components: {} }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});
