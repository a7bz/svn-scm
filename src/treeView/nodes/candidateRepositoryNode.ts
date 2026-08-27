import * as path from "path";
import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from "vscode";
import BaseNode from "./baseNode";

export default class CandidateRepositoryNode implements BaseNode {
  constructor(public readonly repoPath: string) {}

  public getTreeItem(): TreeItem {
    const item = new TreeItem(
      path.basename(this.repoPath),
      TreeItemCollapsibleState.None
    );
    item.description = this.repoPath;
    item.iconPath = new ThemeIcon("repo");
    item.contextValue = "svnCandidateRepo";
    item.command = {
      command: "svn.openCandidateRepository",
      title: "Open repository",
      arguments: [this.repoPath]
    };

    return item;
  }

  public async getChildren(): Promise<BaseNode[]> {
    return [];
  }
}
