import { l10n, window } from "vscode";
import { selectBranch } from "../helpers/branch";
import { buildRevisionArgs, mergeBranch } from "../helpers/merge";
import { Repository } from "../repository";
import { Command } from "./command";

const REVISION_RANGE = /^\d+:\d+$/;
const REVISION_LIST = /^\d+(,\d+)*$/;

export class MergeRevisions extends Command {
  constructor() {
    super("svn.mergeRevisions", { repository: true });
  }

  public async execute(repository: Repository) {
    const branch = await selectBranch(repository);

    if (!branch) {
      return;
    }

    const revision = await window.showInputBox({
      prompt: l10n.t(
        "Provide the revision or range to merge (e.g. 123, 123:456 or 1,2,3)"
      ),
      ignoreFocusOut: true,
      validateInput: value => {
        const input = value.trim();
        if (REVISION_RANGE.test(input) || REVISION_LIST.test(input)) {
          return;
        }
        return l10n.t("Invalid revision");
      }
    });

    if (!revision) {
      return;
    }

    const previewLabel = l10n.t("Preview merge (dry-run)");
    const mergeNow = l10n.t("Merge now");
    const action = await window.showQuickPick([previewLabel, mergeNow], {
      placeHolder: l10n.t(
        "Merge {0} from {1} into the current branch",
        revision.trim(),
        branch.name
      ),
      ignoreFocusOut: true
    });

    if (!action) {
      return;
    }

    await mergeBranch(repository, branch.path, {
      revisions: buildRevisionArgs(revision),
      dryRun: action === previewLabel
    });
  }
}
