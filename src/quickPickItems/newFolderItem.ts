import { l10n, QuickPickItem } from "vscode";

export default class NewFolderItem implements QuickPickItem {
  constructor(protected _parent: string) {}

  get label(): string {
    return l10n.t(`$(plus) Create new branch`);
  }

  get description(): string {
    return l10n.t(`Create new branch in "${this._parent}"`);
  }
}
