// 冒烟测试：用最小 vscode mock 加载产物 bundle，验证模块可加载且导出正确
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

// 构造一个任意属性都返回无操作函数的 vscode mock
const configObj = {
  get: () => undefined,
  update: () => Promise.resolve(),
  inspect: () => undefined,
  onDidChange: () => ({ dispose() {} })
};
const vscodeMock = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === Symbol.toStringTag) return "Module";
      if (prop === "__esModule") return true;
      if (prop === "Uri") {
        return function FakeUri(fsPath) {
          this.fsPath = fsPath;
          this.scheme = "file";
          this.path = "/" + fsPath;
        };
      }
      if (prop === "getConfiguration") {
        return () => configObj;
      }
      const fn = function noop() {};
      return fn;
    }
  }
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(__dirname, "vscode-mock.js");
  return origResolve.call(this, request, ...rest);
};

fs.writeFileSync(
  path.join(__dirname, "vscode-mock.js"),
  "module.exports = global.__vscodeMock__;"
);
global.__vscodeMock__ = vscodeMock;

try {
  const ext = require(path.join(__dirname, "..", "out", "extension.js"));
  const ok =
    typeof ext.activate === "function" && typeof ext.deactivate === "function";
  console.log("activate:", typeof ext.activate);
  console.log("deactivate:", typeof ext.deactivate);
  console.log(ok ? "SMOKE_TEST_OK" : "SMOKE_TEST_FAIL");
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("SMOKE_TEST_CRASH");
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
} finally {
  fs.unlinkSync(path.join(__dirname, "vscode-mock.js"));
}
