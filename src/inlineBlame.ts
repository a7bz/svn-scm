import { Disposable, window, workspace } from "vscode";

import { Blamer } from "./blame/blamer";
import { debounce } from "./blame/debounce";
import { DecorationManager } from "./blame/decorationManager";
import { clearIndicatorUriCache } from "./blame/indicatorUris";
import { Storage } from "./blame/storage";
import { DecorationRecord } from "./blame/types";
import { configuration } from "./helpers/configuration";
import { SourceControlManager } from "./source_control_manager";
import { IDisposable } from "./util";

/**
 * Facade that wires the blame engine (ported from the "SVN Blamer" extension)
 * into this extension's lifecycle.
 *
 * Matches SVN Blamer's interaction model: blame is toggled per file from the
 * editor title bar (`svn.toggleInlineBlame`), `svn.inlineBlame.autoBlame`
 * controls blaming when an editor becomes active, and the active line is
 * tracked on every selection change.
 *
 * Visual behaviour matches SVN Blamer: colour-coded gutter indicators per
 * revision, the author/relative-time annotation on the active line, and full
 * commit details (including the log message) on hover.
 */
export class InlineBlameProvider implements IDisposable {
  private disposables: Disposable[] = [];
  private blamer: Blamer;
  private storage: Storage<DecorationRecord>;

  constructor(sourceControlManager: SourceControlManager) {
    this.storage = new Storage<DecorationRecord>();
    this.blamer = new Blamer(
      sourceControlManager,
      this.storage,
      new DecorationManager()
    );

    this.disposables.push(
      window.onDidChangeActiveTextEditor(
        textEditor => void this.blamer.autoBlame(textEditor)
      ),
      window.onDidChangeTextEditorSelection(
        debounce(event => void this.blamer.trackLine(event))
      ),
      window.onDidChangeTextEditorVisibleRanges(
        debounce(event => this.blamer.handleVisibleRangesChange(event), 50)
      ),
      workspace.onDidChangeTextDocument(event =>
        this.blamer.handleDocumentChange(event)
      ),
      workspace.onDidCloseTextDocument(textDocument =>
        this.blamer.handleClosedDocument(textDocument)
      ),
      window.onDidChangeActiveColorTheme(() => {
        clearIndicatorUriCache();
        void this.blamer.refreshThemeAwareVisibleBlameIndicators();
      }),
      configuration.onDidChange(e => {
        if (
          e.affectsConfiguration("svn.inlineBlame.indicatorColorScheme") ||
          e.affectsConfiguration(
            "svn.inlineBlame.indicatorCustomOldestColor"
          ) ||
          e.affectsConfiguration(
            "svn.inlineBlame.indicatorCustomNewestColor"
          ) ||
          e.affectsConfiguration("svn.inlineBlame.indicatorCustomOutlineColor")
        ) {
          clearIndicatorUriCache();
          void this.blamer.refreshVisibleBlameIndicators();
        }
      })
    );
  }

  /** Blame the active file, replacing any existing annotations. */
  public async show(force?: boolean): Promise<void> {
    await this.blamer.showBlameForActiveTextEditor(force);
  }

  /** Remove blame from the active file. */
  public async clear(): Promise<void> {
    await this.blamer.clearBlameForActiveTextEditor();
  }

  /** Toggle blame for the active file (the editor title-bar button). */
  public async toggle(): Promise<void> {
    await this.blamer.toggleBlameForActiveTextEditor();
  }

  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.blamer.dispose();
  }
}
