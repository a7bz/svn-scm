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

### 3. Incoming (remote) changes sometimes not visible
- Commits made by other users were only detected by the periodic poll
  (`svn.remoteChanges.checkFrequency`, default 300 s), and the **Refresh**
  command did not check the server by default (`svn.refresh.remoteChanges`
  defaulted to `false`).
- Incoming changes are now re-checked when the VS Code window regains focus,
  and the default of `svn.refresh.remoteChanges` is now `true` so a manual
  refresh also surfaces remote commits.
- Remote checks no longer run concurrently (guarded via the operation state)
  and background refresh failures no longer produce unhandled rejections.

### 4. XML parser error handling
- `infoParser`, `logParser`, `listParser`, `diffParser` and `statusParser`
  called `reject()` without `return`, so a parse error still fell through to
  `resolve()` (and could throw on undefined data). They now reject and return.

### 5. Tree view listener leak
- `RepositoryNode` registered a `onDidChangeStatus` listener on every tree
  refresh without ever disposing it. Nodes are now cached per repository in
  `SvnProvider` and disposed with their listeners, and the node also reacts to
  incoming-change updates.

### 6. Revert fails when many files across multiple subdirectories changed
- Reverting a large changeset (e.g. files modified in many subdirectories) built
  a single `svn revert` command line containing every path. On Windows this
  exceeded the ~32k-character command line limit and failed with
  `spawn ENAMETOOLONG`, surfaced to the user as "Unable to revert".
- `svnRepository.revert()` now splits the paths into chunks of at most
  `MAX_CLI_LENGTH` (30000) characters via the new `splitInChunks` helper in
  `util.ts` and runs one `svn revert --depth <depth>` per chunk, preserving the
  original path order and concatenating the output.

### 7. Misc small fixes
- `svn.resolveAll` used `resourceUri.path` (POSIX) instead of `fsPath` and
  continued iterating after reporting "No Conflicts".
- `svn.changelist` compared against `resourceUri.path` instead of `fsPath`.
- `SvnError` no longer overwrites an explicit message with the underlying
  error message.
- Removed a leftover `console.log("here")` debug statement.
- Replaced non-extractable `l10n.t(\`...${x}...\`)` template literals with
  placeholder-based `l10n.t("... {0} ...", x)` calls across commands and views
  so the strings are actually translated, and added the new keys to the
  English/Chinese bundles.

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
