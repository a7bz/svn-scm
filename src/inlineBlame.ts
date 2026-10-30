import { Disposable, window, workspace } from "vscode";

import { Blamer } from "./blame/blamer";
import { debounce } from "./blame/debounce";
import { DecorationManager } from "./blame/decorationManager";
import { clearIndicatorUriCache } from "./blame/indicatorUris";
import { Storage } from "./blame/storage";
import { DecorationRecord } from "./blame/types";
import { configuration } from "./helpers/configuration";
import { SourceControlManager } from "./source_control_manager";
import { IDisposable, setVscodeContext } from "./util";

/** Context key used to switch the editor-title toggle between its two states. */
export const INLINE_BLAME_CONTEXT = "svnInlineBlameEnabled";

/**
 * Facade that wires the blame engine (ported from the "SVN Blamer" extension)
 * into this extension's lifecycle and the `svn.inlineBlame.enabled` switch.
 *
 * Visual behaviour matches SVN Blamer: colour-coded gutter indicators per
 * revision, the author/relative-time annotation on the active line, and full
 * commit details (including the log message) on hover.
 */
export class InlineBlameProvider implements IDisposable {
  private disposables: Disposable[] = [];
  private blamer: Blamer;
  private storage: Storage<DecorationRecord>;
  private lastEnabled: boolean;

  constructor(sourceControlManager: SourceControlManager) {
    this.storage = new Storage<DecorationRecord>();
    this.blamer = new Blamer(
      sourceControlManager,
      this.storage,
      new DecorationManager()
    );
    // Assume disabled so the first `applyEnabledState` actually applies the
    // persisted setting (blaming the already-open file when it is on).
    this.lastEnabled = false;

    this.disposables.push(
      window.onDidChangeActiveTextEditor(textEditor => {
        if (!this.enabled) {
          return;
        }
        void this.blamer.autoBlame(textEditor);
      }),
      window.onDidChangeTextEditorSelection(
        debounce(event => {
          if (!this.enabled) {
            return;
          }
          void this.blamer.trackLine(event);
        })
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
        if (!e.affectsConfiguration("svn.inlineBlame")) {
          return;
        }

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

        this.refreshContextKey();
        void this.applyEnabledState();
      })
    );

    this.refreshContextKey();

    // Blame the file that is already open when the setting is persisted as on.
    void this.applyEnabledState();
  }

  /** Whether inline blame is currently enabled in the settings. */
  public get enabled(): boolean {
    return configuration.get<boolean>("inlineBlame.enabled") === true;
  }

  /** Keep the editor-title toggle in sync with the setting. */
  public refreshContextKey(): void {
    setVscodeContext(INLINE_BLAME_CONTEXT, this.enabled);
  }

  /**
   * Show blame for the active editor. Idempotent unless `force` is set, so the
   * title-bar command (which flips the setting *and* calls this) does not run
   * `svn blame` twice.
   */
  public async show(force?: boolean): Promise<void> {
    if (!force && this.lastEnabled) {
      return;
    }

    this.lastEnabled = true;
    await this.blamer.showBlameForActiveTextEditor(force);
  }

  /** Clear blame from every visible editor. Idempotent. */
  public async hide(): Promise<void> {
    if (!this.lastEnabled) {
      return;
    }

    this.lastEnabled = false;
    for (const editor of window.visibleTextEditors) {
      await this.blamer.clearBlameForFile(editor.document.fileName);
    }
  }

  /**
   * Reflect the `svn.inlineBlame.enabled` switch: when turned on, blame the
   * active file; when turned off, remove every annotation. Only reacts to an
   * actual change so unrelated settings do not trigger another `svn blame`.
   */
  private async applyEnabledState(): Promise<void> {
    if (this.enabled) {
      await this.show();
    } else {
      await this.hide();
    }
  }

  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.blamer.dispose();
    setVscodeContext(INLINE_BLAME_CONTEXT, undefined);
  }
}
