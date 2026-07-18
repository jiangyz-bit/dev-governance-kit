import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";

export async function createFixtureWorkspace(t, fixtureName) {
  const root = await mkdtemp(path.join(tmpdir(), "governance-kit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fixturePath = new URL(`../fixtures/${fixtureName}/governance-kit.yaml`, import.meta.url);
  const manifestPath = path.join(root, "governance-kit.yaml");
  await copyFile(fixturePath, manifestPath);
  const manifest = parse(await readFile(manifestPath, "utf8"));
  for (const component of Object.values(manifest.components)) {
    await mkdir(path.join(root, component.path), { recursive: true });
  }
  return root;
}
