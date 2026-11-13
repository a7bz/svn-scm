import * as xml2js from "xml2js";
import { xml2jsParseSettings } from "../common/constants";
import { ISvnExternal, ISvnProperty } from "../common/types";

/**
 * Parse `svn propget svn:externals --xml` output.
 *
 * ```xml
 * <properties>
 *   <target path=".">
 *     <property name="svn:externals">
 *       https://example.com/svn/lib@123 lib
 *       https://example.com/svn/doc doc
 *     </property>
 *   </target>
 * </properties>
 * ```
 *
 * Each non-empty line is one definition. `url@rev` pins the revision.
 */
export function parseSvnExternals(content: string): Promise<ISvnExternal[]> {
  return new Promise<ISvnExternal[]>(resolve => {
    xml2js.parseString(content, xml2jsParseSettings, (err, result) => {
      const targets = getPropertiesTargets(err, result);

      if (!targets) {
        resolve([]);
        return;
      }

      const externals: ISvnExternal[] = [];

      for (const target of targets) {
        const properties = asArray(target.property);

        for (const property of properties) {
          if (property.name !== "svn:externals") {
            continue;
          }

          const value = propertyValue(property);

          for (const line of value.split(/[\r\n]+/)) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            externals.push(parseExternalLine(trimmed));
          }
        }
      }

      resolve(externals);
    });
  });
}

function parseExternalLine(line: string): ISvnExternal {
  // `url@rev path` or `url path` (path may contain spaces, url may not)
  const match = line.match(/^(\S+?)(?:@(\d+))?\s+(.+)$/);

  if (!match) {
    return { url: line, path: "" };
  }

  return {
    url: match[1],
    revision: match[2],
    path: match[3].trim()
  };
}

/**
 * Parse `svn propget <name> --xml` output into the patterns set on each target.
 *
 * Used for `svn:ignore` (which applies to the directory it is set on) and for
 * `svn:global-ignores` (which applies to every descendant as well). Both are
 * whitespace separated glob lists. `inherited_property` elements are included
 * so `--show-inherited-props` output works too.
 */
export function parseIgnoreProperties(
  content: string,
  propertyName: string
): Promise<Array<{ path: string; patterns: string[] }>> {
  return new Promise(resolve => {
    xml2js.parseString(content, xml2jsParseSettings, (err, result) => {
      const targets = getPropertiesTargets(err, result);

      if (!targets) {
        resolve([]);
        return;
      }

      const rules: Array<{ path: string; patterns: string[] }> = [];

      for (const target of targets) {
        // `xml2jsParseSettings` runs `camelcase`, which only rewrites hyphens,
        // so `inherited_property` keeps its underscore.
        const properties = [
          ...asArray(target.property),
          ...asArray(target.inherited_property),
          ...asArray(target.inheritedProperty)
        ];

        const patterns: string[] = [];

        for (const property of properties) {
          if (property.name !== propertyName) {
            continue;
          }

          patterns.push(
            ...propertyValue(property).split(/\s+/).filter(Boolean)
          );
        }

        if (patterns.length > 0) {
          rules.push({ path: String(target.path ?? ""), patterns });
        }
      }

      resolve(rules);
    });
  });
}

/**
 * Parse `svn proplist --verbose --xml` output into `{ name, value }` pairs.
 */
export function parseSvnProplist(content: string): Promise<ISvnProperty[]> {
  return new Promise<ISvnProperty[]>(resolve => {
    xml2js.parseString(content, xml2jsParseSettings, (err, result) => {
      const targets = getPropertiesTargets(err, result);

      if (!targets) {
        resolve([]);
        return;
      }

      const properties: ISvnProperty[] = [];

      for (const target of targets) {
        const raw = target.property
          ? Array.isArray(target.property)
            ? target.property
            : [target.property]
          : [];

        for (const property of raw) {
          properties.push({
            name: property.name,
            value: propertyValue(property)
          });
        }
      }

      resolve(properties);
    });
  });
}

/**
 * xml2js puts text content of a tag into `_`. A property may also be
 * self-closing (no value), in which case `_` is undefined.
 */
function propertyValue(property: any): string {
  if (typeof property === "string") {
    return property;
  }
  if (property._ !== undefined) {
    return String(property._);
  }
  return "";
}

/**
 * `svn propget/proplist --xml` wraps the targets in a `<properties>` root.
 * `xml2jsParseSettings` uses `explicitRoot: false`, so that root is already
 * stripped and `target` sits at the top level. The `result.properties` lookup
 * is kept as a fallback for a non-stripped parse. Returns `undefined` when
 * there is no target (parse error or no properties).
 */
function getPropertiesTargets(err: any, result: any): any[] | undefined {
  if (err) {
    return undefined;
  }

  const target =
    (result.properties && result.properties.target) || result.target;

  if (!target) {
    return undefined;
  }

  return Array.isArray(target) ? target : [target];
}

/** xml2js returns a single element instead of an array when there is one. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
