import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.ts";

describe("RingBuffer", () => {
  it("returns items in insertion order", () => {
    const rb = new RingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.size).toBe(3);
  });

  it("evicts the oldest item at capacity", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);

    rb.push(4);
    expect(rb.toArray()).toEqual([2, 3, 4]);

    rb.push(5);
    rb.push(6);
    expect(rb.toArray()).toEqual([4, 5, 6]);
    expect(rb.size).toBe(3);
  });

  it("returns the evicted item from push", () => {
    const rb = new RingBuffer<string>(2);
    expect(rb.push("a")).toBeUndefined();
    expect(rb.push("b")).toBeUndefined();
    expect(rb.push("c")).toBe("a");
    expect(rb.push("d")).toBe("b");
    expect(rb.toArray()).toEqual(["c", "d"]);
  });

  it("wraps around multiple capacity cycles", () => {
    const rb = new RingBuffer<string>(2);
    for (let i = 0; i < 100; i++) rb.push(`e${i}`);
    expect(rb.toArray()).toEqual(["e98", "e99"]);
    expect(rb.size).toBe(2);
  });

  it("clears all state", () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.toArray()).toEqual([]);
    rb.push(9);
    expect(rb.toArray()).toEqual([9]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(-1)).toThrow();
  });
});
