import {
  l10n,
  SourceControlResourceState,
  TextDocumentShowOptions,
  Uri,
  ViewColumn,
  window,
  workspace
} from "vscode";
import { exists, stat } from "../fs";
import { Resource } from "../resource";
import IncomingChangeNode from "../treeView/nodes/incomingChangeNode";
import { fromSvnUri } from "../uri";
import { Command } from "./command";

export class OpenFile extends Command {
  constructor() {
    super("svn.openFile");
  }

  public async execute(
    arg?: Resource | Uri | IncomingChangeNode,
    ...resourceStates: SourceControlResourceState[]
  ) {
    const preserveFocus = arg instanceof Resource;

    let uris: Uri[] | undefined;

    if (arg instanceof Uri) {
      if (arg.scheme === "svn") {
        uris = [Uri.file(fromSvnUri(arg).fsPath)];
      } else if (arg.scheme === "file") {
        uris = [arg];
      }
    } else if (arg instanceof IncomingChangeNode) {
      const resource = new Resource(
        arg.uri,
        arg.type,
        undefined,
        arg.props,
        true
      );

      uris = [resource.resourceUri];
    } else {
      const resource = arg;

      if (!(resource instanceof Resource)) {
        // Can happen when the command is invoked from a keybinding or the
        // command palette, i.e. without an explicit resource argument.
        // Fall back to the active editor, otherwise the command silently
        // does nothing.
        const fallback = await this.getSCMResource();

        if (fallback) {
          return this.openUris(
            [...resourceStates.map(r => r.resourceUri), fallback.resourceUri],
            preserveFocus
          );
        }

        window.showWarningMessage(
          l10n.t("Select a file in the Source Control view first")
        );
        return;
      }

      if (resource) {
        uris = [
          ...resourceStates.map(r => r.resourceUri),
          resource.resourceUri
        ];
      }
    }

    if (!uris) {
      return;
    }

    await this.openUris(uris, preserveFocus);
  }

  private async openUris(uris: Uri[], preserveFocus: boolean): Promise<void> {
    const preview = uris.length === 1 ? true : false;
    const activeTextEditor = window.activeTextEditor;
    for (const uri of uris) {
      if (
        !uri ||
        ((await exists(uri.fsPath)) && (await stat(uri.fsPath)).isDirectory())
      ) {
        continue;
      }

      const opts: TextDocumentShowOptions = {
        preserveFocus,
        preview,
        viewColumn: ViewColumn.Active
      };

      if (
        activeTextEditor &&
        activeTextEditor.document.uri.toString() === uri.toString()
      ) {
        opts.selection = activeTextEditor.selection;
      }

      const document = await workspace.openTextDocument(uri);
      await window.showTextDocument(document, opts);
    }
  }
}
