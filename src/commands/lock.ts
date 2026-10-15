import {
  commands,
  l10n,
  SourceControlResourceState,
  Uri,
  window
} from "vscode";
import { Command } from "./command";
import { SourceControlManager } from "../source_control_manager";

/**
 * `svn lock` on the selected files (or the active editor). A lock message is
 * prompted for, and locking an already locked file steals the lock.
 */
export class Lock extends Command {
  constructor() {
    super("svn.lock");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selection = await this.getResourceStates(resourceStates);

    if (selection.length === 0) {
      return;
    }

    const uris = selection.map(resource => resource.resourceUri);

    const message = await window.showInputBox({
      prompt: l10n.t("Lock message (optional)"),
      ignoreFocusOut: true
    });

    if (message === undefined) {
      return;
    }

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const files = resources.map(resource => resource.fsPath);

      try {
        await repository.lock(files, message.trim() || undefined);
      } catch (error) {
        this.showError(error, l10n.t("Unable to lock"));
      }
    });
  }

  protected showError(error: unknown, fallback: string) {
    console.error(error);
    const message =
      (error as { stderrFormated?: string }).stderrFormated ||
      (error as Error).message ||
      String(error);
    window.showErrorMessage(message || fallback);
  }
}

/** `svn unlock` on the selected files (or the active editor). */
export class Unlock extends Command {
  constructor() {
    super("svn.unlock");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selection = await this.getResourceStates(resourceStates);

    if (selection.length === 0) {
      return;
    }

    const uris = selection.map(resource => resource.resourceUri);

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const files = resources.map(resource => resource.fsPath);

      try {
        await repository.unlock(files);
      } catch (error) {
        console.error(error);
        const message =
          (error as { stderrFormated?: string }).stderrFormated ||
          (error as Error).message ||
          String(error);
        window.showErrorMessage(message || l10n.t("Unable to unlock"));
      }
    });
  }
}

/**
 * Toggle the lock state of a single file: unlock it when we hold the lock,
 * lock it (with an optional message) otherwise. Useful as a one-click command
 * from the editor title bar.
 */
export class ToggleLock extends Command {
  constructor() {
    super("svn.toggleLock");
  }

  public async execute(arg?: SourceControlResourceState | Uri) {
    const uri = await this.getTargetUri(arg);

    if (!uri) {
      window.showWarningMessage(l10n.t("Select a file first"));
      return;
    }

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    const repository = sourceControlManager.getRepository(uri);

    if (!repository) {
      window.showWarningMessage(
        l10n.t("The file is not in a versioned working copy")
      );
      return;
    }

    const file = uri.fsPath;

    try {
      const owner = await repository.getLockOwner(file);

      if (owner) {
        await repository.unlock([file]);
        window.showInformationMessage(l10n.t("Unlocked {0}", file));
        return;
      }

      const message = await window.showInputBox({
        prompt: l10n.t("Lock message (optional)"),
        ignoreFocusOut: true
      });

      if (message === undefined) {
        return;
      }

      await repository.lock([file], message.trim() || undefined);
      window.showInformationMessage(l10n.t("Locked {0}", file));
    } catch (error) {
      console.error(error);
      const message =
        (error as { stderrFormated?: string }).stderrFormated ||
        (error as Error).message ||
        String(error);
      window.showErrorMessage(message || l10n.t("Unable to lock"));
    }
  }
}
