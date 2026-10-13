import { l10n, window } from "vscode";
import { getConflictPickOptions } from "../conflictItems";
import { Repository } from "../repository";
import { Command } from "./command";

export class ResolveAll extends Command {
  constructor() {
    super("svn.resolveAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const conflicts = repository.conflicts.resourceStates;

    if (!conflicts.length) {
      window.showInformationMessage(l10n.t("No Conflicts"));
      return;
    }

    for (const conflict of conflicts) {
      const placeHolder = l10n.t(
        "Select conflict option for {0}",
        conflict.resourceUri.fsPath
      );
      const picks = getConflictPickOptions();

      const choice = await window.showQuickPick(picks, { placeHolder });

      if (!choice) {
        return;
      }

      try {
        const response = await repository.resolve(
          [conflict.resourceUri.fsPath],
          choice.label
        );
        window.showInformationMessage(response);
      } catch (error) {
        window.showErrorMessage((error as any).stderrFormated);
      }
    }
  }
}
