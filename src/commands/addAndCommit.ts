import { commands, SourceControlResourceState, Uri, window } from "vscode";
import { Command } from "./command";
import { inputCommitMessage } from "../messages";
import { SourceControlManager } from "../source_control_manager";

/**
 * `svn add` + `svn commit` in one step: version the selected unversioned
 * files and immediately commit them with a message.
 */
export class AddAndCommit extends Command {
  constructor() {
    super("svn.addAndCommit");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selection = await this.getResourceStates(resourceStates);

    if (selection.length === 0) {
      return;
    }

    const uris = selection.map(resource => resource.resourceUri);

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const paths = resources.map(resource => resource.fsPath);

      try {
        const message = await inputCommitMessage(
          repository.inputBox.value,
          true,
          paths
        );

        if (message === undefined) {
          return;
        }

        repository.inputBox.value = message;

        await repository.addFiles(paths);
        const result = await repository.commitFiles(message, paths);

        window.showInformationMessage(result);
        repository.inputBox.value = "";
      } catch (error) {
        console.error(error);
        const message =
          (error as { stderrFormated?: string }).stderrFormated ||
          (error as Error).message ||
          String(error);
        window.showErrorMessage(message);
      }
    });
  }
}

/**
 * Same as {@link AddAndCommit} but invoked from the Explorer context menu,
 * where the arguments are `(mainUri, allUris)` instead of resource states.
 */
export class AddAndCommitExplorer extends Command {
  constructor() {
    super("svn.addAndCommitExplorer");
  }

  public async execute(_mainUri?: Uri, allUris?: Uri[]) {
    if (!allUris || allUris.length === 0) {
      return;
    }

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    const groups: Array<{ repository: any; paths: string[] }> = [];

    for (const uri of allUris) {
      const repository = sourceControlManager.getRepository(uri);

      if (!repository) {
        continue;
      }

      const tuple = groups.filter(g => g.repository === repository)[0];

      if (tuple) {
        tuple.paths.push(uri.fsPath);
      } else {
        groups.push({ repository, paths: [uri.fsPath] });
      }
    }

    for (const { repository, paths } of groups) {
      try {
        const message = await inputCommitMessage(
          repository.inputBox.value,
          true,
          paths
        );

        if (message === undefined) {
          continue;
        }

        repository.inputBox.value = message;

        await repository.addFiles(paths);
        const result = await repository.commitFiles(message, paths);

        window.showInformationMessage(result);
        repository.inputBox.value = "";
      } catch (error) {
        console.error(error);
        const message =
          (error as { stderrFormated?: string }).stderrFormated ||
          (error as Error).message ||
          String(error);
        window.showErrorMessage(message);
      }
    }
  }
}
