import * as os from "os";
import * as path from "path";
import minimatch from "minimatch";
import { readFile, lstat, readdir } from "./fs";
import { getSvnDir } from "./util";
import { IIgnoreRule } from "./common/types";

/**
 * SVN's built-in `miscellany:global-ignores` defaults. They apply even when the
 * user's `config` file leaves the option commented out, so they must be part of
 * the expansion filter; otherwise a freshly created `*.pyc` would be listed as
 * a change while `svn status` would not report it.
 */
export const DEFAULT_GLOBAL_IGNORES = [
  "*.o",
  "*.lo",
  "*.la",
  "*.al",
  ".libs",
  "*.so",
  "*.so.[0-9]*",
  "*.a",
  "*.pyc",
  "*.pyo",
  "__pycache__",
  "*.rej",
  "*~",
  "#*#",
  ".#*",
  ".*.swp",
  ".DS_Store",
  "[Tt]humbs.db"
];

/**
 * Options for expanding an unversioned directory.
 */
export interface IExpandUnversionedOptions {
  /**
   * Maximum number of files to collect. When the directory contains more
   * entries, the expansion is abandoned and the caller keeps the directory
   * entry instead, so a huge tree (a build output folder that is not ignored
   * yet) cannot freeze the Source Control view.
   */
  limit: number;

  /**
   * Returns true when the entry must be hidden. `relativePath` is relative to
   * the working copy root and always `/` separated.
   */
  isIgnored: (relativePath: string) => boolean;
}

export interface IExpandUnversionedResult {
  /** Regular files, relative to the working copy root, `/` separated. */
  files: string[];

  /**
   * False when the walk stopped early: the file limit was reached, a nested
   * working copy was found, or a directory could not be read. The caller then
   * keeps the directory entry, because the file list would be misleading.
   */
  complete: boolean;
}

/**
 * List the files below an unversioned directory.
 *
 * `svn status` reports an unversioned directory as a single entry and never
 * descends into it (`--depth=infinity` does not change that), so the only way
 * to show the individual files - like VS Code's Git extension does for
 * untracked files - is to walk the file system here.
 *
 * The walk is breadth-first and sorted for a stable order, skips the SVN
 * metadata directory, and gives up as soon as `limit` files were found.
 */
export async function expandUnversionedDirectory(
  workingCopyRoot: string,
  relativeDirectory: string,
  options: IExpandUnversionedOptions
): Promise<IExpandUnversionedResult> {
  const files: string[] = [];
  const svnDir = getSvnDir();

  const queue: string[] = [toPosix(relativeDirectory)];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const absolute = path.join(workingCopyRoot, ...current.split("/"));

    let entries: string[];

    try {
      entries = await readdir(absolute);
    } catch {
      // A directory that vanished or cannot be read (permissions, network
      // share) makes the list unreliable.
      return { files, complete: false };
    }

    entries.sort();

    for (const name of entries) {
      if (name === svnDir || name === "_svn") {
        continue;
      }

      const relative = current === "." ? name : `${current}/${name}`;
      const entryPath = path.join(absolute, name);

      let isDirectory = false;

      try {
        const info = await lstat(entryPath);

        // Symlinks are reported as files and never followed: following them
        // could loop or leave the working copy.
        isDirectory = info.isDirectory();
      } catch {
        return { files, complete: false };
      }

      if (options.isIgnored(relative)) {
        continue;
      }

      if (isDirectory) {
        // A nested working copy is managed by its own repository (and by the
        // sub-repository discovery), so the parent directory is shown as a
        // single entry instead of being expanded.
        if (await isWorkingCopyRoot(entryPath)) {
          return { files, complete: false };
        }

        queue.push(relative);
        continue;
      }

      files.push(relative);

      if (files.length >= options.limit) {
        return { files, complete: false };
      }
    }
  }

  return { files, complete: true };
}

/**
 * Build the predicate used to hide entries SVN would ignore.
 *
 * `svn:ignore` only applies to the directory it is set on, while
 * `svn:global-ignores` applies to every descendant of that directory. Patterns
 * are matched against the entry name, which is how SVN matches them too. `dot`
 * is enabled because SVN's `*` matches leading dots (`.foo.rej` matches
 * `*.rej`).
 */
export function createIgnoreMatcher(
  rules: IIgnoreRule[]
): (relativePath: string) => boolean {
  const compiled = rules
    .filter(rule => rule.patterns.length > 0)
    .map(rule => ({
      path: normalizeRulePath(rule.path),
      recursive: rule.recursive,
      matchers: rule.patterns.map(
        pattern => new minimatch.Minimatch(pattern, { dot: true })
      )
    }));

  return (relativePath: string) => {
    const posix = toPosix(relativePath);
    const separator = posix.lastIndexOf("/");
    const directory = separator === -1 ? "." : posix.slice(0, separator);
    const name = separator === -1 ? posix : posix.slice(separator + 1);

    for (const rule of compiled) {
      if (rule.recursive) {
        // `svn:global-ignores` set on an ancestor (or on the root) applies to
        // the whole subtree.
        if (
          rule.path !== "." &&
          posix !== rule.path &&
          !posix.startsWith(rule.path + "/")
        ) {
          continue;
        }
      } else if (directory !== rule.path) {
        continue;
      }

      if (rule.matchers.some(matcher => matcher.match(name))) {
        return true;
      }
    }

    return false;
  };
}

/**
 * Read the effective `miscellany:global-ignores` patterns.
 *
 * SVN has no command that prints the merged configuration, so the user's
 * `config` file is read directly (standard locations plus `SVN_CONFIG_DIR`).
 * When the option is absent or commented out, SVN's built-in defaults apply;
 * an explicit empty value disables them, exactly like SVN does.
 */
export async function getGlobalIgnorePatterns(): Promise<string[]> {
  const patterns = await readGlobalIgnoresFromConfig();

  return patterns === undefined ? DEFAULT_GLOBAL_IGNORES : patterns;
}

/** `undefined` means "not configured", which makes SVN use its defaults. */
async function readGlobalIgnoresFromConfig(): Promise<string[] | undefined> {
  for (const configPath of getConfigPaths()) {
    try {
      const content = await readFile(configPath, "utf8");
      const value = extractGlobalIgnores(String(content));

      if (value !== undefined) {
        return value;
      }
    } catch {
      // Not readable / not present: try the next location.
    }
  }

  return undefined;
}

/**
 * Extract `global-ignores` from an SVN `config` file. The value may be
 * continued on following indented lines; commented lines start with `#` and
 * are ignored.
 */
export function extractGlobalIgnores(content: string): string[] | undefined {
  const lines = content.split(/\r?\n/);
  let inMiscellany = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (section) {
      inMiscellany = section[1].trim().toLowerCase() === "miscellany";
      continue;
    }

    if (!inMiscellany || /^\s*#/.test(line)) {
      continue;
    }

    const match = line.match(/^\s*global-ignores\s*=\s*(.*)$/);

    if (!match) {
      continue;
    }

    const parts = match[1].split(/\s+/).filter(Boolean);

    // Continuation lines are indented and are not a new `key = value` pair.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];

      if (next.trim() === "" || /^\s*[#\[]/.test(next)) {
        break;
      }

      if (/^\S/.test(next) || /^\s*[\w.-]+\s*=/.test(next)) {
        break;
      }

      parts.push(...next.split(/\s+/).filter(Boolean));
    }

    return parts;
  }

  return undefined;
}

function getConfigPaths(): string[] {
  const paths: string[] = [];

  const configDir = process.env.SVN_CONFIG_DIR || process.env.APPDATA;

  if (process.env.SVN_CONFIG_DIR) {
    paths.push(path.join(process.env.SVN_CONFIG_DIR, "config"));
  } else if (configDir) {
    // Windows: %APPDATA%\Subversion\config
    paths.push(path.join(configDir, "Subversion", "config"));
  }

  const home = os.homedir();

  if (home) {
    // Linux / macOS: ~/.subversion/config
    paths.push(path.join(home, ".subversion", "config"));
  }

  return [...new Set(paths)];
}

async function isWorkingCopyRoot(directory: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, getSvnDir()));
    return true;
  } catch {
    return false;
  }
}

function normalizeRulePath(value: string): string {
  const posix = toPosix(value).replace(/^\.\//, "");

  if (posix === "" || posix === ".") {
    return ".";
  }

  return posix.replace(/\/+$/, "");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
