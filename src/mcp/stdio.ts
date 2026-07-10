#!/usr/bin/env node
// `depix-wallet-mcp` — the local stdio entry (spec §6.1). Runs the wallet MCP
// facade over a stdio transport IN THE AGENT'S ENVIRONMENT, so the seed never
// leaves the machine. `npx -p @depixapp/sdk depix-wallet-mcp` runs this.
//
// Config is 100% environment (§6.1): DEPIX_API_KEY (sk_), DEPIX_WALLET_PASSPHRASE,
// DEPIX_WALLET_DIR, DEPIX_GUARDRAIL_*, SIDESHIFT_AFFILIATE_ID?. No CLI flags for
// secrets. STDOUT is the JSON-RPC channel — everything human goes to STDERR
// through the redacting logger.
//
// Boot opens the wallet (WALLET_NOT_FOUND with an actionable message if the
// dataDir is empty — NEVER auto-creates a seed), runs crash-resume once for
// BOTH withdrawals (§3.2.9) and conversions (§5) to feed wallet_status, then
// serves. Shutdown closes the wallet, which cancels in-flight Boltz watches and
// releases the dataDir lock (§2.4/§5.3) — no hang.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DepixWallet, type ConversionResumeSummary, type ResumeSummary } from "../wallet.js";
import { defaultLogger, redactSecrets } from "../logger.js";
import { createWalletMcpServer } from "./server.js";
import { createShutdownHandler, resolveKeyMode, resolveMaxWaitSeconds } from "./runtime.js";

async function main(): Promise<void> {
  const apiKey = process.env.DEPIX_API_KEY;

  // Open the existing wallet. Passphrase / dataDir / apiKey / guardrails all come
  // from env inside open() (§2.3/§6.1). Disable BOTH auto-resumes so we can run
  // them explicitly and surface their summaries via wallet_status.
  const wallet = await DepixWallet.open({
    resumePendingWithdrawalsOnOpen: false,
    resumePendingConversionsOnOpen: false,
  });

  let bootResume: ResumeSummary;
  try {
    bootResume = await wallet.resumePendingWithdrawals();
  } catch (err) {
    defaultLogger.error("boot_resume_failed", { name: err instanceof Error ? err.name : "unknown" });
    bootResume = { resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 0 };
  }

  // Conversion recovery (§5 fund-safety wiring): reconcile in-flight Boltz
  // swaps (re-attach watch / claim / refund), the tracked SideSwap peg-in and
  // non-terminal SideShift shifts — same boot slot as the withdrawals resume.
  let bootConversions: ConversionResumeSummary;
  try {
    bootConversions = await wallet.resumePendingConversions();
  } catch (err) {
    defaultLogger.error("boot_conversion_resume_failed", { name: err instanceof Error ? err.name : "unknown" });
    bootConversions = {
      boltz: null,
      pegin: { pending: 0, cleared: 0, failed: 0 },
      sideshift: { checked: 0, refreshed: 0, failed: 0 },
    };
  }

  const server = createWalletMcpServer({
    wallet,
    keyMode: resolveKeyMode(apiKey),
    apiKeyConfigured: Boolean(apiKey && apiKey.startsWith("sk_")),
    bootResume,
    bootConversions,
    maxWaitSeconds: resolveMaxWaitSeconds(),
  });

  const shutdown = createShutdownHandler({
    close: async () => {
      await server.close();
      await wallet.close();
    },
    exit: (code) => process.exit(code),
    logger: defaultLogger,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The host closing our stdin closes the transport → onclose → clean shutdown.
  server.server.onclose = () => shutdown(0);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  defaultLogger.info("depix-wallet-mcp stdio started", { keyMode: resolveKeyMode(apiKey) });
}

main().catch((err: unknown) => {
  // Redact defensively — a fatal error must never carry a secret. WALLET_NOT_FOUND
  // gets an actionable hint; the SDK never auto-creates a seed (§2.4).
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  process.stderr.write(redactSecrets(`depix-wallet-mcp: fatal: ${message}`) + "\n");
  if (code === "WALLET_NOT_FOUND") {
    process.stderr.write(
      "depix-wallet-mcp: no wallet in the dataDir. Create one first with DepixWallet.create() " +
        "(see the quickstart) — the MCP never creates a seed automatically.\n",
    );
  }
  process.exit(1);
});
