import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createProjectWorkspace(t, { files = {}, directories = [] } = {}) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-scan-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));

  for (const directory of directories) {
    await mkdir(path.join(workspaceDir, directory), { recursive: true });
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(workspaceDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return workspaceDir;
}

export async function resolveGitDir(repositoryDir) {
  const markerPath = path.join(repositoryDir, ".git");
  const marker = await stat(markerPath);
  if (marker.isDirectory()) return markerPath;

  const source = await readFile(markerPath, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/im.exec(source);
  if (!match) throw new Error(`无法解析 Git 工作树标记：${markerPath}`);
  return path.resolve(repositoryDir, match[1]);
}

export async function snapshotGitIndex(repositoryDir) {
  const indexPath = path.join(await resolveGitDir(repositoryDir), "index");
  const info = await stat(indexPath);
  return {
    content: await readFile(indexPath),
    size: info.size,
    mtimeMs: info.mtimeMs
  };
}
