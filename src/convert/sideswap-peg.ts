// SideSwap peg (BTC on-chain ↔ L-BTC) — spec §5.2. Port of pegIn/pegOut
// (sideswap.js:660-724) + validatePegOutPsetRecipient (wallet.js:2441-2479),
// GT §4.E. NON-custodial: the peg address is protocol-bound, but the FINAL
// destination (the caller's on-chain BTC recv_addr for peg-out) is free, so it
// passes the allowlist (§4.3, btcAddresses class).
//
// Peg-out is address-based (the current protocol; the old PSET path is
// deprecated — sideswap.js:702): SideSwap returns a Liquid `peg_addr`, and the
// SDK does a normal internally-built L-BTC send to it (parity with the
// frontend's executePegout → prepareSend/confirmSend). The guardrail counts the
// L-BTC value in BRL and checks the FINAL `recv_addr` BTC destination against
// the allowlist's btcAddresses; the built PSET's single external recipient is
// re-pinned to the peg address (defense in depth, port of
// validatePegOutPsetRecipient).
//
// Peg-in is funded externally (BTC on-chain), so no signing and no guardrail —
// it is an INFLOW; the recv address is OUR backup-gated receive address. Only
// ONE peg-in in flight at a time (PENDING §5.2 → PEG_IN_ALREADY_PENDING).

import { ASSETS } from "../assets.js";
import { Address, TxBuilder, mainnetNetwork } from "../engine/lwk.js";
import type { Pset } from "../engine/lwk.js";
import { ConversionError, SideSwapError, WalletError } from "../errors.js";
import { liquidScriptHex } from "../guardrails/allowlist.js";
import type { ConvertWalletHooks } from "./hooks.js";
import { signWithEphemeralSigner } from "./hooks.js";
import { PendingPegIn } from "./pending-pegin.js";
import {
  createSideSwapClient,
  SS_ERROR,
  type PegStatusResult,
  type SideSwapClient,
  type SideSwapClientOptions
} from "./sideswap-client.js";

// ─── peg-out recipient validation (port of validatePegOutPsetRecipient) ──────

/** Minimal structural view of the lwk recipient inspection. */
interface LwkRecipientLike {
  asset?(): { toString(): string } | undefined;
  value?(): bigint | number | undefined;
  address?(): { scriptPubkey?(): { toString(): string; free?(): void } | undefined } | undefined;
  free?(): void;
}
interface LwkPegBalanceLike {
  recipients(): LwkRecipientLike[];
  free?(): void;
}
interface LwkPegDetailsLike {
  balance(): LwkPegBalanceLike;
  free?(): void;
}
interface LwkPegWolletLike {
  psetDetails(pset: unknown): LwkPegDetailsLike;
}

export interface PegOutRecipient {
  asset: string | null;
  value: bigint | null;
  scriptHex: string | null;
}

export interface PegOutRecipientExpectation {
  /** L-BTC asset id (hex). */
  lbtcId: string;
  /** The amount the caller authorized (base units). */
  authorizedSats: bigint;
  /** scriptPubkey hex of the SideSwap peg address. */
  expectedScriptHex: string;
}

function pegValidationFailed(message: string): ConversionError {
  return new ConversionError("SWAP_VALIDATION_FAILED", message);
}

/**
 * Read the foreign recipients of a PSET (port of readPsetRecipients,
 * wallet.js:2192-2236) — outputs that do NOT belong to the wallet — freeing
 * every wasm handle on the way out.
 */
export function inspectPegOutRecipients(pset: unknown, wollet: LwkPegWolletLike): PegOutRecipient[] {
  let details: LwkPegDetailsLike | undefined;
  let balance: LwkPegBalanceLike | undefined;
  let recipients: LwkRecipientLike[];
  try {
    details = wollet.psetDetails(pset);
    balance = details.balance();
    recipients = balance.recipients();
  } catch {
    try {
      balance?.free?.();
    } catch {
      /* best effort */
    }
    try {
      details?.free?.();
    } catch {
      /* best effort */
    }
    throw pegValidationFailed("could not inspect peg-out PSET recipients");
  }
  const out: PegOutRecipient[] = [];
  try {
    if (Array.isArray(recipients)) {
      for (const r of recipients) {
        let asset: string | null = null;
        let value: bigint | null = null;
        let scriptHex: string | null = null;
        let scriptHandle: { toString(): string; free?(): void } | undefined;
        try {
          asset = r.asset?.()?.toString?.() ?? null;
          const v = r.value?.();
          value = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null;
          scriptHandle = r.address?.()?.scriptPubkey?.();
          scriptHex = scriptHandle?.toString?.() ?? null;
        } finally {
          try {
            scriptHandle?.free?.();
          } catch {
            /* best effort */
          }
          try {
            r.free?.();
          } catch {
            /* best effort */
          }
        }
        out.push({ asset, value, scriptHex });
      }
    }
  } finally {
    try {
      balance?.free?.();
    } catch {
      /* best effort */
    }
    try {
      details?.free?.();
    } catch {
      /* best effort */
    }
  }
  return out;
}

/**
 * Assert the (internally-built) peg-out PSET has EXACTLY ONE external recipient,
 * paying the peg address with L-BTC, not exceeding the authorized amount (port
 * of validatePegOutPsetRecipient). Since the SDK builds the PSET itself and
 * knows the peg address, this also pins the scriptPubkey (stronger than the
 * frontend, which cannot know the rotating deposit address up front).
 */
export function assertPegOutRecipient(
  recipients: readonly PegOutRecipient[],
  expect: PegOutRecipientExpectation
): void {
  if (expect.authorizedSats <= 0n) {
    throw pegValidationFailed("authorized peg-out amount must be positive");
  }
  if (recipients.length !== 1) {
    throw pegValidationFailed(
      `peg-out PSET has ${recipients.length} external recipients (expected exactly 1)`
    );
  }
  const [r] = recipients;
  if (!r || r.asset !== expect.lbtcId) {
    throw pegValidationFailed("peg-out PSET targets an asset other than L-BTC");
  }
  if (typeof r.value !== "bigint") {
    throw pegValidationFailed("peg-out PSET recipient value could not be read");
  }
  if (r.value <= 0n) {
    throw pegValidationFailed("peg-out PSET recipient value is non-positive");
  }
  if (r.value > expect.authorizedSats) {
    throw pegValidationFailed("peg-out PSET exceeds the authorized amount");
  }
  if (r.scriptHex !== expect.expectedScriptHex) {
    throw pegValidationFailed("peg-out PSET does not pay the SideSwap peg address");
  }
}

// ─── public peg API (§5.2) ────────────────────────────────────────────────────

export interface PegInResult {
  orderId: string;
  /** BTC address the owner funds externally. */
  pegAddr: string;
  /** OUR Liquid receive address SideSwap pays L-BTC to. */
  recvAddr: string;
  expiresAt: number | null;
  /** When the peg-in was first tracked (epoch ms). Present when read back from the store. */
  createdAt?: number;
}

export interface PegOutParams {
  /** Destination BTC on-chain address (checked against allowlist.btcAddresses). */
  recvAddr: string;
  /** L-BTC to send, in base units. */
  amountSats: bigint;
  /** BTC-side confirmation target (lower = faster + costlier). Server default if omitted. */
  blocks?: number;
}

export interface PegOutResult {
  orderId: string;
  /** SideSwap Liquid peg address the L-BTC was sent to. */
  pegAddr: string;
  recvAddr: string;
  /** The Liquid txid of the L-BTC send (telemetry; BTC payout is off-band). */
  txid: string;
  amountSats: bigint;
  recvAmount: number | null;
  /** BRL cents accounted against the guardrail window (§4.3). */
  brlCents: number;
}

export interface SideSwapPegDeps {
  hooks: ConvertWalletHooks;
  pending: PendingPegIn;
  clientFactory?: (options: SideSwapClientOptions) => SideSwapClient;
}

/** Orchestrates SideSwap peg-in / peg-out (§5.2). */
export class SideSwapPeg {
  private readonly hooks: ConvertWalletHooks;
  private readonly pending: PendingPegIn;
  private readonly clientFactory: (options: SideSwapClientOptions) => SideSwapClient;

  constructor(deps: SideSwapPegDeps) {
    this.hooks = deps.hooks;
    this.pending = deps.pending;
    this.clientFactory = deps.clientFactory ?? createSideSwapClient;
  }

  /**
   * Start a peg-in (BTC → L-BTC): SideSwap returns a BTC deposit address the
   * owner funds externally, and pays L-BTC to OUR backup-gated receive address.
   * Only one in flight at a time → PEG_IN_ALREADY_PENDING. No signing, no
   * guardrail (it is an inflow).
   */
  async pegIn(): Promise<PegInResult> {
    this.hooks.assertOpen();
    // Serialize the single-in-flight check with its own write (and with the
    // swap / peg-out paths) through the SAME op mutex peg-out uses. Otherwise two
    // concurrent pegIn() calls can both read existing===null, both open a
    // SideSwap order, and the second put() clobbers the first — losing a tracking
    // record and defeating the PEG_IN_ALREADY_PENDING invariant (§5.2 TOCTOU).
    return this.hooks.runExclusive(async () => {
      const existing = await this.pending.load();
      if (existing) {
        throw new ConversionError(
          "PEG_IN_ALREADY_PENDING",
          `a peg-in is already in flight (order ${existing.orderId}, funding BTC address ${existing.pegAddr}). ` +
            "Complete or wait for it (or let it expire after 7 days) before starting another."
        );
      }
      const recvAddr = await this.hooks.getReceiveAddress(); // backup-gated (§2.9)
      const client = this.clientFactory({});
      try {
        await client.connect();
        const peg = await client.pegIn({ recvAddr });
        if (!peg.pegAddr || !peg.orderId) {
          throw new SideSwapError(SS_ERROR.INVALID_RESPONSE, "SideSwap peg-in returned no peg address / order id");
        }
        await this.pending.put({ orderId: peg.orderId, pegAddr: peg.pegAddr, recvAddr });
        return { orderId: peg.orderId, pegAddr: peg.pegAddr, recvAddr, expiresAt: peg.expiresAt ?? null };
      } finally {
        client.disconnect();
      }
    });
  }

  /**
   * Peg-out (L-BTC → BTC): guardrail on the L-BTC value in BRL + the FINAL
   * recv_addr BTC destination (allowlist.btcAddresses), THEN an internally-built
   * L-BTC send to the SideSwap peg address with its single recipient re-pinned.
   * Serialized through the wallet op mutex (§4.3).
   */
  async pegOut(params: PegOutParams): Promise<PegOutResult> {
    this.hooks.assertOpen();
    if (typeof params.recvAddr !== "string" || params.recvAddr.trim().length === 0) {
      throw new WalletError("INVALID_ADDRESS", "peg-out recvAddr (BTC destination) is required");
    }
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "peg-out amountSats must be a positive bigint");
    }

    return this.hooks.runExclusive(async () => {
      // Guardrail on the L-BTC value in BRL + the FINAL BTC destination (§4.3) —
      // BEFORE contacting SideSwap or signing anything.
      const brlCents = await this.hooks.valuate("LBTC", params.amountSats);
      await this.hooks.enforceGuardrails({
        kind: "sideswap-pegout",
        brlCents,
        destinations: [{ kind: "btcAddress", address: params.recvAddr }]
      });

      const client = this.clientFactory({});
      let pegAddr: string;
      let orderId: string;
      let recvAmount: number | null;
      try {
        await client.connect();
        const peg = await client.pegOut({ recvAddr: params.recvAddr, blocks: params.blocks });
        if (!peg.pegAddr || !peg.orderId) {
          throw new SideSwapError(
            SS_ERROR.INVALID_RESPONSE,
            "SideSwap peg-out returned no peg address / order id"
          );
        }
        pegAddr = peg.pegAddr;
        orderId = peg.orderId;
        recvAmount = peg.recvAmount ?? null;
      } finally {
        client.disconnect();
      }

      const txid = await this.buildSignBroadcastLbtc(pegAddr, params.amountSats, brlCents);
      return {
        orderId,
        pegAddr,
        recvAddr: params.recvAddr,
        txid,
        amountSats: params.amountSats,
        recvAmount,
        brlCents
      };
    });
  }

  /** Poll a peg order status (read-only; no signing). */
  async pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult> {
    this.hooks.assertOpen();
    const client = this.clientFactory({});
    try {
      await client.connect();
      return await client.pegStatus(args);
    } finally {
      client.disconnect();
    }
  }

  /** Clear the tracked in-flight peg-in (e.g. once it has settled). */
  async clearPendingPegIn(): Promise<void> {
    await this.pending.clear();
  }

  /** Read the tracked in-flight peg-in, if any (TTL-pruned). */
  async getPendingPegIn(): Promise<PegInResult | null> {
    const rec = await this.pending.load();
    if (!rec) return null;
    return { orderId: rec.orderId, pegAddr: rec.pegAddr, recvAddr: rec.recvAddr, expiresAt: null, createdAt: rec.createdAt };
  }

  private async buildSignBroadcastLbtc(
    pegAddr: string,
    amountSats: bigint,
    brlCents: number
  ): Promise<string> {
    const wollet = await this.hooks.ensureWollet();
    const network = mainnetNetwork();
    let addr: InstanceType<typeof Address>;
    try {
      addr = new Address(pegAddr);
    } catch (err) {
      throw new WalletError("INVALID_ADDRESS", `SideSwap peg address is not a valid Liquid address: ${pegAddr}`, {
        cause: err
      });
    }
    const expectedScriptHex = liquidScriptHex(pegAddr);

    // lwk MOVES (consumes) its input into wasm on addLbtcRecipient()/finish()
    // (each consumes the builder), sign() (consumes `pset`) and finalize()
    // (consumes `signed`) — verified in lwk_wasm.js via `__destroy_into_raw()`.
    // So the builder and `signed` are reclaimed by those moves; only `addr`
    // (borrowed, never moved), the surviving `finalized`, and — on a pre-sign
    // abort (a recipient-pin failure) — `pset`, actually leak. Free those.
    let psetTakenBySigner = false;
    let pset: InstanceType<typeof Pset> | undefined;
    let finalized: InstanceType<typeof Pset> | undefined;
    try {
      let builder = new TxBuilder(network);
      builder = builder.addLbtcRecipient(addr, amountSats);
      try {
        pset = builder.finish(wollet);
      } catch (err) {
        throw this.classifyFinishError(err);
      }

      // Re-pin the single external recipient (defense in depth): exactly one, paying
      // the peg address, L-BTC, not exceeding the authorized amount.
      const recipients = inspectPegOutRecipients(pset, wollet as unknown as LwkPegWolletLike);
      assertPegOutRecipient(recipients, {
        lbtcId: ASSETS.LBTC.id,
        authorizedSats: amountSats,
        expectedScriptHex
      });

      psetTakenBySigner = true; // signWithEphemeralSigner → signer.sign() consumes `pset`
      const signed = await signWithEphemeralSigner(this.hooks, pset);
      finalized = wollet.finalize(signed); // consumes `signed`
      // Account at signing time (§4.5), BEFORE broadcast (parity with send()).
      await this.hooks.recordSpend(brlCents, "sideswap-pegout");
      return await this.hooks.broadcast(finalized);
    } finally {
      try {
        finalized?.free?.();
      } catch {
        /* best effort */
      }
      if (!psetTakenBySigner) {
        try {
          pset?.free?.();
        } catch {
          /* best effort */
        }
      }
      try {
        addr.free?.();
      } catch {
        /* best effort */
      }
    }
  }

  private classifyFinishError(err: unknown): WalletError {
    const message = String((err as Error)?.message ?? err ?? "").toLowerCase();
    if (message.includes("insufficient") || message.includes("not enough")) {
      return new WalletError("INSUFFICIENT_FUNDS", "not enough L-BTC for the peg-out (amount + network fee)", {
        cause: err
      });
    }
    return new WalletError("INVALID_AMOUNT", "peg-out transaction build failed", { cause: err });
  }
}

export type { PegStatusResult } from "./sideswap-client.js";
