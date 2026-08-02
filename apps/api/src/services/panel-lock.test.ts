import { describe, expect, it } from "vitest";
import { KeyedAsyncLock } from "./panel-lock.js";

describe("KeyedAsyncLock", () => {
  it("serializes work for the same key", async () => {
    const lock = new KeyedAsyncLock();
    const order: number[] = [];
    const a = lock.run("s1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
      return "a";
    });
    const b = lock.run("s1", async () => {
      order.push(3);
      return "b";
    });
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([1, 2, 3]);
  });
});
