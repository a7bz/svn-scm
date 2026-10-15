import {
  DecorationOptions,
  DecorationRangeBehavior,
  Disposable,
  MarkdownString,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  window,
  workspace
} from "vscode";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { ISvnBlameLine } from "./common/types";
import { debounce } from "./decorators";
import { configuration } from "./helpers/configuration";
import { SourceControlManager } from "./source_control_manager";
import { IDisposable, setVscodeContext } from "./util";

dayjs.extend(relativeTime);

/** Context key used to switch the editor-title toggle between its two states. */
export const INLINE_BLAME_CONTEXT = "svnInlineBlameEnabled";

/**
 * Renders per-line blame information (author / date / revision) at the end of
 * each line of the active editor, similar to the "SVN Blamer" extension.
 *
 * The feature is off by default and toggled through
 * `svn.inlineBlame.enabled` (see the `svn.showInlineBlame` /
 * `svn.hideInlineBlame` commands in the editor title bar).
 */
export class InlineBlameProvider implements IDisposable {
  private disposables: Disposable[] = [];
  private decorationType: TextEditorDecorationType;

  /**
   * Blame results keyed by `uri.toString()`. Cleared whenever the working copy
   * status changes, so commits/updates are picked up.
   */
  private blameCache = new Map<string, ISvnBlameLine[]>();

  constructor(private sourceControlManager: SourceControlManager) {
    this.decorationType = window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2em",
        color: new ThemeColor("editorCodeLens.foreground")
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed
    });

    this.disposables.push(
      this.decorationType,
      window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
      workspace.onDidChangeTextDocument(e => {
        if (e.document === window.activeTextEditor?.document) {
          this.scheduleUpdate();
        }
      }),
      configuration.onDidChange(e => {
        if (e.affectsConfiguration("svn.inlineBlame")) {
          this.refreshContextKey();
          this.scheduleUpdate();
        }
      }),
      sourceControlManager.onDidChangeRepository(() => {
        this.blameCache.clear();
        this.scheduleUpdate();
      }),
      sourceControlManager.onDidChangeStatusRepository(() => {
        this.blameCache.clear();
        this.scheduleUpdate();
      })
    );

    this.refreshContextKey();
    this.scheduleUpdate();
  }

  /** Whether inline blame is currently enabled in the settings. */
  public get enabled(): boolean {
    return configuration.get<boolean>("inlineBlame.enabled") === true;
  }

  /** Keep the editor-title toggle in sync with the setting. */
  public refreshContextKey(): void {
    setVscodeContext(INLINE_BLAME_CONTEXT, this.enabled);
  }

  private async update(): Promise<void> {
    const editor = window.activeTextEditor;

    if (!editor) {
      return;
    }

    if (!this.enabled) {
      this.clearDecorations(editor);
      return;
    }

    const uri = editor.document.uri;

    if (uri.scheme !== "file") {
      this.clearDecorations(editor);
      return;
    }

    // Blame is based on committed revisions, so unsaved edits would shift the
    // line numbers and make the annotation misleading.
    if (editor.document.isDirty) {
      this.clearDecorations(editor);
      return;
    }

    const repository = this.sourceControlManager.getRepository(uri);

    if (!repository) {
      this.clearDecorations(editor);
      return;
    }

    const key = uri.toString();
    let blame = this.blameCache.get(key);

    if (!blame) {
      try {
        blame = await repository.blame(uri.fsPath);
      } catch {
        // Unversioned / not a working copy — nothing to annotate.
        this.clearDecorations(editor);
        return;
      }

      this.blameCache.set(key, blame);
    }

    // The user may have switched editors (or disabled the feature) while the
    // blame request was in flight.
    if (window.activeTextEditor !== editor || !this.enabled) {
      return;
    }

    this.setDecorations(editor, blame);
  }

  private setDecorations(editor: TextEditor, blame: ISvnBlameLine[]): void {
    if (blame.length === 0) {
      this.clearDecorations(editor);
      return;
    }

    const showAuthor =
      configuration.get<boolean>("inlineBlame.showAuthor") !== false;
    const showDate =
      configuration.get<boolean>("inlineBlame.showDate") !== false;
    const showRevision =
      configuration.get<boolean>("inlineBlame.showRevision") !== false;
    const compact = configuration.get<boolean>("inlineBlame.compact") !== false;
    const dateFormat = configuration.get<string>(
      "inlineBlame.dateFormat",
      "YYYY-MM-DD"
    );

    const lineCount = editor.document.lineCount;
    const decorations: DecorationOptions[] = [];

    let lastRevision: string | undefined;

    for (const entry of blame) {
      const lineIndex = entry.lineNumber - 1;

      if (lineIndex < 0 || lineIndex >= lineCount) {
        continue;
      }

      // With `compact` only the first line of a block of lines sharing the
      // same revision is annotated, which keeps the view readable.
      if (compact && lastRevision === entry.revision) {
        continue;
      }
      lastRevision = entry.revision;

      const parts: string[] = [];

      if (showAuthor && entry.author) {
        parts.push(entry.author);
      }
      if (showDate && entry.date) {
        parts.push(dayjs(entry.date).format(dateFormat));
      }
      if (showRevision && entry.revision) {
        parts.push(`r${entry.revision}`);
      }

      if (parts.length === 0) {
        continue;
      }

      const hover = new MarkdownString();
      hover.appendMarkdown(`**r${entry.revision}**`);
      if (entry.author) {
        hover.appendMarkdown(` · ${entry.author}`);
      }
      if (entry.date) {
        hover.appendMarkdown(` · ${dayjs(entry.date).format(dateFormat)}`);
      }

      decorations.push({
        range: editor.document.lineAt(lineIndex).range,
        renderOptions: {
          after: {
            contentText: "  " + parts.join(", ")
          }
        },
        hoverMessage: hover
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  private clearDecorations(editor: TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }

  @debounce(250)
  private scheduleUpdate(): void {
    void this.update();
  }

  public dispose(): void {
    for (const editor of window.visibleTextEditors) {
      this.clearDecorations(editor);
    }
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.blameCache.clear();
    setVscodeContext(INLINE_BLAME_CONTEXT, undefined);
  }
}
