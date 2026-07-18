import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { GovernanceError } from "./errors.mjs";

export async function readYamlFile(filePath) {
  const source = await readFile(filePath, "utf8");
  return parse(source);
}

export function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GovernanceError("UNSAFE_PATH", `路径逃逸出工作区：${relativePath}`, {
      root,
      target
    });
  }
  return target;
}

export async function writeUtf8Atomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.governance-kit.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}
