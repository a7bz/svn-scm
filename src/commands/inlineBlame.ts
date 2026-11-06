import { InlineBlameProvider } from "../inlineBlame";
import { Command } from "./command";

/** Show inline blame for the active file. */
export class ShowInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.showInlineBlame");
  }

  public async execute() {
    await this.provider.show();
  }
}

/** Force-blame the active file, allowing binary files SVN would skip. */
export class ForceInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.forceInlineBlame");
  }

  public async execute() {
    await this.provider.show(true);
  }
}

/** Clear inline blame from the active file. */
export class ClearInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.clearInlineBlame");
  }

  public async execute() {
    await this.provider.clear();
  }
}

/** Toggle inline blame for the active file (editor title-bar button). */
export class ToggleInlineBlame extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.toggleInlineBlame");
  }

  public async execute() {
    await this.provider.toggle();
  }
}

/**
 * Editor-title button shown while blame is off. It still toggles (rather than
 * only showing) so that a stale on/off context key can never trap the user in
 * the enabled state.
 */
export class ToggleInlineBlameOn extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.toggleInlineBlameOn");
  }

  public async execute() {
    await this.provider.toggle();
  }
}

/**
 * Editor-title button shown while blame is on. It still toggles (rather than
 * only clearing) for the same reason as {@link ToggleInlineBlameOn}.
 */
export class ToggleInlineBlameOff extends Command {
  constructor(private provider: InlineBlameProvider) {
    super("svn.toggleInlineBlameOff");
  }

  public async execute() {
    await this.provider.toggle();
  }
}
