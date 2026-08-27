import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from "vscode";
import { configuration } from "../../helpers/configuration";
import { SourceControlManager } from "../../source_control_manager";
import BaseNode from "./baseNode";
import CandidateRepositoryNode from "./candidateRepositoryNode";

export default class CandidateRepositoriesNode implements BaseNode {
  constructor(private sourceControlManager: SourceControlManager) {}

  public getTreeItem(): TreeItem {
    const candidates = this.sourceControlManager.candidateRepositoryPaths.filter(
      c => !this.sourceControlManager.getRepository(c)
    );

    const multipleFolders = configuration.get<boolean>(
      "multipleFolders.enabled",
      false
    );

    const label = multipleFolders
      ? `Other SVN repositories (${candidates.length})`
      : `Sub-folder SVN repositories (${candidates.length})`;

    const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
    item.iconPath = new ThemeIcon("repo");
    item.contextValue = "svnCandidates";

    return item;
  }

  public async getChildren(): Promise<BaseNode[]> {
    return this.sourceControlManager.candidateRepositoryPaths
      .filter(c => !this.sourceControlManager.getRepository(c))
      .map(c => new CandidateRepositoryNode(c));
  }
}
