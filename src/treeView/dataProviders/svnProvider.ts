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
import { Repository } from "../../repository";
import BaseNode from "../nodes/baseNode";
import CandidateRepositoriesNode from "../nodes/candidateRepositoriesNode";
import RepositoryNode from "../nodes/repositoryNode";
import { dispose } from "../../util";

export default class SvnProvider
  implements TreeDataProvider<BaseNode>, Disposable
{
  private _onDidChangeTreeData: EventEmitter<BaseNode | undefined> =
    new EventEmitter<BaseNode | undefined>();
  private _dispose: Disposable[] = [];
  private repositoryNodes = new Map<Repository, RepositoryNode>();

  public onDidChangeTreeData: Event<BaseNode | undefined> =
    this._onDidChangeTreeData.event;

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

    const repositories = this.sourceControlManager.openRepositories.map(
      liveRepository => liveRepository.repository
    );

    // Drop cached nodes for repositories that are no longer open, disposing
    // their event listeners.
    for (const [repository, node] of this.repositoryNodes) {
      if (!repositories.includes(repository)) {
        node.dispose();
        this.repositoryNodes.delete(repository);
      }
    }

    // Reuse the existing node per repository so its listeners are registered
    // only once, instead of leaking a new subscription on every refresh.
    const nodes: BaseNode[] = repositories.map(repository => {
      let node = this.repositoryNodes.get(repository);

      if (!node) {
        node = new RepositoryNode(repository, this);
        this.repositoryNodes.set(repository, node);
      }

      return node;
    });

    const candidates =
      this.sourceControlManager.candidateRepositoryPaths.filter(
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
    this.repositoryNodes.forEach(node => node.dispose());
    this.repositoryNodes.clear();
    dispose(this._dispose);
  }
}
