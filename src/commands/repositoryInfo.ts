import { l10n, Uri, window, workspace } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { tempSvnFs } from "../temp_svn_fs";

/**
 * Show a read-only overview of the repository the current file/folder belongs
 * to (or of the only open repository): URL, revision, root, UUID, last commit
 * and the state of the working copy.
 */
export class RepositoryInfo extends Command {
  constructor() {
    super("svn.repositoryInfo", { repository: true });
  }

  public async execute(repository: Repository) {
    try {
      const info = await repository.getInfo(repository.workspaceRoot);

      const groups = [
        ["Repository root", info.repository ? info.repository.root : ""],
        ["URL", info.url],
        ["Revision", info.revision],
        ["Repository UUID", info.repository ? info.repository.uuid : ""],
        ["Last changed author", info.commit ? info.commit.author : ""],
        ["Last changed revision", info.commit ? info.commit.revision : ""],
        ["Last changed date", info.commit ? info.commit.date : ""],
        ["Working copy root", info.wcInfo ? info.wcInfo.wcrootAbspath : ""],
        ["Local path", repository.workspaceRoot]
      ];

      const currentBranch = await repository.getCurrentBranch();
      if (currentBranch) {
        groups.splice(2, 0, [l10n.t("Branch"), currentBranch]);
      }

      const lines: string[] = [l10n.t("Repository Information"), ""];

      for (const [label, value] of groups) {
        if (!value) {
          continue;
        }
        lines.push(`${l10n.t(label)}: ${value}`);
      }

      const uri = await tempSvnFs.createTempSvnRevisionFile(
        Uri.file(repository.workspaceRoot),
        "info",
        lines.join("\n")
      );

      await workspace.openTextDocument(uri);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to read repository information"));
    }
  }
}

/**
 * Show, add, edit and remove the `svn:externals` definitions of the working
 * copy root. Editing writes the new definitions through `svn propset`.
 */
export class ManageExternals extends Command {
  constructor() {
    super("svn.manageExternals", { repository: true });
  }

  public async execute(repository: Repository) {
    const directory = repository.workspaceRoot;

    let externals: Array<{ url: string; path: string; revision?: string }>;

    try {
      externals = await repository.getExternals(directory);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to read externals"));
      return;
    }

    const picks = externals.map(e => ({
      label: e.path,
      description: e.url,
      detail: e.revision ? l10n.t("Pinned to revision {0}", e.revision) : "",
      external: e
    }));

    picks.push({
      label: l10n.t("Add a new external"),
      description: "",
      detail: "",
      external: undefined
    });

    const pick = await window.showQuickPick(picks, {
      placeHolder: l10n.t("Externals of {0}", directory),
      matchOnDescription: true
    });

    if (!pick) {
      return;
    }

    if (!pick.external) {
      await this.addExternal(repository, externals, directory);
      return;
    }

    await this.editExternal(repository, externals, directory, pick.external);
  }

  private async addExternal(
    repository: Repository,
    externals: Array<{ url: string; path: string; revision?: string }>,
    directory: string
  ) {
    const url = await window.showInputBox({
      prompt: l10n.t("URL of the external"),
      placeHolder: "https://example.com/svn/lib",
      ignoreFocusOut: true,
      validateInput: value =>
        value.trim() ? undefined : l10n.t("URL cannot be empty")
    });

    if (!url) {
      return;
    }

    const relativePath = await window.showInputBox({
      prompt: l10n.t("Local folder of the external"),
      placeHolder: "lib",
      ignoreFocusOut: true,
      validateInput: value =>
        value.trim() ? undefined : l10n.t("Path cannot be empty")
    });

    if (!relativePath) {
      return;
    }

    const revision = await window.showInputBox({
      prompt: l10n.t("Pin to a revision (optional)"),
      ignoreFocusOut: true
    });

    externals.push({
      url: url.trim(),
      path: relativePath.trim(),
      revision: revision?.trim()
    });

    await this.saveExternals(repository, externals, directory);
  }

  private async editExternal(
    repository: Repository,
    externals: Array<{ url: string; path: string; revision?: string }>,
    directory: string,
    external: { url: string; path: string; revision?: string }
  ) {
    const editLabel = l10n.t("Edit");
    const deleteLabel = l10n.t("Delete external");

    const action = await window.showQuickPick(
      [
        { label: editLabel, description: external.path },
        { label: deleteLabel, description: external.path }
      ],
      {
        placeHolder: l10n.t("External '{0}'", external.path)
      }
    );

    if (!action) {
      return;
    }

    if (action.label === deleteLabel) {
      const yes = l10n.t("Yes");
      const answer = await window.showWarningMessage(
        l10n.t("Remove the external '{0}'?", external.path),
        { modal: true },
        yes,
        l10n.t("No")
      );

      if (answer !== yes) {
        return;
      }

      await this.saveExternals(
        repository,
        externals.filter(e => e !== external),
        directory
      );
      return;
    }

    const url = await window.showInputBox({
      value: external.url,
      prompt: l10n.t("URL of the external"),
      ignoreFocusOut: true
    });

    if (url === undefined) {
      return;
    }

    const relativePath = await window.showInputBox({
      value: external.path,
      prompt: l10n.t("Local folder of the external"),
      ignoreFocusOut: true
    });

    if (relativePath === undefined) {
      return;
    }

    const revision = await window.showInputBox({
      value: external.revision,
      prompt: l10n.t("Pin to a revision (optional)"),
      ignoreFocusOut: true
    });

    external.url = url.trim();
    external.path = relativePath.trim();
    external.revision = revision?.trim();

    await this.saveExternals(repository, externals, directory);
  }

  private async saveExternals(
    repository: Repository,
    externals: Array<{ url: string; path: string; revision?: string }>,
    directory: string
  ) {
    try {
      await repository.setExternals(directory, externals);
      window.showInformationMessage(l10n.t("Externals updated"));
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to update externals"));
    }
  }
}
