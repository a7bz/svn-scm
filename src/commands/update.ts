import { l10n, window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { svnErrorCodes } from "../svn";
import { Command } from "./command";

export class Update extends Command {
  constructor() {
    super("svn.update", { repository: true });
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

      const result = await repository.updateRevision(ignoreExternals);

      if (showUpdateMessage) {
        window.showInformationMessage(result);
      }
    } catch (error) {
      console.error(error);

      const e = error as Error & {
        message?: string;
        stderrFormated?: string;
        svnErrorCode?: string;
      };

      // Never surface just "Unable to update": the actual SVN message (e.g.
      // "Working copy locked; run 'svn cleanup'", "Unable to connect to a
      // repository", "Authorization failed") is what the user needs to act on.
      const details = (e.stderrFormated || e.message || "").trim();
      const message = details
        ? l10n.t("Unable to update: {0}", details)
        : l10n.t("Unable to update");

      if (e.svnErrorCode === svnErrorCodes.RepositoryIsLocked) {
        const cleanUp = l10n.t("Run cleanup command");

        window.showErrorMessage(message, cleanUp).then(choice => {
          if (choice === cleanUp) {
            repository.cleanup().catch(err => console.error(err));
          }
        });

        return;
      }

      window.showErrorMessage(message);
    }
  }
}
