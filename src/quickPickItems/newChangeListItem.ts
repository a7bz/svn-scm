import { l10n, QuickPickItem } from "vscode";

export default class NewChangeListItem implements QuickPickItem {
  get label(): string {
    return l10n.t("$(plus) New changelist");
  }

  get description(): string {
    return l10n.t("Create a new change list");
  }
}
