import {
  commands,
  l10n,
  SourceControlResourceState,
  Uri,
  window,
  workspace
} from "vscode";
import { Command } from "./command";
import { configuration } from "../helpers/configuration";
import dayjs from "dayjs";
import { tempSvnFs } from "../temp_svn_fs";
import * as path from "path";
import { readFile } from "../fs";
import { SourceControlManager } from "../source_control_manager";
import { ISvnBlameLine } from "../common/types";

export class Blame extends Command {
  constructor() {
    super("svn.blame");
  }

  public async execute(arg?: SourceControlResourceState | Uri) {
    // The menu entries are hidden by `svn.blame.enabled`, but the command can
    // still be reached (keybinding, `commands.executeCommand`, ...).
    const blameEnabled = configuration.get<boolean>("blame.enabled");

    if (blameEnabled === false) {
      window.showWarningMessage(
        l10n.t("The blame command is disabled in the settings")
      );
      return;
    }

    const uri = await this.getTargetUri(arg);

    if (!uri) {
      return;
    }

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager | undefined;

    if (!sourceControlManager) {
      return;
    }

    const repository = sourceControlManager.getRepository(uri);

    if (!repository) {
      window.showWarningMessage(
        l10n.t("The file is not in a versioned working copy")
      );
      return;
    }

    try {
      const blame = await repository.blame(uri.fsPath);

      if (!blame.length) {
        window.showWarningMessage(l10n.t("No blame information for this file"));
        return;
      }

      const content = await this.buildBlameDocument(uri.fsPath, blame);

      const tempUri = await tempSvnFs.createTempSvnRevisionFile(
        uri,
        "blame",
        content
      );

      await workspace.openTextDocument(tempUri);
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to blame"));
    }
  }

  /**
   * Resolve the file to blame from a resource state, a `svn:`/`file:` URI or
   * the active editor. Returns `undefined` (after showing a message) when no
   * file could be determined.
   */
  private async getTargetUri(
    arg?: SourceControlResourceState | Uri
  ): Promise<Uri | undefined> {
    let uri: Uri | undefined;

    if (arg instanceof Uri) {
      uri = arg.scheme === "svn" ? Uri.file(JSON.parse(arg.query).fsPath) : arg;
    } else if (arg && arg.resourceUri) {
      uri = arg.resourceUri;
    } else {
      const resource = await this.getSCMResource();

      if (resource) {
        uri = resource.resourceUri;
      } else if (window.activeTextEditor) {
        uri = window.activeTextEditor.document.uri;
      }
    }

    if (!uri) {
      window.showWarningMessage(
        l10n.t("Select a file to show the blame information")
      );
      return undefined;
    }

    if (uri.scheme !== "file") {
      window.showWarningMessage(l10n.t("Blame is only available for files"));
      return undefined;
    }

    return uri;
  }

  /**
   * Build a read-only text document where each line of the original file is
   * prefixed with `r<revision> <author> <date>`.
   */
  private async buildBlameDocument(
    fsPath: string,
    blame: ISvnBlameLine[]
  ): Promise<string> {
    const raw = (await readFile(fsPath, {
      encoding: "utf8"
    })) as string;

    const lines = raw.split(/\r?\n/);

    const useRelativeDates = configuration.get<boolean>(
      "blame.relativeDates",
      true
    );

    const maxRevLength = Math.max(...blame.map(b => b.revision.length), 0);
    const maxAuthorLength = Math.max(...blame.map(b => b.author.length), 0);

    const out: string[] = [];

    out.push(l10n.t("Blame for {0}", path.basename(fsPath)));
    out.push("");
    out.push(
      l10n.t("Revision").padEnd(maxRevLength, " ") +
        " " +
        l10n.t("Author").padEnd(maxAuthorLength, " ") +
        " " +
        l10n.t("Date") +
        " | " +
        l10n.t("Line")
    );
    out.push("");

    for (const entry of blame) {
      const index = entry.lineNumber - 1;

      const revision = entry.revision.padStart(maxRevLength, " ");
      const author = entry.author.padEnd(maxAuthorLength, " ");

      let date = "";
      if (entry.date) {
        date = useRelativeDates
          ? dayjs(entry.date).fromNow()
          : dayjs(entry.date).format("YYYY-MM-DD");
      }

      const line = index >= 0 && index < lines.length ? lines[index] : "";

      const datePart = date ? " " + date : "";

      out.push(`${revision} ${author}${datePart} | ${line}`);
    }

    return out.join("\n");
  }
}
