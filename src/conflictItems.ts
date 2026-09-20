/* tslint:disable:max-line-length */

import { l10n, QuickPickItem } from "vscode";
import { IConflictOption } from "./common/types";

const conflictOptions = [
  {
    label: "base",
    description: l10n.t(
      "Choose the file that was the (unmodified) BASE revision before you tried to integrate changes"
    )
  },
  {
    label: "working",
    description: l10n.t(
      "Assuming that you've manually handled the conflict resolution, choose the version of the file as it currently stands in your working copy."
    )
  },
  {
    label: "mine-full",
    description: l10n.t(
      "Preserve all local modifications and discarding all changes fetched"
    )
  },
  {
    label: "theirs-full",
    description: l10n.t(
      "Discard all local modifications and integrating all changes fetched"
    )
  },
  {
    label: "mine-conflict",
    description: l10n.t(
      "Resolve conflicted files by preferring local modifications over the changes fetched"
    )
  },
  {
    label: "theirs-conflict",
    description: l10n.t(
      "Resolve conflicted files by preferring the changes fetched from the server over local modifications"
    )
  }
];

class ConflictItem implements QuickPickItem {
  constructor(private option: IConflictOption) {}

  get label(): string {
    return this.option.label;
  }

  get description(): string {
    return this.option.description;
  }
}

export function getConflictPickOptions() {
  return conflictOptions.map(option => new ConflictItem(option));
}
