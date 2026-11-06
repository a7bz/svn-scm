import * as assert from "assert";
import dayjs from "dayjs";
import {
  createChronologicalIconMapFromFactory,
  createRandomIconMapFromItems,
  createRandomIconOrderFromFactory,
  getCustomIndicatorGradient,
  getCustomIndicatorOutline,
  getIndicatorColorScheme,
  isThemeAwareIndicatorColorScheme,
  sortRevisions
} from "../blame/indicatorColors";
import {
  mapBlameToHoverMessage,
  mapBlameToInlineMessage,
  truncateString
} from "../blame/messages";
import { Blame } from "../blame/types";

const blame = (overrides: Partial<Blame> = {}): Blame => ({
  author: "alice",
  date: "2020-01-01T00:00:00.000000Z",
  line: "1",
  revision: "42",
  ...overrides
});

suite("Blame formatting", () => {
  suite("truncateString", () => {
    test("leaves short strings untouched", () => {
      assert.strictEqual(truncateString("short"), "short");
    });

    test("truncates long strings to 20 characters with an ellipsis", () => {
      const result = truncateString("0123456789012345678901234567890");
      assert.strictEqual(result.length, 20);
      assert.ok(result.endsWith("..."));
      assert.strictEqual(result, "01234567890123456...");
    });

    test("handles empty and undefined input", () => {
      assert.strictEqual(truncateString(""), "");
      assert.strictEqual(truncateString(undefined), "");
    });
  });

  suite("mapBlameToInlineMessage", () => {
    test("prefixes the revision and joins the author and relative time", () => {
      const message = mapBlameToInlineMessage(blame());

      assert.ok(message.startsWith("42: alice, "));
    });

    test("appends the truncated log after a bullet", () => {
      const message = mapBlameToInlineMessage(blame(), "a very long commit message");

      assert.ok(message.includes(" • "));
      assert.ok(message.endsWith("a very long commi..."));
    });

    test("omits the bullet when there is no log", () => {
      assert.ok(!mapBlameToInlineMessage(blame()).includes(" • "));
    });
  });

  suite("mapBlameToHoverMessage", () => {
    test("renders the themed author, date and revision header", () => {
      const message = mapBlameToHoverMessage(blame(), "did something");

      assert.ok(message.startsWith("$(account) alice"));
      assert.ok(message.includes("$(history) "));
      assert.ok(message.includes("$(git-commit) 42"));
      assert.ok(message.endsWith("did something"));
    });

    test("uses the DATETIME_MED style absolute date", () => {
      const message = mapBlameToHoverMessage(blame());
      const absolute = dayjs(blame().date).format("MMM D, YYYY, h:mm A");

      assert.ok(message.includes(`_(${absolute})_`));
    });

    test("omits missing fields", () => {
      const message = mapBlameToHoverMessage(blame({ author: undefined, date: undefined }));

      assert.ok(!message.includes("$(account)"));
      assert.ok(message.includes("$(git-commit) 42"));
    });
  });
});

suite("Indicator colours", () => {
  suite("getIndicatorColorScheme", () => {
    test("accepts known schemes", () => {
      assert.strictEqual(getIndicatorColorScheme("redToGreen"), "redToGreen");
    });

    test("falls back to random for unknown values", () => {
      assert.strictEqual(getIndicatorColorScheme("nope"), "random");
      assert.strictEqual(getIndicatorColorScheme(undefined), "random");
    });
  });

  suite("isThemeAwareIndicatorColorScheme", () => {
    test("only the built-in palettes are theme aware", () => {
      assert.ok(isThemeAwareIndicatorColorScheme("blue"));
      assert.ok(isThemeAwareIndicatorColorScheme("vermilion"));
      assert.ok(!isThemeAwareIndicatorColorScheme("redToGreen"));
      assert.ok(!isThemeAwareIndicatorColorScheme("custom"));
      assert.ok(!isThemeAwareIndicatorColorScheme("random"));
    });
  });

  suite("custom gradient helpers", () => {
    test("normalises valid hex colours to lowercase", () => {
      assert.deepStrictEqual(getCustomIndicatorGradient("#ABCDEF", "#123456"), {
        oldest: "#abcdef",
        newest: "#123456"
      });
    });

    test("falls back to defaults for invalid values", () => {
      const gradient = getCustomIndicatorGradient("red", null);

      assert.strictEqual(gradient.oldest, "#6b7280");
      assert.strictEqual(gradient.newest, "#1f5f9f");
    });

    test("outline is undefined unless a valid hex is given", () => {
      assert.strictEqual(getCustomIndicatorOutline("#ABCDEF"), "#abcdef");
      assert.strictEqual(getCustomIndicatorOutline(""), undefined);
      assert.strictEqual(getCustomIndicatorOutline("#fff"), undefined);
    });
  });

  suite("sortRevisions", () => {
    test("sorts numerically and de-duplicates", () => {
      assert.deepStrictEqual(sortRevisions(["10", "2", "2", "1"]), [
        "1",
        "2",
        "10"
      ]);
    });
  });

  suite("createChronologicalIconMapFromFactory", () => {
    test("maps oldest to index 0 and newest to the last index", () => {
      const icons = createChronologicalIconMapFromFactory(
        ["30", "10", "20"],
        5,
        index => index
      );

      assert.deepStrictEqual(icons, { "10": 0, "20": 2, "30": 4 });
    });

    test("uses the newest colour for a single revision", () => {
      const icons = createChronologicalIconMapFromFactory(["7"], 5, i => i);
      assert.deepStrictEqual(icons, { "7": 4 });
    });

    test("returns nothing when there are no revisions", () => {
      assert.deepStrictEqual(
        createChronologicalIconMapFromFactory([], 5, i => i),
        {}
      );
    });
  });

  suite("random icon mapping", () => {
    test("is stable for the same file name", () => {
      const first = createRandomIconOrderFromFactory(
        "a.txt",
        10,
        4,
        (palette, index) => `${palette}:${index}`
      );
      const second = createRandomIconOrderFromFactory(
        "a.txt",
        10,
        4,
        (palette, index) => `${palette}:${index}`
      );

      assert.deepStrictEqual(first, second);
      assert.strictEqual(first.length, 4);
    });

    test("assigns an icon to every revision and wraps around", () => {
      const icons = createRandomIconMapFromItems(["1", "2", "3"], ["a", "b"]);

      assert.deepStrictEqual(icons, { "1": "a", "2": "b", "3": "a" });
    });
  });
});
