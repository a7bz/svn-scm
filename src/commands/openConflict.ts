import { SourceControlResourceState, Uri, commands } from "vscode";
import { Command } from "./command";

export class OpenConflict extends Command {
  constructor() {
    super("svn.openConflict");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selection = await this.getResourceStates(resourceStates);

    if (selection.length === 0) {
      return;
    }

    this.runByRepository(selection[0].resourceUri, async (repo, result) => {
      const info = await repo.repository.getInfo(result.fsPath);

      const conflict = info.conflict;
      if (
        !conflict ||
        !conflict.curBaseFile ||
        !conflict.prevWcFile ||
        !conflict.prevBaseFile
      ) {
        return;
      }

      const base = Uri.file(conflict.prevBaseFile);
      const current = Uri.file(conflict.prevWcFile);
      const incoming = Uri.file(conflict.curBaseFile);

      const versions = Array.isArray(conflict.version)
        ? conflict.version
        : [conflict.version];
      const incomingSide = versions.find(v => v.side === "source-right");
      const incomingRevision = incomingSide ? incomingSide.revision : undefined;

      // Mirrors the built-in git extension usage of the internal
      // "_open.mergeEditor" command: input1 = Current (ours), input2 =
      // Incoming (theirs), base/output as plain Uri.
      await commands.executeCommand("_open.mergeEditor", {
        base,
        input1: {
          uri: current,
          title: "Current",
          detail: "Local working copy (.mine)"
        },
        input2: {
          uri: incoming,
          title: "Incoming",
          detail: incomingRevision
            ? `Incoming changes (r${incomingRevision})`
            : "Incoming changes"
        },
        output: result
      });
    });
  }
}
