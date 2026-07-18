import path from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { GovernanceError } from "./errors.mjs";
import { readYamlFile, resolveInside } from "./files.mjs";
import { validateSchema } from "./schema-validator.mjs";

export async function loadProjectManifest(workspaceDir, kitRoot) {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedKitRoot = path.resolve(kitRoot);
  const manifest = await readYamlFile(path.join(resolvedWorkspace, "governance-kit.yaml"));
  validateSchema("governance-kit", manifest);
  const catalog = await loadCatalog(resolvedKitRoot);
  const components = {};

  for (const [type, component] of Object.entries(manifest.components)) {
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
    components[type] = {
      type,
      rootDir: resolveInside(resolvedWorkspace, component.path),
      config: component,
      profile
    };
  }

  for (const [contract, owner] of Object.entries(manifest.contracts)) {
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
