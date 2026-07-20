import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { assertRealPathInside } from "./files.mjs";

const profileRules = {
  "java-springboot-mybatis": {
    component: "server",
    required: ["pom.xml", "spring-boot", "mybatis"],
    assumptions: ["flyway"]
  },
  "react-admin": {
    component: "admin",
    required: ["package.json", "react", "vite", "tsconfig.json"],
    assumptions: ["admin-role"]
  },
  "wechat-miniprogram": {
    component: "client",
    required: ["project.config.json", "app.json"],
    assumptions: []
  }
};

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(/[\\/]/).join("/");
}

function relativePath(workspaceDir, targetPath) {
  return normalizeRelativePath(path.relative(workspaceDir, targetPath));
}

function hasDependency(packageJson, name, signal) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    throwIfAborted(signal);
    const dependencies = packageJson[field];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) && name in dependencies) {
      return true;
    }
  }
  return false;
}

function hasVite(packageJson, signal) {
  if (hasDependency(packageJson, "vite", signal)) return true;
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return false;
  for (const value of Object.values(scripts)) {
    throwIfAborted(signal);
    if (typeof value === "string" && /(^|\s)vite(?:\s|$)/.test(value)) return true;
  }
  return false;
}

function isWellFormedXml(source, signal) {
  const tags = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g) ?? [];
  const stack = [];
  for (const token of tags) {
    throwIfAborted(signal);
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?") || token.startsWith("<!")) continue;
    if (/^<\//.test(token)) {
      const name = token.slice(2, -1).trim();
      if (stack.pop() !== name) return false;
      continue;
    }
    if (/\/>$/.test(token)) continue;
    const match = /^<([A-Za-z_][\w:.-]*)\b/.exec(token);
    if (!match) return false;
    stack.push(match[1]);
  }
  return stack.length === 0 && /<project\b/.test(source) && /<\/project\s*>/.test(source);
}

async function readMarker(rootDir, marker, { workspaceDir, signal, warnings }) {
  throwIfAborted(signal);
  const markerPath = path.join(rootDir, marker);
  try {
    if (workspaceDir) await assertRealPathInside(workspaceDir, markerPath, { allowMissing: false });
    const info = await lstat(markerPath);
    throwIfAborted(signal);
    if (!info.isFile() || info.isSymbolicLink()) return { exists: false };
    const source = await readFile(markerPath, "utf8");
    throwIfAborted(signal);
    return { exists: true, source };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function inspectMarkers({ rootDir, workspaceDir, signal, warnings }) {
  const markers = {};
  for (const marker of ["pom.xml", "package.json", "tsconfig.json", "project.config.json", "app.json"]) {
    throwIfAborted(signal);
    markers[marker] = await readMarker(rootDir, marker, { workspaceDir, signal, warnings });
    throwIfAborted(signal);
  }

  if (markers["pom.xml"].exists && !isWellFormedXml(markers["pom.xml"].source, signal)) {
    warnings.push({ code: "INVALID_POM_XML", path: relativePath(workspaceDir ?? rootDir, path.join(rootDir, "pom.xml")) });
    markers["pom.xml"].invalid = true;
  }

  for (const marker of ["package.json", "project.config.json", "app.json"]) {
    throwIfAborted(signal);
    if (!markers[marker].exists) continue;
    try {
      const parsed = JSON.parse(markers[marker].source);
      if (marker === "package.json" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
        warnings.push({ code: "INVALID_PACKAGE_JSON", path: relativePath(workspaceDir ?? rootDir, path.join(rootDir, marker)) });
        markers[marker].invalid = true;
        continue;
      }
      markers[marker].json = parsed;
    } catch {
      const code = marker === "package.json"
        ? "INVALID_PACKAGE_JSON"
        : marker === "project.config.json"
          ? "INVALID_PROJECT_CONFIG_JSON"
          : "INVALID_APP_JSON";
      warnings.push({ code, path: relativePath(workspaceDir ?? rootDir, path.join(rootDir, marker)) });
      markers[marker].invalid = true;
    }
  }
  return markers;
}

function evaluateProfile(profile, rootDir, markers, signal, componentPath) {
  throwIfAborted(signal);
  const rule = profileRules[profile];
  const found = new Set();
  if (profile === "java-springboot-mybatis") {
    const pom = markers["pom.xml"];
    if (pom.exists && !pom.invalid) {
      found.add("pom.xml");
      if (/spring-boot/i.test(pom.source)) found.add("spring-boot");
      if (/mybatis/i.test(pom.source)) found.add("mybatis");
      if (/flyway/i.test(pom.source)) found.add("flyway");
    }
  }
  if (profile === "react-admin") {
    const packageJson = markers["package.json"];
    if (packageJson.exists && !packageJson.invalid) {
      found.add("package.json");
      if (hasDependency(packageJson.json, "react", signal)) found.add("react");
      if (hasVite(packageJson.json, signal)) found.add("vite");
    }
    if (markers["tsconfig.json"].exists) found.add("tsconfig.json");
    if (/(^|[-_/])(admin|console|dashboard)([-_/]|$)/i.test(componentPath)) {
      found.add("admin-role");
    }
  }
  if (profile === "wechat-miniprogram") {
    for (const marker of rule.required) {
      throwIfAborted(signal);
      if (markers[marker].exists && !markers[marker].invalid) found.add(marker);
    }
  }

  const missing = [];
  for (const marker of [...rule.required, ...rule.assumptions]) {
    throwIfAborted(signal);
    if (!found.has(marker)) missing.push(marker);
  }
  return { rule, found, missing };
}

async function detectComponentAtPath({ component, profile, rootDir, workspaceDir, signal, warnings = [] }) {
  throwIfAborted(signal);
  const rule = profileRules[profile];
  if (!rule || rule.component !== component) {
    return { compatible: false, missing: ["unsupported-profile"] };
  }
  const markers = await inspectMarkers({ rootDir, workspaceDir, signal, warnings });
  throwIfAborted(signal);
  const evaluation = evaluateProfile(
    profile,
    rootDir,
    markers,
    signal,
    relativePath(workspaceDir ?? rootDir, rootDir)
  );
  return {
    compatible: evaluation.missing.length === 0,
    found: evaluation.found,
    missing: evaluation.missing,
    rule: evaluation.rule
  };
}

function candidateFromEvaluation({ component, profile, rootDir, workspaceDir, evaluation, signal }) {
  const evidence = [];
  for (const marker of evaluation.rule.required) {
    throwIfAborted(signal);
    if (evaluation.found.has(marker)) evidence.push(marker);
  }
  for (const marker of evaluation.rule.assumptions) {
    throwIfAborted(signal);
    if (evaluation.found.has(marker)) evidence.push(marker);
  }
  const warnings = [];
  if (profile === "java-springboot-mybatis" && !evaluation.found.has("flyway")) {
    warnings.push("FLYWAY_NOT_DETECTED");
  }
  return {
    component,
    profile,
    path: relativePath(workspaceDir, rootDir),
    confidence: evaluation.missing.some((marker) => evaluation.rule.required.includes(marker)) ? "low" : (
      profile === "react-admin" && !evaluation.found.has("admin-role") ? "medium" : "high"
    ),
    evidence,
    warnings
  };
}

function sortCandidates(candidates) {
  return candidates.sort((left, right) => (
    compareStrings(left.path, right.path)
    || compareStrings(left.component, right.component)
    || compareStrings(left.profile, right.profile)
  ));
}

function sortQuestions(questions) {
  return questions.sort((left, right) => (
    compareStrings(left.path ?? "", right.path ?? "")
    || compareStrings(left.component, right.component)
    || compareStrings(left.profile, right.profile)
    || compareStrings(left.code, right.code)
  ));
}

function sortWarnings(warnings) {
  return warnings.sort((left, right) => (
    compareStrings(left.path ?? "", right.path ?? "")
    || compareStrings(left.code ?? "", right.code ?? "")
  ));
}

function normalizeWarning(warning, workspaceDir) {
  if (!warning.path || typeof warning.path !== "string") return warning;
  return { ...warning, path: relativePath(workspaceDir, warning.path) };
}

function inferProjectName(workspaceDir) {
  return path.basename(path.resolve(workspaceDir));
}

export async function detectWorkspace({ workspaceDir, scan, signal }) {
  throwIfAborted(signal);
  const rootDir = path.resolve(workspaceDir);
  const candidates = [];
  const questions = [];
  const warnings = [];
  const roots = new Set();

  for (const warning of scan.warnings) {
    throwIfAborted(signal);
    warnings.push(normalizeWarning(warning, rootDir));
  }

  for (const entry of scan.entries) {
    throwIfAborted(signal);
    if (entry.type !== "file") continue;
    const marker = normalizeRelativePath(entry.relativePath).split("/").at(-1);
    if (["pom.xml", "package.json", "project.config.json", "app.json"].includes(marker)) {
      roots.add(path.dirname(entry.absolutePath));
    }
  }

  for (const componentRoot of [...roots].sort(compareStrings)) {
    throwIfAborted(signal);
    const localWarnings = [];
    const markers = await inspectMarkers({ rootDir: componentRoot, workspaceDir: rootDir, signal, warnings: localWarnings });
    throwIfAborted(signal);
    for (const [profile, rule] of Object.entries(profileRules)) {
      throwIfAborted(signal);
      const evaluation = evaluateProfile(
        profile,
        componentRoot,
        markers,
        signal,
        relativePath(rootDir, componentRoot)
      );
      let hasAllRequiredEvidence = true;
      for (const marker of evaluation.rule.required) {
        throwIfAborted(signal);
        if (!evaluation.found.has(marker)) {
          hasAllRequiredEvidence = false;
          break;
        }
      }
      if (!hasAllRequiredEvidence) continue;
      const candidate = candidateFromEvaluation({
        component: rule.component,
        profile,
        rootDir: componentRoot,
        workspaceDir: rootDir,
        evaluation,
        signal
      });
      candidates.push(candidate);
      if (profile === "java-springboot-mybatis" && !evaluation.found.has("flyway")) {
        questions.push({
          code: "PROFILE_ASSUMPTION_UNCONFIRMED",
          component: rule.component,
          profile,
          missing: ["flyway"]
        });
      }
      if (profile === "react-admin" && !evaluation.found.has("admin-role")) {
        questions.push({
          code: "ADMIN_ROLE_UNCLEAR",
          component: rule.component,
          profile,
          path: candidate.path
        });
      }
    }
    for (const warning of localWarnings) {
      throwIfAborted(signal);
      warnings.push(warning);
    }
  }

  return {
    projectName: inferProjectName(rootDir),
    candidates: sortCandidates(candidates),
    questions: sortQuestions(questions),
    warnings: sortWarnings(warnings),
    gitMarkers: scan.gitMarkers,
    empty: scan.entries.length === 0,
    incomplete: scan.truncated
  };
}

export async function validateContextEvidence(context, { signal } = {}) {
  throwIfAborted(signal);
  const questions = [];
  for (const component of Object.values(context.components)) {
    throwIfAborted(signal);
    const result = await detectComponentAtPath({
      component: component.type,
      profile: component.profile.id,
      rootDir: component.rootDir,
      workspaceDir: context.workspaceDir,
      signal
    });
    throwIfAborted(signal);
    if (!result.compatible) {
      questions.push({
        code: "PROFILE_EVIDENCE_MISMATCH",
        component: component.type,
        profile: component.profile.id,
        missing: result.missing
      });
    }
  }
  return {
    status: questions.length === 0 ? "ready" : "needs_input",
    questions: sortQuestions(questions)
  };
}
