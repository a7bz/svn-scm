import { commands, ConfigurationTarget } from "vscode";
import { configuration } from "../helpers/configuration";
import { SourceControlManager } from "../source_control_manager";
import { Command } from "./command";

export class EnableSubRepositories extends Command {
  constructor() {
    super("svn.enableSubRepositories");
  }

  public async execute() {
    await configuration.update(
      "multipleFolders.enabled",
      true,
      ConfigurationTarget.Workspace
    );

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    await sourceControlManager.scanWorkspaceFolders();
  }
}
