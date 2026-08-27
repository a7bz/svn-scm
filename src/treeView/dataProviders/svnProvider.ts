import {
  commands,
  Event,
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Disposable,
  window
} from "vscode";
import { SourceControlManager } from "../../source_control_manager";
import BaseNode from "../nodes/baseNode";
import CandidateRepositoriesNode from "../nodes/candidateRepositoriesNode";
import RepositoryNode from "../nodes/repositoryNode";
import { dispose } from "../../util";

export default class SvnProvider
  implements TreeDataProvider<BaseNode>, Disposable {
  private _onDidChangeTreeData: EventEmitter<
    BaseNode | undefined
  > = new EventEmitter<BaseNode | undefined>();
  private _dispose: Disposable[] = [];
  public onDidChangeTreeData: Event<BaseNode | undefined> = this
    ._onDidChangeTreeData.event;

  constructor(private sourceControlManager: SourceControlManager) {
    this._dispose.push(
      window.registerTreeDataProvider("svn", this),
      commands.registerCommand("svn.treeview.refreshProvider", () =>
        this.refresh()
      ),
      sourceControlManager.onDidChangeCandidates(() => this.refresh())
    );
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: RepositoryNode): TreeItem {
    return element.getTreeItem();
  }

  public async getChildren(element?: BaseNode): Promise<BaseNode[]> {
    if (!this.sourceControlManager) {
      return Promise.resolve([]);
    }

    if (element) {
      return element.getChildren();
    }

    const nodes: BaseNode[] = this.sourceControlManager.openRepositories.map(
      repository => {
        return new RepositoryNode(repository.repository, this);
      }
    );

    const candidates = this.sourceControlManager.candidateRepositoryPaths.filter(
      c => !this.sourceControlManager.getRepository(c)
    );

    if (candidates.length > 0) {
      nodes.push(new CandidateRepositoriesNode(this.sourceControlManager));
    }

    return nodes;
  }

  public update(node: BaseNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  public dispose() {
    dispose(this._dispose);
  }
}
