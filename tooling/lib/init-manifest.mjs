import path from "node:path";
import { stringify } from "yaml";
import { validateSchema } from "./schema-validator.mjs";

const componentOrder = ["server", "admin", "client"];
const repositoryModes = new Set(["monorepo", "multi-repo"]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0) return ".";
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized.split("/").includes("..")) return null;
  return normalized || ".";
}

function sortCandidates(candidates) {
  return [...candidates].sort((left, right) => (
    compareStrings(left.component, right.component)
    || compareStrings(left.path, right.path)
    || compareStrings(left.profile, right.profile)
  ));
}

function normalizedCandidates(candidates) {
  return sortCandidates(candidates.map((candidate) => ({
    ...candidate,
    path: normalizedPath(candidate.path)
  })));
}

function resultWithQuestion(code, detection, details = {}) {
  return {
    status: "needs_input",
    code,
    manifest: null,
    questions: [{ code, ...details }],
    detected: detection,
    warnings: detection.warnings ?? []
  };
}

function answerFor(answers, code, component) {
  const componentCode = component ? `${code}:${component}` : null;
  return answers?.[componentCode]
    ?? answers?.[code]
    ?? answers?.questions?.[componentCode]
    ?? answers?.questions?.[code];
}

function isConfirmed(answer) {
  if (answer === true) return true;
  if (!answer || typeof answer !== "object") return false;
  return answer.confirmed === true || answer.value === true;
}

function compatibilityQuestion(detection, answers) {
  const questions = [...(detection.questions ?? [])].sort((left, right) => (
    compareStrings(left.code, right.code)
    || compareStrings(left.component ?? "", right.component ?? "")
    || compareStrings(left.path ?? "", right.path ?? "")
  ));
  return questions.find((question) => !isConfirmed(answerFor(answers, question.code, question.component)));
}

function selectedPath(answer) {
  if (typeof answer === "string") return normalizedPath(answer);
  if (!answer || typeof answer !== "object") return null;
  return normalizedPath(answer.path ?? answer.componentPath ?? answer.value);
}

function componentAnswer(answers, component) {
  return answers?.components?.[component]
    ?? answers?.componentPaths?.[component]
    ?? answers?.[component]
    ?? answerFor(answers, `${component.toUpperCase()}_COMPONENT_UNCLEAR`, component);
}

function selectComponents(candidates, answers, detection) {
  const selected = {};
  for (const component of componentOrder) {
    const options = candidates.filter((candidate) => candidate.component === component);
    if (options.length === 0) continue;

    const choice = selectedPath(componentAnswer(answers, component));
    if (choice) {
      const match = options.find((candidate) => candidate.path === choice);
      if (match) {
        selected[component] = match;
        continue;
      }
    }
    if (options.length === 1) {
      selected[component] = options[0];
      continue;
    }
    return resultWithQuestion(`${component.toUpperCase()}_COMPONENT_UNCLEAR`, detection, {
      component,
      candidates: options.map(({ path: candidatePath, profile }) => ({ path: candidatePath, profile }))
    });
  }
  return selected;
}

function markerRoot(marker) {
  if (!marker?.rootDir || typeof marker.rootDir !== "string") return null;
  return path.resolve(marker.rootDir);
}

function samePath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function isAncestor(ancestor, target) {
  const relative = path.relative(ancestor, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestGitRoot(componentRoot, gitMarkers) {
  const target = path.resolve(componentRoot);
  const matches = gitMarkers
    .map(markerRoot)
    .filter((rootDir) => rootDir && isAncestor(rootDir, target));
  return matches.sort((left, right) => right.length - left.length || compareStrings(left, right))[0] ?? null;
}

function inferRepositoryMode(candidates, gitMarkers) {
  const roots = candidates.map((candidate) => nearestGitRoot(candidate.rootDir, gitMarkers));
  if (roots.some((rootDir) => rootDir === null)) {
    return { code: "REPOSITORY_MODE_UNCLEAR", reason: "GIT_BOUNDARY_MISSING" };
  }
  const uniqueRoots = new Set(roots);
  if (uniqueRoots.size === 1) return "monorepo";
  const rootList = [...uniqueRoots];
  if (rootList.some((rootDir) => rootList.some((otherRoot) => (
    rootDir !== otherRoot && isAncestor(rootDir, otherRoot)
  )))) {
    return { code: "REPOSITORY_MODE_UNCLEAR", reason: "HYBRID_GIT_BOUNDARIES" };
  }
  if (uniqueRoots.size === candidates.length) return "multi-repo";
  return { code: "REPOSITORY_MODE_UNCLEAR", reason: "HYBRID_GIT_BOUNDARIES" };
}

function hasNestedGitRepository(candidates, gitMarkers) {
  const markerRoots = gitMarkers.map(markerRoot).filter(Boolean);
  const owningRoots = candidates
    .map((candidate) => nearestGitRoot(candidate.rootDir, gitMarkers))
    .filter(Boolean);
  return owningRoots.some((owningRoot) => markerRoots.some((rootDir) => (
    !samePath(rootDir, owningRoot) && isAncestor(owningRoot, rootDir)
  )));
}

function repositoryModeAnswer(answers) {
  const value = answers?.repositoryMode
    ?? answers?.repository?.mode
    ?? answerFor(answers, "REPOSITORY_MODE_UNCLEAR");
  const candidate = typeof value === "object" && value !== null ? value.value ?? value.mode : value;
  return repositoryModes.has(candidate) ? candidate : null;
}

function selectContractOwner(components) {
  return componentOrder.find((component) => components[component]);
}

export function resolveInitManifest({ workspaceDir, detection, answers = {} }) {
  if (detection.incomplete) return resultWithQuestion("SCAN_INCOMPLETE", detection);
  if ((detection.candidates ?? []).length === 0) {
    return {
      status: "unsupported",
      code: detection.empty ? "NO_PROJECT_FOUND" : "UNSUPPORTED_PROJECT",
      manifest: null,
      questions: [],
      detected: detection,
      warnings: detection.warnings ?? []
    };
  }

  const candidates = normalizedCandidates(detection.candidates);
  const invalidCandidate = candidates.find((candidate) => !candidate.path || !componentOrder.includes(candidate.component));
  if (invalidCandidate) {
    return resultWithQuestion("COMPONENT_PATH_INVALID", detection, {
      component: invalidCandidate.component,
      path: invalidCandidate.path
    });
  }

  const unresolvedCompatibility = compatibilityQuestion(detection, answers);
  if (unresolvedCompatibility) {
    return resultWithQuestion(unresolvedCompatibility.code, detection, unresolvedCompatibility);
  }

  const components = selectComponents(candidates, answers, detection);
  if (components.status === "needs_input") return components;

  const selectedCandidates = componentOrder.filter((component) => components[component]).map((component) => components[component]);
  const candidatesWithRoots = selectedCandidates.map((candidate) => ({
    ...candidate,
    rootDir: path.resolve(workspaceDir, candidate.path)
  }));
  const repositoryMode = repositoryModeAnswer(answers)
    ?? (hasNestedGitRepository(candidatesWithRoots, detection.gitMarkers ?? [])
      ? { code: "REPOSITORY_MODE_UNCLEAR", reason: "NESTED_GIT_REPOSITORY" }
      : inferRepositoryMode(candidatesWithRoots, detection.gitMarkers ?? []));
  if (typeof repositoryMode !== "string") {
    return resultWithQuestion(repositoryMode.code, detection, repositoryMode);
  }

  const contractOwner = selectContractOwner(components);
  const manifest = {
    schemaVersion: 1,
    project: {
      name: detection.projectName || path.basename(path.resolve(workspaceDir)),
      repositoryMode
    },
    components: Object.fromEntries(componentOrder
      .filter((component) => components[component])
      .map((component) => [component, {
        profile: components[component].profile,
        path: components[component].path
      }])),
    contracts: {
      statusRegistryOwner: contractOwner,
      apiContractOwner: contractOwner
    },
    generation: { conflictPolicy: "report" }
  };
  validateSchema("governance-kit", manifest);
  return {
    status: "ready",
    manifest,
    questions: [],
    detected: detection,
    warnings: detection.warnings ?? []
  };
}

export function renderInitManifest(manifest) {
  return stringify(manifest, { lineWidth: 0 }).replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
}
