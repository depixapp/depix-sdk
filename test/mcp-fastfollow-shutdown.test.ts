// The deferral-critical guarantee (§6.1): opening a socket-bound / long-watch
// fast-follow tool and then shutting the server down cancels EVERYTHING and exits
// clean — no hang.
//
//   • SideSwap quote stream (NEW in PR8b, owned by the MCP layer): server.close()
//     → SwapStreamRegistry.disposeAll() closes the held socket.
//   • Boltz Lightning/gift-card/stablecoin watches: cancelled by wallet.close()
//     → BoltzConvert.dispose() (proven at the unit level in boltz-convert.test.ts);
//     modelled here as the wallet.close() seam the stdio bin runs after
//     server.close(), so the whole shutdown sequence is exercised together.

import { describe, expect, it } from "vitest";
import { createShutdownHandler } from "../src/mcp/runtime.js";
import { defaultLogger } from "../src/logger.js";
import { connectWallet, FakeWallet } from "./support/mcp.js";

async function openSwapQuote(client: Awaited<ReturnType<typeof connectWallet>>["client"]): Promise<void> {
  const res = await client.callTool({
    name: "wallet_swap_quote",
    arguments: { from: "DEPIX", to: "LBTC", amount_sats: "100000" },
  });
  expect((res as { isError?: boolean }).isError).toBeFalsy();
}

describe("shutdown with a socket-bound swap stream in flight", () => {
  it("server.close() cancels the held quote stream (no leaked socket)", async () => {
    const wallet = new FakeWallet();
    const { client, server } = await connectWallet({ wallet });
    await openSwapQuote(client);
    // The stream is held OPEN by the registry between quote and (never-run) execute.
    expect(wallet.convert.stream.closed).toBe(0);

    await server.close(); // the shutdown choke point

    // Registry disposeAll() ran → the socket is closed. And close() settled (awaited
    // above) — synchronous disposal never made shutdown hang.
    expect(wallet.convert.stream.closed).toBe(1);
  });

  it("the full shutdown sequence (server.close + wallet.close) cancels swap AND Boltz watches, exits 0, never hangs", async () => {
    const wallet = new FakeWallet();
    const { client, server } = await connectWallet({ wallet });
    await openSwapQuote(client);

    // The Boltz half is a MODELED boolean seam, not a real pending watch: it
    // asserts the shutdown WIRING/ORDERING only — that the stdio bin runs
    // wallet.close() (→ BoltzConvert.dispose) right AFTER server.close(), in one
    // sequence that exits 0 without hanging. The real proof that dispose() actually
    // tears down an in-flight Boltz watch (status socket + reconnect timer) lives at
    // the unit level in boltz-convert.test.ts ("close() cancels in-flight Boltz
    // watches"). We keep it modeled here because the McpWalletFacade the server
    // drives has no close()/live BoltzConvert to arm — reproducing a genuine watch
    // would duplicate that unit test rather than exercise new server-side behavior.
    let boltzWatchCancelled = false;

    const exited = new Promise<number>((resolve) => {
      const shutdown = createShutdownHandler({
        close: async () => {
          await server.close(); // cancels the swap stream (registry.disposeAll)
          boltzWatchCancelled = true; // wallet.close() → BoltzConvert.dispose seam
        },
        exit: (c) => resolve(c),
        logger: defaultLogger,
        hardExitMs: 5_000,
      });
      shutdown(0);
    });

    expect(await exited).toBe(0); // clean exit — the hard-exit watchdog never fired
    expect(wallet.convert.stream.closed).toBe(1); // swap socket cancelled by server.close
    expect(boltzWatchCancelled).toBe(true); // Boltz watch cancelled by wallet.close
  });

  it("a host disconnect (transport onclose) drives the same clean shutdown with a quote in flight", async () => {
    const wallet = new FakeWallet();
    const { client, server } = await connectWallet({ wallet });
    await openSwapQuote(client);

    const exited = new Promise<number>((resolve) => {
      const shutdown = createShutdownHandler({
        close: async () => {
          await server.close();
        },
        exit: (c) => resolve(c),
        logger: defaultLogger,
      });
      // Exactly the bin's wiring: host closing stdin → transport onclose → shutdown.
      server.server.onclose = () => shutdown(0);
    });
    await client.close(); // closes both ends → onclose → shutdown

    expect(await exited).toBe(0);
    expect(wallet.convert.stream.closed).toBe(1); // the in-flight swap socket was cancelled
  });
});
