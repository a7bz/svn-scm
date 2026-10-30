import { TextEditorDecorationType, Uri } from "vscode";

/**
 * Types for the inline blame rendering.
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 */

export type Blame = {
  author?: string;
  date?: string;
  /** 1-based line number, kept as a string to match the SVN Blamer model. */
  line: string;
  revision: string;
};

export type BlamesByLine = {
  [line: string]: Blame;
};

export type BlamesByRevision = {
  [revision: string]: Blame[];
};

export type GutterIconHashMap = {
  [revision: string]: Uri | undefined;
};

export type LogHashMap = {
  [revision: string]: string;
};

export type DecorationRecord = {
  icons: GutterIconHashMap;
  blamesByLine: BlamesByLine;
  blamesByRevision: BlamesByRevision;
  revisionDecorations: {
    [revision: string]: TextEditorDecorationType;
  };
  logs: LogHashMap;
  workingCopy: boolean;
  indicatorRefreshVersion?: number;
  indicatorThemeRefreshVersion?: number;
};
