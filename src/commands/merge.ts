import { l10n, commands, window } from "vscode";
import { IBranchItem } from "../common/types";
import { isTrunk, selectBranch } from "../helpers/branch";
import { Repository } from "../repository";
import { Command } from "./command";

export class Merge extends Command {
  constructor() {
    super("svn.merge", { repository: true });
  }

  public async execute(repository: Repository) {
    const branch = await selectBranch(repository);

    if (!branch) {
      return;
    }

    await this.merge(repository, branch);
  }

  async merge(repository: Repository, branch: IBranchItem) {
    let reintegrate = false;
    if (isTrunk(repository.currentBranch)) {
      reintegrate = true;
    }

    try {
      await repository.merge(branch.path, reintegrate);
    } catch (error) {
      const e = error as any;
      if (e != null && typeof e === "object" && "stderrFormated" in e) {
        if ((e.stderrFormated as string).includes("try updating first")) {
          const yes = l10n.t("Yes");
          const answer = await window.showErrorMessage(
            l10n.t(
              "Seems like you need to update first prior to merging. Would you like to update now and try merging again?"
            ),
            yes,
            l10n.t("No")
          );
          if (answer === yes) {
            await commands.executeCommand("svn.update");
            await this.merge(repository, branch);
          }
        } else {
          window.showErrorMessage(
            l10n.t("Unable to merge branch: ") + (error as any).stderrFormated
          );
        }
      } else {
        console.log(error);
        window.showErrorMessage(l10n.t("Unable to merge branch"));
      }
    }
  }
}
