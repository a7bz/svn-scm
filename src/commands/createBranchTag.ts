import { l10n, Uri, window } from "vscode";
import { Command } from "./command";
import { stat } from "../fs";
import { Repository } from "../repository";

export class CreateBranchTag extends Command {
  constructor() {
    super("svn.createBranchTag", { repository: true });
  }

  public async execute(repository: Repository, arg?: Uri) {
    let sourcePath: string;

    if (arg) {
      sourcePath = arg.fsPath;
    } else {
      const resource = await this.getSCMResource();

      if (resource) {
        sourcePath = resource.resourceUri.fsPath;
      } else if (window.activeTextEditor) {
        sourcePath = window.activeTextEditor.document.uri.fsPath;
      } else {
        sourcePath = repository.workspaceRoot;
      }
    }

    const isDirectory = await this.isDirectory(sourcePath);
    const kind = isDirectory ? "folder" : "file";

    const name = await window.showInputBox({
      prompt: l10n.t("Name of the new branch/tag"),
      placeHolder: isDirectory ? "branches/my-branch" : "tags/my-tag",
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value.trim()) {
          return l10n.t("Name cannot be empty");
        }
        if (/[\\/]{2,}|^[\\/]|[\\/]$/.test(value)) {
          return l10n.t("Invalid name");
        }
        return;
      }
    });

    if (!name) {
      return;
    }

    const message = await window.showInputBox({
      prompt: l10n.t("Commit message for the new {0}", kind),
      value: l10n.t("Created new {0} {1}", kind, name),
      ignoreFocusOut: true
    });

    // ESC on the message box cancels the copy
    if (message === undefined) {
      return;
    }

    const destination = this.buildDestination(repository, name);

    try {
      const result = await repository.copy(sourcePath, destination, message);

      window.showInformationMessage(
        l10n.t("Created {0} at {1}", kind, name) + (result ? "" : "")
      );
    } catch (error) {
      console.error(error);
      const message_ =
        (error as { stderrFormated?: string }).stderrFormated ||
        (error as Error).message ||
        String(error);
      window.showErrorMessage(message_);
    }
  }

  /**
   * The destination is resolved against the repository root, so
   * `branches/x` becomes `<repoRoot>/branches/x`.
   */
  private buildDestination(repository: Repository, name: string): Uri {
    const info = repository.repository.info;
    const root = info.repository ? info.repository.root : info.url;

    const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");

    return Uri.parse(root + "/" + normalized);
  }

  private async isDirectory(fsPath: string) {
    try {
      return (await stat(fsPath)).isDirectory();
    } catch {
      return false;
    }
  }
}
