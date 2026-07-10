// Async mutex (src/mutex.ts) — the primitive behind the guardrail choke-point
// TOCTOU fix and the fresh-address serialization. Proves mutual exclusion,
// FIFO ordering and release-on-error (a throwing holder must not wedge the
// queue — otherwise the failing path of send() would deadlock the wallet).
import { describe, expect, it } from "vitest";
import { Mutex } from "../src/mutex.js";

describe("Mutex", () => {
  it("serializes overlapping critical sections (never two at once, FIFO)", async () => {
    const m = new Mutex();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const section = (id: number): Promise<void> =>
      m.runExclusive(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        order.push(id);
        active--;
      });
    await Promise.all([section(1), section(2), section(3)]);
    expect(maxActive).toBe(1); // the sections never overlapped
    expect(order).toEqual([1, 2, 3]); // ran in submission order
  });

  it("releases the lock when a holder throws (queue is not deadlocked)", async () => {
    const m = new Mutex();
    await expect(
      m.runExclusive(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // The next op still acquires the lock — the failure did not wedge the chain.
    await expect(m.runExclusive(async () => 42)).resolves.toBe(42);
  });

  it("returns each fn's own result to its caller", async () => {
    const m = new Mutex();
    const results = await Promise.all([
      m.runExclusive(async () => "a"),
      m.runExclusive(async () => "b"),
      m.runExclusive(async () => "c")
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
