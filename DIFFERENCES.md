# Differences from JohnstonCode/svn-scm

This document lists all changes made in this fork compared to the original
[svn-scm](https://github.com/JohnstonCode/svn-scm) project.

- **Fork base**: upstream release **v2.17.0** (`JohnstonCode/svn-scm`)
- **Fork identity**: published as `a7bz.svn-enhanced-by-a7bz` (renamed from `a7bz.svn-a7bz`)

## Added Features

### 1. Three-way merge editor for conflict resolution
- New command `svn.openConflict` ("Open Conflict Merge Resolution").
- Reads conflict metadata via `svn info --xml` (BASE / incoming / working copy)
  and opens VS Code's built-in three-way merge editor (`_open.mergeEditor`).
- Merge results are written directly back to the working copy file.
- Left-clicking a conflicted file in the SCM conflicts group now opens the
  merge editor instead of a plain diff.

### 2. Sub-repositories detection
- Automatically scans workspace sub-folders for independent SVN repositories
  (folders containing their own `.svn`).
- New view section "Other SVN repositories" (`CandidateRepositoriesNode`) in
  the SVN activity bar shows detected candidates before they are opened.
- New commands:
  - `svn.enableSubRepositories` — enable batch mode for all detected sub-repositories.
  - `svn.openCandidateRepository` — pick a candidate from the tree view / QuickPick.
- New settings:
  - `svn.subRepositories.autoScan.enabled` (default `true`)
  - `svn.subRepositories.detectedDismissed`
- New context key `svnCandidateRepositoriesFound` controls menu visibility.

### 3. One-click packaging script
- New `scripts/build.mjs` wraps build + vsix packaging (`pnpm run package`),
  compatible with Node 17+ OpenSSL legacy provider.
- New `scripts/smoke.cjs` smoke test script.

## Fixed Bugs

### 1. "Missing dependency" error after packaging/installing
- Packaged extension failed to resolve `iconv-lite` / `jschardet` at runtime
  (worked only when debugging under F5).
- Root causes: VS Code moved to scoped `@vscode/iconv-lite-umd` (old lookup name
  `iconv-lite-umd` gone) and VS Code's built-in `jschardet` is a trimmed build
  without `main`/`index.js` (directory require fails).
- Fix: upgraded dependency to `@vscode/iconv-lite-umd`, added `extraPaths`
  probing to `getNodeModule`, and added fallback lookup for
  `jschardet/dist/jschardet.min.js`.

### 2. TypeScript strict-mode type errors
- Errors are now explicitly asserted to `Error | svnErrorCode` before accessing
  properties in `repository`, `checkout`, `extension`, `runTest`.
- Renamed a shadowed `process` variable to `child` in `svn.ts` to avoid
  conflicting with the global `process`.
- Added explicit generic types to the `reduce` calls in `svnRepository.ts`.

## Changed Behaviors

- **Build system**: migrated from `yarn + webpack` to `pnpm + vite`.
  - Removed `webpack.config.js`, `yarn.lock`; added `vite.config.ts`, `pnpm-lock.yaml`.
  - Replaced `node-sass` with Dart `sass` (avoids `node-gyp` failures).
  - Declared `packageManager: pnpm` and raised engine requirement to `node >= 18`.
  - Enabled `esModuleInterop` / `allowSyntheticDefaultImports`; import styles of
    `dayjs`, `minimatch`, `mocha`, `glob` adjusted accordingly.
- **Activation**: `activationEvents` narrowed from `*` to `onStartupFinished`
  (extension no longer loads on every startup event).
- **CI workflows** (`.github/workflows`): upgraded `checkout`/`setup-node`/`cache`
  actions to v4 and switched to `pnpm install`.
- **Conflict UX**: conflict resources open the three-way merge editor by default.
- **Extension identity / metadata**: renamed publisher, name, display name,
  description and keywords to clearly distinguish this fork from the original
  (see `package.json`).

## Removed Features

- `webpack.config.js` and `yarn.lock` removed as part of the build migration.
- No user-facing feature has been removed.

## Compatibility Notes

- This fork maintains compatibility with the original extension's core
  functionality and all `svn.*` configuration settings.
- Workspace / user settings from the original extension remain valid.
- All modifications are fully MIT-licensed.
