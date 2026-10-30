import * as assert from "assert";
import { parseSvnBlame } from "../parser/blameParser";
import { parseSvnExternals, parseSvnProplist } from "../parser/propertyParser";

// `svn blame --xml` wraps everything in a `<blame>` root element, while the
// shared `xml2jsParseSettings` uses `explicitRoot: false` and therefore strips
// it. These tests pin the top-level `<target>` handling so the parsers keep
// returning data (a previous regression made inline blame always empty).
const BLAME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<blame>
<target path="a.txt">
<entry line-number="1">
<commit revision="1"><author>alice</author><date>2024-01-01T00:00:00.000000Z</date></commit>
</entry>
<entry line-number="2">
<commit revision="2"><author>bob</author><date>2024-02-02T00:00:00.000000Z</date></commit>
</entry>
</target>
</blame>`;

suite("SVN XML parsers", () => {
  suite("parseSvnBlame", () => {
    test("parses entries from the stripped <blame> root", async () => {
      const blame = await parseSvnBlame(BLAME_XML);

      assert.strictEqual(blame.length, 2);
      assert.deepStrictEqual(blame[0], {
        lineNumber: 1,
        revision: "1",
        author: "alice",
        date: "2024-01-01T00:00:00.000000Z"
      });
      assert.strictEqual(blame[1].author, "bob");
      assert.strictEqual(blame[1].revision, "2");
    });

    test("returns an empty list when there is no target", async () => {
      const blame = await parseSvnBlame(`<?xml version="1.0"?><blame></blame>`);
      assert.deepStrictEqual(blame, []);
    });
  });

  suite("parseSvnProplist", () => {
    test("parses properties from the stripped <properties> root", async () => {
      const props = await parseSvnProplist(`<?xml version="1.0"?>
<properties>
<target path="b.txt">
<property name="svn:mime-type">text/plain</property>
<property name="svn:needs-lock"></property>
</target>
</properties>`);

      assert.deepStrictEqual(props, [
        { name: "svn:mime-type", value: "text/plain" },
        { name: "svn:needs-lock", value: "" }
      ]);
    });
  });

  suite("parseSvnExternals", () => {
    test("parses externals from the stripped <properties> root", async () => {
      const externals = await parseSvnExternals(`<?xml version="1.0"?>
<properties>
<target path=".">
<property name="svn:externals">https://example.com/svn/lib@123 lib
https://example.com/svn/doc doc</property>
</target>
</properties>`);

      assert.deepStrictEqual(externals, [
        { url: "https://example.com/svn/lib", revision: "123", path: "lib" },
        { url: "https://example.com/svn/doc", revision: undefined, path: "doc" }
      ]);
    });
  });
});
