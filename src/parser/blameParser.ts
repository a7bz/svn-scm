import * as xml2js from "xml2js";
import { xml2jsParseSettings } from "../common/constants";
import { ISvnBlameLine } from "../common/types";

interface IBlameEntry {
  lineNumber: string;
  commit?: {
    revision: string;
    author?: string;
    date?: string;
  };
}

/**
 * Parse the output of `svn blame --xml`.
 *
 * The XML looks like:
 * ```xml
 * <blame>
 *   <target path="...">
 *     <entry line-number="1">
 *       <commit revision="1" author="a7bz">
 *         <date>...</date>
 *       </commit>
 *     </entry>
 *   </target>
 * </blame>
 * ```
 * The `line-number` attribute is the 1-based line in the blamed file.
 */
export async function parseSvnBlame(content: string): Promise<ISvnBlameLine[]> {
  return new Promise<ISvnBlameLine[]>((resolve, reject) => {
    xml2js.parseString(content, xml2jsParseSettings, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      const target = result.blame && result.blame.target;
      const entry = target && target.entry;

      if (!entry) {
        resolve([]);
        return;
      }

      const entries: IBlameEntry[] = Array.isArray(entry) ? entry : [entry];

      resolve(
        entries.map(e => {
          const lineNumber = parseInt(e.lineNumber, 10);

          return {
            lineNumber,
            revision: e.commit ? e.commit.revision : "",
            author: (e.commit && e.commit.author) || "",
            date: (e.commit && e.commit.date) || ""
          };
        })
      );
    });
  });
}
