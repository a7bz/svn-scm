// Only this file is allowed to import VSCode modules
// tslint:disable: import-blacklist

import { env, window } from "vscode";

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;

function getNodeModule<T>(
  moduleName: string,
  showError = true,
  extraPaths: string[] = []
): T | undefined {
  const r =
    typeof __webpack_require__ === "function"
      ? __non_webpack_require__
      : require;

  const paths = [
    `${env.appRoot}/node_modules.asar/${moduleName}`,
    `${env.appRoot}/node_modules/${moduleName}`,
    moduleName,
    ...extraPaths
  ];

  for (const p of paths) {
    try {
      return r(p);
    } catch (err) {
      // Not in path.
    }
  }

  if (showError) {
    window.showErrorMessage(`Missing dependency: ${moduleName}`);
  }

  return undefined;
}

let iconv_lite = getNodeModule(
  "@vscode/iconv-lite-umd",
  false
) as typeof import("@vscode/iconv-lite-umd");
if (!iconv_lite) {
  iconv_lite = getNodeModule("iconv-lite-umd", false) as any;
}
if (!iconv_lite) {
  iconv_lite = getNodeModule("iconv-lite") as any;
}
export const iconv = iconv_lite;

// VSCode 内置的 jschardet 是裁剪版: 只有 dist/jschardet.min.js 且 package.json 没有
// main/index.js, 目录式 require 会失败, 因此额外探测可直接加载的入口文件。
const vscodeJschardetDist = `${env.appRoot}/node_modules.asar/jschardet/dist/jschardet.min.js`;
const legacyJschardetDist = `${env.appRoot}/node_modules/jschardet/dist/jschardet.min.js`;

export const jschardet = getNodeModule("jschardet", true, [
  vscodeJschardetDist,
  legacyJschardetDist
]) as typeof import("jschardet");
