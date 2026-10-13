import * as path from "path";
import { Disposable, TreeItem, TreeItemCollapsibleState } from "vscode";
import { Repository } from "../../repository";
import { getIconUri } from "../../uri";
import SvnProvider from "../dataProviders/svnProvider";
import BaseNode from "./baseNode";
import IncomingChangesNode from "./incomingChangesNode";
import { dispose } from "../../util";

export default class RepositoryNode implements BaseNode {
  private disposables: Disposable[] = [];

  constructor(
    private repository: Repository,
    private svnProvider: SvnProvider
  ) {
    this.disposables.push(
      repository.onDidChangeStatus(() => {
        this.svnProvider.update(this);
      }),
      repository.onDidChangeRemoteChangedFile(() => {
        this.svnProvider.update(this);
      })
    );
  }

  get label() {
    return path.basename(this.repository.workspaceRoot);
  }

  public getTreeItem(): TreeItem {
    const item = new TreeItem(this.label, TreeItemCollapsibleState.Collapsed);
    item.iconPath = {
      dark: getIconUri("repo", "dark"),
      light: getIconUri("repo", "light")
    };

    return item;
  }

  public async getChildren(): Promise<BaseNode[]> {
    return [new IncomingChangesNode(this.repository)];
  }

  public dispose(): void {
    this.disposables = dispose(this.disposables);
  }
}
