import { l10n, Command, Disposable, Event } from "vscode";
import { Repository } from "../repository";
import { anyEvent } from "../util";
import { CheckoutStatusBar } from "./checkoutStatusBar";
import { SyncStatusBar } from "./syncStatusBar";

export class StatusBarCommands {
  private checkoutStatusBar: CheckoutStatusBar;
  private syncStatusBar: SyncStatusBar;

  private disposables: Disposable[] = [];

  constructor(private repository: Repository) {
    this.checkoutStatusBar = new CheckoutStatusBar(repository);
    this.syncStatusBar = new SyncStatusBar(repository);

    this.disposables.push(this.checkoutStatusBar, this.syncStatusBar);
  }

  get onDidChange(): Event<void> {
    return anyEvent(
      this.syncStatusBar.onDidChange,
      this.checkoutStatusBar.onDidChange
    );
  }

  get commands(): Command[] {
    const result: Command[] = [];

    const checkout = this.checkoutStatusBar.command;

    if (checkout) {
      result.push(checkout);
    }

    const sync = this.syncStatusBar.command;

    if (sync) {
      result.push(sync);
    }

    // Pull and a local-only refresh sit next to the update (sync) item, so the
    // most frequent remote/local operations are reachable without opening the
    // Source Control view's More Actions menu.
    result.push({
      command: "svn.pull",
      title: "$(repo-pull)",
      tooltip: l10n.t("Pull (Update Revision)"),
      arguments: [this.repository]
    });

    result.push({
      command: "svn.refresh",
      title: "$(refresh)",
      tooltip: l10n.t("Refresh Local Status"),
      arguments: [this.repository]
    });

    return result;
  }

  public dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
  }
}
