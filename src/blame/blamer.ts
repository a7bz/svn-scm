import {
  Range,
  StatusBarAlignment,
  StatusBarItem,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditor,
  TextEditorDecorationType,
  TextEditorSelectionChangeEvent,
  TextEditorVisibleRangesChangeEvent,
  window,
  workspace
} from "vscode";

import { ISvnBlameLine } from "../common/types";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { DecorationManager } from "./decorationManager";
import { mapToDecorationRecord } from "./decorationRecord";
import { Storage } from "./storage";
import { Blame, DecorationRecord } from "./types";

/**
 * The blame engine: fetches blame data, keeps a per-file decoration record and
 * applies gutter indicators, the active-line annotation and hover messages.
 *
 * Ported from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 *
 * Differences from the original: it reuses this extension's `Repository` /
 * `SourceControlManager` for authentication and process handling instead of a
 * private SVN wrapper, and uses the configured output channel.
 */

const NEWLINE_REGEX = /\n/g;

const getFileNameFromTextEditor = async (
  textEditor?: TextEditor
): Promise<string | undefined> => {
  const { fileName, isUntitled, uri } = textEditor?.document || {};

  if (!fileName || isUntitled || !uri) {
    return undefined;
  }

  try {
    await workspace.fs.stat(uri);
  } catch {
    return undefined;
  }

  return fileName;
};

const disposeDecorations = (decorations: TextEditorDecorationType[]): void => {
  decorations.forEach(decoration => decoration.dispose());
};

export class Blamer {
  private activeLine: string | undefined;
  private activeLineDecoration: TextEditorDecorationType | undefined;
  private indicatorRefreshVersion = 0;
  private indicatorThemeRefreshVersion = 0;
  private statusBarItem: StatusBarItem;

  constructor(
    private sourceControlManager: SourceControlManager,
    private storage: Storage<DecorationRecord>,
    private decorationManager: DecorationManager
  ) {
    this.statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 0);
  }

  private setStatusBarText(message: string, icon?: string) {
    this.statusBarItem.text = `${
      icon ? `$(${icon}) ` : ""
    }SVN Blamer: ${message}`;
  }

  public clearRecordForFile(fileName: string) {
    return this.storage.delete(fileName);
  }

  public clearRecordsForAllFiles() {
    this.storage.clear();
  }

  public getRecordForFile(fileName?: string) {
    if (!fileName) {
      return undefined;
    }
    return this.storage.get(fileName);
  }

  public setRecordForFile(fileName: string, record: DecorationRecord) {
    return this.storage.set(fileName, record);
  }

  public updateRecordForFile(
    fileName: string,
    update: Partial<DecorationRecord>
  ) {
    const existingRecord = this.getRecordForFile(fileName);
    return this.storage.set(
      fileName,
      mapToDecorationRecord(existingRecord, update)
    );
  }

  public async getActiveTextEditorAndFileName() {
    const textEditor = window.activeTextEditor;
    const fileName = await getFileNameFromTextEditor(textEditor);

    return { fileName, textEditor };
  }

  public handleClosedDocument(textDocument: TextDocument) {
    return this.clearBlameForFile(textDocument.fileName);
  }

  public handleDocumentChange(event: TextDocumentChangeEvent) {
    const { document, contentChanges } = event;
    const { fileName } = document;

    if (contentChanges.length === 0) {
      return;
    }

    const record = this.getRecordForFile(fileName);
    if (
      !record ||
      !record.blamesByLine ||
      !record.blamesByRevision ||
      Object.keys(record.blamesByLine).length === 0
    ) {
      return;
    }

    // Process changes bottom-to-top so the line shifts stay correct.
    const sortedChanges = [...contentChanges].sort(
      (a, b) => b.range.start.line - a.range.start.line
    );

    let updatedBlamesByLine = { ...record.blamesByLine };

    for (const change of sortedChanges) {
      const changeEndLine = change.range.end.line + 1; // 1-indexed
      const linesInserted = (change.text.match(NEWLINE_REGEX) || []).length;

      const originalLinesAffected =
        change.range.end.line - change.range.start.line;
      const lineDelta = linesInserted - originalLinesAffected;

      if (lineDelta === 0) {
        continue;
      }

      const newBlamesByLine: Record<
        string,
        (typeof record.blamesByLine)[string]
      > = {};

      for (const lineStr in updatedBlamesByLine) {
        if (
          !Object.prototype.hasOwnProperty.call(updatedBlamesByLine, lineStr)
        ) {
          continue;
        }

        const blame = updatedBlamesByLine[lineStr];
        const lineNum = Number(lineStr);

        if (lineNum <= changeEndLine) {
          newBlamesByLine[lineStr] = blame;
        } else if (lineDelta < 0 && lineNum <= changeEndLine - lineDelta) {
          continue; // line was deleted
        } else {
          const newLineNum = lineNum + lineDelta;
          newBlamesByLine[String(newLineNum)] = {
            ...blame,
            line: String(newLineNum)
          };
        }
      }

      updatedBlamesByLine = newBlamesByLine;
    }

    const updatedBlamesByRevision: Record<string, Blame[]> = {};
    for (const key in updatedBlamesByLine) {
      if (!Object.prototype.hasOwnProperty.call(updatedBlamesByLine, key)) {
        continue;
      }
      const blame = updatedBlamesByLine[key];
      if (!updatedBlamesByRevision[blame.revision]) {
        updatedBlamesByRevision[blame.revision] = [];
      }
      updatedBlamesByRevision[blame.revision].push(blame);
    }

    const existingRecord = this.getRecordForFile(fileName);
    if (existingRecord) {
      this.setRecordForFile(fileName, {
        ...existingRecord,
        blamesByLine: updatedBlamesByLine,
        blamesByRevision: updatedBlamesByRevision
      });
    }

    const textEditor = window.activeTextEditor;
    if (textEditor && textEditor.document.fileName === fileName) {
      const updatedRecord = this.getRecordForFile(fileName);
      if (updatedRecord) {
        const extendedRanges = this.getExtendedVisibleRanges(textEditor);
        this.decorationManager.reApplyDecorations(
          textEditor,
          updatedRecord,
          extendedRanges
        );
      }
    }
  }

  public handleVisibleRangesChange(event: TextEditorVisibleRangesChangeEvent) {
    const { textEditor } = event;
    const { fileName } = textEditor.document;

    const record = this.getRecordForFile(fileName);
    if (!record) {
      return;
    }

    const extendedRanges = this.getExtendedVisibleRanges(textEditor);
    this.decorationManager.reApplyDecorations(
      textEditor,
      record,
      extendedRanges
    );
  }

  /**
   * Recreates gutter decorations from cached blame data after the indicator
   * scheme changes. Does not run `svn blame` again.
   */
  public async refreshVisibleBlameIndicators() {
    const refreshVersion = ++this.indicatorRefreshVersion;
    const editorsByFileName = new Map<string, TextEditor[]>();

    for (const textEditor of window.visibleTextEditors) {
      const fileName = textEditor.document.fileName;
      const editors = editorsByFileName.get(fileName) ?? [];
      editors.push(textEditor);
      editorsByFileName.set(fileName, editors);
    }

    await Promise.all(
      [...editorsByFileName].map(([fileName, textEditors]) =>
        this.refreshVisibleBlameForFile(fileName, textEditors, refreshVersion)
      )
    );
  }

  /**
   * Recreates theme-aware gutter decorations after the active theme changes.
   * Does not run `svn blame` again.
   */
  public async refreshThemeAwareVisibleBlameIndicators() {
    const themeRefreshVersion = ++this.indicatorThemeRefreshVersion;
    const editorsByFileName = new Map<string, TextEditor[]>();

    for (const textEditor of window.visibleTextEditors) {
      if (
        !this.decorationManager.usesThemeAwareIndicatorScheme(
          textEditor.document.uri
        )
      ) {
        continue;
      }

      const fileName = textEditor.document.fileName;
      const editors = editorsByFileName.get(fileName) ?? [];
      editors.push(textEditor);
      editorsByFileName.set(fileName, editors);
    }

    await Promise.all(
      [...editorsByFileName].map(([fileName, textEditors]) =>
        this.refreshVisibleBlameForFile(
          fileName,
          textEditors,
          this.indicatorRefreshVersion,
          themeRefreshVersion
        )
      )
    );
  }

  private async refreshVisibleBlameForFile(
    fileName: string,
    textEditors: TextEditor[],
    refreshVersion: number,
    themeRefreshVersion?: number
  ) {
    const record = this.getRecordForFile(fileName);

    if (
      !record ||
      !record.workingCopy ||
      Object.keys(record.blamesByRevision).length === 0
    ) {
      return;
    }

    try {
      const [firstTextEditor, ...otherTextEditors] = textEditors;
      if (!firstTextEditor) {
        return;
      }

      const icons = this.decorationManager.createGutterIconHashMap(
        fileName,
        Object.keys(record.blamesByRevision),
        firstTextEditor.document.uri
      );

      if (
        refreshVersion !== this.indicatorRefreshVersion ||
        (themeRefreshVersion !== undefined &&
          themeRefreshVersion !== this.indicatorThemeRefreshVersion) ||
        this.getRecordForFile(fileName) !== record
      ) {
        return;
      }

      const { revisionDecorations } =
        await this.decorationManager.createAndSetDecorationsForBlame(
          firstTextEditor,
          Object.values(record.blamesByLine),
          icons,
          record.logs,
          this.getExtendedVisibleRanges(firstTextEditor)
        );

      if (
        refreshVersion !== this.indicatorRefreshVersion ||
        (themeRefreshVersion !== undefined &&
          themeRefreshVersion !== this.indicatorThemeRefreshVersion) ||
        this.getRecordForFile(fileName) !== record
      ) {
        disposeDecorations([...new Set(Object.values(revisionDecorations))]);
        return;
      }

      const refreshedRecord: DecorationRecord = {
        ...record,
        icons,
        indicatorRefreshVersion: refreshVersion,
        indicatorThemeRefreshVersion:
          themeRefreshVersion ?? record.indicatorThemeRefreshVersion,
        revisionDecorations
      };
      this.setRecordForFile(fileName, refreshedRecord);

      for (const textEditor of otherTextEditors) {
        this.decorationManager.reApplyDecorations(
          textEditor,
          refreshedRecord,
          this.getExtendedVisibleRanges(textEditor)
        );
      }

      disposeDecorations([
        ...new Set(Object.values(record.revisionDecorations))
      ]);
      this.refreshActiveLineDecoration(fileName);
    } catch (err) {
      console.error("Failed to refresh visual indicators", err);
    }
  }

  private refreshActiveLineDecoration(fileName: string) {
    const textEditor = window.activeTextEditor;

    if (
      !textEditor ||
      textEditor.document.fileName !== fileName ||
      !this.activeLine
    ) {
      return;
    }

    this.activeLineDecoration?.dispose();
    void this.setUpdatedDecoration(textEditor, fileName, this.activeLine);
  }

  private getExtendedVisibleRanges(textEditor: TextEditor): Range[] {
    const viewportBuffer =
      configuration.get<number>("inlineBlame.viewportBuffer", 200) ?? 200;

    return textEditor.visibleRanges.map(range => {
      return new Range(
        Math.max(0, range.start.line - viewportBuffer),
        0,
        Math.min(
          textEditor.document.lineCount - 1,
          range.end.line + viewportBuffer
        ),
        0
      );
    });
  }

  public async clearBlameForFile(fileName?: string) {
    if (!fileName) {
      return;
    }

    const record = this.getRecordForFile(fileName);
    this.activeLineDecoration?.dispose();

    if (!record) {
      return;
    }

    disposeDecorations([...new Set(Object.values(record.revisionDecorations))]);
    this.clearRecordForFile(fileName);
  }

  public dispose() {
    this.activeLineDecoration?.dispose();
    this.statusBarItem.dispose();
    this.clearRecordsForAllFiles();
  }

  public async clearBlameForActiveTextEditor() {
    const { fileName } = await this.getActiveTextEditorAndFileName();
    return this.clearBlameForFile(fileName);
  }

  private async getLogForRevision(
    fileName: string,
    revision: string
  ): Promise<string | undefined> {
    const enableLogs =
      configuration.get<boolean>("inlineBlame.enableLogs") !== false;

    if (!enableLogs) {
      return undefined;
    }

    const repository = this.getRepositoryForFileName(fileName);
    if (!repository) {
      return undefined;
    }

    this.setStatusBarText(
      `Fetching log for revision #${revision}`,
      "loading~spin"
    );
    this.statusBarItem.show();

    try {
      const entries = await repository.logMessage(revision, fileName);
      return entries.length ? entries[0].msg : undefined;
    } catch {
      return undefined;
    } finally {
      this.statusBarItem.hide();
    }
  }

  private getRepositoryForFileName(fileName: string): Repository | null {
    return this.sourceControlManager.getRepository(
      // `getRepository` accepts a Uri or a file path string.
      fileName
    );
  }

  public async showBlameForFile(
    textEditor?: TextEditor,
    fileName?: string,
    force?: boolean,
    notifyOnDirty = true
  ) {
    if (!textEditor || !fileName) {
      return;
    }

    if (textEditor.document.isDirty) {
      // Only warn for explicit user actions; auto-blame stays quiet.
      if (notifyOnDirty) {
        window.showWarningMessage(
          "SVN Blamer: File has unsaved changes. Please save the file to ensure accurate blame information."
        );
      }
      return;
    }

    this.statusBarItem.show();
    this.setStatusBarText("Blaming file...", "loading~spin");

    try {
      await this.clearBlameForFile(fileName);

      const repository = this.getRepositoryForFileName(fileName);
      if (!repository) {
        this.setRecordForFile(
          fileName,
          mapToDecorationRecord({ workingCopy: false })
        );
        return;
      }

      const forceBlame =
        force ??
        workspace
          .getConfiguration("svn", textEditor.document.uri)
          .get<boolean>("inlineBlame.forceBlame", false);

      const lines = await repository.blame(textEditor.document.uri.fsPath, {
        force: forceBlame,
        ignoreWhitespace: true
      });

      if (!lines?.length) {
        return;
      }

      const blame = this.toBlameModel(lines);

      const uniqueRevisions = [
        ...new Set(blame.map(({ revision }) => revision))
      ];
      const iconMapRefreshVersion = this.indicatorRefreshVersion;
      const iconMapThemeRefreshVersion = this.indicatorThemeRefreshVersion;
      const icons = this.decorationManager.createGutterIconHashMap(
        fileName,
        uniqueRevisions,
        textEditor.document.uri
      );

      const extendedRanges = this.getExtendedVisibleRanges(textEditor);

      const { blamesByLine, blamesByRevision, revisionDecorations } =
        await this.decorationManager.createAndSetDecorationsForBlame(
          textEditor,
          blame,
          icons,
          undefined,
          extendedRanges
        );

      const record = mapToDecorationRecord({
        icons,
        blamesByLine,
        blamesByRevision,
        indicatorRefreshVersion: iconMapRefreshVersion,
        indicatorThemeRefreshVersion: iconMapThemeRefreshVersion,
        revisionDecorations
      });

      this.setRecordForFile(fileName, record);

      if (
        iconMapRefreshVersion !== this.indicatorRefreshVersion ||
        (this.decorationManager.usesThemeAwareIndicatorScheme(
          textEditor.document.uri
        ) &&
          iconMapThemeRefreshVersion !== this.indicatorThemeRefreshVersion)
      ) {
        await this.refreshVisibleBlameForFile(
          fileName,
          [textEditor],
          this.indicatorRefreshVersion,
          this.indicatorThemeRefreshVersion
        );
      }
    } finally {
      this.statusBarItem.hide();
    }
  }

  public async showBlameForActiveTextEditor(force?: boolean) {
    const { fileName, textEditor } =
      await this.getActiveTextEditorAndFileName();

    try {
      return await this.showBlameForFile(textEditor, fileName, force);
    } catch (err) {
      console.error("Blame action failed", err);
      window.setStatusBarMessage(
        "$(error) SVN Blamer: Failed to blame file",
        2000
      );
    }
  }

  public async toggleBlameForFile(textEditor?: TextEditor, fileName?: string) {
    const fileData = this.getRecordForFile(fileName);

    try {
      return fileData
        ? await this.clearBlameForFile(fileName)
        : await this.showBlameForFile(textEditor, fileName);
    } catch (err) {
      console.error("Toggle blame failed", err);
      window.setStatusBarMessage(
        "$(error) SVN Blamer: Failed to blame file",
        2000
      );
    }
  }

  public async toggleBlameForActiveTextEditor() {
    const { fileName, textEditor } =
      await this.getActiveTextEditorAndFileName();
    return await this.toggleBlameForFile(textEditor, fileName);
  }

  public async autoBlame(textEditor?: TextEditor) {
    if (!textEditor) {
      return;
    }

    const fileName = await getFileNameFromTextEditor(textEditor);
    if (!fileName) {
      return;
    }

    try {
      const existingRecord = this.getRecordForFile(fileName);

      if (existingRecord?.workingCopy === false) {
        return;
      }

      if (existingRecord) {
        const refreshesForTheme =
          this.decorationManager.usesThemeAwareIndicatorScheme(
            textEditor.document.uri
          );
        if (
          existingRecord.indicatorRefreshVersion !==
            this.indicatorRefreshVersion ||
          (refreshesForTheme &&
            existingRecord.indicatorThemeRefreshVersion !==
              this.indicatorThemeRefreshVersion)
        ) {
          await this.refreshVisibleBlameForFile(
            fileName,
            [textEditor],
            this.indicatorRefreshVersion,
            refreshesForTheme ? this.indicatorThemeRefreshVersion : undefined
          );
          return;
        }

        this.decorationManager.reApplyDecorations(textEditor, existingRecord);
        return;
      }

      // Enablement (auto-blame on open) is handled by the caller.
      return await this.showBlameForFile(
        textEditor,
        fileName,
        undefined,
        false
      );
    } catch (err) {
      this.statusBarItem.hide();
      console.error("Blame attempted via auto-blame, silently failing", err);
    }
  }

  private getBlameForLine(
    record: DecorationRecord,
    line: string
  ): Blame | undefined {
    return record.blamesByLine[line];
  }

  public async trackLine(selectionChangeEvent: TextEditorSelectionChangeEvent) {
    const { textEditor } = selectionChangeEvent;
    const fileName = await getFileNameFromTextEditor(textEditor);

    try {
      if (!fileName) {
        return;
      }

      const line = (textEditor.selection.active.line + 1).toString();
      this.activeLineDecoration?.dispose();
      await this.setUpdatedDecoration(textEditor, fileName, line);
    } catch (err) {
      console.error("Failed to track line", err);
    }
  }

  private async fetchLogAndUpdateDecoration(
    textEditor: TextEditor,
    record: DecorationRecord,
    fileName: string,
    line: string
  ) {
    const blame = this.getBlameForLine(record, line);

    if (!blame) {
      return;
    }

    try {
      const log = await this.getLogForRevision(fileName, blame.revision);

      if (!log) {
        return;
      }

      this.updateRecordForFile(fileName, { logs: { [blame.revision]: log } });

      const updatedRecord = this.getRecordForFile(fileName);

      if (updatedRecord) {
        this.decorationManager.updateRevisionHoverMessages(
          textEditor,
          updatedRecord,
          blame.revision
        );
      }

      if (this.activeLine !== line) {
        return;
      }

      this.activeLineDecoration?.dispose();
      this.activeLineDecoration =
        this.decorationManager.setActiveLineDecoration(
          textEditor,
          blame,
          log,
          updatedRecord?.icons[blame.revision]
        );
    } catch (err) {
      this.statusBarItem.hide();
      console.error("Failed to get log for line", err);
    }
  }

  private async setUpdatedDecoration(
    textEditor: TextEditor,
    fileName: string,
    line: string
  ) {
    const record = this.getRecordForFile(fileName);

    if (!record) {
      return;
    }

    const blame = this.getBlameForLine(record, line);

    if (!blame) {
      return;
    }

    const log = record.logs[blame.revision];

    this.activeLineDecoration = this.decorationManager.setActiveLineDecoration(
      textEditor,
      blame,
      log,
      record.icons[blame.revision]
    );

    this.activeLine = line;

    if (!log) {
      // Don't await: we don't want the log fetch to block the annotation.
      void this.fetchLogAndUpdateDecoration(textEditor, record, fileName, line);
    } else {
      // Re-apply hover decorations to fix rendering overlap issues.
      this.decorationManager.updateRevisionHoverMessages(
        textEditor,
        record,
        blame.revision
      );
    }
  }

  /** Convert the fork's `ISvnBlameLine[]` to the SVN Blamer `Blame[]` model. */
  private toBlameModel(lines: ISvnBlameLine[]): Blame[] {
    return lines
      .filter(line => line.revision && line.revision !== "-")
      .map(line => ({
        author: line.author || undefined,
        date: line.date || undefined,
        line: String(line.lineNumber),
        revision: line.revision
      }));
  }
}
