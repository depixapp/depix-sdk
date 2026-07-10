// SideShift.ai — USDt cross-network conversion (spec §5.4). **CUSTODIAL, signalled**
// (decision G4). Port of depix-frontend/wallet/sideshift.js (GT §4.C).
//
// SideShift uses a DEPOSIT-ADDRESS model: you SEND USDt to an address they give you,
// and THEY pay out from their reserve on the target network. So — unlike every other
// conversion in this SDK — the funds LEAVE the non-custodial sphere the moment the
// send confirms (escrow states REVIEW/REFUND/…). That is why every result carries
// `custodial: true`, the tool description says so, and the README calls it out. G4
// decided this is DOCUMENTATION only: there is NO blocking acceptCustodial gate — the
// call works directly; the signal is informative.
//
// Two flows sign / touch guardrails differently:
//   SEND (fixed shift, USDt Liquid → target network): the on-chain output goes to
//     SideShift's Liquid deposit address (theirs, custodial), but the FINAL
//     destination the agent chose — the `settleAddress` on the target network — is
//     what the allowlist protects (§4.3), plus the `refundAddress` (→
//     sideshiftRefundAddresses). The USDt sent is valued in BRL and counts against
//     the value ceilings.
//   RECEIVE (variable shift, external network → USDt Liquid): funds land in OUR
//     backup-gated Liquid receive address. An INFLOW — no signing, no guardrail (like
//     a Boltz reverse swap / peg-in). Nothing leaves the wallet.
//
// The affiliate id is BAKED AT BUILD TIME (sideshift-affiliate.ts) — never read from
// the runtime env, never fetched from a backend.

import { ASSETS } from "../assets.js";
import type { FetchLike } from "../api/client.js";
import { Address, AssetId, Pset, TxBuilder, mainnetNetwork } from "../engine/lwk.js";
import { ConversionError, SideShiftApiError, WalletError } from "../errors.js";
import type { GuardrailDestination } from "../guardrails/allowlist.js";
import type { ConvertWalletHooks } from "./hooks.js";
import { signWithEphemeralSigner } from "./hooks.js";
import { SIDESHIFT_AFFILIATE_ID } from "./sideshift-affiliate.js";
import { SideShiftStore, type StoredSideShift } from "./sideshift-store.js";

export const SIDESHIFT_API_BASE = "https://sideshift.ai/api/v2";
export const SIDESHIFT_ORDER_URL = "https://sideshift.ai/orders/";

/** USDt has 8 decimals on Liquid (parity with ASSETS.USDT.decimals). */
const USDT_SATS_PER_UNIT = 10n ** BigInt(ASSETS.USDT.decimals);

// ── network whitelist (port of USDT_NETWORKS) ────────────────────────────────
//
// `liquid` is the no-shift fast path — a Liquid→Liquid USDt move is a plain
// wallet.send(), never a shift, so it is NOT offered by the SEND flow. The other
// five route THROUGH SideShift.

export interface UsdtNetwork {
  readonly id: string;
  readonly label: string;
  readonly requiresShift: boolean;
  readonly addressRegex?: RegExp;
}

export const USDT_NETWORKS: readonly UsdtNetwork[] = Object.freeze([
  Object.freeze({ id: "liquid", label: "Liquid Network", requiresShift: false }),
  Object.freeze({ id: "ethereum", label: "Ethereum (ERC20)", requiresShift: true, addressRegex: /^0x[a-fA-F0-9]{40}$/ }),
  Object.freeze({ id: "tron", label: "Tron (TRC20)", requiresShift: true, addressRegex: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ }),
  Object.freeze({ id: "bsc", label: "BNB Smart Chain (BEP20)", requiresShift: true, addressRegex: /^0x[a-fA-F0-9]{40}$/ }),
  Object.freeze({ id: "polygon", label: "Polygon (POS)", requiresShift: true, addressRegex: /^0x[a-fA-F0-9]{40}$/ }),
  Object.freeze({ id: "solana", label: "Solana (SPL)", requiresShift: true, addressRegex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ })
]);

export function getNetwork(id: string): UsdtNetwork | null {
  return USDT_NETWORKS.find((n) => n.id === id) ?? null;
}

// Polygon is catalogued under `usdt0` (Tether's LayerZero OFT upgrade, Aug 2025);
// the on-chain token is unchanged. Every other network — including Liquid — is
// `usdt`. Centralised so pair/quote/shift endpoints stay symmetric.
export function coinIdForNetwork(networkId: string): string {
  return networkId === "polygon" ? "usdt0" : "usdt";
}

/** Validate a settle address against the target network's format (pre-shift). */
export function validateNetworkAddress(networkId: string, address: string): boolean {
  const net = getNetwork(networkId);
  if (!net || !net.requiresShift || !net.addressRegex) return false;
  if (typeof address !== "string" || !address) return false;
  return net.addressRegex.test(address.trim());
}

/**
 * Map a SideShift settle address on `networkId` to its allowlist destination class
 * (§4.3). EVM networks → the case-INsensitive `evmAddress` class; Tron (base58,
 * case-SENSITIVE) → `tronAddress`; Solana has NO representable class, so it is
 * `unrepresentable` — fail-closed when the allowlist is ON, a no-op when OFF.
 */
export function settleDestinationForNetwork(networkId: string, address: string): GuardrailDestination {
  switch (networkId) {
    case "ethereum":
    case "bsc":
    case "polygon":
      return { kind: "evmAddress", address };
    case "tron":
      return { kind: "tronAddress", address };
    case "liquid":
      return { kind: "liquidAddress", address };
    case "solana":
      return { kind: "unrepresentable", class: "solanaAddress" };
    default:
      return { kind: "unrepresentable", class: networkId };
  }
}

// ── SideShift status taxonomy (port of SHIFT_STATUS) ─────────────────────────

export const SHIFT_STATUS = Object.freeze({
  WAITING: "waiting",
  PENDING: "pending",
  PROCESSING: "processing",
  REVIEW: "review",
  SETTLING: "settling",
  SETTLED: "settled",
  REFUND: "refund",
  REFUNDING: "refunding",
  REFUNDED: "refunded",
  EXPIRED: "expired"
} as const);

const PENDING_STATUSES = new Set<string>([
  SHIFT_STATUS.WAITING,
  SHIFT_STATUS.PENDING,
  SHIFT_STATUS.PROCESSING,
  SHIFT_STATUS.REVIEW,
  SHIFT_STATUS.SETTLING
]);
const TERMINAL_STATUSES = new Set<string>([SHIFT_STATUS.SETTLED, SHIFT_STATUS.REFUNDED, SHIFT_STATUS.EXPIRED]);
const REFUND_STATUSES = new Set<string>([SHIFT_STATUS.REFUND, SHIFT_STATUS.REFUNDING, SHIFT_STATUS.REFUNDED]);

export function isShiftPending(status: string): boolean {
  return PENDING_STATUSES.has(status);
}
export function isShiftTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
export function isShiftInRefund(status: string): boolean {
  return REFUND_STATUSES.has(status);
}

// ── amount conversion (USDt base units ↔ SideShift decimal strings) ──────────

/** USDt base units → the decimal string SideShift expects (trailing zeros trimmed). */
export function usdtSatsToDecimal(sats: bigint): string {
  const whole = sats / USDT_SATS_PER_UNIT;
  const frac = sats % USDT_SATS_PER_UNIT;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(ASSETS.USDT.decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * SideShift decimal USDt string → base units, or null when it cannot be represented
 * in 8 decimals without loss (> 8 fractional non-zero digits) or is malformed. A
 * null forces the SEND flow to fail-closed rather than sign a mismatched amount.
 */
export function usdtDecimalToSats(decimal: string): bigint | null {
  if (typeof decimal !== "string") return null;
  const s = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > ASSETS.USDT.decimals && /[1-9]/.test(frac.slice(ASSETS.USDT.decimals))) return null;
  const fracPadded = frac.slice(0, ASSETS.USDT.decimals).padEnd(ASSETS.USDT.decimals, "0");
  return BigInt(whole) * USDT_SATS_PER_UNIT + BigInt(fracPadded || "0");
}

// ── REST layer (pure, injectable fetch — the integration-test seam) ──────────

function nodeFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

/**
 * SideShift REST call. On a non-2xx it throws SideShiftApiError carrying the
 * upstream `{ error: { message } }` VERBATIM — untrusted DATA that mapToolError
 * (§6.2e) routes to data.untrusted_api_message, never into a tool message.
 */
async function sideshiftFetch(
  path: string,
  init: { method: string; body?: unknown },
  fetchImpl?: FetchLike
): Promise<Record<string, unknown>> {
  const f = fetchImpl ?? nodeFetch();
  const url = `${SIDESHIFT_API_BASE}${path}`;
  const res = await f(url, {
    method: init.method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* tolerate an empty / non-JSON body */
  }
  if (!res.ok) {
    const errObj = body?.error;
    const message =
      (errObj && typeof errObj === "object" && typeof (errObj as { message?: unknown }).message === "string"
        ? (errObj as { message: string }).message
        : typeof errObj === "string"
          ? errObj
          : `SideShift HTTP ${res.status}`) || `SideShift HTTP ${res.status}`;
    throw new SideShiftApiError(message, { status: res.status, body });
  }
  return body;
}

export interface RequestQuoteArgs {
  depositNetwork: string;
  settleNetwork: string;
  /** USDt amount to deposit, as a decimal string (SideShift wire form). */
  depositAmount: string;
  affiliateId: string;
}

/** POST /v2/quotes — a fixed-rate quote (expires in ~15 min). */
export function requestQuote(args: RequestQuoteArgs, fetchImpl?: FetchLike): Promise<Record<string, unknown>> {
  return sideshiftFetch(
    "/quotes",
    {
      method: "POST",
      body: {
        depositCoin: coinIdForNetwork(args.depositNetwork),
        settleCoin: coinIdForNetwork(args.settleNetwork),
        depositNetwork: args.depositNetwork,
        settleNetwork: args.settleNetwork,
        depositAmount: args.depositAmount,
        affiliateId: args.affiliateId
      }
    },
    fetchImpl
  );
}

export interface CreateFixedShiftArgs {
  quoteId: string;
  settleAddress: string;
  refundAddress?: string;
  affiliateId: string;
}

/** POST /v2/shifts/fixed — the SEND flow. Returns SideShift's Liquid deposit address. */
export function createFixedShift(args: CreateFixedShiftArgs, fetchImpl?: FetchLike): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    quoteId: args.quoteId,
    settleAddress: args.settleAddress,
    affiliateId: args.affiliateId
  };
  if (args.refundAddress) body.refundAddress = args.refundAddress;
  return sideshiftFetch("/shifts/fixed", { method: "POST", body }, fetchImpl);
}

export interface CreateVariableShiftArgs {
  depositNetwork: string;
  /** OUR Liquid CT address the swapped USDt lands in. */
  settleAddress: string;
  refundAddress?: string;
  affiliateId: string;
}

/** POST /v2/shifts/variable — the RECEIVE flow (settleNetwork hardcoded to liquid). */
export function createVariableShift(
  args: CreateVariableShiftArgs,
  fetchImpl?: FetchLike
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    depositCoin: coinIdForNetwork(args.depositNetwork),
    settleCoin: "usdt",
    depositNetwork: args.depositNetwork,
    settleNetwork: "liquid",
    settleAddress: args.settleAddress,
    affiliateId: args.affiliateId
  };
  if (args.refundAddress) body.refundAddress = args.refundAddress;
  return sideshiftFetch("/shifts/variable", { method: "POST", body }, fetchImpl);
}

/** GET /v2/shifts/{id} — the polling target. */
export function fetchShift(shiftId: string, fetchImpl?: FetchLike): Promise<Record<string, unknown>> {
  return sideshiftFetch(`/shifts/${encodeURIComponent(shiftId)}`, { method: "GET" }, fetchImpl);
}

/** POST /v2/shifts/{id}/set-refund-address — for a receive shift stuck in refund. */
export function setRefundAddressRequest(
  shiftId: string,
  address: string,
  fetchImpl?: FetchLike
): Promise<Record<string, unknown>> {
  return sideshiftFetch(
    `/shifts/${encodeURIComponent(shiftId)}/set-refund-address`,
    { method: "POST", body: { address } },
    fetchImpl
  );
}

// ── small parse helpers (SideShift responses are external — read defensively) ─
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// ── public results ───────────────────────────────────────────────────────────

export interface SideShiftQuote {
  quoteId: string;
  depositNetwork: string;
  settleNetwork: string;
  depositCoin: string;
  settleCoin: string;
  /** What the wallet will SEND (USDt base units). */
  depositAmountSats: bigint;
  /** What lands on the target network (decimal string), when quoted. */
  settleAmount: string | null;
  rate: string | null;
  expiresAt: number | null;
  /** SideShift is CUSTODIAL — funds leave the non-custodial sphere on send (G4). */
  custodial: true;
}

export interface SideShiftSendResult {
  shiftId: string;
  network: string;
  /** SideShift's Liquid deposit address — CUSTODIAL (the on-chain output pays them). */
  depositAddress: string;
  /** The FINAL destination on `network` the agent chose (allowlist-gated, §4.3). */
  settleAddress: string;
  refundAddress: string | null;
  /** USDt sent from the wallet (base units). */
  depositAmountSats: bigint;
  settleAmount: string | null;
  status: string;
  /** The Liquid txid of OUR USDt send. */
  txid: string;
  /** BRL cents counted against the guardrail window (§4.3). */
  brlCents: number;
  custodial: true;
}

export interface SideShiftReceiveResult {
  shiftId: string;
  /** The source network the external sender pays USDt on. */
  network: string;
  /** Where the sender sends USDt (on `network`). */
  depositAddress: string;
  /** OUR Liquid receive address the swapped USDt lands in. */
  settleAddress: string;
  min: string | null;
  max: string | null;
  expiresAt: number | null;
  custodial: true;
}

export interface SideShiftStatusResult {
  shiftId: string;
  status: string;
  pending: boolean;
  terminal: boolean;
  inRefund: boolean;
  depositAmount: string | null;
  settleAmount: string | null;
  custodial: true;
}

// ── namespace ─────────────────────────────────────────────────────────────────

/** SEND signing seam — signs a USDt send, records the spend, broadcasts. */
export type SendUsdt = (params: {
  depositAddress: string;
  amountSats: bigint;
  brlCents: number;
}) => Promise<{ txid: string }>;

export interface SideShiftNamespaceDeps {
  hooks: ConvertWalletHooks;
  store: SideShiftStore;
  /** Injected fetch (default: Node global). */
  fetchImpl?: FetchLike;
  /** The baked affiliate id (default: SIDESHIFT_AFFILIATE_ID). Tests inject "" / a value. */
  affiliateId?: string;
  /** SEND signing seam (default: the real lwk USDt send). Tests inject a fake txid. */
  sendUsdt?: SendUsdt;
  now?: () => number;
}

/**
 * `wallet.convert.sideshift.*` (§5.4) — USDt cross-network via SideShift.
 * **CUSTODIAL, signalled** (G4): every result carries `custodial: true`. The SEND
 * flow moves money (guardrail + allowlist); RECEIVE is an inflow (no guardrail).
 */
export class SideShiftNamespace {
  private readonly hooks: ConvertWalletHooks;
  private readonly store: SideShiftStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly affiliateId: string;
  private readonly sendUsdt: SendUsdt;
  private readonly now: () => number;

  constructor(deps: SideShiftNamespaceDeps) {
    this.hooks = deps.hooks;
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl;
    this.affiliateId = deps.affiliateId ?? SIDESHIFT_AFFILIATE_ID;
    this.sendUsdt = deps.sendUsdt ?? defaultSendUsdt(deps.hooks);
    this.now = deps.now ?? deps.hooks.now;
  }

  /**
   * The DePix affiliate id, baked into the build (§5.4). Throws AFFILIATE_ID_MISSING
   * when it is empty (SIDESHIFT_AFFILIATE_ID unset at publish time) — mirrors the
   * frontend's "SideShift is not configured" throw.
   */
  private requireAffiliateId(): string {
    if (!this.affiliateId) {
      throw new ConversionError(
        "AFFILIATE_ID_MISSING",
        "SideShift is not configured: the DePix affiliate id was not baked into this build " +
          "(SIDESHIFT_AFFILIATE_ID unset at publish time). SideShift conversions are unavailable."
      );
    }
    return this.affiliateId;
  }

  private assertShiftable(network: string): UsdtNetwork {
    const net = getNetwork(network);
    if (!net) {
      throw new WalletError("UNSUPPORTED_ASSET", `Unknown USDt network: ${String(network)}`);
    }
    if (!net.requiresShift) {
      throw new WalletError(
        "UNSUPPORTED_ASSET",
        `${net.label} needs no SideShift — a Liquid↔Liquid USDt move is a plain wallet.send().`
      );
    }
    return net;
  }

  /**
   * Preview a fixed-rate SEND quote (§5.4) — read-only, moves no money. CUSTODIAL:
   * the result carries `custodial: true` because the follow-up send() leaves the
   * non-custodial sphere (G4).
   */
  async quote(params: { network: string; amountSats: bigint }): Promise<SideShiftQuote> {
    this.hooks.assertOpen();
    this.assertShiftable(params.network);
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "amountSats must be a positive bigint (USDt base units)");
    }
    const affiliateId = this.requireAffiliateId();
    const { raw, quoteId } = await this.requestQuoteWithId(params.network, params.amountSats, affiliateId);
    return {
      quoteId,
      depositNetwork: "liquid",
      settleNetwork: params.network,
      depositCoin: coinIdForNetwork("liquid"),
      settleCoin: coinIdForNetwork(params.network),
      depositAmountSats: params.amountSats,
      settleAmount: str(raw.settleAmount),
      rate: str(raw.rate),
      expiresAt: numOrNull(raw.expiresAt),
      custodial: true
    };
  }

  /**
   * SEND USDt from Liquid to `network` via a fixed shift (§5.4). **CUSTODIAL** — the
   * on-chain output pays SideShift's deposit address; they pay out on the target
   * network. MOVES MONEY: the USDt sent passes through the guardrail choke point
   * BEFORE signing, valuing it in BRL and (with the allowlist ON) requiring BOTH the
   * `settleAddress` (mapped to its network class) AND the `refundAddress` (→
   * sideshiftRefundAddresses) to be opted in (§4.3). Everything runs under the
   * wallet op mutex.
   */
  async send(params: {
    network: string;
    amountSats: bigint;
    settleAddress: string;
    refundAddress?: string;
  }): Promise<SideShiftSendResult> {
    this.hooks.assertOpen();
    this.assertShiftable(params.network);
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "amountSats must be a positive bigint (USDt base units)");
    }
    if (!validateNetworkAddress(params.network, params.settleAddress)) {
      throw new WalletError(
        "INVALID_ADDRESS",
        `settleAddress is not a valid ${params.network} address for SideShift`
      );
    }
    const affiliateId = this.requireAffiliateId();
    const refundAddress = params.refundAddress ? params.refundAddress.trim() : undefined;

    return this.hooks.runExclusive(async () => {
      // Choke point BEFORE any shift is created or signed (§4.3). Value the USDt sent
      // in BRL (fails CLOSED with QUOTES_UNAVAILABLE, §4.4). Destinations: the FINAL
      // settle address on the target network, plus the refund address — a
      // protocol-bound deposit address does NOT exempt the agent-chosen destinations.
      const brlCents = await this.hooks.valuate("USDT", params.amountSats);
      const destinations: GuardrailDestination[] = [
        settleDestinationForNetwork(params.network, params.settleAddress)
      ];
      if (refundAddress) destinations.push({ kind: "sideshiftRefundAddress", address: refundAddress });
      await this.hooks.enforceGuardrails({ kind: "sideshift-send", brlCents, destinations });

      // Create the fixed shift (custodial deposit address + fixed deposit amount).
      // A fixed shift consumes a fresh quote, so send() quotes internally — the
      // public quote() is a separate, informational preview.
      const quoteId = await this.freshQuoteId(params.network, params.amountSats, affiliateId);
      const raw = await createFixedShift(
        {
          quoteId,
          settleAddress: params.settleAddress,
          ...(refundAddress ? { refundAddress } : {}),
          affiliateId
        },
        this.fetchImpl
      );
      const shiftId = str(raw.id);
      const depositAddress = str(raw.depositAddress);
      const depositAmount = str(raw.depositAmount);
      if (!shiftId || !depositAddress || !depositAmount) {
        throw new SideShiftApiError("SideShift shift response is missing id / depositAddress / depositAmount.", {
          status: 200,
          body: raw
        });
      }
      // Not-inflated guard: SideShift must never ask for MORE than the caller agreed
      // to (a hostile/buggy response). A smaller amount (rounding down) is safe; the
      // guardrail counted the larger requested amount, so it never under-counts.
      const depositAmountSats = usdtDecimalToSats(depositAmount);
      if (depositAmountSats === null || depositAmountSats <= 0n || depositAmountSats > params.amountSats) {
        throw new ConversionError(
          "SIDESHIFT_AMOUNT_MISMATCH",
          `SideShift asked to deposit ${depositAmount} USDt, which does not match the quoted ${usdtSatsToDecimal(
            params.amountSats
          )} — refusing to sign.`
        );
      }

      // Sign + broadcast the USDt send to the deposit address (records the spend
      // BEFORE broadcast, §4.5). The deposit address is a Liquid CT address.
      const { txid } = await this.sendUsdt({ depositAddress, amountSats: depositAmountSats, brlCents });

      const status = str(raw.status) ?? SHIFT_STATUS.WAITING;
      const settleAmount = str(raw.settleAmount);
      const nowTs = this.now();
      const record: StoredSideShift = {
        id: shiftId,
        type: "send",
        asset: "USDT",
        network: params.network,
        depositAddress,
        settleAddress: params.settleAddress,
        refundAddress: refundAddress ?? null,
        status,
        depositAmount,
        settleAmount,
        liquidTxid: txid,
        expiresAt: numOrNull(raw.expiresAt),
        createdAt: nowTs,
        updatedAt: nowTs
      };
      await this.store.save(record).catch(() => {});

      return {
        shiftId,
        network: params.network,
        depositAddress,
        settleAddress: params.settleAddress,
        refundAddress: refundAddress ?? null,
        depositAmountSats,
        settleAmount,
        status,
        txid,
        brlCents,
        custodial: true
      };
    });
  }

  /**
   * Request a fresh SideShift quote and extract its id, failing CLOSED if the id is
   * missing. Single source of truth for the quote request shape + id-extraction +
   * missing-id throw: quote() reuses `raw` to build its preview, send()/freshQuoteId
   * consume only the `quoteId` (a fixed shift burns one quote), so the two can never
   * drift.
   */
  private async requestQuoteWithId(
    network: string,
    amountSats: bigint,
    affiliateId: string
  ): Promise<{ raw: Record<string, unknown>; quoteId: string }> {
    const raw = await requestQuote(
      { depositNetwork: "liquid", settleNetwork: network, depositAmount: usdtSatsToDecimal(amountSats), affiliateId },
      this.fetchImpl
    );
    const quoteId = str(raw.id);
    if (!quoteId) {
      throw new SideShiftApiError("SideShift quote response is missing the quote id.", { status: 200, body: raw });
    }
    return { raw, quoteId };
  }

  /** A fresh quote id for the fixed shift (a fixed shift consumes a quote). */
  private async freshQuoteId(network: string, amountSats: bigint, affiliateId: string): Promise<string> {
    const { quoteId } = await this.requestQuoteWithId(network, amountSats, affiliateId);
    return quoteId;
  }

  /**
   * RECEIVE USDt into the wallet from `network` via a variable shift (§5.4). The
   * external sender pays USDt on `network`; SideShift settles USDt to OUR Liquid
   * receive address. An INFLOW — no guardrail, no signing (nothing leaves the
   * wallet). Still CUSTODIAL end-to-end (SideShift holds the funds mid-flight), so
   * the result is marked. The settle address is a FRESH backup-gated receive address.
   */
  async receive(params: { network: string; refundAddress?: string }): Promise<SideShiftReceiveResult> {
    this.hooks.assertOpen();
    this.assertShiftable(params.network);
    const affiliateId = this.requireAffiliateId();
    const settleAddress = await this.hooks.getReceiveAddress(); // backup-gated (§2.9)
    // A receive (variable) shift signs nothing and moves no wallet funds: settleAddress is OUR
    // backup-gated receive address, and refundAddress refunds the EXTERNAL depositor's inbound
    // coin (on the source network), not ours. So — unlike send() — it is deliberately NOT
    // allowlist-gated. Keep this asymmetry intentional. receive() is also not an MCP tool, so
    // this refundAddress is not agent/injection-reachable.
    const refundAddress = params.refundAddress ? params.refundAddress.trim() : undefined;
    const raw = await createVariableShift(
      { depositNetwork: params.network, settleAddress, ...(refundAddress ? { refundAddress } : {}), affiliateId },
      this.fetchImpl
    );
    const shiftId = str(raw.id);
    const depositAddress = str(raw.depositAddress);
    if (!shiftId || !depositAddress) {
      throw new SideShiftApiError("SideShift variable-shift response is missing id / depositAddress.", {
        status: 200,
        body: raw
      });
    }
    const nowTs = this.now();
    const record: StoredSideShift = {
      id: shiftId,
      type: "receive",
      asset: "USDT",
      network: params.network,
      depositAddress,
      settleAddress,
      refundAddress: refundAddress ?? null,
      status: str(raw.status) ?? SHIFT_STATUS.WAITING,
      settleAmount: null,
      liquidTxid: null,
      expiresAt: numOrNull(raw.expiresAt),
      createdAt: nowTs,
      updatedAt: nowTs
    };
    await this.store.save(record).catch(() => {});

    return {
      shiftId,
      network: params.network,
      depositAddress,
      settleAddress,
      min: str(raw.depositMin),
      max: str(raw.depositMax),
      expiresAt: numOrNull(raw.expiresAt),
      custodial: true
    };
  }

  /** Poll a shift's status (read-only) and fold it into the local log. */
  async getStatus(shiftId: string): Promise<SideShiftStatusResult> {
    this.hooks.assertOpen();
    const raw = await fetchShift(shiftId, this.fetchImpl);
    const status = str(raw.status) ?? SHIFT_STATUS.WAITING;
    const settleAmount = str(raw.settleAmount);
    await this.store.update(shiftId, { status, ...(settleAmount ? { settleAmount } : {}) }).catch(() => {});
    return {
      shiftId,
      status,
      pending: isShiftPending(status),
      terminal: isShiftTerminal(status),
      inRefund: isShiftInRefund(status),
      depositAmount: str(raw.depositAmount),
      settleAmount,
      custodial: true
    };
  }

  /**
   * Set the refund address of a stuck receive shift (§5.4). A pure API passthrough:
   * SideShift performs the refund from its own reserve, so NOTHING is signed from
   * this wallet — there is no signing choke point to attach a guardrail to.
   */
  async setRefundAddress(shiftId: string, address: string): Promise<{ shiftId: string; refundAddress: string }> {
    this.hooks.assertOpen();
    const addr = typeof address === "string" ? address.trim() : "";
    if (!addr) throw new WalletError("INVALID_ADDRESS", "refund address is required");
    await setRefundAddressRequest(shiftId, addr, this.fetchImpl);
    await this.store.update(shiftId, { refundAddress: addr }).catch(() => {});
    return { shiftId, refundAddress: addr };
  }

  /** Every tracked shift, newest first (local log — no network). */
  listShifts(): Promise<StoredSideShift[]> {
    return this.store.list();
  }
}

/**
 * The real SEND signing seam: build a USDt send to the SideShift deposit address,
 * sign it with an ephemeral signer (per-op auth §2.3), record the spend at signing
 * time (§4.5), then broadcast. Mirrors send()'s USDt branch + peg-out's
 * build→sign→record→broadcast, reusing the wallet's proven seam.
 */
function defaultSendUsdt(hooks: ConvertWalletHooks): SendUsdt {
  return async ({ depositAddress, amountSats, brlCents }) => {
    const wollet = await hooks.ensureWollet();
    const network = mainnetNetwork();
    let addr: InstanceType<typeof Address>;
    try {
      addr = new Address(depositAddress);
    } catch (err) {
      throw new WalletError("INVALID_ADDRESS", `SideShift deposit address is not a valid Liquid address: ${depositAddress}`, {
        cause: err
      });
    }
    // lwk MOVES (consumes) its inputs on addRecipient()/finish()/sign()/finalize().
    // Only `addr` (borrowed), the surviving `finalized`, and — on a pre-sign abort —
    // `pset` actually leak; free those.
    let psetTakenBySigner = false;
    let pset: InstanceType<typeof Pset> | undefined;
    let finalized: InstanceType<typeof Pset> | undefined;
    try {
      let builder = new TxBuilder(network);
      try {
        builder = builder.addRecipient(addr, amountSats, new AssetId(ASSETS.USDT.id));
      } catch (err) {
        throw new WalletError("INVALID_ADDRESS", "Recipient rejected by the transaction builder", { cause: err });
      }
      try {
        pset = builder.finish(wollet);
      } catch (err) {
        const message = String((err as Error)?.message ?? err ?? "").toLowerCase();
        if (message.includes("insufficient") || message.includes("not enough")) {
          throw new WalletError("INSUFFICIENT_FUNDS", "not enough USDt for the SideShift send (amount + network fee)", {
            cause: err
          });
        }
        throw new WalletError("INVALID_AMOUNT", "SideShift send transaction build failed", { cause: err });
      }
      psetTakenBySigner = true; // signWithEphemeralSigner → signer.sign() consumes `pset`
      const signed = await signWithEphemeralSigner(hooks, pset);
      finalized = wollet.finalize(signed);
      // Account at SIGNING time, BEFORE broadcast (§4.5, parity with send()).
      await hooks.recordSpend(brlCents, "sideshift-send");
      const txid = await hooks.broadcast(finalized);
      return { txid };
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
  };
}
