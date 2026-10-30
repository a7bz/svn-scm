import {
  DecorationOptions,
  DecorationRangeBehavior,
  MarkdownString,
  Range,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  Uri,
  window,
  workspace
} from "vscode";

import { MAX_NUMBER } from "./const";
import {
  createChronologicalIconMapFromFactory,
  createRandomIconMapFromItems,
  createRandomIconOrderFromFactory,
  getCustomIndicatorGradient,
  getCustomIndicatorOutline,
  getIndicatorColorScheme,
  isThemeAwareIndicatorColorScheme
} from "./indicatorColors";
import {
  getBuiltInIndicatorGradient,
  getChronologicalIndicatorUri,
  getRandomIndicatorUri,
  INDICATOR_COUNT,
  LIGHT_INDICATOR_OUTLINE,
  usesLightThemeIndicatorOutline
} from "./indicatorUris";
import { mapBlameToHoverMessage, mapBlameToInlineMessage } from "./messages";
import {
  Blame,
  DecorationRecord,
  GutterIconHashMap,
  LogHashMap
} from "./types";

/**
 * Creates and applies the blame decorations (gutter indicators, the inline
 * annotation on the active line and the hover tooltips).
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 *
 * Settings live under the `svn.inlineBlame` namespace instead of `svnBlamer`
 * and are read with `workspace.getConfiguration` so folder-level overrides are
 * honoured in multi-root workspaces.
 */
export class DecorationManager {
  public usesThemeAwareIndicatorScheme(resource: Uri): boolean {
    const config = workspace.getConfiguration("svn", resource);
    return isThemeAwareIndicatorColorScheme(
      getIndicatorColorScheme(config.get("inlineBlame.indicatorColorScheme"))
    );
  }

  public createGutterDecorationType(
    gutterIconImage?: Uri
  ): TextEditorDecorationType {
    return window.createTextEditorDecorationType({
      gutterIconPath: gutterIconImage,
      gutterIconSize: "contain",
      rangeBehavior: DecorationRangeBehavior.ClosedClosed
    });
  }

  public createActiveLineDecorationType(
    blame: Blame,
    log?: string,
    gutterIconImage?: Uri
  ): TextEditorDecorationType {
    return window.createTextEditorDecorationType({
      after: {
        color: new ThemeColor("svnBlamer.blame.editorDecorationForeground"),
        contentText: mapBlameToInlineMessage(blame, log),
        margin: "0 0 0 3em",
        textDecoration: "none"
      },
      gutterIconPath: gutterIconImage,
      gutterIconSize: "contain",
      rangeBehavior: DecorationRangeBehavior.ClosedClosed
    });
  }

  /**
   * Binary search for the first index whose line number is >= `startLine`.
   * Assumes `blames` is sorted by line number.
   */
  private findFirstVisibleIndex(blames: Blame[], startLine: number): number {
    let low = 0;
    let high = blames.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midLine = Number(blames[mid].line) - 1;

      if (midLine < startLine) {
        low = mid + 1;
      } else if (midLine > startLine) {
        high = mid - 1;
      } else {
        return mid;
      }
    }

    return low;
  }

  private createDecorationOptions(
    blames: Blame[],
    logs?: LogHashMap,
    visibleRanges?: readonly Range[]
  ): DecorationOptions[] {
    if (!blames.length) {
      return [];
    }

    const options: DecorationOptions[] = [];
    let hoverMessage: MarkdownString | undefined;

    const getHoverMessage = () => {
      if (!hoverMessage) {
        const [firstBlame] = blames;
        const log = logs?.[firstBlame.revision];
        hoverMessage = new MarkdownString(
          mapBlameToHoverMessage(firstBlame, log),
          true
        );
      }
      return hoverMessage;
    };

    if (visibleRanges) {
      const firstLine = Number(blames[0].line) - 1;
      const lastLine = Number(blames[blames.length - 1].line) - 1;

      // Skip entirely when the whole revision block is outside the viewport.
      if (
        !visibleRanges.some(
          range => firstLine <= range.end.line && lastLine >= range.start.line
        )
      ) {
        return [];
      }

      const addedLines = new Set<number>();
      for (const range of visibleRanges) {
        let index = this.findFirstVisibleIndex(blames, range.start.line);
        while (index < blames.length) {
          const blame = blames[index];
          const lineNumber = Number(blame.line) - 1;

          if (lineNumber > range.end.line) {
            break;
          }

          if (!addedLines.has(lineNumber)) {
            options.push({
              hoverMessage: getHoverMessage(),
              range: new Range(lineNumber, MAX_NUMBER, lineNumber, MAX_NUMBER)
            });
            addedLines.add(lineNumber);
          }
          index++;
        }
      }
    } else {
      for (const blame of blames) {
        const lineNumber = Number(blame.line) - 1;

        options.push({
          hoverMessage: getHoverMessage(),
          range: new Range(lineNumber, MAX_NUMBER, lineNumber, MAX_NUMBER)
        });
      }
    }

    return options;
  }

  public createGutterIconHashMap(
    fileName: string,
    revisions: string[],
    resource: Uri = Uri.file(fileName)
  ): GutterIconHashMap {
    const config = workspace.getConfiguration("svn", resource);
    const enableVisualIndicators =
      config.get<boolean>("inlineBlame.enableVisualIndicators") !== false;

    if (!enableVisualIndicators) {
      return {};
    }

    const scheme = getIndicatorColorScheme(
      config.get<string>("inlineBlame.indicatorColorScheme")
    );

    if (scheme !== "random") {
      const themeKind = window.activeColorTheme.kind;
      const gradient =
        scheme === "custom"
          ? getCustomIndicatorGradient(
              config.get("inlineBlame.indicatorCustomOldestColor"),
              config.get("inlineBlame.indicatorCustomNewestColor")
            )
          : isThemeAwareIndicatorColorScheme(scheme)
          ? getBuiltInIndicatorGradient(scheme)
          : undefined;
      const outline =
        scheme === "custom"
          ? getCustomIndicatorOutline(
              config.get("inlineBlame.indicatorCustomOutlineColor")
            )
          : isThemeAwareIndicatorColorScheme(scheme) &&
            usesLightThemeIndicatorOutline(themeKind)
          ? LIGHT_INDICATOR_OUTLINE
          : undefined;

      return createChronologicalIconMapFromFactory(
        revisions,
        INDICATOR_COUNT,
        index => getChronologicalIndicatorUri(scheme, index, gradient, outline)
      );
    }

    const iconOrder = createRandomIconOrderFromFactory(
      fileName,
      INDICATOR_COUNT,
      revisions.length,
      getRandomIndicatorUri
    );

    return createRandomIconMapFromItems(revisions, iconOrder);
  }

  public async createAndSetDecorationsForBlame(
    textEditor: TextEditor,
    blames: Blame[],
    icons: GutterIconHashMap,
    logs?: LogHashMap,
    visibleRanges?: readonly Range[]
  ): Promise<
    Pick<
      DecorationRecord,
      "blamesByLine" | "blamesByRevision" | "revisionDecorations"
    >
  > {
    const blamesByLine: Record<string, Blame> = {};
    const blamesByRevision: Record<string, Blame[]> = {};

    for (const blame of blames) {
      blamesByLine[blame.line] = blame;

      if (!blamesByRevision[blame.revision]) {
        blamesByRevision[blame.revision] = [];
      }
      blamesByRevision[blame.revision].push(blame);
    }

    const revisionDecorations: Record<string, TextEditorDecorationType> = {};
    const revisionsByIcon = new Map<Uri | undefined, string[]>();

    for (const revision of Object.keys(blamesByRevision)) {
      const icon = icons[revision];
      if (!revisionsByIcon.has(icon)) {
        revisionsByIcon.set(icon, []);
      }
      revisionsByIcon.get(icon)!.push(revision);
    }

    for (const [icon, revisions] of revisionsByIcon) {
      const decoration = this.createGutterDecorationType(icon);
      const allOptions: DecorationOptions[] = [];

      for (const revision of revisions) {
        revisionDecorations[revision] = decoration;
        const revisionBlames = blamesByRevision[revision];
        const options = this.createDecorationOptions(
          revisionBlames,
          logs,
          visibleRanges
        );
        allOptions.push(...options);
      }

      textEditor.setDecorations(decoration, allOptions);
    }

    return { blamesByLine, blamesByRevision, revisionDecorations };
  }

  public reApplyDecorations(
    textEditor: TextEditor,
    record: DecorationRecord,
    visibleRanges?: readonly Range[]
  ): void {
    const decorationToRevisions = new Map<TextEditorDecorationType, string[]>();

    for (const revision in record.revisionDecorations) {
      if (
        !Object.prototype.hasOwnProperty.call(
          record.revisionDecorations,
          revision
        )
      ) {
        continue;
      }

      const decoration = record.revisionDecorations[revision];
      if (!decorationToRevisions.has(decoration)) {
        decorationToRevisions.set(decoration, []);
      }
      decorationToRevisions.get(decoration)!.push(revision);
    }

    for (const [decoration, revisions] of decorationToRevisions) {
      const allOptions: DecorationOptions[] = [];
      for (const revision of revisions) {
        const revisionBlames = record.blamesByRevision[revision] || [];
        const options = this.createDecorationOptions(
          revisionBlames,
          record.logs,
          visibleRanges
        );
        allOptions.push(...options);
      }
      textEditor.setDecorations(decoration, allOptions);
    }
  }

  public updateRevisionHoverMessages(
    textEditor: TextEditor,
    record: DecorationRecord,
    revision: string
  ): void {
    const decoration = record.revisionDecorations[revision];
    if (!decoration) {
      return;
    }

    const revisionsSharingDecoration: string[] = [];
    for (const rev in record.revisionDecorations) {
      if (
        !Object.prototype.hasOwnProperty.call(record.revisionDecorations, rev)
      ) {
        continue;
      }
      if (record.revisionDecorations[rev] === decoration) {
        revisionsSharingDecoration.push(rev);
      }
    }

    const allOptions: DecorationOptions[] = [];
    for (const rev of revisionsSharingDecoration) {
      const revisionBlames = record.blamesByRevision[rev] || [];
      const options = this.createDecorationOptions(revisionBlames, record.logs);
      allOptions.push(...options);
    }

    textEditor.setDecorations(decoration, allOptions);
  }

  public setActiveLineDecoration(
    textEditor: TextEditor,
    blame: Blame,
    log?: string,
    gutterIconImage?: Uri
  ): TextEditorDecorationType {
    const decoration = this.createActiveLineDecorationType(
      blame,
      log,
      gutterIconImage
    );
    const lineNumber = Number(blame.line) - 1;

    textEditor.setDecorations(decoration, [
      {
        range: new Range(lineNumber, MAX_NUMBER, lineNumber, MAX_NUMBER)
      }
    ]);

    return decoration;
  }
}
