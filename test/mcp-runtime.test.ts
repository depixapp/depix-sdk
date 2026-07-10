// Runtime helpers for the stdio bin: local key-mode derivation, the wait ceiling
// override, and the idempotent shutdown that closes the wallet (cancelling Boltz
// watches, releasing the dataDir lock) with no hang and no double close.

import { describe, expect, it, vi } from "vitest";
import {
  createShutdownHandler,
  resolveKeyMode,
  resolveMaxWaitSeconds,
} from "../src/mcp/runtime.js";
import { MAX_WAIT_SECONDS_CEILING } from "../src/mcp/schemas.js";
import { defaultLogger } from "../src/logger.js";
import { connectWallet, FakeWallet } from "./support/mcp.js";

describe("resolveKeyMode (local prefix derivation, §6.2)", () => {
  it("derives live/test/unknown without any API call", () => {
    expect(resolveKeyMode("sk_live_abc")).toBe("live");
    expect(resolveKeyMode("sk_test_abc")).toBe("test");
    expect(resolveKeyMode("sk_something")).toBe("test"); // sk_ but not live → test (api-client parity)
    expect(resolveKeyMode(undefined)).toBe("unknown");
    expect(resolveKeyMode("not-a-key")).toBe("unknown");
  });
});

describe("resolveMaxWaitSeconds (wait ceiling, §6.2d)", () => {
  it("defaults to the 900s ceiling and clamps overrides", () => {
    expect(resolveMaxWaitSeconds({})).toBe(MAX_WAIT_SECONDS_CEILING);
    expect(resolveMaxWaitSeconds({ DEPIX_MCP_MAX_WAIT_SECONDS: "60" })).toBe(60);
    expect(resolveMaxWaitSeconds({ DEPIX_MCP_MAX_WAIT_SECONDS: "5000" })).toBe(MAX_WAIT_SECONDS_CEILING);
    expect(resolveMaxWaitSeconds({ DEPIX_MCP_MAX_WAIT_SECONDS: "0" })).toBe(MAX_WAIT_SECONDS_CEILING);
    expect(resolveMaxWaitSeconds({ DEPIX_MCP_MAX_WAIT_SECONDS: "abc" })).toBe(MAX_WAIT_SECONDS_CEILING);
  });
});

describe("createShutdownHandler (idempotent, no hang)", () => {
  it("closes once and exits once even if invoked repeatedly", async () => {
    let closes = 0;
    const exits: number[] = [];
    const shutdown = createShutdownHandler({
      close: async () => {
        closes++;
      },
      exit: (c) => exits.push(c),
      logger: defaultLogger,
    });
    shutdown(0);
    shutdown(0);
    shutdown(0);
    await new Promise((r) => setImmediate(r));
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("still exits when close() rejects (never hangs)", async () => {
    const errSpy = vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
    let exited: number | undefined;
    const shutdown = createShutdownHandler({
      close: async () => {
        throw new Error("close failed");
      },
      exit: (c) => {
        exited = c;
      },
      logger: defaultLogger,
    });
    shutdown(0);
    await new Promise((r) => setImmediate(r));
    expect(exited).toBe(0);
    expect(errSpy).toHaveBeenCalledWith("shutdown_close_failed", expect.anything());
    errSpy.mockRestore();
  });

  it("hard-exits via the watchdog if close() never settles (failsafe for fast-follow watches)", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
    let exited: number | undefined;
    const shutdown = createShutdownHandler({
      close: () => new Promise<void>(() => {}), // never settles (wedged watch-cancel)
      exit: (c) => {
        exited = c;
      },
      logger: defaultLogger,
      hardExitMs: 1_000,
    });
    shutdown(0);
    expect(exited).toBeUndefined(); // still waiting on close()
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exited).toBe(1); // failsafe fired a hard exit
    expect(errSpy).toHaveBeenCalledWith("shutdown_hard_exit", expect.anything());
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it("clears the watchdog once close() settles (no spurious hard exit)", async () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    const shutdown = createShutdownHandler({
      close: async () => {},
      exit: (c) => exits.push(c),
      logger: defaultLogger,
      hardExitMs: 1_000,
    });
    shutdown(0);
    await vi.advanceTimersByTimeAsync(2_000); // well past the failsafe window
    expect(exits).toEqual([0]); // exited once cleanly; watchdog never fired
    vi.useRealTimers();
  });

  it("a transport close (host disconnect) drives shutdown → wallet close, deterministically", async () => {
    const wallet = new FakeWallet();
    const { server, client } = await connectWallet({ wallet });
    let closedServer = 0;
    let exitCode: number | undefined;
    const exited = new Promise<number>((resolve) => {
      const shutdown = createShutdownHandler({
        close: async () => {
          closedServer++;
          await server.close();
        },
        exit: (c) => {
          exitCode = c;
          resolve(c);
        },
        logger: defaultLogger,
      });
      // The bin wires exactly this: host closing stdin → transport onclose → shutdown.
      server.server.onclose = () => shutdown(0);
    });
    await client.close(); // closes both ends of the in-memory pair
    expect(await exited).toBe(0);
    expect(exitCode).toBe(0);
    expect(closedServer).toBe(1); // guarded — the re-entrant onclose from server.close() is a no-op
  });
});
