import { commands } from "vscode";
import { SourceControlManager } from "../source_control_manager";
import CandidateRepositoryNode from "../treeView/nodes/candidateRepositoryNode";
import { Command } from "./command";

export class OpenCandidateRepository extends Command {
  constructor() {
    super("svn.openCandidateRepository");
  }

  public async execute(arg?: string | CandidateRepositoryNode) {
    let repoPath: string | undefined;

    if (typeof arg === "string") {
      repoPath = arg;
    } else if (arg instanceof CandidateRepositoryNode) {
      repoPath = arg.repoPath;
    }

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    if (!repoPath) {
      try {
        repoPath = await sourceControlManager.pickCandidateRepository();
      } catch (error) {
        return;
      }
    }

    if (!repoPath) {
      return;
    }

    await sourceControlManager.tryOpenRepository(repoPath, 0);
  }
}
