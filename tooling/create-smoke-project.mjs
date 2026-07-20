#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedPomXml = [
  "<project>",
  "  <modelVersion>4.0.0</modelVersion>",
  "  <groupId>example</groupId>",
  "  <artifactId>demo-server</artifactId>",
  "  <version>0.0.1</version>",
  "  <dependencies>",
  "    <dependency><artifactId>spring-boot</artifactId></dependency>",
  "    <dependency><artifactId>mybatis</artifactId></dependency>",
  "    <dependency><artifactId>flyway</artifactId></dependency>",
  "  </dependencies>",
  "</project>",
  ""
].join("\n");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(
        `命令执行失败（${code}）：${command} ${args.join(" ")}\n${stderr}`
      ));
    });
  });
}

async function ensureEmptyDirectory(rootDir) {
  try {
    const info = await lstat(rootDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`烟测项目路径必须是普通目录：${rootDir}`);
    }
    if ((await readdir(rootDir)).length > 0) {
      throw new Error(`烟测项目目录必须为空：${rootDir}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(rootDir, { recursive: true });
  }
}

export async function createSmokeProject(rootDir) {
  if (!rootDir || typeof rootDir !== "string") {
    throw new Error("必须提供烟测项目目录");
  }
  const resolvedRoot = path.resolve(rootDir);
  await ensureEmptyDirectory(resolvedRoot);

  const server = path.join(resolvedRoot, "demo-server");
  const admin = path.join(resolvedRoot, "demo-admin");
  const client = path.join(resolvedRoot, "demo-miniprogram");
  await Promise.all([
    mkdir(server, { recursive: true }),
    mkdir(admin, { recursive: true }),
    mkdir(client, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(server, "pom.xml"), supportedPomXml, "utf8"),
    writeFile(path.join(admin, "package.json"), `${JSON.stringify({
      name: "demo-admin",
      private: true,
      dependencies: { react: "19.1.0" },
      devDependencies: { vite: "7.0.0", typescript: "5.8.0" },
      scripts: { dev: "vite" }
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(admin, "tsconfig.json"), "{}\n", "utf8"),
    writeFile(path.join(client, "project.config.json"), `${JSON.stringify({
      appid: "touristappid",
      miniprogramRoot: "./"
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(client, "app.json"), "{}\n", "utf8")
  ]);

  await run("git", [
    "-c",
    "init.defaultBranch=main",
    "init",
    "--quiet",
    resolvedRoot
  ], {
    cwd: resolvedRoot,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(
        resolvedRoot,
        ".gitconfig-intentionally-absent"
      )
    }
  });

  return { rootDir: resolvedRoot, server, admin, client };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1])
    === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  try {
    const project = await createSmokeProject(process.argv[2]);
    process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
