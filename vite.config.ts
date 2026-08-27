import { builtinModules } from "module";
import * as path from "path";
import { defineConfig } from "vite";

const externals = [
  "vscode",
  ...builtinModules,
  ...builtinModules.map(moduleName => `node:${moduleName}`)
];

export default defineConfig({
  build: {
    target: "es2019",
    outDir: "out",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "src", "extension.ts"),
      formats: ["cjs"],
      fileName: () => "extension.js"
    },
    rollupOptions: {
      external: externals
    }
  }
});