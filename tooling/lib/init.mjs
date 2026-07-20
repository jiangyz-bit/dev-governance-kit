import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPreviewUnchanged,
  createApplyPreview,
  executeApplyPreview
} from "./apply-preview.mjs";
import { GovernanceError } from "./errors.mjs";
import {
  assertRealPathInside,
  assertSnapshotUnchanged,
  detectStaleTempFiles,
  preflightWritableTargets,
  snapshotPath,
  writeUtf8Atomic
} from "./files.mjs";
import {
  inspectContextGitStates,
  inspectGitStates
} from "./git-state.mjs";
import {
  renderInitManifest,
  resolveInitManifest
} from "./init-manifest.mjs";
import {
  createProjectContext,
  loadProjectManifest
} from "./manifest.mjs";
import {
  detectWorkspace,
  validateContextEvidence
} from "./project-detect.mjs";
import { validateWorkspace } from "./validate.mjs";
import { scanWorkspace } from "./workspace-scan.mjs";

const defaultKitRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const expectedPrewriteFileSystemCodes = new Set([
  "EACCES",
  "EBUSY",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS"
]);

const kitResourceDirectories = [
  "blueprints",
  "core",
  "profiles",
  "schemas",
  "templates"
];

function interruptedError(message = "用户中断初始化") {
  return new GovernanceError("INTERRUPTED", message);
}

function throwIfAborted(signal, message) {
  if (signal?.aborted) throw interruptedError(message);
}

function isInterrupted(error, signal) {
  return signal?.aborted
    || error?.code === "INTERRUPTED"
    || error?.code === "ABORT_ERR"
    || error?.name === "AbortError";
}

function stableError(error, fallbackCode = "INIT_FAILED") {
  if (error instanceof GovernanceError) return error.toJSON();
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? "初始化失败",
    details: {}
  };
}

function isPathInside(rootDir, targetPath) {
  if (typeof targetPath !== "string") return false;
  const relative = path.relative(
    path.resolve(rootDir),
    path.resolve(targetPath)
  );
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isKitResourceFileSystemError(error, kitRoot) {
  if (!expectedPrewriteFileSystemCodes.has(error?.code)) return false;
  return kitResourceDirectories.some((directory) => (
    isPathInside(path.join(kitRoot, directory), error.path)
  ));
}

function isExpectedWorkspaceError(error, workspaceDir) {
  return error instanceof GovernanceError
    || (
      expectedPrewriteFileSystemCodes.has(error?.code)
      && isPathInside(workspaceDir, error.path)
    );
}

function isManifestInputError(error, workspaceDir) {
  return isExpectedWorkspaceError(error, workspaceDir)
    || /^YAML/i.test(error?.name ?? "");
}

function normalizeExecutionError(error, signal) {
  if (isInterrupted(error, signal)) {
    return interruptedError().toJSON();
  }
  return stableError(error);
}

function normalizeManifestError(error) {
  const cause = stableError(error, "MANIFEST_READ_FAILED");
  return new GovernanceError(
    "INVALID_MANIFEST",
    "governance-kit.yaml 无效",
    {
      cause: cause.code,
      reason: cause.message
    }
  ).toJSON();
}

function publicPlan(plan) {
  return {
    source: plan.source,
    manifestChange: plan.manifestChange,
    gitStates: plan.gitStates,
    writableTargets: [...plan.writableTargets]
  };
}

function baseResult(workspaceDir, overrides = {}) {
  return {
    command: "init",
    workspace: path.resolve(workspaceDir),
    ok: false,
    applied: false,
    valid: false,
    written: [],
    ...overrides
  };
}

function planningConflictResult(workspaceDir, failed) {
  return baseResult(workspaceDir, {
    status: "conflict",
    code: failed.code,
    failed,
    plan: null,
    report: null
  });
}

function invalidManifestResult(workspaceDir, failed) {
  return planningConflictResult(workspaceDir, failed);
}

function interruptedResultForPlanning(workspaceDir) {
  const failed = interruptedError().toJSON();
  return baseResult(workspaceDir, {
    status: "interrupted",
    code: failed.code,
    failed,
    plan: null,
    report: null
  });
}

function prewriteConflictResult(plan, failed) {
  return baseResult(plan.workspaceDir, {
    status: "conflict",
    code: failed.code,
    failed,
    manifestChange: plan.manifestChange,
    gitStates: plan.gitStates,
    detected: plan.detected,
    plan: publicPlan(plan),
    report: plan.report
  });
}

function conflictResult(plan) {
  const failed = new GovernanceError(
    "INIT_CONFLICT",
    "初始化计划存在文件冲突",
    { conflicts: plan.report.conflicts }
  ).toJSON();
  return prewriteConflictResult(plan, failed);
}

function resultWithoutPlan(resolved, workspaceDir) {
  const questionCode = resolved.questions?.[0]?.code;
  const status = resolved.status === "unsupported"
    ? "unsupported"
    : "needs_input";
  return baseResult(workspaceDir, {
    status,
    code: resolved.code ?? questionCode ?? (
      status === "unsupported" ? "UNSUPPORTED_PROJECT" : "INPUT_REQUIRED"
    ),
    detected: resolved.detected ?? [],
    questions: resolved.questions ?? [],
    warnings: resolved.warnings ?? [],
    plan: null,
    report: null
  });
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

function resolveEvidenceQuestions(evidence, answers) {
  const questions = (evidence.questions ?? []).filter((question) => (
    !isConfirmed(answerFor(answers, question.code, question.component))
  ));
  return {
    ...evidence,
    status: questions.length === 0 ? "ready" : "needs_input",
    code: questions[0]?.code,
    questions
  };
}

function snapshotWithoutContent(snapshot) {
  const { content: _content, ...metadata } = snapshot;
  return metadata;
}

function renderDiff(previous, candidate) {
  const oldLines = previous.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const newLines = candidate.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}

function classifyManifestChange(snapshot, candidate, { reconfigure }) {
  const cleanSnapshot = snapshotWithoutContent(snapshot);
  if (!snapshot.exists) {
    return {
      category: "created",
      snapshot: cleanSnapshot
    };
  }
  if (!reconfigure || snapshot.content === candidate) {
    return {
      category: "unchanged",
      snapshot: cleanSnapshot
    };
  }
  return {
    category: "updated",
    snapshot: cleanSnapshot,
    diff: renderDiff(snapshot.content, candidate)
  };
}

function reportEntryForManifest(manifestPath, manifestChange) {
  const codes = {
    created: "CREATE_MANIFEST",
    updated: "UPDATE_MANIFEST",
    unchanged: "UNCHANGED_MANIFEST"
  };
  return {
    path: manifestPath,
    component: null,
    sourceId: "manifest:governance-kit",
    code: codes[manifestChange.category]
  };
}

function sortReport(report) {
  for (const values of Object.values(report)) {
    if (!Array.isArray(values)) continue;
    values.sort((left, right) => (
      (left.path ?? "").localeCompare(right.path ?? "")
      || (left.code ?? "").localeCompare(right.code ?? "")
    ));
  }
  return report;
}

function mergeWarnings(...warningGroups) {
  const seen = new Set();
  const warnings = [];
  for (const warning of warningGroups.flat()) {
    const key = JSON.stringify(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(warning);
  }
  return warnings;
}

function makeInitPlan({
  source,
  workspaceDir,
  kitRoot,
  manifestPath,
  manifestContent,
  manifestChange,
  gitStates,
  applyPreview,
  detected = [],
  warnings = []
}) {
  const report = {
    created: [...applyPreview.report.created],
    updated: [...applyPreview.report.updated],
    unchanged: [...applyPreview.report.unchanged],
    conflicts: [...applyPreview.report.conflicts],
    warnings: mergeWarnings(applyPreview.report.warnings, warnings),
    errors: [...applyPreview.report.errors]
  };
  report[manifestChange.category].push(
    reportEntryForManifest(manifestPath, manifestChange)
  );

  const writableTargets = [];
  const targetPaths = [manifestPath];
  if (
    manifestChange.category === "created"
    || manifestChange.category === "updated"
  ) {
    writableTargets.push(manifestPath);
  }
  for (const item of applyPreview.operations) {
    targetPaths.push(item.operation.targetPath);
    if (
      item.classification.category === "created"
      || item.classification.category === "updated"
    ) {
      writableTargets.push(item.operation.targetPath);
    }
  }

  return {
    command: "init",
    workspace: workspaceDir,
    workspaceDir,
    kitRoot,
    ok: false,
    status: "ready",
    source,
    detected,
    manifestPath,
    manifestContent,
    manifestChange,
    gitStates,
    applyPreview,
    targetPaths: [...new Set(targetPaths.map((target) => path.resolve(target)))],
    writableTargets: [...new Set(writableTargets.map((target) => path.resolve(target)))],
    report: sortReport(report)
  };
}

async function collectStaleWarnings(targetPaths, signal) {
  const observedPaths = [];
  const directories = [...new Set(targetPaths.map((target) => path.dirname(target)))];
  for (const directory of directories) {
    throwIfAborted(signal);
    try {
      const entries = await readdir(directory);
      throwIfAborted(signal);
      for (const entry of entries) {
        throwIfAborted(signal);
        observedPaths.push(path.join(directory, entry));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return detectStaleTempFiles(targetPaths, observedPaths);
}

async function preflightInitTargets({
  plan,
  preflightTargets,
  signal
}) {
  throwIfAborted(signal);
  for (const _target of plan.writableTargets) {
    throwIfAborted(signal);
  }
  await preflightTargets(plan.writableTargets, { signal });
  throwIfAborted(signal);
}

async function finalizePlan(plan, {
  preflightTargets,
  signal
}) {
  const staleWarnings = await collectStaleWarnings(plan.targetPaths, signal);
  plan.report.warnings = mergeWarnings(plan.report.warnings, staleWarnings)
    .sort((left, right) => (
      (left.path ?? "").localeCompare(right.path ?? "")
      || (left.code ?? "").localeCompare(right.code ?? "")
    ));
  try {
    await preflightInitTargets({ plan, preflightTargets, signal });
  } catch (error) {
    if (isInterrupted(error, signal)) throw error;
    if (!isExpectedWorkspaceError(error, plan.workspaceDir)) throw error;
    return prewriteConflictResult(plan, normalizeExecutionError(error, signal));
  }
  return plan;
}

async function planInitializationUnsafe({
  workspaceDir,
  kitRoot = defaultKitRoot,
  reconfigure = false,
  answers = {},
  preflightTargets = preflightWritableTargets,
  signal,
  snapshotManifest = snapshotPath,
  loadManifest = loadProjectManifest,
  validateEvidence = validateContextEvidence,
  scan = scanWorkspace,
  inspectGit = inspectGitStates,
  inspectContextGit = inspectContextGitStates,
  detect = detectWorkspace,
  createContext = createProjectContext,
  createPreview = createApplyPreview
}) {
  throwIfAborted(signal);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedKitRoot = path.resolve(kitRoot);
  const manifestPath = path.join(resolvedWorkspace, "governance-kit.yaml");
  let manifestSnapshot;

  try {
    await assertRealPathInside(resolvedWorkspace, manifestPath, {
      allowMissing: true
    });
    throwIfAborted(signal);
    manifestSnapshot = await snapshotManifest(manifestPath, {
      includeContent: true
    });
    throwIfAborted(signal);
  } catch (error) {
    if (isInterrupted(error, signal)) throw error;
    if (!isExpectedWorkspaceError(error, resolvedWorkspace)) throw error;
    return planningConflictResult(
      resolvedWorkspace,
      normalizeExecutionError(error, signal)
    );
  }

  let existingContext;
  if (manifestSnapshot.exists) {
    try {
      existingContext = await loadManifest(
        resolvedWorkspace,
        resolvedKitRoot,
        {
          requireComponentDirs: true,
          signal
        }
      );
      throwIfAborted(signal);
    } catch (error) {
      if (isInterrupted(error, signal)) throw error;
      if (isKitResourceFileSystemError(error, resolvedKitRoot)) throw error;
      if (!isManifestInputError(error, resolvedWorkspace)) throw error;
      return invalidManifestResult(
        resolvedWorkspace,
        normalizeManifestError(error)
      );
    }
  }

  if (manifestSnapshot.exists && !reconfigure) {
    const evidence = resolveEvidenceQuestions(
      await validateEvidence(existingContext, { signal }),
      answers
    );
    throwIfAborted(signal);
    if (evidence.status !== "ready") {
      return resultWithoutPlan(evidence, resolvedWorkspace);
    }

    const applyPreview = await createPreview({
      context: existingContext,
      signal
    });
    throwIfAborted(signal);
    const gitStates = await inspectContextGit(existingContext, { signal });
    throwIfAborted(signal);
    const plan = makeInitPlan({
      source: "existing-manifest",
      workspaceDir: resolvedWorkspace,
      kitRoot: resolvedKitRoot,
      manifestPath,
      manifestContent: null,
      manifestChange: {
        category: "unchanged",
        snapshot: snapshotWithoutContent(manifestSnapshot)
      },
      gitStates,
      applyPreview,
      detected: Object.values(existingContext.components).map((component) => ({
        component: component.type,
        profile: component.profile.id,
        path: path.relative(resolvedWorkspace, component.rootDir)
          .replaceAll("\\", "/")
      }))
    });
    return finalizePlan(plan, { preflightTargets, signal });
  }

  throwIfAborted(signal);
  const workspaceScan = await scan({
    workspaceDir: resolvedWorkspace,
    signal
  });
  throwIfAborted(signal);
  const gitStates = await inspectGit({
    gitMarkers: workspaceScan.gitMarkers,
    signal
  });
  throwIfAborted(signal);
  const detection = await detect({
    workspaceDir: resolvedWorkspace,
    scan: workspaceScan,
    signal
  });
  throwIfAborted(signal);
  const resolved = resolveInitManifest({
    workspaceDir: resolvedWorkspace,
    detection,
    answers
  });
  throwIfAborted(signal);
  if (resolved.status !== "ready") {
    return resultWithoutPlan(resolved, resolvedWorkspace);
  }

  const manifestContent = renderInitManifest(resolved.manifest);
  const context = await createContext({
    workspaceDir: resolvedWorkspace,
    kitRoot: resolvedKitRoot,
    manifest: resolved.manifest,
    requireComponentDirs: true,
    signal
  });
  throwIfAborted(signal);
  const applyPreview = await createPreview({ context, signal });
  throwIfAborted(signal);
  const manifestChange = classifyManifestChange(
    manifestSnapshot,
    manifestContent,
    { reconfigure }
  );
  const plan = makeInitPlan({
    source: reconfigure ? "reconfigure" : "detected",
    workspaceDir: resolvedWorkspace,
    kitRoot: resolvedKitRoot,
    gitStates,
    manifestPath,
    manifestContent,
    manifestChange,
    applyPreview,
    detected: detection.candidates,
    warnings: resolved.warnings
  });
  return finalizePlan(plan, { preflightTargets, signal });
}

export async function planInitialization(options) {
  try {
    return await planInitializationUnsafe(options);
  } catch (error) {
    if (isInterrupted(error, options?.signal)) {
      return interruptedResultForPlanning(options.workspaceDir);
    }
    const kitRoot = path.resolve(options?.kitRoot ?? defaultKitRoot);
    if (isKitResourceFileSystemError(error, kitRoot)) throw error;
    if (isExpectedWorkspaceError(error, options.workspaceDir)) {
      return planningConflictResult(
        options.workspaceDir,
        normalizeExecutionError(error, options?.signal)
      );
    }
    throw error;
  }
}

function publicResultFields(plan) {
  return {
    source: plan.source,
    detected: plan.detected,
    manifestChange: plan.manifestChange,
    gitStates: plan.gitStates,
    plan: publicPlan(plan),
    report: plan.report
  };
}

export function plannedResult(plan) {
  if (plan.report.conflicts.length > 0) return conflictResult(plan);
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    ok: true,
    status: "planned"
  });
}

export function needsFinalConfirmationResult(plan) {
  if (plan.report.conflicts.length > 0) return conflictResult(plan);
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    status: "needs_input",
    code: "FINAL_CONFIRMATION_REQUIRED",
    questions: [{
      code: "FINAL_CONFIRMATION_REQUIRED",
      message: "需要确认初始化计划"
    }]
  });
}

function appliedResult(plan, validation, written) {
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    ok: true,
    status: "applied",
    applied: true,
    valid: true,
    written,
    validation
  });
}

function failedValidationResult(plan, validation, written) {
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    status: "failed_validation",
    code: "VALIDATION_FAILED",
    applied: true,
    valid: false,
    written,
    validation
  });
}

function expectedContentByPath(plan) {
  const contents = new Map();
  if (
    plan.manifestChange.category === "created"
    || plan.manifestChange.category === "updated"
  ) {
    contents.set(path.resolve(plan.manifestPath), plan.manifestContent);
  }
  for (const item of plan.applyPreview.operations) {
    if (
      item.classification.category === "created"
      || item.classification.category === "updated"
    ) {
      contents.set(
        path.resolve(item.operation.targetPath),
        item.operation.content
      );
    }
  }
  return contents;
}

async function safeToRerun(plan, written) {
  const expected = expectedContentByPath(plan);
  for (const target of written) {
    const targetPath = path.resolve(target);
    if (!expected.has(targetPath)) return false;
    try {
      if (await readFile(targetPath, "utf8") !== expected.get(targetPath)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function recoveryFor(plan, written) {
  return {
    safeToRerun: await safeToRerun(plan, written),
    nextCommand: "npx dev-governance-kit init --verbose"
  };
}

async function partialFailureResult(plan, error, written) {
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    status: "partial_failure",
    code: error.code,
    applied: true,
    valid: false,
    written,
    failed: error,
    recovery: await recoveryFor(plan, written)
  });
}

async function interruptedResult(plan, error, written) {
  const applied = written.length > 0;
  return baseResult(plan.workspaceDir, {
    ...publicResultFields(plan),
    status: "interrupted",
    code: "INTERRUPTED",
    applied,
    valid: false,
    written,
    failed: error,
    ...(applied
      ? { recovery: await recoveryFor(plan, written) }
      : {})
  });
}

function appendWritten(written, values) {
  for (const target of values ?? []) {
    const resolved = path.resolve(target);
    if (!written.includes(resolved)) written.push(resolved);
  }
}

async function appendCommittedWrites(plan, written) {
  for (const [targetPath, content] of expectedContentByPath(plan)) {
    if (written.includes(targetPath)) continue;
    try {
      if (await readFile(targetPath, "utf8") === content) {
        appendWritten(written, [targetPath]);
      }
    } catch {
      // 未提交或已消失的目标不属于本次成功写入清单。
    }
  }
}

export async function executeInitialization(plan, {
  writeFile = writeUtf8Atomic,
  executePreview = executeApplyPreview,
  validate = validateWorkspace,
  preflightTargets = preflightWritableTargets,
  signal
} = {}) {
  if (plan.status !== "ready") return plan;
  if (plan.report.conflicts.length > 0) return conflictResult(plan);

  const written = [];
  let writePhaseStarted = false;
  try {
    throwIfAborted(signal);
    await preflightTargets(plan.writableTargets, { signal });
    throwIfAborted(signal);
    await assertRealPathInside(
      plan.workspaceDir,
      plan.manifestPath,
      { allowMissing: true }
    );
    throwIfAborted(signal);
    await assertSnapshotUnchanged(plan.manifestChange.snapshot);
    throwIfAborted(signal);
    await assertPreviewUnchanged(plan.applyPreview);
    throwIfAborted(signal);

    if (
      plan.manifestChange.category === "created"
      || plan.manifestChange.category === "updated"
    ) {
      writePhaseStarted = true;
      await writeFile(plan.manifestPath, plan.manifestContent, {
        expectedSnapshot: plan.manifestChange.snapshot,
        rootDir: plan.workspaceDir,
        signal
      });
      appendWritten(written, [plan.manifestPath]);
    }

    throwIfAborted(signal);
    writePhaseStarted = true;
    const applied = await executePreview(plan.applyPreview, {
      allowConflicts: false,
      signal
    });
    appendWritten(written, applied.written);
    throwIfAborted(signal);
    const validation = await validate({
      workspaceDir: plan.workspaceDir,
      kitRoot: plan.kitRoot,
      signal
    });
    throwIfAborted(signal, "用户在验证阶段中断");
    return validation.valid
      ? appliedResult(plan, validation, written)
      : failedValidationResult(plan, validation, written);
  } catch (error) {
    if (
      !isInterrupted(error, signal)
      && (
        isKitResourceFileSystemError(error, plan.kitRoot)
        || !isExpectedWorkspaceError(error, plan.workspaceDir)
      )
    ) {
      throw error;
    }
    appendWritten(written, error?.details?.written);
    if (writePhaseStarted) {
      await appendCommittedWrites(plan, written);
    }
    const failed = normalizeExecutionError(error, signal);
    if (failed.code === "INTERRUPTED") {
      return interruptedResult(plan, failed, written);
    }
    if (written.length === 0) {
      return prewriteConflictResult(plan, failed);
    }
    return partialFailureResult(plan, failed, written);
  }
}

export async function initializeGovernance({
  workspaceDir,
  kitRoot = defaultKitRoot,
  reconfigure = false,
  answers = {},
  dryRun = false,
  yes = false,
  signal
}) {
  const plan = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure,
    answers,
    signal
  });
  if (plan.status !== "ready") return plan;
  if (dryRun) return plannedResult(plan);
  if (!yes) return needsFinalConfirmationResult(plan);
  return executeInitialization(plan, { signal });
}
