import * as assert from "assert";
import * as fs from "original-fs";
import * as path from "path";
import {
  createIgnoreMatcher,
  expandUnversionedDirectory,
  extractGlobalIgnores
} from "../unversioned";
import * as testUtil from "./testUtil";

suite("Unversioned directory expansion", () => {
  let root: string;

  setup(() => {
    root = testUtil.newTempDir("svn_unversioned_");
  });

  function write(relativePath: string, content = "x") {
    const absolute = path.join(root, ...relativePath.split("/"));

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  test("lists nested files with posix paths", async () => {
    write("dir/a.txt");
    write("dir/sub/b.txt");

    const result = await expandUnversionedDirectory(root, "dir", {
      limit: 100,
      isIgnored: () => false
    });

    assert.deepStrictEqual(result.files, ["dir/a.txt", "dir/sub/b.txt"]);
    assert.strictEqual(result.complete, true);
  });

  test("skips the metadata directory", async () => {
    write("dir/a.txt");
    write("dir/.svn/entries");

    const result = await expandUnversionedDirectory(root, "dir", {
      limit: 100,
      isIgnored: () => false
    });

    assert.deepStrictEqual(result.files, ["dir/a.txt"]);
  });

  test("stops when the file limit is reached", async () => {
    write("dir/a.txt");
    write("dir/b.txt");
    write("dir/c.txt");

    const result = await expandUnversionedDirectory(root, "dir", {
      limit: 2,
      isIgnored: () => false
    });

    assert.strictEqual(result.files.length, 2);
    assert.strictEqual(result.complete, false);
  });

  test("stops at a nested working copy", async () => {
    write("dir/a.txt");
    write("dir/nested/b.txt");
    write("dir/nested/.svn/entries");

    const result = await expandUnversionedDirectory(root, "dir", {
      limit: 100,
      isIgnored: () => false
    });

    assert.strictEqual(result.complete, false);
  });

  test("applies the ignore predicate", async () => {
    write("dir/a.txt");
    write("dir/a.log");

    const result = await expandUnversionedDirectory(root, "dir", {
      limit: 100,
      isIgnored: relative => relative.endsWith(".log")
    });

    assert.deepStrictEqual(result.files, ["dir/a.txt"]);
  });
});

suite("Ignore matcher", () => {
  test("svn:ignore only applies to its own directory", () => {
    const isIgnored = createIgnoreMatcher([
      { path: "dir", patterns: ["*.log"], recursive: false }
    ]);

    assert.strictEqual(isIgnored("dir/a.log"), true);
    assert.strictEqual(isIgnored("dir/sub/a.log"), false);
    assert.strictEqual(isIgnored("other/a.log"), false);
  });

  test("svn:global-ignores applies to descendants", () => {
    const isIgnored = createIgnoreMatcher([
      { path: ".", patterns: ["*.tmp"], recursive: true }
    ]);

    assert.strictEqual(isIgnored("a.tmp"), true);
    assert.strictEqual(isIgnored("dir/a.tmp"), true);
    assert.strictEqual(isIgnored("dir/sub/a.tmp"), true);
    assert.strictEqual(isIgnored("dir/a.txt"), false);
  });

  test("a nested global rule is limited to its subtree", () => {
    const isIgnored = createIgnoreMatcher([
      { path: "dir", patterns: ["*.tmp"], recursive: true }
    ]);

    assert.strictEqual(isIgnored("dir/a.tmp"), true);
    assert.strictEqual(isIgnored("dir/sub/a.tmp"), true);
    assert.strictEqual(isIgnored("other/a.tmp"), false);
  });

  test("patterns match a leading dot like SVN does", () => {
    const isIgnored = createIgnoreMatcher([
      { path: ".", patterns: ["*.rej"], recursive: true }
    ]);

    assert.strictEqual(isIgnored(".foo.rej"), true);
  });

  test("matches the entry name, not the whole path", () => {
    const isIgnored = createIgnoreMatcher([
      { path: "dir", patterns: ["build"], recursive: false }
    ]);

    assert.strictEqual(isIgnored("dir/build"), true);
    assert.strictEqual(isIgnored("dir/build2"), false);
  });
});

suite("SVN config global-ignores", () => {
  test("reads a plain value", () => {
    const patterns = extractGlobalIgnores(
      ["[miscellany]", "global-ignores = *.o *.pyc", "[auth]", "x = y"].join(
        "\n"
      )
    );

    assert.deepStrictEqual(patterns, ["*.o", "*.pyc"]);
  });

  test("ignores a commented default", () => {
    const patterns = extractGlobalIgnores(
      ["[miscellany]", "# global-ignores = *.o *.pyc"].join("\n")
    );

    assert.strictEqual(patterns, undefined);
  });

  test("an empty value disables the built-in defaults", () => {
    // SVN treats an explicit empty value as "ignore nothing"; the caller must
    // not fall back to the default list in that case.
    const patterns = extractGlobalIgnores(
      ["[miscellany]", "global-ignores =", "[auth]", "x = y"].join("\n")
    );

    assert.deepStrictEqual(patterns, []);
  });

  test("reads continuation lines", () => {
    const patterns = extractGlobalIgnores(
      ["[miscellany]", "global-ignores = *.o", "  *.pyc", "  *.tmp"].join("\n")
    );

    assert.deepStrictEqual(patterns, ["*.o", "*.pyc", "*.tmp"]);
  });

  test("ignores the property outside the miscellany section", () => {
    const patterns = extractGlobalIgnores(
      ["[auth]", "global-ignores = *.o"].join("\n")
    );

    assert.strictEqual(patterns, undefined);
  });
});
