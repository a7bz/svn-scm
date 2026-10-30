// 用最小 vscode mock 直接跑解析器回归测试（不启动 VS Code）。
const Module = require("node:module");
const path = require("node:path");
const Mocha = require("mocha");

function makeNoop() {
  const fn = function noop() {};
  return new Proxy(fn, handler);
}

const handler = {
  get(_t, prop) {
    if (prop === Symbol.toStringTag) return "Module";
    if (prop === Symbol.toPrimitive) return () => "";
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
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
global.__vscodeMock__ = vscodeMock;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "..", "scripts", "vscode-mock.js");
  }
  return origResolve.call(this, request, ...rest);
};

const mocha = new Mocha({ ui: "tdd", color: true });
mocha.addFile(path.join(__dirname, "..", "out", "test", "parsers.test.js"));
mocha.addFile(path.join(__dirname, "..", "out", "test", "blame.test.js"));
mocha.run(failures => process.exit(failures > 0 ? 1 : 0));
