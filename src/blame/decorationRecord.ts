import { DecorationRecord } from "./types";

/**
 * Merge helper for the per-file decoration records.
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 */

const defaultRecord: DecorationRecord = {
  icons: {},
  blamesByLine: {},
  blamesByRevision: {},
  revisionDecorations: {},
  logs: {},
  workingCopy: true,
  indicatorRefreshVersion: 0,
  indicatorThemeRefreshVersion: 0
};

export const mapToDecorationRecord = (
  ...records: ReadonlyArray<Partial<DecorationRecord> | undefined>
): DecorationRecord =>
  records.reduce<DecorationRecord>(
    (result, record) => ({
      ...result,
      ...record,
      icons: { ...result.icons, ...record?.icons },
      blamesByLine: { ...result.blamesByLine, ...record?.blamesByLine },
      blamesByRevision: {
        ...result.blamesByRevision,
        ...record?.blamesByRevision
      },
      revisionDecorations: {
        ...result.revisionDecorations,
        ...record?.revisionDecorations
      },
      logs: { ...result.logs, ...record?.logs }
    }),
    defaultRecord
  );
