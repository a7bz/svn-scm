import { window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { Command } from "./command";
import { reportUpdateError } from "./update";

/**
 * Pull the latest revision from the repository, then refresh the incoming
 * changes list.
 *
 * `svn update` already performs the fetch + merge step of `git pull`; the
 * explicit remote refresh afterwards makes the incoming changes group reflect
 * the new revision instead of listing files that were just updated.
 */
export class Pull extends Command {
  constructor() {
    super("svn.pull", { repository: true });
  }

  public async execute(repository: Repository) {
    try {
      const ignoreExternals = configuration.get<boolean>(
        "update.ignoreExternals",
        false
      );
      const showUpdateMessage = configuration.get<boolean>(
        "showUpdateMessage",
        true
      );
      const checkFrequency = configuration.get<number>(
        "remoteChanges.checkFrequency",
        0
      );

      const result = await repository.updateRevision(ignoreExternals);

      // With automatic remote checks enabled, `updateRevision` already
      // schedules a refresh; only fetch explicitly when they are off (the
      // default), so a pull does not query the server twice.
      if (checkFrequency === 0) {
        await repository.fetchRemoteChanges();
      }

      if (showUpdateMessage) {
        window.showInformationMessage(result);
      }
    } catch (error) {
      reportUpdateError(repository, error);
    }
  }
}
