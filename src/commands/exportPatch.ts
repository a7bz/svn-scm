import { SourceControlResourceState, Uri, window } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { l10n } from "vscode";
import { writeFile } from "../fs";

export class ExportPatch extends Command {
  constructor() {
    super("svn.exportPatch");
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
        const content = await repository.patch(files);

        if (!content.trim()) {
          window.showInformationMessage(l10n.t("No changes to export"));
          return;
        }

        await this.savePatch(repository, content, files);
      } catch (error) {
        console.error(error);
        window.showErrorMessage(l10n.t("Unable to create patch"));
      }
    });
  }

  private async savePatch(
    repository: Repository,
    content: string,
    files: string[]
  ) {
    const suggested = this.suggestFileName(repository, files);

    const uri = await window.showSaveDialog({
      defaultUri: suggested,
      filters: { Patch: ["patch", "diff"], All: ["*"] },
      saveLabel: l10n.t("Export patch")
    });

    if (!uri) {
      return;
    }

    try {
      await writeFile(uri.fsPath, content, "UTF-8");
      window.showInformationMessage(
        l10n.t("Patch exported to {0}", uri.fsPath)
      );
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to write patch file"));
    }
  }

  /**
   * Build a `<workspace>-<timestamp>.patch` default file name inside the
   * workspace root so the dialog opens somewhere sensible.
   */
  private suggestFileName(repository: Repository, files: string[]) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);

    const name = files.length === 1 ? files[0].split(/[\\/]/).pop() : "changes";

    const base = name
      ? name.replace(/\.[^.]+$/, "")
      : repository.root.split(/[\\/]/).pop();

    const uri = Uri.file(`${repository.root}/${base}-${stamp}.patch`);

    return uri;
  }

  /** Exposed for the "export all changes" command. */
  public async exportAll(repository: Repository) {
    try {
      const content = await repository.patch([]);

      if (!content.trim()) {
        window.showInformationMessage(l10n.t("No changes to export"));
        return;
      }

      await this.savePatch(repository, content, []);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to create patch"));
    }
  }
}

export class ExportPatchAll extends Command {
  constructor(private exporter: ExportPatch) {
    super("svn.exportPatchAll", { repository: true });
  }

  public async execute(repository: Repository) {
    await this.exporter.exportAll(repository);
  }
}
