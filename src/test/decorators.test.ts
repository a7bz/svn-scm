import * as assert from "assert";
import { throttle } from "../decorators";

suite("Decorators testing", () => {
  suite("throttle", () => {
    class Throttled {
      public calls: string[] = [];

      @throttle
      public async run(value: string): Promise<string> {
        this.calls.push(value);

        if (value.startsWith("fail")) {
          throw new Error(`boom: ${value}`);
        }

        return value;
      }
    }

    test("Runs a queued call after the current call fails", async () => {
      const target = new Throttled();

      const first = target.run("fail-1");
      const queued = target.run("ok-1");

      await assert.rejects(first, /boom: fail-1/);
      assert.strictEqual(await queued, "ok-1");
      assert.deepStrictEqual(target.calls, ["fail-1", "ok-1"]);
    });

    test("Recovers after a queued call also fails", async () => {
      const target = new Throttled();

      const first = target.run("fail-1");
      const queued = target.run("fail-2");

      await assert.rejects(first, /boom: fail-1/);
      await assert.rejects(queued, /boom: fail-2/);

      assert.strictEqual(await target.run("ok-1"), "ok-1");
      assert.deepStrictEqual(target.calls, ["fail-1", "fail-2", "ok-1"]);
    });
  });
});
