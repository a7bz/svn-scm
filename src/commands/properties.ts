import {
  commands,
  l10n,
  SourceControlResourceState,
  Uri,
  window
} from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";

/** SVN properties a user is likely to inspect or edit. */
const WELL_KNOWN_PROPERTIES = [
  "svn:ignore",
  "svn:externals",
  "svn:eol-style",
  "svn:mime-type",
  "svn:executable",
  "svn:keywords",
  "svn:needs-lock",
  "svn:special"
];

interface PropertyPick {
  label: string;
  description: string;
  detail: string;
  property: { name: string; value: string };
}

export class Properties extends Command {
  constructor() {
    super("svn.properties");
  }

  public async execute(arg?: SourceControlResourceState | Uri) {
    const uri = await this.getTargetUri(arg);

    if (!uri) {
      window.showWarningMessage(l10n.t("Select a file or folder first"));
      return;
    }

    if (uri.scheme !== "file") {
      window.showWarningMessage(
        l10n.t("Properties are only available for working copy files")
      );
      return;
    }

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    const repository = sourceControlManager.getRepository(uri);

    if (!repository) {
      window.showWarningMessage(
        l10n.t("The path is not in a versioned working copy")
      );
      return;
    }

    const fsPath = uri.fsPath;

    let properties: Array<{ name: string; value: string }>;

    try {
      properties = await repository.proplist(fsPath);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to read properties"));
      return;
    }

    const picks: PropertyPick[] = properties.map(p => ({
      label: p.name,
      description: p.value,
      detail: l10n.t("Current value"),
      property: p
    }));

    // Also offer well-known properties that are not set yet
    for (const name of WELL_KNOWN_PROPERTIES) {
      if (properties.some(p => p.name === name)) {
        continue;
      }
      picks.push({
        label: name,
        description: l10n.t("Not set"),
        detail: l10n.t("Add property"),
        property: { name, value: "" }
      });
    }

    const pick = await window.showQuickPick(picks, {
      placeHolder: l10n.t("Select a property of {0}", fsPath),
      matchOnDescription: true
    });

    if (!pick) {
      return;
    }

    if (pick.property.value) {
      await this.editProperty(repository, fsPath, pick.property);
    } else {
      await this.addProperty(repository, fsPath, pick.property.name);
    }
  }

  private async editProperty(
    repository: Repository,
    fsPath: string,
    property: { name: string; value: string }
  ) {
    const editLabel = l10n.t("Edit value");
    const deleteLabel = l10n.t("Delete property");

    const action = await window.showQuickPick(
      [
        { label: editLabel, description: property.name },
        { label: deleteLabel, description: property.name }
      ],
      {
        placeHolder: l10n.t("What do you want to do with '{0}'?", property.name)
      }
    );

    if (!action) {
      return;
    }

    if (action.label === deleteLabel) {
      const yes = l10n.t("Yes");
      const answer = await window.showWarningMessage(
        l10n.t("Delete the property '{0}'?", property.name),
        { modal: true },
        yes,
        l10n.t("No")
      );

      if (answer !== yes) {
        return;
      }

      try {
        await repository.propdel(property.name, fsPath);
      } catch (error) {
        console.error(error);
        window.showErrorMessage(l10n.t("Unable to delete property"));
      }
      return;
    }

    const newValue = await window.showInputBox({
      value: property.value,
      prompt: l10n.t("New value for '{0}'", property.name),
      ignoreFocusOut: true
    });

    if (newValue === undefined) {
      return;
    }

    try {
      await repository.propset(property.name, newValue, fsPath);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to set property"));
    }
  }

  private async addProperty(
    repository: Repository,
    fsPath: string,
    name: string
  ) {
    const value = await window.showInputBox({
      prompt: l10n.t("Value for '{0}'", name),
      ignoreFocusOut: true
    });

    if (value === undefined) {
      return;
    }

    try {
      await repository.propset(name, value, fsPath);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to set property"));
    }
  }
}
