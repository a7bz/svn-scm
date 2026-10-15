import * as assert from "assert";
import { splitInChunks, MAX_CLI_LENGTH } from "../util";

suite("Util testing", () => {
  suite("splitInChunks", () => {
    test("Returns no chunks for an empty list", () => {
      const chunks = splitInChunks<string>([], 10, item => item.length);
      assert.deepStrictEqual(chunks, []);
    });

    test("Keeps a single short item in one chunk", () => {
      const chunks = splitInChunks(["abc"], 10, item => item.length);
      assert.deepStrictEqual(chunks, [["abc"]]);
    });

    test("Preserves the order of the items", () => {
      const items = ["a", "b", "c", "d", "e"];
      const chunks = splitInChunks(items, 2, item => item.length);
      assert.deepStrictEqual(chunks, [["a", "b"], ["c", "d"], ["e"]]);
    });

    test("Splits items that exceed the limit", () => {
      const items = ["aa", "bb", "cc"];
      const chunks = splitInChunks(items, 4, item => item.length);
      assert.deepStrictEqual(chunks, [
        ["aa", "bb"],
        ["cc"]
      ]);
    });

    test("Places an oversized item in its own chunk", () => {
      const items = ["a", "this-item-is-way-too-long", "b"];
      const chunks = splitInChunks(items, 5, item => item.length);
      assert.deepStrictEqual(chunks, [
        ["a"],
        ["this-item-is-way-too-long"],
        ["b"]
      ]);
    });

    test("Every chunk stays within the limit (except single oversized items)", () => {
      const items = Array.from({ length: 3000 }, (_, i) =>
        `path/to/file_${i}.txt`
      );
      const getLength = (item: string) => item.length + 1;
      const chunks = splitInChunks(items, MAX_CLI_LENGTH, getLength);

      const totalLength = items.reduce((sum, item) => sum + getLength(item), 0);
      assert.ok(totalLength > MAX_CLI_LENGTH);
      assert.ok(chunks.length > 1);
      for (const chunk of chunks) {
        const length = chunk.reduce((sum, item) => sum + getLength(item), 0);
        if (chunk.length > 1) {
          assert.ok(length <= MAX_CLI_LENGTH);
        }
      }

      // No item is lost or duplicated.
      assert.deepStrictEqual(chunks.flat(), items);
    });
  });
});
