import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { stringify } from "yaml";

const execFileAsync = promisify(execFile);

export async function createProjectWorkspace(t, {
  files = {},
  directories = [],
  prefix = "governance-scan-"
} = {}) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), prefix));
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

const componentFiles = {
  server: {
    "server/pom.xml": [
      "<project><dependencies>",
      "<dependency><artifactId>spring-boot</artifactId></dependency>",
      "<dependency><artifactId>mybatis</artifactId></dependency>",
      "<dependency><artifactId>flyway</artifactId></dependency>",
      "</dependencies></project>"
    ].join("")
  },
  admin: {
    "admin/package.json": JSON.stringify({
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "7.0.0" }
    }),
    "admin/tsconfig.json": "{}"
  },
  client: {
    "miniprogram/project.config.json": "{}",
    "miniprogram/app.json": "{}"
  }
};

export async function createDetectedWorkspace(t, mode = "monorepo", options = {}) {
  const workspaceDir = await createProjectWorkspace(t, {
    prefix: options.prefix,
    files: {
      ...componentFiles.server,
      ...componentFiles.admin,
      ...componentFiles.client,
      ...(options.files ?? {})
    }
  });
  const repositoryRoots = mode === "multi-repo"
    ? ["server", "admin", "miniprogram"].map((component) => (
        path.join(workspaceDir, component)
      ))
    : [workspaceDir];
  for (const repositoryRoot of repositoryRoots) {
    await execFileAsync("git", [
      "-c", "init.defaultBranch=main",
      "init", "--quiet", repositoryRoot
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
      }
    });
  }
  return workspaceDir;
}

export async function snapshotWorkspace(rootDir, relativeDir = "") {
  const result = {};
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const portablePath = relativePath.replaceAll("\\", "/");
    const absolutePath = path.join(rootDir, relativePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      result[portablePath] = {
        type: "link",
        device: info.dev,
        inode: info.ino,
        size: info.size,
        target: await readlink(absolutePath)
      };
    } else if (info.isDirectory()) {
      result[`${portablePath}/`] = { type: "directory" };
      Object.assign(result, await snapshotWorkspace(rootDir, relativePath));
    } else if (info.isFile()) {
      result[portablePath] = {
        type: "file",
        device: info.dev,
        inode: info.ino,
        size: info.size,
        content: await readFile(absolutePath)
      };
    } else {
      result[portablePath] = { type: "other" };
    }
  }
  return result;
}

export function changedWorkspacePaths(before, after) {
  return [...new Set([
    ...Object.keys(before),
    ...Object.keys(after)
  ])].filter((relativePath) => (
    !isDeepStrictEqual(before[relativePath], after[relativePath])
  )).sort();
}

export function expectedWorkspaceChanges(before, workspaceDir, written) {
  const rootDir = path.resolve(workspaceDir);
  const expected = new Set();
  for (const targetPath of written) {
    const relativePath = path.relative(rootDir, path.resolve(targetPath));
    if (
      relativePath === ""
      || relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      throw new Error(`写入路径逃逸工作区：${targetPath}`);
    }
    const portablePath = relativePath.replaceAll("\\", "/");
    expected.add(portablePath);
    const parts = portablePath.split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      const directoryKey = `${parent}/`;
      if (!(directoryKey in before)) expected.add(directoryKey);
    }
  }
  return [...expected].sort();
}

export function manifestForLinkedServer(componentPath = "server") {
  return stringify({
    schemaVersion: 1,
    project: {
      name: "linked-project",
      repositoryMode: "monorepo"
    },
    components: {
      server: {
        profile: "java-springboot-mybatis",
        path: componentPath
      }
    },
    contracts: {
      statusRegistryOwner: "server",
      apiContractOwner: "server"
    },
    generation: { conflictPolicy: "report" }
  }, { lineWidth: 0 });
}

export async function createRealLink(t, {
  target,
  linkPath,
  type
}) {
  try {
    await symlink(target, linkPath, type);
    return { supported: true };
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip(`当前平台不能创建 ${type} 链接：${error.code}`);
      return { supported: false, error };
    }
    throw error;
  }
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
