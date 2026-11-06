import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

import { Blame } from "./types";

/**
 * Inline and hover message formatting for the blame decorations.
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 *
 * The original uses `luxon`; this fork already ships `dayjs`, which produces
 * the same relative ("2 days ago") and absolute wording for the annotations.
 */

dayjs.extend(relativeTime);

export const truncateString = (str?: string): string => {
  if (!str) {
    return "";
  }

  const MAX_LENGTH = 20;
  const SUFFIX = "...";

  if (str.length > MAX_LENGTH) {
    const TRUNCATE_INDEX = MAX_LENGTH - SUFFIX.length;
    return `${str.substring(0, TRUNCATE_INDEX).trim()}${SUFFIX}`;
  }

  return str;
};

export const mapBlameToInlineMessage = (blame: Blame, log?: string): string => {
  const { author, date, revision } = blame;

  const timeRelative = date ? dayjs(date).fromNow() : "";
  const authorAndTime = [author, timeRelative].filter(Boolean).join(", ");
  const truncatedLog = truncateString(log);
  const prefix = `${revision}: ${authorAndTime}`;

  return [prefix, truncatedLog].filter(Boolean).join(" • ");
};

const mapAuthor = (author?: string) => (author ? `$(account) ${author}` : "");

const mapRevisionDate = (date?: string) => {
  if (!date) {
    return "";
  }

  const revisionDateRelative = dayjs(date).fromNow();
  // Matches luxon's `DateTime.DATETIME_MED`, used by SVN Blamer.
  const revisionDate = dayjs(date).format("MMM D, YYYY, h:mm A");

  return `$(history) ${revisionDateRelative} _(${revisionDate})_`;
};

const mapRevisionNumber = (revision?: string) =>
  revision ? `$(git-commit) ${revision}` : "";

export const mapBlameToHoverMessage = (blame: Blame, log?: string): string => {
  const { author, date, revision } = blame;

  const header = [
    mapAuthor(author),
    mapRevisionDate(date),
    mapRevisionNumber(revision)
  ]
    .filter(Boolean)
    .join("&nbsp;&nbsp;|&nbsp;&nbsp;");

  return [header, log].join("\n\n");
};
