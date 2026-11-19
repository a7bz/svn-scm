import * as path from "path";
import { clearTimeout, setTimeout } from "timers";
import {
  l10n,
  commands,
  Disposable,
  Event,
  EventEmitter,
  ProgressLocation,
  scm,
  SecretStorage,
  SourceControl,
  SourceControlInputBox,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode";
import {
  IAuth,
  IFileStatus,
  IIgnoreRule,
  IOperations,
  ISvnBlameLine,
  ISvnExternal,
  ISvnInfo,
  ISvnProperty,
  ISvnResourceGroup,
  Operation,
  RepositoryState,
  Status,
  SvnDepth,
  SvnUriAction,
  ISvnPathChange,
  IStoredAuth,
  ISvnListItem
} from "./common/types";
import { debounce, memoize, sequentialize, throttle } from "./decorators";
import { exists, lstat } from "./fs";
import { configuration } from "./helpers/configuration";
import OperationsImpl from "./operationsImpl";
import { PathNormalizer } from "./pathNormalizer";
import { IRemoteRepository } from "./remoteRepository";
import { Resource } from "./resource";
import { StatusBarCommands } from "./statusbar/statusBarCommands";
import { svnErrorCodes } from "./svn";
import { Repository as BaseRepository } from "./svnRepository";
import { toSvnUri } from "./uri";
import {
  createIgnoreMatcher,
  expandUnversionedDirectory,
  getGlobalIgnorePatterns
} from "./unversioned";
import {
  anyEvent,
  dispose,
  getSvnDir,
  isDescendant,
  isReadOnly,
  timeout,
  toDisposable
} from "./util";
import { match, matchAll } from "./util/globMatch";
import { RepositoryFilesWatcher } from "./watchers/repositoryFilesWatcher";

// Upper bound for waiting on a busy repository before refreshing anyway.
// Long running (or stuck) commands must never freeze the auto refresh.
const IDLE_WAIT_TIMEOUT = 10000;

// Coalesce bursts of file system events, but never postpone a refresh longer
// than the maximum delay: a build/watch process that keeps writing files must
// not starve the Source Control view (a plain debounce did exactly that).
const REFRESH_DEBOUNCE = 300;
const REFRESH_MAX_DELAY = 2000;

// `svn:ignore` / `svn:global-ignores` change rarely, but reading them costs two
// `svn propget` calls. They are cached and invalidated on `.svn` events.
const IGNORE_RULES_TTL = 30000;

function shouldShowProgress(operation: Operation): boolean {
  switch (operation) {
    case Operation.CurrentBranch:
    case Operation.Show:
    case Operation.Info:
    case Operation.Blame:
      return false;
    default:
      return true;
  }
}

export class Repository implements IRemoteRepository {
  public sourceControl: SourceControl;
  public statusBar: StatusBarCommands;
  public changes: ISvnResourceGroup;
  public unversioned: ISvnResourceGroup;
  public remoteChanges?: ISvnResourceGroup;
  public changelists: Map<string, ISvnResourceGroup> = new Map();
  public conflicts: ISvnResourceGroup;
  public statusIgnored: IFileStatus[] = [];
  public statusExternal: IFileStatus[] = [];
  private disposables: Disposable[] = [];
  public currentBranch = "";
  public remoteChangedFiles: number = 0;
  public isIncomplete: boolean = false;
  public needCleanUp: boolean = false;
  private remoteChangedUpdateInterval?: NodeJS.Timeout;
  private statusPollTimeout?: NodeJS.Timeout;
  private refreshDebounceTimer?: NodeJS.Timeout;
  private refreshMaxTimer?: NodeJS.Timeout;
  private refreshPending = false;
  private refreshPendingIncludeIgnored = false;
  private refreshInFlight = false;
  private ignoreRules?: { rules: IIgnoreRule[]; loadedAt: number };
  private deletedUris: Uri[] = [];
  private canSaveAuth: boolean = false;

  private lastPromptAuth?: Thenable<IAuth | undefined>;

  private _fsWatcher: RepositoryFilesWatcher;
  public get fsWatcher() {
    return this._fsWatcher;
  }

  private _onDidChangeRepository = new EventEmitter<Uri>();
  public readonly onDidChangeRepository: Event<Uri> =
    this._onDidChangeRepository.event;

  private _onDidChangeState = new EventEmitter<RepositoryState>();
  public readonly onDidChangeState: Event<RepositoryState> =
    this._onDidChangeState.event;

  private _onDidChangeStatus = new EventEmitter<void>();
  public readonly onDidChangeStatus: Event<void> =
    this._onDidChangeStatus.event;

  private _onDidChangeRemoteChangedFiles = new EventEmitter<void>();
  public readonly onDidChangeRemoteChangedFile: Event<void> =
    this._onDidChangeRemoteChangedFiles.event;

  private _onRunOperation = new EventEmitter<Operation>();
  public readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

  private _onDidRunOperation = new EventEmitter<Operation>();
  public readonly onDidRunOperation: Event<Operation> =
    this._onDidRunOperation.event;

  @memoize
  get onDidChangeOperations(): Event<void> {
    return anyEvent(
      this.onRunOperation as Event<any>,
      this.onDidRunOperation as Event<any>
    );
  }

  private _operations = new OperationsImpl();
  get operations(): IOperations {
    return this._operations;
  }

  private _state = RepositoryState.Idle;
  get state(): RepositoryState {
    return this._state;
  }
  set state(state: RepositoryState) {
    this._state = state;
    this._onDidChangeState.fire(state);

    this.changes.resourceStates = [];
    this.unversioned.resourceStates = [];
    this.conflicts.resourceStates = [];
    this.changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });

    if (this.remoteChanges) {
      this.remoteChanges.dispose();
      this.remoteChanges = undefined;
    }

    this.isIncomplete = false;
    this.needCleanUp = false;
  }

  get root(): string {
    return this.repository.root;
  }

  get workspaceRoot(): string {
    return this.repository.workspaceRoot;
  }

  /** 'svn://repo.x/branches/b1' e.g. */
  get branchRoot(): Uri {
    return Uri.parse(this.repository.info.url);
  }

  get inputBox(): SourceControlInputBox {
    return this.sourceControl.inputBox;
  }

  get username(): string | undefined {
    return this.repository.username;
  }

  set username(username: string | undefined) {
    this.repository.username = username;
  }

  get password(): string | undefined {
    return this.repository.password;
  }

  set password(password: string | undefined) {
    this.repository.password = password;
  }

  constructor(
    public repository: BaseRepository,
    private secrets: SecretStorage
  ) {
    this._fsWatcher = new RepositoryFilesWatcher(
      repository.root,
      repository.workspaceRoot
    );
    this.disposables.push(this._fsWatcher);

    // Working tree changes only; `.svn` metadata changes are handled by
    // `onDidSvnAny` below (same split as VS Code's Git extension, which
    // filters `.git` out of the working tree watcher).
    this._fsWatcher.onDidWorkspaceAny(this.onFSChange, this, this.disposables);
    this._fsWatcher.onDidSvnAny(
      async (e: Uri) => {
        // `svn:ignore` / `svn:global-ignores` and the working copy database
        // change here, so the cached ignore rules are stale now.
        this.invalidateIgnoreRulesCache();
        // Metadata-only operations (`svn add`, `svn commit`, `svn revert`,
        // property/changelist changes, ...) do not touch the working files, so
        // they may only produce `.svn` events. Refresh the status as well as
        // the repository info; otherwise such changes stay invisible until the
        // next poll or window focus.
        await this.onDidAnyFileChanged(e);
        // A fast status is enough here; the periodic poll performs the full
        // scan (including ignored entries) and keeps that list fresh.
        this.requestStatusRefresh();
      },
      this,
      this.disposables
    );

    this.sourceControl = scm.createSourceControl(
      "svn",
      "SVN",
      Uri.file(repository.workspaceRoot)
    );

    this.sourceControl.count = 0;
    this.sourceControl.inputBox.placeholder = l10n.t(
      "Message (press Ctrl+Enter to commit)"
    );
    this.sourceControl.acceptInputCommand = {
      command: "svn.commitWithMessage",
      title: l10n.t("commit"),
      arguments: [this.sourceControl]
    };
    this.sourceControl.quickDiffProvider = this;
    this.disposables.push(this.sourceControl);

    this.statusBar = new StatusBarCommands(this);
    this.disposables.push(this.statusBar);
    this.statusBar.onDidChange(
      () => (this.sourceControl.statusBarCommands = this.statusBar.commands),
      null,
      this.disposables
    );

    this.changes = this.sourceControl.createResourceGroup(
      "changes",
      l10n.t("Changes")
    ) as ISvnResourceGroup;
    this.conflicts = this.sourceControl.createResourceGroup(
      "conflicts",
      l10n.t("Conflicts")
    ) as ISvnResourceGroup;
    this.unversioned = this.sourceControl.createResourceGroup(
      "unversioned",
      l10n.t("Unversioned")
    ) as ISvnResourceGroup;

    this.changes.hideWhenEmpty = true;
    this.unversioned.hideWhenEmpty = true;
    this.conflicts.hideWhenEmpty = true;

    this.disposables.push(this.changes);
    this.disposables.push(this.conflicts);

    // The this.unversioned can recreated by update state model
    this.disposables.push(toDisposable(() => this.unversioned.dispose()));

    // Dispose the timers of Remote Changes and of the status polling fallback
    this.disposables.push(
      toDisposable(() => {
        if (this.remoteChangedUpdateInterval) {
          clearTimeout(this.remoteChangedUpdateInterval);
        }

        if (this.statusPollTimeout) {
          clearTimeout(this.statusPollTimeout);
        }

        if (this.refreshDebounceTimer) {
          clearTimeout(this.refreshDebounceTimer);
        }

        if (this.refreshMaxTimer) {
          clearTimeout(this.refreshMaxTimer);
        }
      })
    );

    // For each deleted file, append to list
    this._fsWatcher.onDidWorkspaceDelete(
      uri => this.deletedUris.push(uri),
      this,
      this.disposables
    );

    // Only check deleted files after the status list is fully updated
    this.onDidChangeStatus(this.actionForDeletedFiles, this, this.disposables);

    this.createRemoteChangedInterval();

    // Fallback for file systems / configurations where the VS Code file
    // watcher does not report changes made by other processes (AI agents,
    // terminals, network drives, ...). Without it a missed watcher event left
    // the Source Control view stale until the next window focus or reload.
    this.createStatusPollInterval();

    this.refreshRemoteChanges();

    // On change config, dispose current interval and create a new.
    this.disposables.push(
      configuration.onDidChange(e => {
        if (e.affectsConfiguration("svn.remoteChanges.checkFrequency")) {
          this.createRemoteChangedInterval();

          this.refreshRemoteChanges();
        }

        if (
          e.affectsConfiguration("svn.autorefresh") ||
          e.affectsConfiguration("svn.refresh.pollInterval")
        ) {
          this.createStatusPollInterval();
        }
      })
    );

    // Recheck the repository when the window regains focus: refresh the remote
    // changes (commits pushed by other users) and re-run the working copy
    // status, so anything that changed while VS Code was in the background is
    // picked up immediately.
    this.disposables.push(
      window.onDidChangeWindowState(e => {
        if (e.focused) {
          this.refreshRemoteChanges();
          this.requestStatusRefresh();
        }
      })
    );

    this.status().catch(error => console.error(error));

    this.disposables.push(
      workspace.onDidSaveTextDocument(document => {
        this.onDidSaveTextDocument(document);
      })
    );
  }

  @debounce(1000)
  private async onDidAnyFileChanged(e: Uri) {
    try {
      await this.repository.updateInfo();
    } catch (error) {
      // A concurrent `svn` command (or a working copy lock) can make `svn info`
      // fail temporarily. The status refresh that follows will report the
      // current state, so do not turn this into an unhandled rejection.
      console.error(error);
    }

    this._onDidChangeRepository.fire(e);
  }

  private createRemoteChangedInterval() {
    if (this.remoteChangedUpdateInterval) {
      clearTimeout(this.remoteChangedUpdateInterval);
      this.remoteChangedUpdateInterval = undefined;
    }

    const updateFreq = configuration.get<number>(
      "remoteChanges.checkFrequency",
      0
    );

    if (!updateFreq) {
      return;
    }

    const base = Math.max(1000, Math.floor(updateFreq * 1000));

    const scheduleNext = () => {
      if (this.state === RepositoryState.Disposed) {
        return;
      }

      this.refreshRemoteChanges();

      // Jitter keeps several repositories from hitting the server at the same
      // moment.
      const jitter = Math.floor(Math.random() * Math.min(base, 10000));
      this.remoteChangedUpdateInterval = setTimeout(
        scheduleNext,
        base + jitter
      );
    };

    const jitter = Math.floor(Math.random() * Math.min(base, 10000));
    this.remoteChangedUpdateInterval = setTimeout(scheduleNext, base + jitter);
  }

  /**
   * Periodically re-run `svn status` as a safety net.
   *
   * Disabled by default (`svn.refresh.pollInterval` is 0): like the Git
   * extension, local changes are detected through file system events (plus the
   * explicit refresh command and window focus), so no periodic full scan of
   * the working copy is needed. Users can opt back in for setups where events
   * are unreliable (network drives, external tools).
   *
   * The extension detects local changes through VS Code's file watcher. That
   * watcher does not see everything: changes written by another process (AI
   * coding agents, terminals, build tools), working copies on network drives,
   * excluded paths, workspaces where VS Code had to disable watching or an
   * event lost under heavy churn are silently missed. Polling the working copy
   * directly makes the view eventually consistent even when no watcher event
   * arrives.
   *
   * The poll deliberately does not require the window to be focused: changes
   * are frequently made by a terminal/agent while VS Code sits in the
   * background, and waiting for a focus event made those changes invisible
   * until the user clicked back into the window. It also uses jitter so that
   * several repositories do not run `svn status` at the same instant.
   */
  private createStatusPollInterval() {
    if (this.statusPollTimeout) {
      clearTimeout(this.statusPollTimeout);
      this.statusPollTimeout = undefined;
    }

    const autorefresh = configuration.get<boolean>("autorefresh", true);
    const interval = configuration.get<number>("refresh.pollInterval", 0);

    if (!autorefresh || !interval || interval <= 0) {
      return;
    }

    const base = Math.max(1000, Math.floor(interval * 1000));

    const scheduleNext = () => {
      if (this.state === RepositoryState.Disposed) {
        return;
      }

      if (!configuration.get<boolean>("autorefresh", true)) {
        return;
      }

      // `requestStatusRefresh` coalesces with watcher events and waits for a
      // running operation (with a bounded timeout), so the poll can never
      // overlap another `svn` command indefinitely. The periodic run is also
      // the one that refreshes the ignored list used for sub-repository
      // discovery.
      this.requestStatusRefresh(true);

      const jitter = Math.floor(Math.random() * Math.min(base, 5000));
      this.statusPollTimeout = setTimeout(scheduleNext, base + jitter);
    };

    // Spread the first run of all repositories over one interval.
    const jitter = Math.floor(Math.random() * Math.min(base, 5000));
    this.statusPollTimeout = setTimeout(scheduleNext, base + jitter);
  }

  /**
   * Request a local working copy refresh.
   *
   * Events are coalesced with a short debounce, but a refresh is guaranteed to
   * start within {@link REFRESH_MAX_DELAY} even while events keep arriving
   * (build watchers, log files, ...). Only one refresh runs at a time; events
   * received during a refresh trigger exactly one follow-up run, so the final
   * state on disk is always reflected.
   */
  private requestStatusRefresh(includeIgnored: boolean = false): void {
    if (this.state === RepositoryState.Disposed) {
      return;
    }

    // `svn.autorefresh` is the master switch for every automatic status
    // refresh (file events, `.svn` metadata events, poll and focus).
    if (!configuration.get<boolean>("autorefresh", true)) {
      return;
    }

    this.refreshPending = true;
    // A full request wins over a fast one: the ignored list is only updated by
    // a full status and must not be skipped just because a file event arrived
    // in the same window.
    this.refreshPendingIncludeIgnored =
      this.refreshPendingIncludeIgnored || includeIgnored;

    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }

    this.refreshDebounceTimer = setTimeout(
      () => this.runPendingRefresh(),
      REFRESH_DEBOUNCE
    );

    if (!this.refreshMaxTimer) {
      this.refreshMaxTimer = setTimeout(
        () => this.runPendingRefresh(),
        REFRESH_MAX_DELAY
      );
    }
  }

  private runPendingRefresh(): void {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = undefined;
    }

    if (this.refreshMaxTimer) {
      clearTimeout(this.refreshMaxTimer);
      this.refreshMaxTimer = undefined;
    }

    if (!this.refreshPending || this.refreshInFlight) {
      return;
    }

    const includeIgnored = this.refreshPendingIncludeIgnored;

    this.refreshPending = false;
    this.refreshPendingIncludeIgnored = false;
    this.refreshInFlight = true;

    this.performStatusRefresh(includeIgnored)
      .catch(error => console.error(error))
      .finally(() => {
        this.refreshInFlight = false;

        if (this.refreshPending) {
          this.requestStatusRefresh(this.refreshPendingIncludeIgnored);
        }
      });
  }

  private async performStatusRefresh(includeIgnored: boolean): Promise<void> {
    await this.whenIdle();

    if (this.state === RepositoryState.Disposed) {
      return;
    }

    // File-event bursts only need the working copy status; `--no-ignore` is
    // unnecessary there. The periodic poll requests a full status so ignored
    // entries stay fresh for the sub-repository discovery scan.
    await this.status(false, includeIgnored);
  }

  /**
   * Check all recently deleted files and compare with svn status "missing"
   */
  @debounce(1000)
  private async actionForDeletedFiles() {
    if (!this.deletedUris.length) {
      return;
    }

    const allUris = this.deletedUris;
    this.deletedUris = [];

    const actionForDeletedFiles = configuration.get<string>(
      "delete.actionForDeletedFiles",
      "prompt"
    );

    if (actionForDeletedFiles === "none") {
      return;
    }

    const resources = allUris
      .map(uri => this.getResourceFromFile(uri))
      .filter(
        resource => resource && resource.type === Status.MISSING
      ) as Resource[];

    let uris = resources.map(resource => resource.resourceUri);

    if (!uris.length) {
      return;
    }

    const ignoredRulesForDeletedFiles = configuration.get<string[]>(
      "delete.ignoredRulesForDeletedFiles",
      []
    );
    const rules = ignoredRulesForDeletedFiles.map(ignored => match(ignored));

    if (rules.length) {
      uris = uris.filter(uri => {
        // Check first for relative URL (Better for workspace configuration)
        const relativePath = this.repository.removeAbsolutePath(uri.fsPath);

        // If some match, remove from list
        return !rules.some(
          rule => rule.match(relativePath) || rule.match(uri.fsPath)
        );
      });
    }

    if (!uris.length) {
      return;
    }

    if (actionForDeletedFiles === "remove") {
      return this.removeFiles(
        uris.map(uri => uri.fsPath),
        false
      );
    } else if (actionForDeletedFiles === "prompt") {
      return commands.executeCommand("svn.promptRemove", ...uris);
    }

    return;
  }

  @debounce(1000)
  public async updateRemoteChangedFiles() {
    await this.checkRemoteChanges();
  }

  /**
   * Fetch the incoming (remote) changes on demand.
   *
   * This bypasses `svn.remoteChanges.checkFrequency` on purpose: the Pull and
   * Refresh Remote Changes commands must keep working when the automatic
   * background check is disabled (the default).
   */
  public async fetchRemoteChanges() {
    try {
      // The remote check is a routine refresh: like the file-system driven
      // refreshes it does not need ignored entries, and skipping
      // `--no-ignore` keeps the already expensive `--show-updates` scan from
      // walking large ignored trees (node_modules, build output, ...).
      await this.run(Operation.StatusRemote, undefined, true, false);
    } catch (error) {
      console.error(error);

      // `svn status --show-updates` is also the refresh used to pick up local
      // changes. When the server cannot be reached (offline, VPN down,
      // authentication problem) that command fails as a whole, so fall back to
      // a local-only status. Otherwise the Source Control view would stay stale
      // until the window is reloaded.
      try {
        await this.status(false, false);
      } catch (localError) {
        console.error(localError);
      }
    }
  }

  /**
   * Automatic background check, wired to the scheduled interval and to window
   * focus. A frequency of 0 (the default) disables it entirely; remote changes
   * are then fetched only by explicit commands (Pull / Refresh Remote
   * Changes), which is what Git users expect and avoids polling a slow server.
   */
  @debounce(1000)
  private async refreshRemoteChanges() {
    await this.checkRemoteChanges();
  }

  private async checkRemoteChanges() {
    const updateFreq = configuration.get<number>(
      "remoteChanges.checkFrequency",
      0
    );

    // A positive frequency enables the automatic remote check. Disabling it
    // must not clear the group: a manual fetch can still fill it.
    if (updateFreq === 0) {
      return;
    }

    // Avoid piling up remote checks (e.g. rapid window focus changes or a
    // slow server) and never start one while another `svn` command is running
    // on the same working copy: concurrent commands can leave the working copy
    // locked (E155004) and make `svn update` fail.
    if (!this.operations.isIdle()) {
      return;
    }

    await this.fetchRemoteChanges();
  }

  private onFSChange(_uri: Uri): void {
    const autorefresh = configuration.get<boolean>("autorefresh", true);

    if (!autorefresh) {
      return;
    }

    // Never drop an event while another operation is running: the refresh
    // scheduler waits for the repository to become idle (with a bounded
    // timeout) and coalesces bursts without starving under continuous writes.
    this.requestStatusRefresh();
  }

  /**
   * Wait until no long running operation is keeping the repository busy.
   *
   * The wait is bounded on purpose: a slow or stuck command must never block
   * file change notifications forever. Window focus is deliberately not
   * required either, so changes made while VS Code is in the background (or by
   * another application) show up without the user having to focus the window
   * first.
   */
  public async whenIdle(): Promise<void> {
    const deadline = Date.now() + IDLE_WAIT_TIMEOUT;

    while (!this.operations.isIdle() && Date.now() < deadline) {
      await timeout(200);
    }
  }

  @throttle
  @sequentialize
  public async updateModelState(
    checkRemoteChanges: boolean = false,
    includeIgnored: boolean = true
  ) {
    const changes: any[] = [];
    const unversioned: any[] = [];
    const conflicts: any[] = [];
    const changelists: Map<string, Resource[]> = new Map();
    const remoteChanges: any[] = [];

    this.statusExternal = [];
    // Ignored entries are only needed by the repository discovery scan. A
    // routine refresh omits them (and the expensive `--no-ignore`) but must
    // keep the result of the last full scan.
    if (includeIgnored) {
      this.statusIgnored = [];
    }
    this.isIncomplete = false;
    this.needCleanUp = false;

    const combineExternal = configuration.get<boolean>(
      "sourceControl.combineExternalIfSameServer",
      false
    );

    const statuses =
      (await this.retryRun(async () => {
        return this.repository.getStatus({
          includeIgnored,
          includeExternals: combineExternal,
          checkRemoteChanges
        });
      })) || [];

    const fileConfig = workspace.getConfiguration("files", Uri.file(this.root));

    const filesToExclude = fileConfig.get<any>("exclude");

    const excludeList: string[] = [];
    for (const pattern in filesToExclude) {
      if (filesToExclude.hasOwnProperty(pattern)) {
        const negate = !filesToExclude[pattern];
        excludeList.push((negate ? "!" : "") + pattern);
      }
    }

    this.statusExternal = statuses.filter(
      status => status.status === Status.EXTERNAL
    );

    if (combineExternal && this.statusExternal.length) {
      const repositoryUuid = await this.repository.getRepositoryUuid();
      this.statusExternal = this.statusExternal.filter(
        status => repositoryUuid !== status.repositoryUuid
      );
    }

    const statusesRepository = statuses.filter(status => {
      if (status.status === Status.EXTERNAL) {
        return false;
      }

      return !this.statusExternal.some(external =>
        isDescendant(external.path, status.path)
      );
    });

    const hideUnversioned = configuration.get<boolean>(
      "sourceControl.hideUnversioned"
    );

    const ignoreList = configuration.get<string[]>("sourceControl.ignore");

    // Expanding an unversioned directory costs a file system walk, so it can be
    // turned off. The rules that SVN itself would apply (`svn:ignore`,
    // `svn:global-ignores` and `miscellany:global-ignores`) are only loaded
    // when an unversioned directory is actually found, because reading them
    // costs two extra `svn propget` runs.
    const expandUnversioned = configuration.get<boolean>(
      "sourceControl.expandUnversioned",
      true
    );

    let ignoreMatcher: ((relativePath: string) => boolean) | undefined;

    const getIgnoreMatcher = async (): Promise<
      (relativePath: string) => boolean
    > => {
      if (!ignoreMatcher) {
        ignoreMatcher = createIgnoreMatcher(await this.getIgnoreRules());
      }

      return ignoreMatcher;
    };

    for (const status of statusesRepository) {
      if (status.path === ".") {
        this.isIncomplete = status.status === Status.INCOMPLETE;
        this.needCleanUp = status.wcStatus.locked;
      }

      // If exists a switched item, the repository is incomplete
      // To simulate, run "svn switch" and kill "svn" proccess
      // After, run "svn update"
      if (status.wcStatus.switched) {
        this.isIncomplete = true;
      }

      if (
        status.wcStatus.locked ||
        status.wcStatus.switched ||
        status.status === Status.INCOMPLETE
      ) {
        // On commit, `svn status` return all locked files with status="normal" and props="none"
        continue;
      }

      if (matchAll(status.path, excludeList, { dot: true })) {
        continue;
      }

      const uri = Uri.file(path.join(this.workspaceRoot, status.path));
      const renameUri = status.rename
        ? Uri.file(path.join(this.workspaceRoot, status.rename))
        : undefined;

      if (status.reposStatus) {
        remoteChanges.push(
          new Resource(
            uri,
            status.reposStatus.item,
            undefined,
            status.reposStatus.props,
            true
          )
        );
      }

      const resource = new Resource(
        uri,
        status.status,
        renameUri,
        status.props
      );

      if (
        (status.status === Status.NORMAL || status.status === Status.NONE) &&
        (status.props === Status.NORMAL || status.props === Status.NONE) &&
        !status.changelist
      ) {
        // Ignore non changed itens
        continue;
      } else if (status.status === Status.IGNORED) {
        if (includeIgnored) {
          this.statusIgnored.push(status);
        }
      } else if (status.status === Status.CONFLICTED) {
        conflicts.push(resource);
      } else if (status.status === Status.UNVERSIONED) {
        if (hideUnversioned) {
          continue;
        }

        const matches = status.path.match(
          /(.+?)\.(mine|working|merge-\w+\.r\d+|r\d+)$/
        );

        // If file end with (mine, working, merge, etc..) and has file without extension
        if (
          matches &&
          matches[1] &&
          statuses.some(s => s.path === matches[1])
        ) {
          continue;
        }
        if (
          ignoreList.length > 0 &&
          matchAll(path.sep + status.path, ignoreList, {
            dot: true,
            matchBase: true
          })
        ) {
          continue;
        }

        // `svn status` reports an unversioned directory as one entry and never
        // descends into it (`--depth=infinity` does not help). Expand it here
        // so the individual files show up, like the Git extension shows
        // untracked files, instead of a single opaque folder.
        //
        // The directory entry itself is dropped once its files are listed: Git
        // does the same, and keeping both would duplicate every path. When the
        // expansion yields nothing (empty directory, everything ignored, walk
        // aborted) the directory is kept so it stays visible and addable.
        const expanded = expandUnversioned
          ? await this.expandUnversioned(status.path, await getIgnoreMatcher())
          : [];

        let listed = 0;

        for (const file of expanded) {
          // The expanded entries must obey the same filters as a normal status
          // entry, otherwise `files.exclude` and `svn.sourceControl.ignore`
          // would only apply to the folder.
          if (matchAll(file, excludeList, { dot: true })) {
            continue;
          }

          if (
            ignoreList.length > 0 &&
            matchAll(path.sep + file, ignoreList, {
              dot: true,
              matchBase: true
            })
          ) {
            continue;
          }

          unversioned.push(
            new Resource(
              Uri.file(path.join(this.workspaceRoot, file)),
              Status.UNVERSIONED
            )
          );

          listed++;
        }

        if (listed === 0) {
          unversioned.push(resource);
        }
      } else if (status.changelist) {
        let changelist = changelists.get(status.changelist);
        if (!changelist) {
          changelist = [];
        }
        changelist.push(resource);
        changelists.set(status.changelist, changelist);
      } else {
        changes.push(resource);
      }
    }

    this.changes.resourceStates = changes;
    this.conflicts.resourceStates = conflicts;

    const prevChangelistsSize = this.changelists.size;

    this.changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });

    const counts = [this.changes, this.conflicts];

    const ignoreOnStatusCountList = configuration.get<string[]>(
      "sourceControl.ignoreOnStatusCount"
    );

    changelists.forEach((resources, changelist) => {
      let group = this.changelists.get(changelist);
      if (!group) {
        // Prefix 'changelist-' to prevent double id with 'change' or 'external'
        group = this.sourceControl.createResourceGroup(
          `changelist-${changelist}`,
          `Changelist "${changelist}"`
        ) as ISvnResourceGroup;
        group.hideWhenEmpty = true;
        this.disposables.push(group);

        this.changelists.set(changelist, group);
      }

      group.resourceStates = resources;

      if (!ignoreOnStatusCountList.includes(changelist)) {
        counts.push(group);
      }
    });

    // Recreate unversioned group to move after changelists
    if (prevChangelistsSize !== this.changelists.size) {
      this.unversioned.dispose();

      this.unversioned = this.sourceControl.createResourceGroup(
        "unversioned",
        l10n.t("Unversioned")
      ) as ISvnResourceGroup;

      this.unversioned.hideWhenEmpty = true;
    }

    this.unversioned.resourceStates = unversioned;

    if (configuration.get<boolean>("sourceControl.countUnversioned", false)) {
      counts.push(this.unversioned);
    }

    this.sourceControl.count = counts.reduce(
      (a, b) => a + b.resourceStates.length,
      0
    );

    // Recreate remoteChanges group to move after unversioned
    if (!this.remoteChanges || prevChangelistsSize !== this.changelists.size) {
      /**
       * Destroy and create for keep at last position
       */
      let tempResourceStates: Resource[] = [];
      if (this.remoteChanges) {
        tempResourceStates = this.remoteChanges.resourceStates;
        this.remoteChanges.dispose();
      }

      this.remoteChanges = this.sourceControl.createResourceGroup(
        "remotechanges",
        l10n.t("Remote Changes")
      ) as ISvnResourceGroup;

      this.remoteChanges.repository = this;
      this.remoteChanges.hideWhenEmpty = true;
      this.remoteChanges.resourceStates = tempResourceStates;
    }

    // Update remote changes group
    if (checkRemoteChanges) {
      this.remoteChanges.resourceStates = remoteChanges;

      if (remoteChanges.length !== this.remoteChangedFiles) {
        this.remoteChangedFiles = remoteChanges.length;
        this._onDidChangeRemoteChangedFiles.fire();
      }
    }

    this._onDidChangeStatus.fire();

    // The resource groups are already up to date; a failure while reading the
    // branch name (e.g. the working copy is locked by another process) must not
    // turn an otherwise successful refresh into an error.
    try {
      this.currentBranch = await this.getCurrentBranch();
    } catch (error) {
      console.error(error);
    }

    return Promise.resolve();
  }

  /**
   * Return the effective ignore rules, cached for {@link IGNORE_RULES_TTL}.
   *
   * Both `svn propget -R` calls are cheap for a normal working copy but not
   * free, and the rules only change on `propset`/`commit`/`update`, all of
   * which touch `.svn` and therefore invalidate the cache.
   */
  private async getIgnoreRules(): Promise<IIgnoreRule[]> {
    const now = Date.now();

    if (
      this.ignoreRules &&
      now - this.ignoreRules.loadedAt < IGNORE_RULES_TTL
    ) {
      return this.ignoreRules.rules;
    }

    try {
      const rules = await this.repository.getIgnoreRules();

      // `miscellany:global-ignores` (SVN's own configuration file, falling
      // back to SVN's built-in defaults) applies to the whole working copy,
      // exactly like `svn status` does.
      const globalIgnores = await getGlobalIgnorePatterns();

      if (globalIgnores.length > 0) {
        rules.push({ path: ".", patterns: globalIgnores, recursive: true });
      }

      this.ignoreRules = { rules, loadedAt: now };

      return rules;
    } catch (error) {
      console.error(error);
      return this.ignoreRules ? this.ignoreRules.rules : [];
    }
  }

  /**
   * List the files below an unversioned directory, skipping everything SVN
   * would ignore.
   *
   * When the walk is incomplete (too many files, a nested working copy, an
   * unreadable folder) an empty list is returned and the caller keeps the
   * directory entry, which is what the previous behaviour was.
   */
  private async expandUnversioned(
    relativeDirectory: string,
    isIgnored: (relativePath: string) => boolean
  ): Promise<string[]> {
    const absolute = path.join(this.workspaceRoot, relativeDirectory);

    // `svn status` reports unversioned files too; only directories need a walk.
    // `lstat` is used so a symlink to a directory is treated as a file, exactly
    // like the walker and `svn add` do.
    try {
      if (!(await lstat(absolute)).isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const limit = configuration.get<number>(
      "sourceControl.unversionedLimit",
      1000
    );

    const result = await expandUnversionedDirectory(
      this.workspaceRoot,
      relativeDirectory,
      { limit, isIgnored }
    );

    return result.complete ? result.files : [];
  }

  /** Drop the ignore rule cache (it depends on `.svn` metadata). */
  private invalidateIgnoreRulesCache(): void {
    this.ignoreRules = undefined;
  }

  public getResourceFromFile(uri: string | Uri): Resource | undefined {
    if (typeof uri === "string") {
      uri = Uri.file(uri);
    }

    const groups = [
      this.changes,
      this.conflicts,
      this.unversioned,
      ...this.changelists.values()
    ];

    const uriString = uri.toString();

    for (const group of groups) {
      for (const resource of group.resourceStates) {
        if (
          uriString === resource.resourceUri.toString() &&
          resource instanceof Resource
        ) {
          return resource;
        }
      }
    }

    return undefined;
  }

  public provideOriginalResource(uri: Uri): Uri | undefined {
    if (uri.scheme !== "file") {
      return;
    }

    // Not has original resource for content of ".svn" folder
    if (isDescendant(path.join(this.root, getSvnDir()), uri.fsPath)) {
      return;
    }

    return toSvnUri(uri, SvnUriAction.SHOW, {}, true);
  }

  public async getBranches() {
    try {
      return await this.repository.getBranches();
    } catch (error) {
      return [];
    }
  }

  @throttle
  public async status(
    showProgress: boolean = true,
    includeIgnored: boolean = true
  ) {
    return this.run(Operation.Status, undefined, showProgress, includeIgnored);
  }

  public async show(
    filePath: string | Uri,
    revision?: string
  ): Promise<string> {
    return this.run<string>(Operation.Show, () => {
      return this.repository.show(filePath, revision);
    });
  }

  public async showBuffer(
    filePath: string | Uri,
    revision?: string
  ): Promise<Buffer> {
    return this.run<Buffer>(Operation.Show, () => {
      return this.repository.showBuffer(filePath, revision);
    });
  }

  public async addFiles(files: string[]) {
    return this.run(Operation.Add, () => this.repository.addFiles(files));
  }

  public async addChangelist(files: string[], changelist: string) {
    return this.run(Operation.AddChangelist, () =>
      this.repository.addChangelist(files, changelist)
    );
  }

  public async removeChangelist(files: string[]) {
    return this.run(Operation.RemoveChangelist, () =>
      this.repository.removeChangelist(files)
    );
  }

  public async getCurrentBranch() {
    return this.run(Operation.CurrentBranch, async () => {
      return this.repository.getCurrentBranch();
    });
  }

  public async newBranch(
    name: string,
    commitMessage: string = "Created new branch"
  ) {
    return this.run(Operation.NewBranch, async () => {
      await this.repository.newBranch(name, commitMessage);
      this.updateRemoteChangedFiles();
    });
  }

  public async switchBranch(name: string, force: boolean = false) {
    await this.run(Operation.SwitchBranch, async () => {
      await this.repository.switchBranch(name, force);
      this.updateRemoteChangedFiles();
    });
  }

  public async merge(
    name: string,
    reintegrate: boolean = false,
    accept_action: string = "postpone",
    revisions: string[] = [],
    dryRun: boolean = false
  ): Promise<string> {
    return this.run<string>(Operation.Merge, async () => {
      const output = await this.repository.merge(
        name,
        reintegrate,
        accept_action,
        revisions,
        dryRun
      );
      this.updateRemoteChangedFiles();
      return output;
    });
  }

  public async updateRevision(
    ignoreExternals: boolean = false
  ): Promise<string> {
    return this.run<string>(Operation.Update, async () => {
      const response = await this.repository.update(ignoreExternals);
      this.updateRemoteChangedFiles();
      return response;
    });
  }

  public async pullIncomingChange(path: string) {
    return this.pullIncomingChanges([path]);
  }

  public async pullIncomingChanges(files: string[]) {
    return this.run<string>(Operation.Update, async () => {
      const response = await this.repository.pullIncomingChanges(files);
      this.updateRemoteChangedFiles();
      return response;
    });
  }

  public async resolve(files: string[], action: string) {
    return this.run(Operation.Resolve, () =>
      this.repository.resolve(files, action)
    );
  }

  public async commitFiles(message: string, files: any[]) {
    return this.run(Operation.Commit, () =>
      this.repository.commitFiles(message, files)
    );
  }

  public async revert(files: string[], depth: keyof typeof SvnDepth) {
    return this.run(Operation.Revert, () =>
      this.repository.revert(files, depth)
    );
  }

  public async info(path: string) {
    return this.run(Operation.Info, () => this.repository.getInfo(path));
  }

  public async patch(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patch(files));
  }

  public async patchBuffer(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patchBuffer(files));
  }

  public async patchChangelist(changelistName: string) {
    return this.run(Operation.Patch, () =>
      this.repository.patchChangelist(changelistName)
    );
  }

  public async removeFiles(files: string[], keepLocal: boolean) {
    return this.run(Operation.Remove, () =>
      this.repository.removeFiles(files, keepLocal)
    );
  }

  public async plainLog() {
    return this.run(Operation.Log, () => this.repository.plainLog());
  }

  public async plainLogBuffer() {
    return this.run(Operation.Log, () => this.repository.plainLogBuffer());
  }

  public async plainLogByRevision(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevision(revision)
    );
  }

  public async plainLogByRevisionBuffer(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevisionBuffer(revision)
    );
  }

  public async plainLogByText(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByText(search)
    );
  }

  public async plainLogByTextBuffer(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByTextBuffer(search)
    );
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri
  ) {
    return this.run(Operation.Log, () =>
      this.repository.log(rfrom, rto, limit, target)
    );
  }

  /**
   * Fetch a single revision's log entries without the Source Control progress
   * indicator. Used by the inline blame hover: `Operation.Log` would flash the
   * progress bar in the SCM view on every hovered line.
   */
  public async logMessage(revision: string, target?: string | Uri) {
    return this.run(Operation.Blame, () =>
      this.repository.log(revision, revision, 1, target)
    );
  }

  public async logByUser(user: string) {
    return this.run(Operation.Log, () => this.repository.logByUser(user));
  }

  public async cleanup() {
    return this.run(Operation.CleanUp, () => this.repository.cleanup());
  }

  public async removeUnversioned() {
    return this.run(Operation.CleanUp, () =>
      this.repository.removeUnversioned()
    );
  }

  public async getInfo(path: string, revision?: string): Promise<ISvnInfo> {
    return this.run(Operation.Info, () =>
      this.repository.getInfo(path, revision, true)
    );
  }

  public async getChanges(): Promise<ISvnPathChange[]> {
    return this.run(Operation.Changes, () => this.repository.getChanges());
  }

  public async finishCheckout() {
    return this.run(Operation.SwitchBranch, () =>
      this.repository.finishCheckout()
    );
  }

  public async addToIgnore(
    expressions: string[],
    directory: string,
    recursive: boolean = false
  ) {
    return this.run(Operation.Ignore, () =>
      this.repository.addToIgnore(expressions, directory, recursive)
    );
  }

  public async rename(oldFile: string, newFile: string) {
    return this.run(Operation.Rename, () =>
      this.repository.rename(oldFile, newFile)
    );
  }

  public async blame(
    filePath: string,
    options?: { force?: boolean; revision?: string; ignoreWhitespace?: boolean }
  ): Promise<ISvnBlameLine[]> {
    return this.run<ISvnBlameLine[]>(Operation.Blame, () =>
      this.repository.blame(filePath, options)
    );
  }

  public async copy(
    source: string | Uri,
    destination: string | Uri,
    message?: string
  ) {
    return this.run(Operation.Copy, () =>
      this.repository.copy(source, destination, message)
    );
  }

  public async propget(
    propName: string,
    filePath: string,
    revision?: string
  ): Promise<string | undefined> {
    return this.run<string | undefined>(Operation.PropGet, () =>
      this.repository.propget(propName, filePath, revision)
    );
  }

  public async propset(
    propName: string,
    value: string,
    filePath: string,
    recursive: boolean = false
  ) {
    return this.run(Operation.PropSet, () =>
      this.repository.propset(propName, value, filePath, recursive)
    );
  }

  public async propdel(
    propName: string,
    filePath: string,
    recursive: boolean = false
  ) {
    return this.run(Operation.PropDel, () =>
      this.repository.propdel(propName, filePath, recursive)
    );
  }

  public async proplist(filePath: string): Promise<ISvnProperty[]> {
    return this.run<ISvnProperty[]>(Operation.PropGet, () =>
      this.repository.proplist(filePath)
    );
  }

  public async getExternals(directory: string): Promise<ISvnExternal[]> {
    return this.run<ISvnExternal[]>(Operation.PropGet, () =>
      this.repository.getExternals(directory)
    );
  }

  public async setExternals(
    directory: string,
    externals: ISvnExternal[]
  ): Promise<string> {
    return this.run<string>(Operation.PropSet, () =>
      this.repository.setExternals(directory, externals)
    );
  }

  public async lock(files: string[], message?: string): Promise<string> {
    return this.run<string>(Operation.Lock, () =>
      this.repository.lock(files, message)
    );
  }

  public async unlock(
    files: string[],
    force: boolean = false
  ): Promise<string> {
    return this.run<string>(Operation.Unlock, () =>
      this.repository.unlock(files, force)
    );
  }

  public async getLockOwner(filePath: string): Promise<string | undefined> {
    return this.run<string | undefined>(Operation.Info, () =>
      this.repository.getLockOwner(filePath)
    );
  }

  public async list(filePath: string): Promise<ISvnListItem[]> {
    return this.run<ISvnListItem[]>(Operation.List, () => {
      return this.repository.ls(filePath);
    });
  }

  public getPathNormalizer(): PathNormalizer {
    return new PathNormalizer(this.repository.info);
  }

  protected getCredentialServiceName() {
    let key = "vscode.svn-scm";

    const info = this.repository.info;

    if (info.repository && info.repository.root) {
      key += ":" + info.repository.root;
    } else if (info.url) {
      key += ":" + info.url;
    }

    return key;
  }

  public async loadStoredAuths(): Promise<Array<IStoredAuth>> {
    // Prevent multiple prompts for auth
    if (this.lastPromptAuth) {
      await this.lastPromptAuth;
    }

    const secret = await this.secrets.get(this.getCredentialServiceName());

    if (typeof secret === "undefined") {
      return [];
    }

    const credentials = JSON.parse(secret) as Array<IStoredAuth>;

    return credentials;
  }

  public async saveAuth(): Promise<void> {
    if (this.canSaveAuth && this.username && this.password) {
      const secret = await this.secrets.get(this.getCredentialServiceName());
      let credentials: Array<IStoredAuth> = [];

      if (typeof secret === "string") {
        credentials = JSON.parse(secret) as Array<IStoredAuth>;
      }

      credentials.push({
        account: this.username,
        password: this.password
      });

      await this.secrets.store(
        this.getCredentialServiceName(),
        JSON.stringify(credentials)
      );

      this.canSaveAuth = false;
    }
  }

  public async promptAuth(): Promise<IAuth | undefined> {
    // Prevent multiple prompts for auth
    if (this.lastPromptAuth) {
      return this.lastPromptAuth;
    }

    this.lastPromptAuth = commands.executeCommand("svn.promptAuth");
    const result = await this.lastPromptAuth;

    if (result) {
      this.username = result.username;
      this.password = result.password;
      this.canSaveAuth = true;
    }

    this.lastPromptAuth = undefined;
    return result;
  }

  public onDidSaveTextDocument(document: TextDocument) {
    const uriString = document.uri.toString();
    const conflict = this.conflicts.resourceStates.find(
      resource => resource.resourceUri.toString() === uriString
    );
    if (!conflict) {
      return;
    }

    const text = document.getText();

    // Check for lines begin with "<<<<<<", "=======", ">>>>>>>"
    if (!/^<{7}[^]+^={7}[^]+^>{7}/m.test(text)) {
      commands.executeCommand("svn.resolved", conflict.resourceUri);
    }
  }

  private async run<T>(
    operation: Operation,
    runOperation: () => Promise<T> = () => Promise.resolve<any>(null),
    showProgress: boolean = true,
    includeIgnored: boolean = true
  ): Promise<T> {
    if (this.state !== RepositoryState.Idle) {
      throw new Error("Repository not initialized");
    }

    const run = async () => {
      this._operations.start(operation);
      this._onRunOperation.fire(operation);

      try {
        const result = await this.retryRun(runOperation);

        const checkRemote = operation === Operation.StatusRemote;

        if (!isReadOnly(operation)) {
          try {
            await this.updateModelState(checkRemote, includeIgnored);
          } catch (err) {
            // Refreshing the model is not part of the user's operation. A
            // background `svn status` (notably `--show-updates` timing out on
            // a slow server) must not make a successful update or commit look
            // like it failed. Status operations still propagate because the
            // refresh *is* their result and callers fall back to a local scan;
            // a missing working copy must propagate so the repository is closed.
            const e = err as Error & { svnErrorCode?: string };

            if (
              operation === Operation.Status ||
              operation === Operation.StatusRemote ||
              e.svnErrorCode === svnErrorCodes.NotASvnRepository
            ) {
              throw err;
            }

            console.error(err);
          }
        }

        return result;
      } catch (err) {
        const e = err as Error & { svnErrorCode?: string };
        if (e.svnErrorCode === svnErrorCodes.NotASvnRepository) {
          this.state = RepositoryState.Disposed;
        }

        const rootExists = await exists(this.workspaceRoot);
        if (!rootExists) {
          await commands.executeCommand("svn.close", this);
        }

        throw err;
      } finally {
        this._operations.end(operation);
        this._onDidRunOperation.fire(operation);
      }
    };

    return showProgress && shouldShowProgress(operation)
      ? window.withProgress({ location: ProgressLocation.SourceControl }, run)
      : run();
  }

  private async retryRun<T>(
    runOperation: () => Promise<T> = () => Promise.resolve<any>(null)
  ): Promise<T> {
    let attempt = 0;
    let accounts: IStoredAuth[] = [];

    while (true) {
      try {
        attempt++;
        const result = await runOperation();
        this.saveAuth();
        return result;
      } catch (err) {
        const e = err as Error & { svnErrorCode?: string };
        if (
          e.svnErrorCode === svnErrorCodes.RepositoryIsLocked &&
          attempt <= 10
        ) {
          // quatratic backoff
          await timeout(Math.pow(attempt, 2) * 50);
        } else if (
          e.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
          attempt <= 1 + accounts.length
        ) {
          // First attempt load all stored auths
          if (attempt === 1) {
            accounts = await this.loadStoredAuths();
          }

          // each attempt, try a different account
          const index = accounts.length - 1;
          if (typeof accounts[index] !== "undefined") {
            this.username = accounts[index].account;
            this.password = accounts[index].password;
          }
        } else if (
          e.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
          attempt <= 3 + accounts.length
        ) {
          const result = await this.promptAuth();
          if (!result) {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
  }

  public dispose(): void {
    this.disposables = dispose(this.disposables);
  }
}
