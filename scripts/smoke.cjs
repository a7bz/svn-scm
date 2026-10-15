// 冒烟测试：用最小 vscode mock 加载产物 bundle，验证模块可加载且导出正确
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

// 构造一个"任意属性可访问、可调用、可 new"的递归 vscode mock。
// 关键点：属性访问返回的必须仍是一个"可调用代理"，否则形如
// `workspace.getConfiguration(...)` 的链式访问会因取到普通函数而缺少属性。
function FakeUri(fsPath) {
  this.fsPath = fsPath;
  this.scheme = "file";
  this.path = "/" + fsPath;
  this.toString = () => `file://${fsPath}`;
}
FakeUri.file = fsPath => new FakeUri(fsPath);
FakeUri.parse = value => new FakeUri(String(value));
FakeUri.joinPath = (base, ...parts) =>
  new FakeUri([base && base.fsPath, ...parts].join("/"));

function FakeDisposable(fn) {
  this.dispose = typeof fn === "function" ? fn : () => {};
}
FakeDisposable.from = (...items) => new FakeDisposable(() => {
  for (const item of items) {
    if (item && typeof item.dispose === "function") item.dispose();
  }
});

function FakeEventEmitter() {
  this.event = () => new FakeDisposable();
  this.fire = () => {};
  this.dispose = () => {};
}

const cache = new WeakMap();

function makeNoop() {
  const fn = function noop() {};
  const proxy = new Proxy(fn, handler);
  cache.set(fn, proxy);
  return proxy;
}

const handler = {
  get(_target, prop) {
    if (prop === Symbol.toStringTag) return "Module";
    if (prop === Symbol.toPrimitive) return () => "";
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined; // 避免被当作 thenable
    if (prop === "Uri") return FakeUri;
    if (prop === "Disposable") return FakeDisposable;
    if (prop === "EventEmitter") return FakeEventEmitter;
    if (prop === "ConfigurationTarget") {
      return { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
    }
    if (prop === "StatusBarAlignment") return { Left: 1, Right: 2 };
    if (prop === "ViewColumn") return { Active: -1, One: 1, Two: 2 };
    if (prop === "ThemeIcon") {
      return function ThemeIcon(id) {
        this.id = id;
      };
    }
    if (prop === "version") return "0.0.0-mock";
    if (prop === "env") return { appRoot: process.cwd(), language: "en" };
    return makeNoop();
  },
  apply() {
    return makeNoop();
  },
  construct() {
    return makeNoop();
  }
};

const vscodeMock = new Proxy({}, handler);

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
