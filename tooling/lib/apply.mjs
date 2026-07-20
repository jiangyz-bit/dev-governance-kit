import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApplyPreview,
  executeApplyPreview
} from "./apply-preview.mjs";
import { loadProjectManifest } from "./manifest.mjs";

const defaultKitRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export async function applyGovernance({
  workspaceDir,
  kitRoot = defaultKitRoot,
  dryRun = false
}) {
  const context = await loadProjectManifest(workspaceDir, kitRoot);
  const preview = await createApplyPreview({ context });
  if (!dryRun) {
    await executeApplyPreview(preview, { allowConflicts: true });
  }
  return preview.report;
}
