import { l10n, QuickPickItem } from "vscode";

export default class IgnoredChangeListItem implements QuickPickItem {
  constructor(protected _id: string) {}

  get label(): string {
    return this._id;
  }

  get description(): string {
    return l10n.t("Ignored on commit");
  }
}
