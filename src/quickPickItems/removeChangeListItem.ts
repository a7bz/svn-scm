import { l10n, QuickPickItem } from "vscode";

export default class RemoveChangeListItem implements QuickPickItem {
  get label(): string {
    return l10n.t("$(dash) Remove changelist");
  }

  get description(): string {
    return l10n.t("Remove changelist of file(s)");
  }
}
