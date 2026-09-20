import { l10n, QuickPickItem } from "vscode";

export default class ParentFolderItem implements QuickPickItem {
  constructor(public path?: string) {}

  get label(): string {
    return l10n.t(`$(arrow-left) back to /${this.path}`);
  }
  get description(): string {
    return l10n.t(`Back to parent`);
  }
}
