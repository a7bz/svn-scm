import { Command } from "./command";
import {
  l10n,
  window,
  Uri,
  commands,
  ProgressLocation,
  CancellationToken
} from "vscode";
import { Repository } from "../repository";
import { tempSvnFs } from "../temp_svn_fs";
import { ICpOptions } from "../common/types";
import SvnError from "../svnError";

export class SearchLogByText extends Command {
  constructor() {
    super("svn.searchLogByText", { repository: true });
  }

  public async execute(repository: Repository) {
    const input = await window.showInputBox({
      prompt: l10n.t("Search query")
    });
    if (!input) {
      return;
    }

    const uri = Uri.parse("tempsvnfs:/svn.log");
    tempSvnFs.writeFile(uri, Buffer.from(""), {
      create: true,
      overwrite: true
    });

    await commands.executeCommand<void>("vscode.open", uri);

    let content = "";

    const options: ICpOptions = {
      log: false,
      onStdout: (data: Buffer) => {
        content += data.toString();

        tempSvnFs.writeFile(uri, Buffer.from(content), {
          create: true,
          overwrite: true
        });
      }
    };

    try {
      await window.withProgress(
        {
          cancellable: true,
          location: ProgressLocation.Notification,
          title: l10n.t("Searching Log")
        },
        (_progress, token: CancellationToken) => {
          token.onCancellationRequested(() => options.onCancel?.());

          return repository.repository
            .exec(["log", "--search", input], options)
            .then(
              result => {
                content = result.stdout;
              },
              err => {
                // `svn log --search` exits non-zero when nothing matches,
                // which surfaces as a SvnError; keep whatever was streamed.
                if (!(err instanceof SvnError)) {
                  throw err;
                }
              }
            );
        }
      );

      tempSvnFs.writeFile(uri, Buffer.from(content), {
        create: true,
        overwrite: true
      });
    } catch (error) {
      console.error(error);
      window.showErrorMessage(l10n.t("Unable to log"));
    }
  }
}
