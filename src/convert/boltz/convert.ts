// wallet.convert.boltz — the Boltz Lightning namespace (spec §5.3 / §2.3).
//
// Ties the pure modules to the wallet: LN SEND (payLightningInvoice) runs the
// submarine guard cadence, then the guardrail choke point + L-BTC lockup signing
// via the injected ctx.lockupLbtc; LN RECEIVE (receiveLightning) drives a reverse
// swap and claims the L-BTC into the wallet (an INFLOW — no guardrail). resume()
// recovers claim/refund of in-flight swaps from boltz-swaps.json after a crash.
//
// The wallet supplies only a MINIMAL context (guardrail-wrapped L-BTC lockup, a
// backup-gated receive address, the durable store, a logger) so the money-signing
// path stays in wallet.ts (reusing send()'s proven per-op-auth + opMutex +
// record-before-broadcast). Heavy crypto/network is injectable (deps) so tests
// never touch real Boltz or WASM.

import type { GuardrailDestination } from "../../guardrails/allowlist.js";
import type { Logger } from "../../logger.js";
import { hex } from "@scure/base";
import { BoltzClient } from "./client.js";
import { deriveReverseSecrets } from "./keys.js";
import { mapSubmarineStatus } from "./lightning.js";
import {
  refundChainSwap,
  refundSubmarineSwap,
  type ChainRefundDeps,
  type ChainRefundRecord,
  type RefundDeps,
  type RefundResult,
  type SubmarineRefundRecord
} from "./refund.js";
import {
  receiveViaLightning,
  resumeReverseSwap,
  getReverseLimits,
  type ReverseDeps,
  type ReverseOutcome,
  type ReverseSwapRecord
} from "./reverse.js";
import {
  CHAIN_SWAP_FAILURE_STATUSES,
  executeStablecoinRoute,
  getStablecoinNetwork,
  mapChainSwapStatus,
  prepareStablecoinRoute,
  type ExecuteStablecoinDeps,
  type PrepareStablecoinDeps,
  type StablecoinAsset,
  type StablecoinParams
} from "./stablecoin.js";
import { prepareSubmarineSwap } from "./submarine.js";
import type { assertLockupAddressBindsToUser } from "./verify-lockup.js";
import {
  BoltzSwapStore,
  type StoredReverseSwap,
  type StoredStablecoinSwap,
  type StoredSubmarineSwap
} from "./store.js";

/** Minimal wallet seam the Boltz namespace needs (kept small — §2.3 surgical wiring). */
export interface BoltzWalletContext {
  store: BoltzSwapStore;
  logger: Logger;
  /**
   * Guardrail choke point + L-BTC lockup signing (§4.3): values `amountSats`
   * L-BTC in BRL, enforces the caps with the given FINAL destinations, signs the
   * lockup with an ephemeral signer, records the spend and broadcasts — all under
   * the wallet's opMutex. Returns the broadcast txid.
   *
   * `feeSplit` (gift cards, §5.5): an OPTIONAL second L-BTC output in the SAME
   * transaction paying the DePix service fee to the config `splitAddress`. It is
   * NOT counted by the guardrail (the value counted is `amountSats` — the lockup
   * — per §4.3 "idem") and NOT an allowlist destination (it pays DePix's own
   * address from the authenticated config). `kind` labels the spend for the
   * rolling-24h accountant / telemetry (default "boltz-submarine").
   */
  lockupLbtc: (params: {
    address: string;
    amountSats: bigint;
    destinations: readonly GuardrailDestination[];
    feeSplit?: { address: string; amountSats: bigint };
    kind?: string;
  }) => Promise<{ txid: string }>;
  /** Backup-gated receive address (refund on send / claim on receive). */
  getReceiveAddress: () => Promise<string>;
}

/** Test/advanced overrides so the flows never touch real Boltz crypto/network. */
export interface BoltzConvertDeps {
  client?: BoltzClient;
  verifyLockup?: typeof assertLockupAddressBindsToUser;
  genRefundKeypair?: () => { privHex: string; pubHex: string };
  deriveSecrets?: () => {
    preimage: Uint8Array;
    preimageHash: Uint8Array;
    claimKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  };
  /** Injected refund driver (default refundSubmarineSwap). */
  refundSubmarine?: (record: SubmarineRefundRecord, deps: RefundDeps) => Promise<RefundResult>;
  /** Passed to the reverse flow as its claim/broadcast/lockup overrides (tests). */
  reverseClaim?: ReverseDeps["claim"];
  reverseBroadcast?: ReverseDeps["broadcast"];
  reverseGetLockupTx?: ReverseDeps["getLockupTx"];
  reverseCreate?: ReverseDeps["createReverseSwap"];
  getReversePairHash?: () => Promise<string>;
  maxTimeoutBlocks?: number;
  /**
   * Stablecoin (L-BTC → USDC/USDT EVM) overrides (§5.3, PR5b) so the flow never
   * touches real viem/Boltz route execution in tests.
   */
  stablecoin?: {
    /** createRoute / verifyLockup / deriveKeys / isKnownTokenAddress / viemImporter / getChainHeight / buildSigner overrides. */
    prepare?: PrepareStablecoinDeps;
    /** executeRoute / buildSigner / viemImporter / ensureConfig overrides. */
    execute?: Omit<ExecuteStablecoinDeps, "waitForServerLockup">;
    /** Injected chain refund driver (default refundChainSwap). */
    refundChain?: (record: ChainRefundRecord, deps: ChainRefundDeps) => Promise<RefundResult>;
    /** How long to wait for Boltz's destination lockup before giving up (ms). */
    serverLockupTimeoutMs?: number;
  };
}

export interface SubmarineOutcome {
  swapId: string;
  status: "paid" | "refunded" | "refund_pending" | "failed";
  refundTxId?: string | null;
}

export interface PayLightningResult {
  swapId: string;
  lockupTxid: string;
  expectedAmountSats: number;
  invoiceSats: number;
  invoice: string;
  /** Resolves when Boltz pays (paid) or the lockup is refunded/failed. */
  completion: Promise<SubmarineOutcome>;
}

export interface ReceiveLightningResult {
  swapId: string;
  invoice: string;
  lockupAddress: string;
  amountSats: number;
  /** Resolves when the swap settles (claimed into the wallet) or fails. */
  completion: Promise<ReverseOutcome>;
}

export interface StablecoinOutcome {
  swapId: string;
  /** settled = delivered; pending = post-lockup failure left for resume/refund. */
  status: "settled" | "refunded" | "refund_pending" | "pending" | "failed";
  claimTransactionId?: string;
  refundTxId?: string | null;
}

export interface ToStablecoinResult {
  swapId: string;
  lockupTxid: string;
  lockAmountSats: number;
  asset: StablecoinAsset;
  networkId: string;
  claimAddress: string;
  /** Resolves when the swap settles (delivered) or is left pending for recovery. */
  completion: Promise<StablecoinOutcome>;
}

export interface BoltzResumeSummary {
  submarineResumed: number;
  submarineRefunded: number;
  reverseResumed: number;
  stablecoinResumed: number;
  stablecoinRefunded: number;
  discarded: number;
  removed: number;
  failed: number;
}

export class BoltzConvert {
  private readonly ctx: BoltzWalletContext;
  private readonly client: BoltzClient;
  private readonly deps: BoltzConvertDeps;
  private readonly logger: Logger;
  /** Teardown handles for every in-flight watch (status socket + reconnect timer). */
  private readonly activeUnsubs = new Set<() => void>();
  private disposed = false;

  constructor(ctx: BoltzWalletContext, deps: BoltzConvertDeps = {}) {
    this.ctx = ctx;
    this.deps = deps;
    this.client = deps.client ?? new BoltzClient();
    this.logger = ctx.logger;
  }

  /**
   * Subscribe to a swap's status through a tracked handle so every in-flight
   * watch can be torn down on dispose(). Without this a reverse/submarine watch
   * keeps its WebSocket + reconnect backoff timer alive after wallet.close()
   * (§5.3 resource hygiene). Deregisters itself when the watch unsubscribes.
   */
  private trackedSubscribe(swapId: string, onRaw: (raw: string) => void): () => void {
    if (this.disposed) return () => {};
    const raw = this.client.subscribeSwap(swapId, onRaw);
    let cleared = false;
    const wrapped = (): void => {
      if (cleared) return;
      cleared = true;
      this.activeUnsubs.delete(wrapped);
      try {
        raw();
      } catch {
        // noop
      }
    };
    this.activeUnsubs.add(wrapped);
    return wrapped;
  }

  /**
   * Cancel every in-flight watch — closes each status WebSocket and clears its
   * reconnect timer. Called by wallet.close() so a closed wallet leaves no live
   * socket/timer behind (an agent that opens a receive then closes must not keep
   * reconnecting to Boltz forever). Idempotent; blocks new watches afterward.
   */
  dispose(): void {
    this.disposed = true;
    for (const unsub of [...this.activeUnsubs]) {
      try {
        unsub();
      } catch {
        // noop
      }
    }
    this.activeUnsubs.clear();
  }

  // ─── LN SEND (submarine) ─────────────────────────────────────────────────

  /**
   * Pay a BOLT11 invoice by locking L-BTC (§5.3). Runs the full fail-closed guard
   * cadence + verify-lockup, persists the refund material BEFORE funding, then
   * signs the L-BTC lockup through the guardrail choke point (the expectedAmount
   * is valued in BRL; the FINAL Lightning payee is checked against the allowlist
   * `allowLightning` class — verify-lockup binding does NOT exempt it, §4.3).
   *
   * REUSED by the gift-card flow (§5.5): `extraDestinations` adds the
   * `giftcardBeneficiary` class so the allowlist gates BOTH the Lightning payee
   * AND the CryptoRefills beneficiary (§4.3 requires both for a gift card);
   * `feeSplit` adds the 1% DePix service-fee output to the same lockup tx;
   * `spendKind` labels the spend. All optional — a plain LN send passes none.
   */
  async payLightningInvoice(params: {
    invoice: string;
    /** Extra FINAL destination classes to enforce (gift-card beneficiary, §5.5). */
    extraDestinations?: readonly GuardrailDestination[];
    /** Optional service-fee output paid to DePix's config splitAddress (§5.5). */
    feeSplit?: { address: string; amountSats: bigint };
    /** Rolling-24h accountant label (default "boltz-submarine"). */
    spendKind?: string;
  }): Promise<PayLightningResult> {
    const prepared = await prepareSubmarineSwap(
      { invoice: params.invoice },
      {
        getSubmarinePairHash: () => this.client.getSubmarinePairHash(),
        createSubmarineSwap: (p) => this.client.createSubmarineSwap(p),
        getChainHeight: () => this.client.getChainHeight("L-BTC"),
        ...(this.deps.genRefundKeypair ? { genRefundKeypair: this.deps.genRefundKeypair } : {}),
        ...(this.deps.verifyLockup ? { verifyLockup: this.deps.verifyLockup } : {}),
        ...(this.deps.maxTimeoutBlocks !== undefined ? { maxTimeoutBlocks: this.deps.maxTimeoutBlocks } : {})
      }
    );

    // Persist the (crash-safe) refund material BEFORE anything is funded — a
    // crash after the lockup broadcasts must still be refundable (§5.3).
    const record: StoredSubmarineSwap = {
      type: "submarine",
      swapId: prepared.swapId,
      invoice: prepared.invoice,
      lockupAddress: prepared.lockupAddress,
      expectedAmountSats: prepared.expectedAmountSats,
      invoiceSats: prepared.invoiceSats,
      swapTree: prepared.swapTree,
      claimPublicKey: prepared.claimPublicKey,
      ...(prepared.blindingKey !== undefined ? { blindingKey: prepared.blindingKey } : {}),
      timeoutBlockHeight: prepared.timeoutBlockHeight,
      refundPrivateKeyHex: prepared.refundPrivateKeyHex,
      refundPublicKeyHex: prepared.refundPublicKeyHex,
      state: "prepared",
      createdAt: Date.now()
    };
    await this.ctx.store.put(record);

    // Guardrail choke point + L-BTC lockup signing (in the wallet). The FINAL
    // destination is the Lightning payee → the `lightning` allowlist class, plus
    // any caller-supplied classes (gift card = beneficiary, §5.5 — BOTH must be
    // opted in with the allowlist ON).
    let lockupTxid: string;
    try {
      const res = await this.ctx.lockupLbtc({
        address: prepared.lockupAddress,
        amountSats: BigInt(prepared.expectedAmountSats),
        destinations: [{ kind: "lightning" }, ...(params.extraDestinations ?? [])],
        ...(params.feeSplit ? { feeSplit: params.feeSplit } : {}),
        ...(params.spendKind ? { kind: params.spendKind } : {})
      });
      lockupTxid = res.txid;
    } catch (err) {
      // Roll back the record ONLY when the wallet PROVES nothing was locked
      // (pre-broadcast failure: guardrail/allowlist rejection, quotes-unavailable,
      // build/sign failure — tagged `nothingLocked`). A broadcast-stage error can
      // arrive AFTER the lockup tx propagated, so the L-BTC may be locked to the
      // Boltz Taproot address while this record is its SOLE holder of
      // `refundPrivateKeyHex`. In that case KEEP the record: resume() is a harmless
      // no-op if nothing actually funded, but recovers the funds (refund) if it
      // did — dropping the key would make a locked lockup irrecoverable (§5.3).
      const nothingLocked =
        err !== null && typeof err === "object" && (err as { nothingLocked?: boolean }).nothingLocked === true;
      if (nothingLocked) {
        await this.ctx.store.remove(prepared.swapId).catch(() => {});
      }
      throw err;
    }

    await this.ctx.store.patch(prepared.swapId, (r) => {
      (r as StoredSubmarineSwap).lockupTxid = lockupTxid;
      (r as StoredSubmarineSwap).state = "locked_up";
    });

    const completion = this.watchSubmarine(record.swapId, prepared.timeoutBlockHeight);
    // Never surface an unhandled rejection if the caller ignores `completion`.
    completion.catch(() => {});

    return {
      swapId: prepared.swapId,
      lockupTxid,
      expectedAmountSats: prepared.expectedAmountSats,
      invoiceSats: prepared.invoiceSats,
      invoice: prepared.invoice,
      completion
    };
  }

  /** Watch a funded submarine lockup: on refund/expiry, refund the L-BTC. */
  private watchSubmarine(swapId: string, timeoutBlockHeight: number): Promise<SubmarineOutcome> {
    return new Promise<SubmarineOutcome>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      let refunding = false;
      const finish = (outcome: SubmarineOutcome): void => {
        if (settled) return;
        settled = true;
        try {
          unsubscribe();
        } catch {
          // noop
        }
        resolve(outcome);
      };

      const onRaw = (raw: string): void => {
        const bucket = mapSubmarineStatus(raw);
        if (bucket === "completed") {
          void this.ctx.store.remove(swapId).catch(() => {});
          finish({ swapId, status: "paid" });
        } else if (bucket === "refunded") {
          void this.ctx.store.remove(swapId).catch(() => {});
          finish({ swapId, status: "refunded" });
        } else if (bucket === "refund" && !refunding) {
          refunding = true;
          void this.refundOne(swapId, timeoutBlockHeight)
            .then((r) => {
              if (r.refunded) finish({ swapId, status: "refunded", refundTxId: r.refundTxId });
              else finish({ swapId, status: "refund_pending" });
            })
            .catch(() => {
              refunding = false; // allow a later status to retry
            });
        }
      };

      try {
        unsubscribe = this.trackedSubscribe(swapId, onRaw);
      } catch (err) {
        this.logger.error("boltz submarine watch could not subscribe", {
          swapId,
          error: String((err as Error)?.message ?? err)
        });
        finish({ swapId, status: "failed" });
      }
    });
  }

  /**
   * Refund one submarine lockup. On success marks the record refunded (removed);
   * on RefundPendingError (timeout not reached) marks refund_pending so resume
   * retries. Returns whether the on-chain refund actually broadcast.
   */
  private async refundOne(
    swapId: string,
    timeoutBlockHeight: number
  ): Promise<{ refunded: boolean; refundTxId?: string | null }> {
    const stored = await this.ctx.store.get(swapId).catch(() => null);
    if (!stored || stored.type !== "submarine") return { refunded: false };
    const refundFn = this.deps.refundSubmarine ?? refundSubmarineSwap;
    const refundDeps: RefundDeps = {
      getRefundAddress: () => this.ctx.getReceiveAddress(),
      getBlockHeight: () => this.client.getChainHeight("L-BTC")
    };
    try {
      const res = await refundFn(
        {
          swapId: stored.swapId,
          claimPublicKey: stored.claimPublicKey,
          swapTree: stored.swapTree,
          ...(stored.blindingKey !== undefined ? { blindingKey: stored.blindingKey } : {}),
          timeoutBlockHeight: stored.timeoutBlockHeight,
          refundPrivateKeyHex: stored.refundPrivateKeyHex,
          refundPublicKeyHex: stored.refundPublicKeyHex
        },
        refundDeps
      );
      await this.ctx.store.remove(swapId).catch(() => {});
      return { refunded: true, refundTxId: res.refundTxId };
    } catch (err) {
      if ((err as { refundPending?: boolean }).refundPending) {
        await this.ctx.store
          .patch(swapId, (r) => {
            (r as StoredSubmarineSwap).state = "refund_pending";
          })
          .catch(() => {});
        this.logger.warn("boltz submarine refund pending (timeout not reached) — will retry on resume", {
          swapId,
          timeoutBlockHeight
        });
        return { refunded: false };
      }
      throw err;
    }
  }

  // ─── STABLECOIN (L-BTC → USDC/USDT EVM, chain swap) ──────────────────────

  /**
   * Convert L-BTC to USDC/USDT delivered to an external EVM/Tron address (§5.3,
   * G5). Creates + verifies the Boltz chain-swap route (fail-closed cadence),
   * persists the crash-safe refund/resume material BEFORE funding, then signs the
   * L-BTC lockup through the guardrail choke point (the lockup amount is valued in
   * BRL; the FINAL EVM settle address is checked against allowlist.evmAddresses —
   * a protocol-bound lockup does NOT exempt it, §4.3). Once funded, the EVM legs
   * (claim → DEX → bridge → deliver) run in the background signed by an EPHEMERAL
   * viem account, gas paid by the hosted sponsor (sponsor.ccxp.space).
   */
  async toStablecoin(params: StablecoinParams): Promise<ToStablecoinResult> {
    const prepared = await prepareStablecoinRoute(params, {
      ...(this.deps.stablecoin?.prepare ?? {})
    });

    // Persist the crash-safe resume/refund material BEFORE anything is funded — a
    // crash after the lockup broadcasts must still be recoverable (refund the
    // L-BTC or finish the swap). The ephemeral EVM key rides in the ENCRYPTED
    // record; the in-memory copy is zeroed right after (below).
    const record: StoredStablecoinSwap = {
      type: "stablecoin",
      swapId: prepared.swapId,
      asset: prepared.asset,
      networkId: prepared.networkId,
      claimAddress: prepared.claimAddress,
      lockupAddress: prepared.lockupAddress,
      lockAmountSats: prepared.lockAmountSats,
      serverPublicKey: prepared.serverPublicKey,
      swapTree: prepared.swapTree,
      ...(prepared.blindingKey !== undefined ? { blindingKey: prepared.blindingKey } : {}),
      timeoutBlockHeight: prepared.timeoutBlockHeight,
      refundPrivateKeyHex: prepared.refundPrivateKeyHex,
      refundPublicKeyHex: prepared.refundPublicKeyHex,
      preimageHex: prepared.preimageHex,
      evmPrivateKeyHex: hex.encode(prepared.evmPrivateKey),
      createdSwap: prepared.createdSwap,
      plan: prepared.plan,
      state: "prepared",
      createdAt: Date.now()
    };
    await this.ctx.store.put(record);
    // The encrypted store copy is now the source of truth — zero the in-memory
    // ephemeral EVM key immediately (frontend zeroInMemory parity). Every later
    // use (execute/resume) decodes a fresh copy from the record and zeroes it too.
    prepared.evmPrivateKey.fill(0);
    // Also DROP the plaintext hex STRING from the long-lived in-memory record: the
    // store already encrypted a shallow copy at rest, so this reference is the only
    // remaining cleartext key that would otherwise linger through the (potentially
    // slow) lockup + guardrail step below. JS strings are immutable and can't be
    // wiped in place; the best we can do is release the reference so it is
    // GC-eligible immediately. (The transient 0x-hex string viem materializes per
    // signing session inside withEphemeralEvmSigner is inherent to viem and cannot
    // be avoided.) `record` is not read again after this point.
    record.evmPrivateKeyHex = "";

    // Guardrail choke point + L-BTC lockup signing (in the wallet). The FINAL
    // destination is the agent-chosen settle address. Dispatch by address family:
    // EVM targets use the case-INsensitive `evmAddress` class; Tron (TRC-20) is
    // base58check — case-SENSITIVE — so it must use the exact-match `tronAddress`
    // class, never `evmAddress` (lowercasing a base58 identifier is semantically
    // wrong and could, in principle, fail OPEN on a lowercased collision).
    const settleDestination: GuardrailDestination =
      getStablecoinNetwork(prepared.networkId)?.family === "tron"
        ? { kind: "tronAddress", address: prepared.claimAddress }
        : { kind: "evmAddress", address: prepared.claimAddress };
    let lockupTxid: string;
    try {
      const res = await this.ctx.lockupLbtc({
        address: prepared.lockupAddress,
        amountSats: BigInt(prepared.lockAmountSats),
        destinations: [settleDestination]
      });
      lockupTxid = res.txid;
    } catch (err) {
      // Same rollback rule as the submarine path: drop the record ONLY when the
      // wallet PROVES nothing was locked (`nothingLocked`). A broadcast-stage error
      // may arrive AFTER the L-BTC lockup propagated, and this record is the SOLE
      // holder of `refundPrivateKeyHex` — keep it so resume() can refund.
      const nothingLocked =
        err !== null && typeof err === "object" && (err as { nothingLocked?: boolean }).nothingLocked === true;
      if (nothingLocked) {
        await this.ctx.store.remove(prepared.swapId).catch(() => {});
      }
      throw err;
    }

    await this.ctx.store.patch(prepared.swapId, (r) => {
      (r as StoredStablecoinSwap).lockupTxid = lockupTxid;
      (r as StoredStablecoinSwap).state = "locked_up";
    });

    const completion = this.executeStablecoin(prepared.swapId);
    completion.catch(() => {});

    return {
      swapId: prepared.swapId,
      lockupTxid,
      lockAmountSats: prepared.lockAmountSats,
      asset: prepared.asset,
      networkId: prepared.networkId,
      claimAddress: prepared.claimAddress,
      completion
    };
  }

  /**
   * Finish a funded stablecoin swap: wait for Boltz's confirmed destination
   * lockup, then run the claim → DEX → bridge with the ephemeral viem signer
   * (zeroed after). On success the record is dropped; on a post-lockup failure the
   * record is LEFT for resume()/refund — the L-BTC is safe either way.
   */
  private async executeStablecoin(swapId: string): Promise<StablecoinOutcome> {
    let stored: StoredStablecoinSwap | null;
    try {
      const rec = await this.ctx.store.get(swapId);
      stored = rec && rec.type === "stablecoin" ? rec : null;
    } catch (err) {
      this.logger.error("boltz stablecoin execute: could not read the swap record", {
        swapId,
        error: String((err as Error)?.message ?? err)
      });
      return { swapId, status: "pending" };
    }
    if (!stored) return { swapId, status: "failed" };

    const executeDeps: ExecuteStablecoinDeps = {
      waitForServerLockup: (id) => this.waitForServerLockup(id),
      ...(this.deps.stablecoin?.execute ?? {})
    };
    try {
      const { claimTransactionId } = await executeStablecoinRoute(
        {
          swapId: stored.swapId,
          claimAddress: stored.claimAddress,
          createdSwap: stored.createdSwap,
          plan: stored.plan,
          preimageHex: stored.preimageHex,
          evmPrivateKeyHex: stored.evmPrivateKeyHex
        },
        executeDeps
      );
      await this.ctx.store.remove(swapId).catch(() => {});
      return { swapId, status: "settled", claimTransactionId };
    } catch (err) {
      // Post-lockup failure — the L-BTC lockup is safe (refundable) and the
      // persisted record lets resume() finish or refund. This is "pending", not a
      // lost-funds error.
      this.logger.error("boltz stablecoin execution failed — recovery will resume/refund on next open()", {
        swapId,
        error: String((err as Error)?.message ?? err)
      });
      return { swapId, status: "pending" };
    }
  }

  // How long to wait for Boltz to lock the destination after our L-BTC lockup
  // broadcasts (zero-conf is seconds; a rejected zeroconf needs ~1 L-BTC block).
  private static readonly SERVER_LOCKUP_TIMEOUT_MS = 20 * 60_000;

  /**
   * Resolve once Boltz CONFIRMS its destination lockup ("transaction.server.
   * confirmed"), reject on a chain-swap failure status or timeout. executeRoute
   * does NOT poll, so calling it before the server lockup exists reverts — this
   * mirrors the frontend's waitForServerLockup. Uses the tracked subscription so
   * close() tears the socket + reconnect timer down.
   */
  private waitForServerLockup(swapId: string): Promise<void> {
    const timeoutMs = this.deps.stablecoin?.serverLockupTimeoutMs ?? BoltzConvert.SERVER_LOCKUP_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      function finish(fn: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          unsubscribe();
        } catch {
          // noop
        }
        fn();
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error("timed out waiting for the Boltz destination lockup"))),
        timeoutMs
      );
      try {
        unsubscribe = this.trackedSubscribe(swapId, (raw) => {
          if (raw === "transaction.server.confirmed") {
            finish(resolve);
          } else if (CHAIN_SWAP_FAILURE_STATUSES.has(raw)) {
            finish(() => reject(new Error(`chain swap failed before execution: ${raw}`)));
          }
        });
      } catch (err) {
        finish(() => reject(err as Error));
      }
    });
  }

  /**
   * Refund one stablecoin (chain) L-BTC lockup. On success the record is dropped;
   * on RefundPendingError (timeout not reached) it is marked refund_pending +
   * outcome:refund so resume() retries and never re-attempts execution.
   */
  private async refundStablecoin(
    record: StoredStablecoinSwap
  ): Promise<{ refunded: boolean; refundTxId?: string | null }> {
    const refundFn = this.deps.stablecoin?.refundChain ?? refundChainSwap;
    const refundDeps: ChainRefundDeps = {
      getRefundAddress: () => this.ctx.getReceiveAddress(),
      getBlockHeight: () => this.client.getChainHeight("L-BTC")
    };
    try {
      const res = await refundFn(
        {
          swapId: record.swapId,
          serverPublicKey: record.serverPublicKey,
          swapTree: record.swapTree,
          ...(record.blindingKey !== undefined ? { blindingKey: record.blindingKey } : {}),
          timeoutBlockHeight: record.timeoutBlockHeight,
          refundPrivateKeyHex: record.refundPrivateKeyHex,
          refundPublicKeyHex: record.refundPublicKeyHex
        },
        refundDeps
      );
      await this.ctx.store.remove(record.swapId).catch(() => {});
      return { refunded: true, refundTxId: res.refundTxId };
    } catch (err) {
      if ((err as { refundPending?: boolean }).refundPending) {
        await this.ctx.store
          .patch(record.swapId, (r) => {
            (r as StoredStablecoinSwap).state = "refund_pending";
            (r as StoredStablecoinSwap).outcome = "refund";
          })
          .catch(() => {});
        this.logger.warn("boltz stablecoin refund pending (timeout not reached) — will retry on resume", {
          swapId: record.swapId
        });
        return { refunded: false };
      }
      throw err;
    }
  }

  // ─── LN RECEIVE (reverse) ────────────────────────────────────────────────

  /**
   * Receive over Lightning into the wallet (§5.3). Creates a reverse swap, binds
   * the returned invoice to OUR preimage (INVOICE_HASH_MISMATCH otherwise), and
   * claims the L-BTC lockup into a backup-gated receive address once the payer
   * pays. An INFLOW — no guardrail.
   */
  async receiveLightning(params: { amountSats: number }): Promise<ReceiveLightningResult> {
    const pairHash = this.deps.getReversePairHash
      ? await this.deps.getReversePairHash()
      : (await getReverseLimits()).hash;

    let resolveInvoice!: (v: { invoice: string; record: ReverseSwapRecord }) => void;
    let rejectInvoice!: (e: unknown) => void;
    const invoiceReady = new Promise<{ invoice: string; record: ReverseSwapRecord }>((res, rej) => {
      resolveInvoice = res;
      rejectInvoice = rej;
    });

    const reverseDeps: ReverseDeps = {
      deriveSecrets: async () => (this.deps.deriveSecrets ?? deriveReverseSecrets)(),
      getClaimAddress: () => this.ctx.getReceiveAddress(),
      subscribe: (id, onRaw) => this.trackedSubscribe(id, onRaw),
      persist: async (rec) => {
        const stored: StoredReverseSwap = { ...rec, type: "reverse", state: "awaiting_payment", createdAt: Date.now() };
        // Awaited (durability §5.3) but best-effort: a persist failure logs and
        // does not reject the receive — the frontend's persist is likewise
        // try/caught. receiveViaLightning awaits this before surfacing the invoice.
        try {
          await this.ctx.store.put(stored);
        } catch (e) {
          this.logger.error("failed to persist reverse swap record", {
            swapId: rec.swapId,
            error: String((e as Error)?.message ?? e)
          });
        }
      },
      onInvoice: (invoice, record) => resolveInvoice({ invoice, record }),
      ...(this.deps.reverseClaim ? { claim: this.deps.reverseClaim } : {}),
      ...(this.deps.reverseBroadcast ? { broadcast: this.deps.reverseBroadcast } : {}),
      ...(this.deps.reverseGetLockupTx ? { getLockupTx: this.deps.reverseGetLockupTx } : {}),
      ...(this.deps.reverseCreate ? { createReverseSwap: this.deps.reverseCreate } : {})
    };

    const completion = receiveViaLightning({ amountSats: params.amountSats, pairHash }, reverseDeps).then(
      (outcome) => {
        // Terminal — mark the stored record and drop it.
        void this.ctx.store.remove(outcome.swapId).catch(() => {});
        return outcome;
      }
    );
    completion.catch((err) => rejectInvoice(err));
    // Don't leak an unhandled rejection when the caller only awaits the invoice.
    completion.catch(() => {});

    const { invoice, record } = await invoiceReady;
    return { swapId: record.swapId, invoice, lockupAddress: record.lockupAddress, amountSats: params.amountSats, completion };
  }

  // ─── resume (post-crash) ─────────────────────────────────────────────────

  /**
   * Recover in-flight swaps from boltz-swaps.json (§5.3). Submarine records are
   * reconciled with Boltz and refunded if in a refund state; reverse records are
   * re-watched and claimed. Tampered records (failed GCM auth) are discarded.
   * NEVER throws — per-record failures are logged.
   */
  async resume(): Promise<BoltzResumeSummary> {
    const summary: BoltzResumeSummary = {
      submarineResumed: 0,
      submarineRefunded: 0,
      reverseResumed: 0,
      stablecoinResumed: 0,
      stablecoinRefunded: 0,
      discarded: 0,
      removed: 0,
      failed: 0
    };

    let read;
    try {
      read = await this.ctx.store.readAll();
    } catch (err) {
      this.logger.error("could not read boltz-swaps.json — skipping resume", {
        error: String((err as Error)?.message ?? err)
      });
      return summary;
    }

    for (const id of read.tamperedIds) {
      summary.discarded++;
      this.logger.error("boltz swap failed authentication (tampered) — discarding", { swapId: id });
      await this.ctx.store.remove(id).catch(() => {});
    }

    for (const record of read.records) {
      try {
        if (record.type === "submarine") {
          await this.resumeSubmarine(record, summary);
        } else if (record.type === "stablecoin") {
          await this.resumeStablecoin(record, summary);
        } else {
          await this.resumeReverse(record, summary);
        }
      } catch (err) {
        summary.failed++;
        this.logger.error("failed to resume a boltz swap", {
          swapId: record.swapId,
          type: record.type,
          error: String((err as Error)?.message ?? err)
        });
      }
    }
    return summary;
  }

  private async resumeSubmarine(record: StoredSubmarineSwap, summary: BoltzResumeSummary): Promise<void> {
    // Reconcile with Boltz to decide claim (paid) vs refund vs still-pending.
    let bucket: ReturnType<typeof mapSubmarineStatus>;
    try {
      const status = await this.client.getSwapStatus(record.swapId);
      bucket = mapSubmarineStatus(status?.status);
    } catch {
      bucket = null;
    }

    if (bucket === "completed") {
      await this.ctx.store.remove(record.swapId).catch(() => {});
      summary.removed++;
      return;
    }
    if (bucket === "refunded") {
      await this.ctx.store.remove(record.swapId).catch(() => {});
      summary.removed++;
      return;
    }
    if (bucket === "refund" || record.state === "refund_pending") {
      const r = await this.refundOne(record.swapId, record.timeoutBlockHeight);
      if (r.refunded) summary.submarineRefunded++;
      else summary.submarineResumed++; // refund_pending — will retry next resume
      return;
    }
    // Still in flight — re-attach the watch (best-effort, background).
    const completion = this.watchSubmarine(record.swapId, record.timeoutBlockHeight);
    completion.catch(() => {});
    summary.submarineResumed++;
  }

  private async resumeReverse(record: StoredReverseSwap, summary: BoltzResumeSummary): Promise<void> {
    const reverseDeps: ReverseDeps = {
      deriveSecrets: async () => (this.deps.deriveSecrets ?? deriveReverseSecrets)(),
      getClaimAddress: () => this.ctx.getReceiveAddress(),
      subscribe: (id, onRaw) => this.trackedSubscribe(id, onRaw),
      persist: (rec) => {
        void this.ctx.store
          .patch(rec.swapId, (r) => {
            (r as StoredReverseSwap).claimTxId = rec.claimTxId ?? null;
          })
          .catch(() => {});
      },
      ...(this.deps.reverseClaim ? { claim: this.deps.reverseClaim } : {}),
      ...(this.deps.reverseBroadcast ? { broadcast: this.deps.reverseBroadcast } : {}),
      ...(this.deps.reverseGetLockupTx ? { getLockupTx: this.deps.reverseGetLockupTx } : {})
    };
    const completion = resumeReverseSwap(record, reverseDeps).then((outcome) => {
      void this.ctx.store.remove(outcome.swapId).catch(() => {});
      return outcome;
    });
    completion.catch((err) =>
      this.logger.error("reverse swap resume failed", {
        swapId: record.swapId,
        error: String((err as Error)?.message ?? err)
      })
    );
    summary.reverseResumed++;
  }

  private async resumeStablecoin(record: StoredStablecoinSwap, summary: BoltzResumeSummary): Promise<void> {
    // Reconcile with Boltz to decide finish (server-locked → execute) vs refund
    // (failed/expired) vs still-pending. A swap we've already decided will refund
    // (outcome:refund) never re-attempts execution — straight to refund.
    let bucket: ReturnType<typeof mapChainSwapStatus>;
    try {
      const status = await this.client.getSwapStatus(record.swapId);
      bucket = mapChainSwapStatus(status?.status);
    } catch {
      bucket = null;
    }

    if (bucket === "done") {
      await this.ctx.store.remove(record.swapId).catch(() => {});
      summary.removed++;
      return;
    }
    if (record.outcome === "refund" || bucket === "refund" || record.state === "refund_pending") {
      const r = await this.refundStablecoin(record);
      if (r.refunded) summary.stablecoinRefunded++;
      else summary.stablecoinResumed++; // refund_pending — will retry next resume
      return;
    }
    if (bucket === "resume" || record.state === "locked_up") {
      // Server-locked (or funded, awaiting) — finish the swap in the background.
      const completion = this.executeStablecoin(record.swapId);
      completion.catch(() => {});
      summary.stablecoinResumed++;
      return;
    }
    // Still pending (user lockup not yet server-locked) — re-attach execution,
    // which waits for the server lockup before claiming.
    const completion = this.executeStablecoin(record.swapId);
    completion.catch(() => {});
    summary.stablecoinResumed++;
  }
}
