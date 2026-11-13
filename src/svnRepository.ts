import * as path from "path";
import * as tmp from "tmp";
import { Uri, workspace } from "vscode";
import {
  ConstructorPolicy,
  ICpOptions,
  IExecutionResult,
  IFileStatus,
  IIgnoreRule,
  ISvnBlameLine,
  ISvnExternal,
  ISvnInfo,
  ISvnLogEntry,
  ISvnProperty,
  Status,
  SvnDepth,
  ISvnPathChange,
  ISvnPath,
  ISvnListItem
} from "./common/types";
import { sequentialize } from "./decorators";
import * as encodeUtil from "./encoding";
import { exists, writeFile, stat, readdir } from "./fs";
import { getBranchName } from "./helpers/branch";
import { configuration } from "./helpers/configuration";
import { parseSvnBlame } from "./parser/blameParser";
import { parseInfoXml } from "./parser/infoParser";
import {
  parseIgnoreProperties,
  parseSvnExternals,
  parseSvnProplist
} from "./parser/propertyParser";
import { parseSvnList } from "./parser/listParser";
import { parseSvnLog } from "./parser/logParser";
import { parseStatusXml } from "./parser/statusParser";
import { svnErrorCodes, Svn, BufferResult } from "./svn";
import SvnError from "./svnError";
import {
  fixPathSeparator,
  fixPegRevision,
  isDescendant,
  normalizePath,
  splitInChunks,
  MAX_CLI_LENGTH,
  unwrap
} from "./util";
import { matchAll } from "./util/globMatch";
import { parseDiffXml } from "./parser/diffParser";

// `svn status` runs in the background (poll, file watcher, window focus). A
// hung process (network drive, server stall) would otherwise keep the refresh
// scheduler busy forever, so give it a generous upper bound.
const LOCAL_STATUS_TIMEOUT = 2 * 60 * 1000;
const REMOTE_STATUS_TIMEOUT = 5 * 60 * 1000;

export class Repository {
  private _infoCache: {
    [index: string]: ISvnInfo;
  } = {};
  private _info?: ISvnInfo;

  public username?: string;
  public password?: string;

  constructor(
    private svn: Svn,
    public root: string,
    public workspaceRoot: string,
    policy: ConstructorPolicy
  ) {
    if (policy === ConstructorPolicy.LateInit) {
      return (async (): Promise<Repository> => {
        return this;
      })() as unknown as Repository;
    }
    return (async (): Promise<Repository> => {
      await this.updateInfo();
      return this;
    })() as unknown as Repository;
  }

  public async updateInfo() {
    const result = await this.exec([
      "info",
      "--xml",
      fixPegRevision(this.workspaceRoot ? this.workspaceRoot : this.root)
    ]);

    this._info = await parseInfoXml(result.stdout);
  }

  public async exec(
    args: string[],
    options: ICpOptions = {}
  ): Promise<IExecutionResult> {
    options.username = this.username;
    options.password = this.password;

    return this.svn.exec(this.workspaceRoot, args, options);
  }

  public async execBuffer(
    args: string[],
    options: ICpOptions = {}
  ): Promise<BufferResult> {
    options.username = this.username;
    options.password = this.password;

    return this.svn.execBuffer(this.workspaceRoot, args, options);
  }

  public removeAbsolutePath(file: string) {
    file = fixPathSeparator(file);

    file = path.relative(this.workspaceRoot, file);

    if (file === "") {
      file = ".";
    }

    return fixPegRevision(file);
  }

  public async getStatus(params: {
    includeIgnored?: boolean;
    includeExternals?: boolean;
    checkRemoteChanges?: boolean;
  }): Promise<IFileStatus[]> {
    params = Object.assign(
      {},
      {
        includeIgnored: false,
        includeExternals: true,
        checkRemoteChanges: false
      },
      params
    );

    const args = ["stat", "--xml"];

    if (params.includeIgnored) {
      args.push("--no-ignore");
    }
    if (!params.includeExternals) {
      args.push("--ignore-externals");
    }
    if (params.checkRemoteChanges) {
      args.push("--show-updates");
    }

    const result = await this.exec(args, {
      timeout: params.checkRemoteChanges
        ? REMOTE_STATUS_TIMEOUT
        : LOCAL_STATUS_TIMEOUT
    });

    const status: IFileStatus[] = await parseStatusXml(result.stdout);

    for (const s of status) {
      if (s.status === Status.EXTERNAL) {
        try {
          const info = await this.getInfo(s.path);
          s.repositoryUuid = info.repository.uuid;
        } catch (error) {
          console.error(error);
        }
      }
    }

    return status;
  }

  public get info(): ISvnInfo {
    return unwrap(this._info);
  }

  public resetInfoCache(file: string = "") {
    delete this._infoCache[file];
  }

  @sequentialize
  public async getInfo(
    file: string = "",
    revision?: string,
    skipCache: boolean = false,
    isUrl: boolean = false
  ): Promise<ISvnInfo> {
    if (!skipCache && this._infoCache[file]) {
      return this._infoCache[file];
    }

    const args = ["info", "--xml"];

    if (revision) {
      args.push("-r", revision);
    }

    if (file) {
      if (!isUrl) {
        file = fixPathSeparator(file);
      }
      args.push(file);
    }

    const result = await this.exec(args);

    this._infoCache[file] = await parseInfoXml(result.stdout);

    // Cache for 2 minutes
    setTimeout(() => {
      this.resetInfoCache(file);
    }, 2 * 60 * 1000);

    return this._infoCache[file];
  }

  public async getChanges(): Promise<ISvnPathChange[]> {
    // First, check to see if this branch was copied from somewhere.
    let args = [
      "log",
      "-r1:HEAD",
      "--limit=1",
      "--stop-on-copy",
      "--xml",
      "--with-all-revprops",
      "--verbose"
    ];
    let result = await this.exec(args);
    const entries = await parseSvnLog(result.stdout);

    if (entries.length === 0 || entries[0].paths.length === 0) {
      return [];
    }

    const copyCommitPath = entries[0].paths[0];

    if (
      typeof copyCommitPath.copyfromRev === "undefined" ||
      typeof copyCommitPath.copyfromPath === "undefined" ||
      typeof copyCommitPath._ === "undefined" ||
      copyCommitPath.copyfromRev.trim().length === 0 ||
      copyCommitPath.copyfromPath.trim().length === 0 ||
      copyCommitPath._.trim().length === 0
    ) {
      return [];
    }

    const copyFromPath = copyCommitPath.copyfromPath;
    const copyFromRev = copyCommitPath.copyfromRev;
    const copyToPath = copyCommitPath._;
    const copyFromUrl = this.info.repository.root + copyFromPath;
    const copyToUrl = this.info.repository.root + copyToPath;

    // Get last merge revision from path that this branch was copied from.
    args = ["mergeinfo", "--show-revs=merged", copyFromUrl, copyToUrl];
    result = await this.exec(args);
    const revisions = result.stdout.trim().split("\n");
    let latestMergedRevision: string = "";

    if (revisions.length) {
      latestMergedRevision = revisions[revisions.length - 1];
    }

    if (latestMergedRevision.trim().length === 0) {
      latestMergedRevision = copyFromRev;
    }

    // Now, diff the source branch at the latest merged revision with the current branch's revision
    const info = await this.getInfo(copyToUrl, undefined, true, true);
    args = [
      "diff",
      `${copyFromUrl}@${latestMergedRevision}`,
      copyToUrl,
      "--ignore-properties",
      "--xml",
      "--summarize"
    ];
    result = await this.exec(args);
    let paths: ISvnPath[];
    try {
      paths = await parseDiffXml(result.stdout);
    } catch (err) {
      return [];
    }

    const changes: ISvnPathChange[] = [];

    // Now, we have all the files that this branch changed.
    for (const path of paths) {
      changes.push({
        oldPath: Uri.parse(path._),
        newPath: Uri.parse(path._.replace(copyFromUrl, copyToUrl)),
        oldRevision: latestMergedRevision.replace("r", ""),
        newRevision: info.revision,
        item: path.item,
        props: path.props,
        kind: path.kind,
        repo: Uri.parse(this.info.repository.root),
        localPath: Uri.parse(path._.replace(copyFromUrl, ""))
      });
    }

    return changes;
  }

  public async show(file: string | Uri, revision?: string): Promise<string> {
    const args = ["cat"];

    let uri: Uri;
    let filePath: string;

    if (file instanceof Uri) {
      uri = file;
      filePath = file.toString(true);
    } else {
      uri = Uri.file(file);
      filePath = file;
    }

    const isChild =
      uri.scheme === "file" && isDescendant(this.workspaceRoot, uri.fsPath);

    let target: string = filePath;

    if (isChild) {
      target = this.removeAbsolutePath(target);
    }

    if (revision) {
      args.push("-r", revision);
      if (
        isChild &&
        !["BASE", "COMMITTED", "PREV"].includes(revision.toUpperCase())
      ) {
        const info = await this.getInfo();
        target = info.url + "/" + target.replace(/\\/g, "/");
        // TODO move to SvnRI
      }
    }

    args.push(target);

    /**
     * ENCODE DETECTION
     * if TextDocuments exists and autoGuessEncoding is true,
     * try detect current encoding of content
     */
    const configs = workspace.getConfiguration("files", uri);

    let encoding: string | undefined | null = configs.get("encoding");
    let autoGuessEncoding: boolean = configs.get<boolean>(
      "autoGuessEncoding",
      false
    );

    const textDocument = workspace.textDocuments.find(
      doc => normalizePath(doc.uri.fsPath) === normalizePath(filePath)
    );

    if (textDocument) {
      // Load encoding by languageId
      const languageConfigs = workspace.getConfiguration(
        `[${textDocument.languageId}]`,
        uri
      );
      if (languageConfigs["files.encoding"] !== undefined) {
        encoding = languageConfigs["files.encoding"];
      }
      if (languageConfigs["files.autoGuessEncoding"] !== undefined) {
        autoGuessEncoding = languageConfigs["files.autoGuessEncoding"];
      }

      if (autoGuessEncoding) {
        // The `getText` return a `utf-8` string
        const buffer = Buffer.from(textDocument.getText(), "utf-8");
        const detectedEncoding = encodeUtil.detectEncoding(buffer);
        if (detectedEncoding) {
          encoding = detectedEncoding;
        }
      }
    } else {
      const svnEncoding: string | undefined =
        configuration.get<string>("default.encoding");
      if (svnEncoding) {
        encoding = svnEncoding;
      }
    }

    const experimental = configuration.get<boolean>(
      "experimental.detect_encoding",
      false
    );
    if (experimental) {
      encoding = null;
    }

    const result = await this.exec(args, { encoding });

    return result.stdout;
  }

  public async showBuffer(
    file: string | Uri,
    revision?: string
  ): Promise<Buffer> {
    const args = ["cat"];

    let uri: Uri;
    let filePath: string;

    if (file instanceof Uri) {
      uri = file;
      filePath = file.toString(true);
    } else {
      uri = Uri.file(file);
      filePath = file;
    }

    const isChild =
      uri.scheme === "file" && isDescendant(this.workspaceRoot, uri.fsPath);

    let target: string = filePath;

    if (isChild) {
      target = this.removeAbsolutePath(target);
    }

    if (revision) {
      args.push("-r", revision);
      if (
        isChild &&
        !["BASE", "COMMITTED", "PREV"].includes(revision.toUpperCase())
      ) {
        const info = await this.getInfo();
        target = info.url + "/" + target.replace(/\\/g, "/");
        // TODO move to SvnRI
      }
    }

    args.push(target);

    const result = await this.execBuffer(args);

    return result.stdout;
  }

  public async commitFiles(message: string, files: string[]) {
    files = await this.addMissingParents(files);

    const options: string[] = [];

    if (await exists(path.join(this.workspaceRoot, message))) {
      options.push("--force-log");
    }

    let tmpFile: tmp.FileResult | undefined;

    /**
     * For message with line break or non:
     * \x00-\x7F -> ASCII
     * \x80-\xFF -> Latin
     * Use a file for commit message
     */
    if (/\n|[^\x00-\x7F\x80-\xFF]/.test(message)) {
      tmp.setGracefulCleanup();

      tmpFile = tmp.fileSync({
        prefix: "svn-commit-message-"
      });

      await writeFile(tmpFile.name, message, "UTF-8");

      options.push("-F", tmpFile.name);
      options.push("--encoding", "UTF-8");
    } else {
      options.push("-m", message);
    }

    // Prevents commit the files inside the folder
    options.push("--depth", "empty");

    // A commit must stay a single transaction: splitting it would create one
    // revision per chunk. `--targets` cannot be used instead because SVN reads
    // that file in the system ANSI code page on Windows, breaking non-ASCII
    // paths. The expanded unversioned view can therefore hit the command line
    // limit on very large selections, which is reported as a normal SVN error.
    const result = await this.exec(["commit", ...files, ...options]);

    // Remove temporary file if exists
    if (tmpFile) {
      tmpFile.removeCallback();
    }

    const matches = result.stdout.match(/Committed revision (.*)\./i);
    if (matches && matches[0]) {
      const sendedFiles = (
        result.stdout.match(/(Sending|Adding|Deleting)\s+/g) || []
      ).length;

      const filesMessage = `${sendedFiles} ${
        sendedFiles === 1 ? "file" : "files"
      } commited`;

      return `${filesMessage}: revision ${matches[1]}.`;
    }

    return result.stdout;
  }

  public async addFilesByIgnore(files: string[], ignoreList: string[]) {
    const allFiles = async (file: string): Promise<string[]> => {
      if ((await stat(file)).isDirectory()) {
        return (
          await Promise.all(
            (
              await readdir(file)
            ).map(subfile => {
              const abspath = path.resolve(file + path.sep + subfile);
              const relpath = this.removeAbsolutePath(abspath);
              if (
                !matchAll(path.sep + relpath, ignoreList, {
                  dot: true,
                  matchBase: true
                })
              ) {
                return allFiles(abspath);
              }
              return [];
            })
          )
        ).reduce((acc: string[], cur: string[]) => acc.concat(cur), [file]);
      }
      return [file];
    };
    files = (await Promise.all(files.map(file => allFiles(file)))).flat();

    // Every entry of the tree is passed explicitly and `--depth=empty` stops
    // SVN from walking a directory again, so a directory and its children can
    // be listed together without the `E200009` "already versioned" error.
    return this.execWithTargets(["add"], this.collapseTargets(files), [
      "--parents",
      "--depth=empty"
    ]);
  }

  public addFiles(files: string[]) {
    const ignoreList = configuration.get<string[]>("sourceControl.ignore");
    if (ignoreList.length > 0) {
      return this.addFilesByIgnore(files, ignoreList);
    }

    // `--parents` schedules the parent directories for addition too. This is
    // required when the Source Control view lists the individual files of an
    // unversioned directory (the default now): adding `dir/a.txt` alone fails
    // with `E150000` because `dir` is not under version control yet.
    //
    // This call is recursive, so a selected directory already covers its
    // children and passing both would fail with `E200009`.
    return this.execWithTargets(
      ["add"],
      this.removeDescendants(this.collapseTargets(files)),
      ["--parents"]
    );
  }

  /**
   * Convert absolute paths to working copy relative ones and drop duplicates.
   *
   * `svn add` fails with `E200009` when the same target is passed twice, which
   * happens when the same file is selected in more than one resource group.
   */
  private collapseTargets(files: string[]): string[] {
    return [...new Set(files.map(file => this.removeAbsolutePath(file)))];
  }

  /**
   * Drop every target whose ancestor is also selected.
   *
   * Only valid for a recursive `svn add` (no `--depth`), where adding a
   * directory already covers its children: passing both makes SVN report
   * `E200009: some targets are already versioned`. It must not be used for a
   * commit or for `--depth=empty`, where children are not implied.
   */
  private removeDescendants(files: string[]): string[] {
    const normalized = new Set(
      files.map(file => normalizePath(file === "." ? "" : file))
    );

    return files.filter(file => {
      const parts = (file === "." ? "" : file).split(/[\\/]+/);

      let parent = "";

      for (let i = 0; i < parts.length - 1; i++) {
        parent = parent ? `${parent}/${parts[i]}` : parts[i];

        if (normalized.has(normalizePath(parent))) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Make sure every parent directory of the given files is part of the commit.
   *
   * `svn commit file` fails with `E200009` when an ancestor is scheduled for
   * addition but is not part of the same commit ("is not known to exist in the
   * repository ... yet its child is part of the commit"). That happens as soon
   * as the Source Control view lists the individual files of an unversioned
   * directory: adding `dir/a.txt` also schedules `dir`, but a commit of just
   * `dir/a.txt` would not include it.
   *
   * The extra paths are read from `svn status` (only entries that are already
   * scheduled for addition are added), so a normal commit of modified files is
   * unaffected and no unrelated file is committed.
   */
  private async addMissingParents(files: string[]): Promise<string[]> {
    const relative = this.collapseTargets(files);

    const parents: string[] = [];

    for (const file of relative) {
      const parts = file.split(/[\\/]+/);

      let parent = "";

      for (let i = 0; i < parts.length - 1; i++) {
        parent = parent ? `${parent}/${parts[i]}` : parts[i];
        parents.push(parent);
      }
    }

    const uniqueParents = [...new Set(parents)];

    if (uniqueParents.length === 0) {
      return relative;
    }

    const added: string[] = [];

    try {
      for (const chunk of splitInChunks(
        uniqueParents,
        MAX_CLI_LENGTH,
        parent => parent.length + 1
      )) {
        const result = await this.exec(
          ["status", "--xml", "--depth=empty", ...chunk],
          { log: false }
        );

        added.push(
          ...(await parseStatusXml(result.stdout))
            .filter(status => status.status === Status.ADDED)
            .map(status => status.path.replace(/\\/g, "/"))
        );
      }
    } catch (error) {
      console.error(error);
    }

    if (added.length === 0) {
      return relative;
    }

    return [...relative, ...added];
  }

  /**
   * Run a command with an arbitrary number of targets.
   *
   * The Source Control view lists the files of unversioned directories one by
   * one, so an `svn add` can carry hundreds of paths and exceed the OS command
   * line limit (`spawn ENAMETOOLONG`). The targets are therefore split into
   * chunks that fit within {@link MAX_CLI_LENGTH} and the command is run once
   * per chunk.
   *
   * `--targets` is not used on purpose: SVN reads that file in the system ANSI
   * code page on Windows, so paths with non-ASCII characters (e.g. Chinese
   * directory names) would not be found. Multiple invocations are safe for
   * `add` because every chunk is self-contained (`--parents` adds the
   * intermediate directories it needs, and a later chunk sees them as
   * versioned).
   */
  private async execWithTargets(
    args: string[],
    targets: string[],
    options: string[]
  ): Promise<IExecutionResult> {
    const chunks = splitInChunks(
      targets,
      MAX_CLI_LENGTH,
      target => target.length + 1
    );

    const result: IExecutionResult = {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };

    for (const chunk of chunks) {
      const chunkResult = await this.exec([...args, ...chunk, ...options]);

      result.stdout += chunkResult.stdout;
      result.stderr = chunkResult.stderr || result.stderr;
    }

    return result;
  }

  public async addChangelist(files: string[], changelist: string) {
    files = files.map(file => this.removeAbsolutePath(file));
    return this.exec(["changelist", changelist, ...files]);
  }

  public removeChangelist(files: string[]) {
    files = files.map(file => this.removeAbsolutePath(file));
    return this.exec(["changelist", "--remove", ...files]);
  }

  public async getCurrentBranch(): Promise<string> {
    const info = await this.getInfo();

    const branch = getBranchName(info.url);

    if (branch) {
      const showFullName = configuration.get<boolean>("layout.showFullName");
      if (showFullName) {
        return branch.path;
      } else {
        return branch.name;
      }
    }

    return "";
  }

  public async getRepositoryUuid(): Promise<string> {
    const info = await this.getInfo();

    return info.repository.uuid;
  }

  public async getRepoUrl() {
    const info = await this.getInfo();

    const branch = getBranchName(info.url);

    if (!branch) {
      return info.repository.root;
    }

    const regex = new RegExp(branch.path + "$");

    return info.url.replace(regex, "").replace(/\/$/, "");
  }

  public async getBranches() {
    const trunkLayout = configuration.get<string>("layout.trunk");
    const branchesLayout = configuration.get<string>("layout.branches");
    const tagsLayout = configuration.get<string>("layout.tags");

    const repoUrl = await this.getRepoUrl();

    const branches: string[] = [];

    const promises = [];

    if (trunkLayout) {
      promises.push(
        new Promise<string[]>(async resolve => {
          try {
            await this.exec([
              "ls",
              repoUrl + "/" + trunkLayout,
              "--depth",
              "empty"
            ]);

            resolve([trunkLayout]);
          } catch (error) {
            resolve([]);
          }
        })
      );
    }

    const trees: string[] = [];

    if (branchesLayout) {
      trees.push(branchesLayout);
    }

    if (tagsLayout) {
      trees.push(tagsLayout);
    }

    for (const tree of trees) {
      promises.push(
        new Promise<string[]>(async resolve => {
          const branchUrl = repoUrl + "/" + tree;

          try {
            const result = await this.exec(["ls", branchUrl]);

            const list = result.stdout
              .trim()
              .replace(/\/|\\/g, "")
              .split(/[\r\n]+/)
              .filter((x: string) => !!x)
              .map((i: string) => tree + "/" + i);

            resolve(list);
          } catch (error) {
            resolve([]);
          }
        })
      );
    }

    const all = await Promise.all<any>(promises);
    all.forEach(list => {
      branches.push(...list);
    });

    return branches;
  }

  public async newBranch(
    name: string,
    commitMessage: string = "Created new branch"
  ) {
    const repoUrl = await this.getRepoUrl();
    const newBranch = repoUrl + "/" + name;
    const info = await this.getInfo();
    const currentBranch = info.url;

    await this.exec(["copy", currentBranch, newBranch, "-m", commitMessage]);

    await this.switchBranch(name);

    return true;
  }

  public async switchBranch(ref: string, force: boolean = false) {
    const repoUrl = await this.getRepoUrl();
    const branchUrl = repoUrl + "/" + ref;

    await this.exec(
      ["switch", branchUrl].concat(force ? ["--ignore-ancestry"] : [])
    );

    this.resetInfoCache();
    return true;
  }

  public async merge(
    ref: string,
    reintegrate: boolean = false,
    accept_action: string = "postpone",
    revisions: string[] = [],
    dryRun: boolean = false
  ): Promise<string> {
    const repoUrl = await this.getRepoUrl();
    const branchUrl = repoUrl + "/" + ref;

    let args = ["merge", "--accept", accept_action];
    args = args.concat(reintegrate ? ["--reintegrate"] : []);
    args = args.concat(revisions);
    if (dryRun) {
      args = args.concat(["--dry-run"]);
    }
    args = args.concat([branchUrl]);

    const result = await this.exec(args);

    this.resetInfoCache();
    return result.stdout;
  }

  public async revert(files: string[], depth: keyof typeof SvnDepth) {
    files = files.map(file => this.removeAbsolutePath(file));

    // Split the paths into chunks that fit within the command line limit,
    // otherwise `svn revert` fails with `spawn ENAMETOOLONG` when a large
    // number of files (spread across multiple directories) is reverted.
    const chunks = splitInChunks(
      files,
      MAX_CLI_LENGTH,
      file => file.length + 1
    );

    let stdout = "";

    for (const chunk of chunks) {
      const result = await this.exec(["revert", "--depth", depth, ...chunk]);
      stdout += result.stdout;
    }

    return stdout;
  }

  public async update(ignoreExternals: boolean = true): Promise<string> {
    const args = ["update"];

    if (ignoreExternals) {
      args.push("--ignore-externals");
    }

    const result = await this.exec(args);

    this.resetInfoCache();

    const message = result.stdout.trim().split(/\r?\n/).pop();

    if (message) {
      return message;
    }
    return result.stdout;
  }

  public async pullIncomingChange(path: string): Promise<string> {
    return this.pullIncomingChanges([path]);
  }

  public async pullIncomingChanges(files: string[]): Promise<string> {
    if (files.length === 0) {
      return this.update();
    }

    try {
      const result = await this.exec(["update", ...files]);

      this.resetInfoCache();

      const message = result.stdout.trim().split(/\r?\n/).pop();

      if (message) {
        return message;
      }
      return result.stdout;
    } catch (error) {
      if (
        error instanceof SvnError &&
        error.svnErrorCode === svnErrorCodes.NotASvnRepository
      ) {
        return this.update();
      }

      throw error;
    }
  }

  public async patch(files: string[]) {
    files = files.map(file => this.removeAbsolutePath(file));
    const result = await this.exec(["diff", "--internal-diff", ...files]);
    const message = result.stdout;
    return message;
  }

  public async patchBuffer(files: string[]) {
    files = files.map(file => this.removeAbsolutePath(file));
    const result = await this.execBuffer(["diff", "--internal-diff", ...files]);
    const message = result.stdout;
    return message;
  }

  public async patchChangelist(changelistName: string) {
    const result = await this.exec([
      "diff",
      "--internal-diff",
      "--changelist",
      changelistName
    ]);
    const message = result.stdout;
    return message;
  }

  public async removeFiles(files: string[], keepLocal: boolean) {
    files = files.map(file => this.removeAbsolutePath(file));
    const args = ["remove"];

    if (keepLocal) {
      args.push("--keep-local");
    }

    args.push(...files);

    const result = await this.exec(args);

    return result.stdout;
  }

  public async resolve(files: string[], action: string) {
    files = files.map(file => this.removeAbsolutePath(file));

    const result = await this.exec(["resolve", "--accept", action, ...files]);

    return result.stdout;
  }

  public async plainLog(): Promise<string> {
    const logLength = configuration.get<string>("log.length") || "50";
    const result = await this.exec([
      "log",
      "-r",
      "HEAD:1",
      "--limit",
      logLength
    ]);

    return result.stdout;
  }

  public async plainLogBuffer(): Promise<Buffer> {
    const logLength = configuration.get<string>("log.length") || "50";
    const result = await this.execBuffer([
      "log",
      "-r",
      "HEAD:1",
      "--limit",
      logLength
    ]);

    return result.stdout;
  }

  public async plainLogByRevision(revision: number) {
    const result = await this.exec(["log", "-r", revision.toString()]);

    return result.stdout;
  }

  public async plainLogByRevisionBuffer(revision: number) {
    const result = await this.execBuffer(["log", "-r", revision.toString()]);

    return result.stdout;
  }

  public async plainLogByText(search: string) {
    const result = await this.exec(["log", "--search", search]);

    return result.stdout;
  }

  public async plainLogByTextBuffer(search: string) {
    const result = await this.execBuffer(["log", "--search", search]);

    return result.stdout;
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri
  ): Promise<ISvnLogEntry[]> {
    const args = [
      "log",
      "-r",
      `${rfrom}:${rto}`,
      `--limit=${limit}`,
      "--xml",
      "-v"
    ];
    if (target !== undefined) {
      args.push(
        fixPegRevision(target instanceof Uri ? target.toString(true) : target)
      );
    }
    const result = await this.exec(args);

    return parseSvnLog(result.stdout);
  }

  public async logByUser(user: string) {
    const result = await this.exec(["log", "--xml", "-v", "--search", user]);

    return parseSvnLog(result.stdout);
  }

  public async countNewCommit(revision: string = "BASE:HEAD") {
    const result = await this.exec(["log", "-r", revision, "-q", "--xml"]);

    const matches = result.stdout.match(/<logentry/g);

    if (matches && matches.length > 0) {
      // Every return current commit
      return matches.length - 1;
    }

    return 0;
  }

  public async cleanup() {
    const result = await this.exec(["cleanup"]);

    return result.stdout;
  }

  public async removeUnversioned() {
    const result = await this.exec(["cleanup", "--remove-unversioned"]);

    this.svn.logOutput(result.stdout);

    return result.stdout;
  }

  public async finishCheckout() {
    const info = await this.getInfo();

    const result = await this.exec(["switch", info.url]);

    return result.stdout;
  }

  public async list(folder?: string) {
    let url = await this.getRepoUrl();

    if (folder) {
      url += "/" + folder;
    }

    const result = await this.exec(["list", url, "--xml"]);

    return parseSvnList(result.stdout);
  }

  public async ls(file: string): Promise<ISvnListItem[]> {
    const result = await this.exec(["list", file, "--xml"]);

    return parseSvnList(result.stdout);
  }

  public async getCurrentIgnore(directory: string) {
    directory = this.removeAbsolutePath(directory);

    let currentIgnore = "";

    try {
      const args = ["propget", "svn:ignore"];

      if (directory) {
        args.push(directory);
      }

      const currentIgnoreResult = await this.exec(args);

      currentIgnore = currentIgnoreResult.stdout.trim();
    } catch (error) {
      console.error(error);
    }

    const ignores = currentIgnore.split(/[\r\n]+/);

    return ignores;
  }

  public async addToIgnore(
    expressions: string[],
    directory: string,
    recursive: boolean = false
  ) {
    const ignores = await this.getCurrentIgnore(directory);

    directory = this.removeAbsolutePath(directory);

    ignores.push(...expressions);
    const newIgnore = [...new Set(ignores)]
      .filter(v => !!v)
      .sort()
      .join("\n");

    const args = ["propset", "svn:ignore", newIgnore];

    if (directory) {
      args.push(directory);
    } else {
      args.push(".");
    }
    if (recursive) {
      args.push("--recursive");
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  public async rename(oldName: string, newName: string): Promise<string> {
    oldName = this.removeAbsolutePath(oldName);
    newName = this.removeAbsolutePath(newName);
    const args = ["rename", oldName, newName];

    const result = await this.exec(args);

    return result.stdout;
  }

  /**
   * `svn blame` for a single file, parsed into per-line metadata.
   * Returns an empty array when the file has no blame information
   * (e.g. unversioned).
   *
   * `force` adds `--force`, which lets SVN blame files it would otherwise
   * skip (e.g. binary files). `ignoreWhitespace` adds
   * `-x -w --ignore-eol-style`, matching the "SVN Blamer" extension so
   * whitespace/EOL-only changes are ignored; it is opt-in so the "Blame
   * (Annotate)" document keeps showing the raw attribution.
   */
  public async blame(
    file: string,
    options: {
      force?: boolean;
      revision?: string;
      ignoreWhitespace?: boolean;
    } = {}
  ): Promise<ISvnBlameLine[]> {
    file = this.removeAbsolutePath(file);

    const args = ["blame", "--xml"];

    if (options.ignoreWhitespace) {
      args.push("-x", "-w --ignore-eol-style");
    }

    if (options.force) {
      args.push("--force");
    }

    if (options.revision) {
      args.push("-r", options.revision);
    }

    args.push(file);

    const result = await this.exec(args);

    return parseSvnBlame(result.stdout);
  }

  /**
   * Copy a working copy path (or a repository URL) to a new path/URL.
   * `svn copy SRC DST` — used to create branches, tags or local copies.
   * Without `message` the copy is not committed (only scheduled in the
   * working copy).
   */
  public async copy(
    source: string | Uri,
    destination: string | Uri,
    message?: string
  ): Promise<string> {
    const src =
      source instanceof Uri
        ? source.toString(true)
        : this.removeAbsolutePath(source);
    const dst =
      destination instanceof Uri
        ? destination.toString(true)
        : this.removeAbsolutePath(destination);

    const args = ["copy", src, dst];

    if (message) {
      args.push("-m", message);
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  /**
   * Read a single svn property. Returns `undefined` when the property
   * is not set.
   */
  public async propget(
    propName: string,
    file: string,
    revision?: string
  ): Promise<string | undefined> {
    file = this.removeAbsolutePath(file);

    const args = ["propget", propName];

    if (revision) {
      args.push("--revision", revision);
    }

    args.push(file);

    const result = await this.exec(args);

    const value = result.stdout.replace(/[\r\n]+$/, "");

    return value.length ? value : undefined;
  }

  /** Set (or replace) an svn property on a path. */
  public async propset(
    propName: string,
    value: string,
    file: string,
    recursive: boolean = false
  ): Promise<string> {
    file = this.removeAbsolutePath(file);

    const args = ["propset", propName, value, file];

    if (recursive) {
      args.push("--recursive");
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  /** Delete an svn property from a path. */
  public async propdel(
    propName: string,
    file: string,
    recursive: boolean = false
  ): Promise<string> {
    file = this.removeAbsolutePath(file);

    const args = ["propdel", propName, file];

    if (recursive) {
      args.push("--recursive");
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  /** List the svn properties set on a path. */
  public async proplist(file: string): Promise<ISvnProperty[]> {
    file = this.removeAbsolutePath(file);

    const result = await this.exec(["proplist", "--verbose", "--xml", file]);

    return parseSvnProplist(result.stdout);
  }

  /**
   * Read the ignore rules that apply inside this working copy.
   *
   * `svn:ignore` is returned per directory (it only applies there), while
   * `svn:global-ignores` is inherited by every descendant (SVN >= 1.8). Both
   * are needed to expand an unversioned directory the way `svn status` would
   * classify its files.
   */
  public async getIgnoreRules(): Promise<IIgnoreRule[]> {
    const rules: IIgnoreRule[] = [];

    const ignore = await this.propgetAll("svn:ignore");
    for (const rule of ignore) {
      rules.push({ ...rule, recursive: false });
    }

    const globalIgnores = await this.propgetAll("svn:global-ignores", true);
    for (const rule of globalIgnores) {
      rules.push({ ...rule, recursive: true });
    }

    return rules;
  }

  /**
   * `svn propget -R --xml` for one property. A missing property is not an
   * error (SVN prints an empty `<properties/>`), so a failure here means the
   * property is unavailable on this SVN version and an empty list is returned.
   */
  private async propgetAll(
    name: string,
    inherited: boolean = false
  ): Promise<Array<{ path: string; patterns: string[] }>> {
    const args = ["propget", name, "--xml", "-R"];

    if (inherited) {
      args.push("--show-inherited-props");
    }

    args.push(".");

    try {
      const result = await this.exec(args, { log: false });

      const rules = await parseIgnoreProperties(result.stdout, name);

      return rules.map(rule => ({
        ...rule,
        path: this.relativePosixPath(rule.path)
      }));
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  /**
   * Convert a path printed by `svn propget` into a root-relative POSIX path.
   *
   * `--show-inherited-props` reports a rule inherited from above the working
   * copy root as a URL (or as a path outside the working copy) when the
   * checkout only covers a subdirectory. SVN still applies such a rule to the
   * whole working copy, so it is mapped to `.` rather than dropped.
   */
  private relativePosixPath(value: string): string {
    if (!value) {
      return ".";
    }

    const normalized = normalizePath(value);
    const root = normalizePath(this.workspaceRoot);

    if (normalized === root) {
      return ".";
    }

    if (!isDescendant(root, normalized)) {
      return ".";
    }

    const relative = path.relative(this.workspaceRoot, value);

    return relative === ""
      ? "."
      : fixPathSeparator(relative).replace(/\\/g, "/");
  }

  /**
   * Read the `svn:externals` definitions for a directory.
   * Returns an empty array when none are set.
   */
  public async getExternals(directory: string): Promise<ISvnExternal[]> {
    directory = this.removeAbsolutePath(directory);

    const result = await this.exec([
      "propget",
      "svn:externals",
      "--xml",
      directory
    ]);

    return parseSvnExternals(result.stdout);
  }

  /** Replace the `svn:externals` definitions of a directory. */
  public async setExternals(
    directory: string,
    externals: ISvnExternal[]
  ): Promise<string> {
    directory = this.removeAbsolutePath(directory);

    const value = externals
      .map(e =>
        e.revision ? `${e.url}@${e.revision} ${e.path}` : `${e.url} ${e.path}`
      )
      .join("\n");

    const args = ["propset", "svn:externals", value, directory];

    const result = await this.exec(args);

    return result.stdout;
  }

  /** `svn lock` — requires svn >= 1.7 */
  public async lock(files: string[], message?: string): Promise<string> {
    files = files.map(file => this.removeAbsolutePath(file));

    const args = ["lock", ...files];

    if (message) {
      args.push("-m", message);
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  /** `svn unlock` */
  public async unlock(
    files: string[],
    force: boolean = false
  ): Promise<string> {
    files = files.map(file => this.removeAbsolutePath(file));

    const args = ["unlock", ...files];

    if (force) {
      args.push("--force");
    }

    const result = await this.exec(args);

    return result.stdout;
  }

  /**
   * Whether the working copy path is locked by someone (including us).
   * Returns the lock owner, or `undefined` when not locked.
   */
  public async getLockOwner(file: string): Promise<string | undefined> {
    file = this.removeAbsolutePath(file);

    try {
      const result = await this.exec(["info", "--xml", file]);
      const info = await parseInfoXml(result.stdout);

      const lock = info.lock;

      if (lock && lock.owner) {
        return lock.owner;
      }
    } catch (error) {
      // Not locked (or not a repository) — treat as unlocked.
    }

    return undefined;
  }
}
