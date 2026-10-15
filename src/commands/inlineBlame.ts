import { commands, ConfigurationTarget, l10n, window } from "vscode";
import { configuration } from "../helpers/configuration";
import { InlineBlameProvider } from "../inlineBlame";
import { Command } from "./command";

/**
 * Turn inline blame on from the editor title bar (the button is only shown
 * while `svn.inlineBlame.enabled` is `false`).
 */
export class ShowInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.showInlineBlame");
  }

  public async execute() {
    await configuration.update(
      "inlineBlame.enabled",
      true,
      ConfigurationTarget.Global
    );
    this.provider.refreshContextKey();
    window.showInformationMessage(l10n.t("Inline blame enabled"));
  }
}

/** Turn inline blame off from the editor title bar. */
export class HideInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.hideInlineBlame");
  }

  public async execute() {
    await configuration.update(
      "inlineBlame.enabled",
      false,
      ConfigurationTarget.Global
    );
    this.provider.refreshContextKey();
    window.showInformationMessage(l10n.t("Inline blame disabled"));
  }
}

/** Toggle inline blame from the command palette. */
export class ToggleInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.toggleInlineBlame");
  }

  public async execute() {
    if (this.provider.enabled) {
      await commands.executeCommand("svn.hideInlineBlame");
    } else {
      await commands.executeCommand("svn.showInlineBlame");
    }
  }
}
