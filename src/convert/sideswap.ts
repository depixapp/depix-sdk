// SideSwap market swaps between {DePix, USDt, L-BTC} (spec §5.1) — NON-custodial.
// Port of depix-frontend/wallet/sideswap.js + swap-ui.js (GT §4.A). This module
// is the §5.1 entry: it owns the swap PSET validation (the load-bearing security
// check), the taker UTXO collection, and the quote/execute orchestration. The
// raw WS protocol lives in ./sideswap-client.ts.
//
// Signing a foreign PSET (port of signSwapPset, wallet.js:2820-2873):
//   pset.addDetails(wollet)  →  validateSwapPsetOutput  →  signer.sign
//     PRIMARY (hard): the PSET MUST pay the exact scriptPubkey of OUR receive
//       address — the load-bearing protection against fund diversion. Never
//       softened.
//     SECONDARY (FAIL-CLOSED, G3 — DIVERGES from the frontend's fail-open): the
//       wallet's net balance for the recv asset must be positive AND within ±1%
//       of the quoted amount. Where the browser (with a human at the preview
//       screen) proceeds on an inspection failure or an asset-not-found, the SDK
//       has no human confirmation — so a failed/absent inspection ABORTS with
//       SWAP_VALIDATION_FAILED and nothing is signed (spec §5.1/G3).
//
// Guardrail (§4.3): taker_sign goes through the choke point BEFORE signing,
// counting the SENT side in BRL (via the BrlValuator). Market swaps are EXEMPT
// from the allowlist (the validated PSET pays OUR OWN address — funds return to
// the wallet, kind "protocolBound") but DO count against the value ceilings.

import { ASSETS, type AssetKey } from "../assets.js";
import { Pset } from "../engine/lwk.js";
import { ConversionError, WalletError } from "../errors.js";
import { liquidScriptHex } from "../guardrails/allowlist.js";
import type { ConvertWalletHooks } from "./hooks.js";
import { signWithEphemeralSigner } from "./hooks.js";
import {
  createSideSwapClient,
  isTransientBlindingError,
  SS_ERROR,
  type SideSwapClient,
  type SideSwapClientOptions,
  type SideSwapQuoteEvent,
  type SideSwapUtxo,
  type SubscriptionHandle
} from "./sideswap-client.js";
import { SideSwapError } from "../errors.js";

/** Minimum TTL remaining to attempt an execute — the round-trip must land in time. */
const QUOTE_MIN_REMAINING_MS = 3_000;
/** Default deadline for a single next() (the frontend arms a 15s quote timeout). */
const DEFAULT_QUOTE_WAIT_MS = 20_000;
/** Bounded wait for the market list after connect (frontend parity, 3s). */
const MARKETS_READY_WAIT_MS = 3_000;

// ─── swap PSET inspection + validation (the security-critical §5.1 core) ─────

/** Minimal structural view of the lwk objects the inspection reads. */
interface LwkScriptLike {
  toString(): string;
  free?(): void;
}
interface LwkPsetOutputLike {
  scriptPubkey(): LwkScriptLike;
  free?(): void;
}
interface LwkPsetLike {
  outputs(): LwkPsetOutputLike[];
}
interface LwkBalancesLike {
  // lwk 0.18 returns a JS Map (asset id → amount); older builds returned an
  // array of [k, v] pairs. inspectSwapPset handles both (a wrong guard here
  // would leave netBalances empty → the fail-closed §5.1/G3 check would reject
  // EVERY legitimate swap, not just tampered ones).
  entries(): unknown;
  free?(): void;
}
interface LwkBalanceLike {
  balances(): LwkBalancesLike;
  free?(): void;
}
interface LwkPsetDetailsLike {
  balance(): LwkBalanceLike;
  free?(): void;
}
interface LwkWolletLike {
  psetDetails(pset: unknown): LwkPsetDetailsLike;
}

export interface SwapPsetInspection {
  /** scriptPubkey hex of every output (readable for blinded and explicit alike). */
  outputScriptsHex: readonly string[];
  /**
   * The wallet's net per-asset balance delta keyed by asset id, or null when
   * inspection FAILED entirely (LWK API drift / blinded edge case). null is
   * fail-closed in the SDK (§5.1/G3) — never treated as "passed".
   */
  netBalances: ReadonlyMap<string, bigint> | null;
}

export interface SwapValidationExpectation {
  /** scriptPubkey hex of OUR receive address (from the pinned quote). */
  expectedScriptHex: string;
  /** Liquid asset id (hex) of the recv side. */
  recvAssetId: string;
  /** Quoted recv amount in base units. */
  recvAmountSats: bigint;
  /** Liquid asset id (hex) of the SENT (from) side — bounds the change-diversion guard. */
  fromAssetId: string;
  /** Quoted send amount in base units — the MOST of the from-asset we agreed to part with. */
  sendAmountSats: bigint;
}

/**
 * Read a foreign swap PSET into an inspection (port of psetHasOutputWithScript +
 * readPsetNetBalances, wallet.js:2132-2186). Every wasm handle is freed on the
 * way out. A failure to read the net balances yields netBalances=null (the
 * SDK's fail-closed signal), NOT a throw — so the caller decides.
 */
export function inspectSwapPset(pset: LwkPsetLike, wollet: LwkWolletLike): SwapPsetInspection {
  return {
    outputScriptsHex: readOutputScripts(pset),
    netBalances: readNetBalances(pset, wollet)
  };
}

/** scriptPubkey hex of every PSET output (port of psetHasOutputWithScript's iteration). */
function readOutputScripts(pset: LwkPsetLike): string[] {
  const hexes: string[] = [];
  let outputs: LwkPsetOutputLike[];
  try {
    outputs = pset.outputs();
  } catch {
    return hexes;
  }
  for (const o of outputs) {
    let script: LwkScriptLike | undefined;
    try {
      script = o.scriptPubkey();
      const hex = script?.toString?.() ?? "";
      if (hex) hexes.push(hex);
    } catch {
      /* skip unreadable output */
    } finally {
      try {
        script?.free?.();
      } catch {
        /* best effort */
      }
      try {
        o.free?.();
      } catch {
        /* best effort */
      }
    }
  }
  return hexes;
}

/**
 * The wallet's net per-asset balance delta (port of readPsetNetBalances). Returns
 * null on ANY read failure — the fail-closed signal (§5.1/G3), never treated as
 * "passed". lwk 0.18 returns a Map; older builds an array of pairs — both handled
 * (a wrong guard would leave this empty → the fail-closed check rejects EVERY
 * legitimate swap).
 */
function readNetBalances(pset: LwkPsetLike, wollet: LwkWolletLike): Map<string, bigint> | null {
  let details: LwkPsetDetailsLike | undefined;
  let balance: LwkBalanceLike | undefined;
  let balances: LwkBalancesLike | undefined;
  try {
    details = wollet.psetDetails(pset);
    balance = details.balance();
    balances = balance.balances();
    const raw = typeof balances?.entries === "function" ? balances.entries() : null;
    const pairs: Array<[unknown, unknown]> =
      raw instanceof Map ? [...raw.entries()] : Array.isArray(raw) ? (raw as Array<[unknown, unknown]>) : [];
    const out = new Map<string, bigint>();
    for (const e of pairs) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const k = String(e[0]);
      try {
        out.set(k, BigInt(e[1] as string | number | bigint));
      } catch {
        /* skip unparseable amount */
      }
    }
    return out;
  } catch {
    return null; // inspection failed — fail-closed signal (§5.1/G3)
  } finally {
    try {
      balances?.free?.();
    } catch {
      /* best effort */
    }
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
}

function validationFailed(message: string): ConversionError {
  return new ConversionError("SWAP_VALIDATION_FAILED", message);
}

/**
 * Fail-closed slack (base units) allowed on the SENT asset's net outflow ABOVE
 * the quoted sendAmount. Rationale: the dealer BUILDS the swap PSET and
 * `selectSwapUtxos` overshoots (largest-first, stopping at the first UTXO that
 * covers the send), so a hostile/compromised dealer could shrink or omit our
 * change output and make us part with up to a whole selected UTXO instead of
 * `sendAmount` — while paying us the exact quoted recv, so the recv-side ±1%
 * check stays blind (spec §5.1 only mandates the recv check; this is the §5.1/G3
 * hardening on the send side). We therefore cap the from-asset net outflow at
 * `sendAmountSats + this slack`. The slack only has to absorb the Liquid NETWORK
 * FEE, and only when the from-asset IS L-BTC (the fee is paid in L-BTC out of our
 * own inputs); for a non-BTC from-asset the fee is a separate L-BTC output, so
 * the from-asset net is exactly `sendAmountSats`. A confidential Liquid swap tx
 * is at most a few thousand discounted vB, and Liquid's floor is 0.1 sat/vB
 * (~a few hundred sats); 5_000 base units is a generous ceiling on that (it also
 * absorbs a dealer fee-bumping toward ~1 sat/vB) while collapsing the diversion
 * exposure from ~a whole UTXO down to ≤ 5_000 — the same "no human at the preview
 * screen" reasoning that drove the recv-side fail-closed (G3).
 */
const SEND_NET_FEE_SLACK_SATS = 5_000n;

/** Amount of `assetId` this PSET spends from the wallet (0 if it nets non-negative). */
function netSpentOf(netBalances: ReadonlyMap<string, bigint>, assetId: string): bigint {
  const net =
    netBalances.get(assetId) ?? netBalances.get(assetId.toLowerCase()) ?? netBalances.get(assetId.toUpperCase());
  return typeof net === "bigint" && net < 0n ? -net : 0n;
}

/**
 * Validate a swap PSET inspection against the pinned quote (port of
 * validateSwapPsetOutput, wallet.js:2343-2432, with the G3 fail-closed change).
 *
 * PRIMARY (hard): an output MUST pay `expectedScriptHex` (our receive address).
 * SECONDARY (FAIL-CLOSED): the recv-asset net balance must be present, positive
 * and within ±1% of `recvAmountSats`. A null inspection (read failed) or a
 * missing recv-asset key ABORTS here — the SDK has no human at a preview screen,
 * so the amount check is the only confirmation of value (§5.1/G3).
 */
export function assertSwapPsetPaysAndBalances(
  inspection: SwapPsetInspection,
  expect: SwapValidationExpectation
): void {
  if (!expect.expectedScriptHex) {
    throw validationFailed("expectedScriptHex (our receive address) is required for swap validation");
  }
  // PRIMARY SECURITY CHECK — the load-bearing protection. NEVER soften.
  if (!inspection.outputScriptsHex.includes(expect.expectedScriptHex)) {
    throw validationFailed("PSET does not pay the expected receive address — operation aborted.");
  }
  if (expect.recvAmountSats <= 0n) {
    throw validationFailed("quoted recvAmountSats must be positive");
  }
  if (expect.sendAmountSats <= 0n) {
    throw validationFailed("quoted sendAmountSats must be positive");
  }
  // SECONDARY SANITY CHECK — FAIL-CLOSED in the SDK (G3, diverges from frontend).
  if (inspection.netBalances === null) {
    throw validationFailed(
      "could not inspect swap PSET net balances — failing closed (no human preview in headless mode, §5.1/G3)."
    );
  }
  const net =
    inspection.netBalances.get(expect.recvAssetId) ??
    inspection.netBalances.get(expect.recvAssetId.toLowerCase()) ??
    inspection.netBalances.get(expect.recvAssetId.toUpperCase());
  if (typeof net !== "bigint") {
    throw validationFailed(
      "recv asset is not present in the PSET net balances — failing closed (§5.1/G3)."
    );
  }
  if (net <= 0n) {
    throw validationFailed(
      `PSET net balance for the recv asset is non-positive (got ${net}, expected ~${expect.recvAmountSats}).`
    );
  }
  const tolerance = expect.recvAmountSats / 100n; // 1%
  if (net < expect.recvAmountSats - tolerance || net > expect.recvAmountSats + tolerance) {
    throw validationFailed(
      `PSET amount diverges >1% from the quote (got ${net}, expected ${expect.recvAmountSats}).`
    );
  }
  // SEND-SIDE FAIL-CLOSED BOUND (§5.1/G3 hardening) — the recv checks above are
  // blind to our change output, so a hostile dealer could pay us the exact recv
  // while pocketing our overshoot change. Cap the from-asset outflow: what leaves
  // us must not exceed the quoted send amount plus a network-fee slack. A missing
  // from-asset key means zero from-outflow (cannot overpay) → passes.
  const sentFrom = netSpentOf(inspection.netBalances, expect.fromAssetId);
  if (sentFrom > expect.sendAmountSats + SEND_NET_FEE_SLACK_SATS) {
    throw validationFailed(
      `PSET spends ${sentFrom} of the sent asset, above the quoted ${expect.sendAmountSats} + ${SEND_NET_FEE_SLACK_SATS} fee slack — ` +
        "failing closed (§5.1/G3 change-diversion guard, no human at the preview screen)."
    );
  }
}

// ─── taker UTXO collection (port of getUtxos, wallet.js:2687-2719) ───────────

interface LwkUtxoLike {
  outpoint(): { txid(): { toString(): string }; vout(): number };
  unblinded(): {
    asset(): { toString(): string };
    assetBlindingFactor(): { toString(): string };
    value(): bigint | number;
    valueBlindingFactor(): { toString(): string };
  };
  height?(): number | undefined;
}
interface LwkWolletUtxos {
  utxos(): LwkUtxoLike[];
}

/**
 * Collect the wallet's spendable UTXOs with their blinding factors — SideSwap's
 * dealer flow needs these so the server can build a valid PSET with the taker's
 * inputs. Malformed entries are skipped. `.toString()` on the blinding factors
 * renders big-endian hex, exactly what SideSwap expects on the wire.
 */
export function collectSwapUtxos(wollet: LwkWolletUtxos): SideSwapUtxo[] {
  const result: SideSwapUtxo[] = [];
  let raw: LwkUtxoLike[];
  try {
    raw = wollet.utxos();
  } catch {
    return result;
  }
  for (const u of raw) {
    try {
      const op = u.outpoint();
      const unblinded = u.unblinded();
      let height: number | null = null;
      try {
        const h = u.height?.();
        if (typeof h === "number") height = h;
      } catch {
        /* lwk build without height() */
      }
      result.push({
        txid: op.txid().toString(),
        vout: op.vout(),
        asset: unblinded.asset().toString(),
        asset_bf: unblinded.assetBlindingFactor().toString(),
        value: Number(unblinded.value()),
        value_bf: unblinded.valueBlindingFactor().toString(),
        redeem_script: null, // P2WPKH — no redeem script
        height
      });
    } catch {
      /* skip malformed entry */
    }
  }
  return result;
}

/**
 * Greedy confirmed-UTXO selection for the from-asset (port of the swap-ui
 * candidate selection): only the from-asset, only confirmed (SideSwap rejects
 * unconfirmed with "unknown UTXO, wait for wallet sync"), largest-first, taking
 * just enough to cover the send amount (a whole-wallet request is large AND
 * fragile — one un-indexed UTXO aborts the quote).
 */
export function selectSwapUtxos(
  utxos: readonly SideSwapUtxo[],
  fromAssetId: string,
  sendAmountSats: bigint
): { selected: SideSwapUtxo[]; covered: bigint } {
  const candidates = utxos
    .filter((u) => u.asset === fromAssetId && u.height !== null && u.height !== undefined)
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  const selected: SideSwapUtxo[] = [];
  let covered = 0n;
  for (const u of candidates) {
    selected.push(u);
    covered += BigInt(u.value);
    if (covered >= sendAmountSats) break;
  }
  return { selected, covered };
}

// ─── public quote/execute API (§2.3, §5.1) ───────────────────────────────────

export interface SwapQuoteParams {
  from: AssetKey;
  to: AssetKey;
  /** Amount of `from` to send, in base units. */
  amountSats: bigint;
}

export interface SideSwapQuote {
  quoteId: number | string;
  from: AssetKey;
  to: AssetKey;
  /** What actually leaves the wallet (the dealer-quoted send side). */
  sendAmountSats: bigint;
  /** What we receive back (validated against the PSET on execute). */
  recvAmountSats: bigint;
  serverFeeSats: bigint;
  fixedFeeSats: bigint;
  feeAsset: string | null;
  ttlMs: number;
  /** now()+ttlMs at receipt — execute() refuses within QUOTE_MIN_REMAINING_MS of this. */
  expiresAt: number;
  /** OUR receive address (pinned at quote() time; the PSET must pay its script). */
  receiveAddress: string;
}

export interface SwapExecuteResult {
  txid: string;
  from: AssetKey;
  to: AssetKey;
  sendAmountSats: bigint;
  recvAmountSats: bigint;
  /** BRL cents accounted against the guardrail window (the SENT side, §4.3). */
  brlCents: number;
}

export interface NextQuoteOptions {
  timeoutMs?: number;
}

type ForeignPsetSigner = (
  psetB64: string,
  validate: (inspection: SwapPsetInspection) => void
) => Promise<string>;

/**
 * Links each issued quote back to the stream that produced it, so a caller can
 * `wallet.convert.sideswap.execute(quote)` without holding the stream (the
 * quote_id is bound to the stream's socket, so execute MUST run there). A
 * WeakMap so a garbage-collected quote never pins the stream.
 */
const quoteToStream = new WeakMap<SideSwapQuote, SwapQuoteStream>();

/** Resolve the stream that issued a quote (namespace-level execute). */
export function resolveQuoteStream(quote: SideSwapQuote): SwapQuoteStream | undefined {
  return quoteToStream.get(quote);
}

/** Real foreign-PSET signer (addDetails → validate → sign → finalize). */
export function makeForeignPsetSigner(hooks: ConvertWalletHooks): ForeignPsetSigner {
  return async (psetB64, validate) => {
    const wollet = await hooks.ensureWollet();
    let pset: InstanceType<typeof Pset>;
    try {
      pset = new Pset(psetB64);
    } catch (err) {
      throw new ConversionError("SWAP_VALIDATION_FAILED", "SideSwap returned an unparseable PSET", {
        cause: err
      });
    }
    // lwk MOVES (consumes) a Pset into wasm on sign() and finalize() — verified in
    // lwk_wasm.js: both do `pset.__destroy_into_raw()`. So the source `pset` is
    // reclaimed by sign() and the intermediate `signed` by finalize(); freeing
    // either again would be a double-free (UB). Only the surviving `finalized`
    // leaks in the happy path, and the source `pset` leaks when we ABORT BEFORE
    // signing (e.g. a fail-closed validate) — those are the ones we free here.
    let psetTakenBySigner = false;
    let finalized: InstanceType<typeof Pset> | undefined;
    try {
      // Foreign PSET — populate derivation paths / witness scripts before the
      // signer touches it (idempotent on complete PSETs).
      try {
        pset.addDetails(wollet);
      } catch (err) {
        throw new ConversionError(
          "SWAP_VALIDATION_FAILED",
          "could not associate the swap PSET with the wallet for validation",
          { cause: err }
        );
      }
      const inspection = inspectSwapPset(pset as unknown as LwkPsetLike, wollet as unknown as LwkWolletLike);
      validate(inspection); // throws SWAP_VALIDATION_FAILED (fail-closed) — BEFORE signing
      psetTakenBySigner = true; // signWithEphemeralSigner → signer.sign() consumes `pset`
      const signed = await signWithEphemeralSigner(hooks, pset);
      finalized = wollet.finalize(signed); // consumes `signed`
      return finalized.toString();
    } finally {
      try {
        finalized?.free?.();
      } catch {
        /* best effort */
      }
      // Free the source PSET only if the signer never took ownership of it.
      if (!psetTakenBySigner) {
        try {
          pset.free?.();
        } catch {
          /* best effort */
        }
      }
    }
  };
}

interface SwapQuoteStreamDeps {
  hooks: ConvertWalletHooks;
  client: SideSwapClient;
  sub: SubscriptionHandle;
  from: AssetKey;
  to: AssetKey;
  requestedAmountSats: bigint;
  receiveAddress: string;
  expectedScriptHex: string;
  signForeignPset: ForeignPsetSigner;
  now: () => number;
}

/**
 * A live stream of SideSwap quotes for one (from, to, amount) request. Backed by
 * a persistent start_quotes subscription on a single socket — execute() MUST run
 * on that same socket (the quote_id is bound to it), so the stream owns the
 * client lifecycle and close() tears it down. Latest-quote-wins: next() resolves
 * with the freshest tick; transient blinding errors are ignored (§5.1).
 */
export class SwapQuoteStream {
  private readonly deps: SwapQuoteStreamDeps;
  /** Owns the pinned quotes so execute() can reject a foreign quote object. */
  private readonly issued = new Set<SideSwapQuote>();
  private latest: SideSwapQuote | null = null;
  private waiters: Array<{ resolve: (q: SideSwapQuote) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }> = [];
  private closed = false;

  constructor(deps: SwapQuoteStreamDeps) {
    this.deps = deps;
  }

  /** Called by the market layer when the client delivers a quote tick. */
  push(event: SideSwapQuoteEvent): void {
    if (this.closed) return;
    const quote: SideSwapQuote = {
      quoteId: event.quoteId,
      from: this.deps.from,
      to: this.deps.to,
      sendAmountSats: event.sendAmount,
      recvAmountSats: event.recvAmount,
      serverFeeSats: event.serverFee,
      fixedFeeSats: event.fixedFee,
      feeAsset: event.feeAsset,
      ttlMs: event.ttlMs,
      expiresAt: this.deps.now() + event.ttlMs,
      receiveAddress: this.deps.receiveAddress
    };
    this.issued.add(quote);
    quoteToStream.set(quote, this);
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(quote);
    } else {
      this.latest = quote;
    }
  }

  /** Called by the market layer on a (non-transient) stream error. */
  fail(err: unknown): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    // Not sticky: a later tick may still succeed (dealer refills, reconnect).
  }

  /** Await the next fresh quote (or reject on error/timeout/close). */
  next(options: NextQuoteOptions = {}): Promise<SideSwapQuote> {
    if (this.closed) {
      return Promise.reject(new SideSwapError(SS_ERROR.CONNECTION_LOST, "swap quote stream is closed"));
    }
    if (this.latest) {
      const q = this.latest;
      this.latest = null;
      return Promise.resolve(q);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_QUOTE_WAIT_MS;
    return new Promise<SideSwapQuote>((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new SideSwapError(SS_ERROR.TIMEOUT, `no SideSwap quote within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Async-iterate quotes until the stream is closed. */
  async *[Symbol.asyncIterator](): AsyncGenerator<SideSwapQuote> {
    while (!this.closed) {
      try {
        yield await this.next();
      } catch (err) {
        if (this.closed) return;
        throw err;
      }
    }
  }

  /**
   * Execute a quote (§5.1): the ONLY money-moving step. Guardrail on the SENT
   * side BEFORE signing → get_quote → sign+validate (fail-closed) → record →
   * taker_sign (SideSwap broadcasts). Serialized through the wallet op mutex so
   * the rolling-24h accountant stays correct across every signing caller (§4.3).
   */
  async execute(quote: SideSwapQuote): Promise<SwapExecuteResult> {
    this.deps.hooks.assertOpen();
    if (!this.issued.has(quote)) {
      throw new ConversionError(
        "SWAP_VALIDATION_FAILED",
        "this quote was not issued by this stream — re-request a quote and execute that object"
      );
    }
    if (this.deps.now() >= quote.expiresAt - QUOTE_MIN_REMAINING_MS) {
      throw new ConversionError("SWAP_QUOTE_EXPIRED", "the quote TTL has (nearly) lapsed — request a fresh quote");
    }

    const { hooks, client, from, signForeignPset, expectedScriptHex } = this.deps;
    const recvAssetId = ASSETS[quote.to].id;
    const fromAssetId = ASSETS[from].id;

    return hooks.runExclusive(async () => {
      // Guardrail on the SENT side in BRL (§4.3) — BEFORE anything signs. Market
      // swaps are EXEMPT from the allowlist (protocolBound: the validated PSET
      // pays our own address — funds return to the wallet) but DO count against
      // the value ceilings.
      const brlCents = await hooks.valuate(from, quote.sendAmountSats);
      await hooks.enforceGuardrails({
        kind: "sideswap-swap",
        brlCents,
        destinations: [
          {
            kind: "protocolBound",
            note: "sideswap market swap — PSET validated to pay our own receive address (§4.3)"
          }
        ]
      });

      const { pset } = await client.getQuote(quote.quoteId);
      const signedPset = await signForeignPset(pset, (inspection) =>
        assertSwapPsetPaysAndBalances(inspection, {
          expectedScriptHex,
          recvAssetId,
          recvAmountSats: quote.recvAmountSats,
          fromAssetId,
          sendAmountSats: quote.sendAmountSats
        })
      );

      // Account the SENT side at signing time (§4.5) — BEFORE taker_sign asks
      // SideSwap to broadcast (parity with send() recording before broadcast).
      await hooks.recordSpend(brlCents, "sideswap-swap");
      const { txid } = await client.takerSign({ quoteId: quote.quoteId, signedPset });
      return {
        txid,
        from: quote.from,
        to: quote.to,
        sendAmountSats: quote.sendAmountSats,
        recvAmountSats: quote.recvAmountSats,
        brlCents
      };
    });
  }

  /** Tear down the subscription and disconnect the socket. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new SideSwapError(SS_ERROR.CONNECTION_LOST, "swap quote stream closed"));
    }
    try {
      this.deps.sub.unsubscribe();
    } catch {
      /* best effort */
    }
    try {
      this.deps.client.disconnect();
    } catch {
      /* best effort */
    }
  }
}

export interface SideSwapMarketDeps {
  hooks: ConvertWalletHooks;
  /** Client factory (default: real WS). Tests inject a fake. */
  clientFactory?: (options: SideSwapClientOptions) => SideSwapClient;
  /** Foreign-PSET signer (default: real lwk). Tests inject a fake. */
  signForeignPset?: ForeignPsetSigner;
  now?: () => number;
}

/** Orchestrates the SideSwap market swap: quote() opens a stream, execute() moves funds. */
export class SideSwapMarket {
  private readonly hooks: ConvertWalletHooks;
  private readonly clientFactory: (options: SideSwapClientOptions) => SideSwapClient;
  private readonly signForeignPset: ForeignPsetSigner;
  private readonly now: () => number;

  constructor(deps: SideSwapMarketDeps) {
    this.hooks = deps.hooks;
    this.clientFactory = deps.clientFactory ?? createSideSwapClient;
    this.signForeignPset = deps.signForeignPset ?? makeForeignPsetSigner(deps.hooks);
    this.now = deps.now ?? deps.hooks.now;
  }

  /**
   * Open a live quote stream for (from → to, amountSats). Derives a FRESH
   * receive address (subject to the backup gate §2.9) and pins it: execute()
   * validates the PSET pays exactly this address. Selects confirmed from-asset
   * UTXOs, connects, and subscribes. The returned stream owns the socket —
   * call close() when done.
   */
  async quote(params: SwapQuoteParams): Promise<SwapQuoteStream> {
    this.hooks.assertOpen();
    const from = params.from;
    const dest = params.to;
    if (!ASSETS[from] || !ASSETS[dest]) {
      throw new WalletError("UNSUPPORTED_ASSET", `Unknown swap asset(s): ${String(from)} → ${String(dest)}`);
    }
    if (from === dest) {
      throw new WalletError("INVALID_AMOUNT", "swap from and to must differ");
    }
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "amountSats must be a positive bigint");
    }

    const wollet = await this.hooks.ensureWollet();
    // Select confirmed from-asset UTXOs FIRST, so a doomed quote does not burn
    // receive-address indices (they are derived only once funds are proven).
    const fromAssetId = ASSETS[from].id;
    const recvAssetId = ASSETS[dest].id;
    const allUtxos = collectSwapUtxos(wollet as unknown as LwkWolletUtxos);
    const { selected, covered } = selectSwapUtxos(allUtxos, fromAssetId, params.amountSats);
    if (selected.length === 0 || covered < params.amountSats) {
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        `not enough confirmed ${from} to swap ${params.amountSats} base units (have ${covered})`
      );
    }

    // Fresh receive + change addresses (backup-gated). getReceiveAddress() is
    // monotonic per call, so these are distinct indices of OUR descriptor. The
    // receive address is pinned so execute() can prove the PSET pays its script.
    const receiveAddress = await this.hooks.getReceiveAddress();
    const changeAddress = await this.hooks.getReceiveAddress();
    const expectedScriptHex = liquidScriptHex(receiveAddress);

    const client = this.clientFactory({});
    await client.connect();
    await this.waitForMarkets(client);

    // The subscription callbacks fire on later WS messages (after this
    // synchronous block), so a holder set right after construction is safe and
    // lets `stream` stay const.
    const holder: { stream: SwapQuoteStream | null } = { stream: null };
    const sub = client.startQuotes({
      sendAsset: fromAssetId,
      recvAsset: recvAssetId,
      sendAmountSats: Number(params.amountSats),
      utxos: selected,
      receiveAddress,
      changeAddress,
      onQuote: (event) => holder.stream?.push(event),
      onError: (err) => {
        // Transient dealer-side blinding failure — ignore; the next tick
        // re-rolls and the previous quote stays valid (§5.1).
        if (isTransientBlindingError(err)) return;
        holder.stream?.fail(this.mapStreamError(err));
      }
    });

    const stream = new SwapQuoteStream({
      hooks: this.hooks,
      client,
      sub,
      from,
      to: dest,
      requestedAmountSats: params.amountSats,
      receiveAddress,
      expectedScriptHex,
      signForeignPset: this.signForeignPset,
      now: this.now
    });
    holder.stream = stream;
    return stream;
  }

  private mapStreamError(err: SideSwapError): unknown {
    if (err?.code === SS_ERROR.LOW_BALANCE) {
      return new ConversionError("SWAP_LOW_BALANCE", err.message, { cause: err });
    }
    return err;
  }

  private async waitForMarkets(client: SideSwapClient): Promise<void> {
    if (client.hasMarkets()) return;
    const deadline = this.now() + MARKETS_READY_WAIT_MS;
    // Poll cheaply — the client caches markets after list_markets resolves.
    while (!client.hasMarkets() && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export { isTransientBlindingError, SS_ERROR } from "./sideswap-client.js";
export type { SideSwapClient, SideSwapUtxo } from "./sideswap-client.js";
