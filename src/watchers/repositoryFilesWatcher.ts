import { Event, Uri, workspace, EventEmitter, RelativePattern } from "vscode";
import { watch } from "fs";
import { exists } from "../fs";
import { join } from "path";
import {
  anyEvent,
  filterEvent,
  IDisposable,
  fixPathSeparator,
  getSvnDir,
  normalizePath,
  toDisposable
} from "../util";

export class RepositoryFilesWatcher implements IDisposable {
  private disposables: IDisposable[] = [];

  private _onRepoChange: EventEmitter<Uri>;
  private _onRepoCreate: EventEmitter<Uri>;
  private _onRepoDelete: EventEmitter<Uri>;

  public onDidChange: Event<Uri>;
  public onDidCreate: Event<Uri>;
  public onDidDelete: Event<Uri>;
  public onDidAny: Event<Uri>;

  public onDidWorkspaceChange: Event<Uri>;
  public onDidWorkspaceCreate: Event<Uri>;
  public onDidWorkspaceDelete: Event<Uri>;
  public onDidWorkspaceAny: Event<Uri>;

  public onDidSvnChange: Event<Uri>;
  public onDidSvnCreate: Event<Uri>;
  public onDidSvnDelete: Event<Uri>;
  public onDidSvnAny: Event<Uri>;

  constructor(readonly root: string, workspaceRoot?: string) {
    // Watch both the working copy root and (when it differs) the opened
    // workspace folder. VS Code's recursive watcher is the most reliable for
    // paths inside a workspace folder, while the working copy root may be an
    // ancestor of it (or outside the workspace entirely).
    const roots = [fixPathSeparator(root)];

    if (workspaceRoot) {
      const fixedWorkspaceRoot = fixPathSeparator(workspaceRoot);

      if (normalizePath(fixedWorkspaceRoot) !== normalizePath(roots[0])) {
        roots.push(fixedWorkspaceRoot);
      }
    }

    const fsWatchers = roots.map(r =>
      workspace.createFileSystemWatcher(new RelativePattern(r, "**"))
    );

    this._onRepoChange = new EventEmitter<Uri>();
    this._onRepoCreate = new EventEmitter<Uri>();
    this._onRepoDelete = new EventEmitter<Uri>();
    let onRepoChange: Event<Uri> | undefined;
    let onRepoCreate: Event<Uri> | undefined;
    let onRepoDelete: Event<Uri> | undefined;

    // Watch the metadata directory directly, exactly like VS Code's Git
    // extension watches `.git`. The recursive VS Code watcher already covers
    // `.svn` when the working copy is inside the workspace, but it can be
    // excluded through `files.watcherExclude` and is unreliable on network
    // drives. A dedicated `fs.watch` keeps external `svn add/commit/revert`
    // visible in those setups; if it fails, the VS Code watcher remains as a
    // fallback and the periodic status poll is the final safety net.
    try {
      const repoWatcher = watch(
        join(root, getSvnDir()),
        this.repoWatch.bind(this)
      );

      // A watcher error (network drive, permissions, ENOSPC, ...) must not
      // crash the extension host.
      repoWatcher.on("error", error => console.error(error));
      this.disposables.push(toDisposable(() => repoWatcher.close()));

      onRepoChange = this._onRepoChange.event;
      onRepoCreate = this._onRepoCreate.event;
      onRepoDelete = this._onRepoDelete.event;
    } catch (error) {
      console.error(error);
    }

    this.disposables.push(...fsWatchers);

    //https://subversion.apache.org/docs/release-notes/1.3.html#_svn-hack
    const isTmp = (uri: Uri) => /[\\\/](\.svn|_svn)[\\\/]tmp/.test(uri.path);

    const isRelevant = (uri: Uri) => !isTmp(uri);

    const onDidChange = anyEvent(...fsWatchers.map(w => w.onDidChange));
    const onDidCreate = anyEvent(...fsWatchers.map(w => w.onDidCreate));
    const onDidDelete = anyEvent(...fsWatchers.map(w => w.onDidDelete));

    this.onDidChange = filterEvent(onDidChange, isRelevant);
    this.onDidCreate = filterEvent(onDidCreate, isRelevant);
    this.onDidDelete = filterEvent(onDidDelete, isRelevant);

    this.onDidAny = anyEvent(
      this.onDidChange,
      this.onDidCreate,
      this.onDidDelete
    );

    //https://subversion.apache.org/docs/release-notes/1.3.html#_svn-hack
    const svnPattern = /[\\\/](\.svn|_svn)[\\\/]/;

    const ignoreSvn = (uri: Uri) => !svnPattern.test(uri.path);

    this.onDidWorkspaceChange = filterEvent(this.onDidChange, ignoreSvn);
    this.onDidWorkspaceCreate = filterEvent(this.onDidCreate, ignoreSvn);
    this.onDidWorkspaceDelete = filterEvent(this.onDidDelete, ignoreSvn);

    this.onDidWorkspaceAny = anyEvent(
      this.onDidWorkspaceChange,
      this.onDidWorkspaceCreate,
      this.onDidWorkspaceDelete
    );
    const ignoreWorkspace = (uri: Uri) => svnPattern.test(uri.path);

    this.onDidSvnChange = filterEvent(this.onDidChange, ignoreWorkspace);
    this.onDidSvnCreate = filterEvent(this.onDidCreate, ignoreWorkspace);
    this.onDidSvnDelete = filterEvent(this.onDidDelete, ignoreWorkspace);

    if (onRepoChange && onRepoCreate && onRepoDelete) {
      this.onDidSvnChange = onRepoChange;
      this.onDidSvnCreate = onRepoCreate;
      this.onDidSvnDelete = onRepoDelete;
    }

    this.onDidSvnAny = anyEvent(
      this.onDidSvnChange,
      this.onDidSvnCreate,
      this.onDidSvnDelete
    );
  }

  private repoWatch(event: string, filename: string | null): void {
    // SQLite creates these transient files while writing the working copy
    // database. Reacting to them would only cause refresh loops; `wc.db`
    // itself is written when `svn add/commit/revert/propset` completes.
    if (filename && /^(wc\.db-(journal|wal|shm)|tmp)$/.test(filename)) {
      return;
    }

    const svnDir = join(this.root, getSvnDir());
    const uri = filename ? Uri.file(join(svnDir, filename)) : Uri.file(svnDir);

    if (event === "change") {
      this._onRepoChange.fire(uri);
    } else if (event === "rename") {
      exists(uri.fsPath).then(doesExist => {
        if (doesExist) {
          this._onRepoCreate.fire(uri);
        } else {
          this._onRepoDelete.fire(uri);
        }
      });
    }
  }

  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
