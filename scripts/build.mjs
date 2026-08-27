#!/usr/bin/env node
/**
 * 一键编译 / 发布脚本
 *
 * 用法:
 *   pnpm run package            # 完整流程: tsc 校验 + vite 构建 + sass 构建 + vsce 打包
 *   pnpm run package:build      # 仅编译 (tsc + vite + sass)
 *   pnpm run package:vsix       # 仅打包 vsix (要求先 build)
 *
 * 说明:
 *   - 自动为 Node 17+ 注入 --openssl-legacy-provider (避免旧依赖的 OpenSSL 哈希报错)
 *   - vsce 打包使用 --no-dependencies, 兼容 pnpm 的 symlink node_modules
 *   - 产物: svn-scm-<version>.vsix
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const vsce = isWin ? "vsce.cmd" : "vsce";

function ensureLegacyProvider() {
  const major = Number(process.versions.node.split(".")[0]);
  const current = process.env.NODE_OPTIONS || "";
  if (major >= 17 && !current.includes("--openssl-legacy-provider")) {
    process.env.NODE_OPTIONS = `${current} --openssl-legacy-provider`.trim();
  }
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    ...opts
  });
  if (result.status !== 0) {
    console.error(
      `\n[package] 命令失败 (exit ${result.status}): ${cmd} ${args.join(" ")}`
    );
    process.exit(result.status || 1);
  }
}

function packageVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function runTypeCheck() {
  run(pnpm, ["run", "test-compile"]);
}

function runBuild() {
  run(pnpm, ["run", "build:ts"]);
  run(pnpm, ["run", "build:css"]);
}

function runPackage() {
  const out = path.join(root, `svn-scm-${packageVersion()}.vsix`);
  run(vsce, ["package", "--no-dependencies", "-o", out]);
  console.log(`\n[package] 打包完成: ${out}`);
}

const mode = process.argv[2] || "all";
ensureLegacyProvider();

switch (mode) {
  case "build":
    runTypeCheck();
    runBuild();
    break;
  case "vsix":
    runPackage();
    break;
  case "all":
  default:
    runTypeCheck();
    runBuild();
    runPackage();
    break;
}
