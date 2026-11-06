import { Event, Uri, workspace, EventEmitter, RelativePattern } from "vscode";
import { watch } from "fs";
import { exists } from "../fs";
import { join } from "path";
import { debounce } from "../decorators";
import {
  anyEvent,
  filterEvent,
  IDisposable,
  isDescendant,
  fixPathSeparator,
  getSvnDir,
  normalizePath
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

    if (
      typeof workspace.workspaceFolders !== "undefined" &&
      !workspace.workspaceFolders.filter(w => isDescendant(w.uri.fsPath, root))
        .length
    ) {
      const repoWatcher = watch(
        join(root, getSvnDir()),
        this.repoWatch.bind(this)
      );

      repoWatcher.on("error", error => {
        throw error;
      });

      onRepoChange = this._onRepoChange.event;
      onRepoCreate = this._onRepoCreate.event;
      onRepoDelete = this._onRepoDelete.event;
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

  @debounce(1000)
  private repoWatch(event: string, filename: string): void {
    if (event === "change") {
      this._onRepoChange.fire(Uri.parse(filename));
    } else if (event === "rename") {
      exists(filename).then(doesExist => {
        if (doesExist) {
          this._onRepoCreate.fire(Uri.parse(filename));
        } else {
          this._onRepoDelete.fire(Uri.parse(filename));
        }
      });
    }
  }

  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
