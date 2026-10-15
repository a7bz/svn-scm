import { commands, l10n, window, workspace } from "vscode";
import { Repository } from "../repository";

export interface MergeBranchOptions {
  /** Use --reintegrate when merging a feature branch back into trunk */
  reintegrate?: boolean;
  /** Extra revision arguments, e.g. ["-r", "10:20"] or ["-c", "123,124"] */
  revisions?: string[];
  /** Run the merge with --dry-run and keep the working copy untouched */
  dryRun?: boolean;
}

export async function mergeBranch(
  repository: Repository,
  branchPath: string,
  options: MergeBranchOptions = {}
): Promise<string | undefined> {
  const { reintegrate = false, revisions = [], dryRun = false } = options;

  try {
    const output = await repository.merge(
      branchPath,
      reintegrate,
      "postpone",
      revisions,
      dryRun
    );
    await reportMergeResult(repository, branchPath, output, dryRun, options);
    return output;
  } catch (error) {
    const e = error as any;
    if (e != null && typeof e === "object" && "stderrFormated" in e) {
      if ((e.stderrFormated as string).includes("try updating first")) {
        const yes = l10n.t("Yes");
        const answer = await window.showErrorMessage(
          l10n.t(
            "Seems like you need to update first prior to merging. Would you like to update now and try merging again?"
          ),
          yes,
          l10n.t("No")
        );
        if (answer === yes) {
          await commands.executeCommand("svn.update");
          return mergeBranch(repository, branchPath, options);
        }
      } else {
        window.showErrorMessage(
          l10n.t("Unable to merge branch: ") + (e.stderrFormated as string)
        );
      }
    } else {
      console.log(error);
      window.showErrorMessage(l10n.t("Unable to merge branch"));
    }
    return undefined;
  }
}

export function buildRevisionArgs(revision: string): string[] {
  const value = revision.trim();
  if (value.includes(":")) {
    return ["-r", value];
  }
  return ["-c", value];
}

async function reportMergeResult(
  repository: Repository,
  branchPath: string,
  output: string,
  dryRun: boolean,
  options: MergeBranchOptions
) {
  if (!dryRun) {
    window.showInformationMessage(l10n.t("Merge completed"));
    return;
  }

  const text = output.trim();

  if (text.length === 0) {
    window.showInformationMessage(
      l10n.t("Merge preview finished: nothing to merge")
    );
    return;
  }

  const mergeNow = l10n.t("Merge now");
  const showOutput = l10n.t("Show Output");
  const answer = await window.showInformationMessage(
    l10n.t("Merge preview finished. The working copy was not modified."),
    mergeNow,
    showOutput
  );

  if (answer === mergeNow) {
    await mergeBranch(repository, branchPath, {
      ...options,
      dryRun: false
    });
  } else if (answer === showOutput) {
    await openMergeOutput(text);
  }
}

async function openMergeOutput(output: string) {
  try {
    const document = await workspace.openTextDocument({
      content: output,
      language: "plaintext"
    });
    await window.showTextDocument(document, {
      preview: true,
      preserveFocus: true
    });
  } catch (error) {
    console.error(error);
    window.showErrorMessage(output);
  }
}
