import path from "node:path";
import { lstat } from "node:fs/promises";
import { loadCatalog } from "./catalog.mjs";
import { GovernanceError } from "./errors.mjs";
import { assertRealPathInside, readYamlFile, resolveInside } from "./files.mjs";
import { validateSchema } from "./schema-validator.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

export async function createProjectContext({
  workspaceDir,
  kitRoot,
  manifest,
  requireComponentDirs = false,
  signal
}) {
  throwIfAborted(signal);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedKitRoot = path.resolve(kitRoot);
  validateSchema("governance-kit", manifest);
  throwIfAborted(signal);
  const catalog = await loadCatalog(resolvedKitRoot);
  throwIfAborted(signal);
  const components = {};

  for (const [type, component] of Object.entries(manifest.components)) {
    throwIfAborted(signal);
    const profile = catalog.profiles.get(component.profile);
    if (!profile) {
      throw new GovernanceError("PROFILE_NOT_FOUND", `Profile 不存在：${component.profile}`, {
        component: type,
        profile: component.profile
      });
    }
    if (!profile.componentTypes.includes(type)) {
      throw new GovernanceError(
        "INCOMPATIBLE_PROFILE",
        `Profile ${component.profile} 不支持组件 ${type}`,
        { component: type, profile: component.profile }
      );
    }
    const rootDir = resolveInside(resolvedWorkspace, component.path);
    if (requireComponentDirs) {
      try {
        const info = await lstat(rootDir);
        if (!info.isDirectory()) {
          throw new Error("组件路径不是目录");
        }
        await assertRealPathInside(resolvedWorkspace, rootDir, { allowMissing: false });
      } catch (error) {
        if (error.code === "UNSAFE_REAL_PATH") throw error;
        throw new GovernanceError("COMPONENT_DIR_INVALID", `组件目录不可用：${rootDir}`, {
          component: type,
          rootDir,
          cause: error.code ?? error.message
        });
      }
    }
    components[type] = {
      type,
      rootDir,
      config: component,
      profile
    };
  }

  for (const [contract, owner] of Object.entries(manifest.contracts)) {
    throwIfAborted(signal);
    if (!components[owner]) {
      throw new GovernanceError(
        "UNKNOWN_CONTRACT_OWNER",
        `${contract} 指向不存在的组件：${owner}`,
        { contract, owner }
      );
    }
  }

  return {
    kitRoot: resolvedKitRoot,
    workspaceDir: resolvedWorkspace,
    manifest,
    catalog,
    components
  };
}

export async function loadProjectManifest(
  workspaceDir,
  kitRoot,
  { requireComponentDirs = false, signal } = {}
) {
  const resolvedWorkspace = path.resolve(workspaceDir);
  throwIfAborted(signal);
  const manifest = await readYamlFile(path.join(resolvedWorkspace, "governance-kit.yaml"));
  throwIfAborted(signal);
  return createProjectContext({
    workspaceDir: resolvedWorkspace,
    kitRoot,
    manifest,
    requireComponentDirs,
    signal
  });
}
