// Liquid engine — lwk_node (spec §2.1, SPIKE candidate B).
//
// lwk_node is the nodejs-target wasm-pack build of the SAME LWK crate the
// frontend embeds as lwk_wasm, published in lockstep (same versions). The
// module import IS the wasm init (synchronous, 1-2 ms, no flags, no loader).
//
// Bump governance (SPIKE risk 5 + memory `lwk_wasm DePix dependency`): only
// bump together with the frontend's lwk_wasm pin, and keep the golden +
// addDetails guardian tests green (test/engine.test.ts). `pset.addDetails` is
// NOT used by send/withdraw (TxBuilder.finish PSETs come complete) — it is
// load-bearing for the SideSwap/peg-out flows (PR4+), so the export check is
// mandatory on every bump.
//
// Package fallback (documented, not implemented): candidate A — lwk_wasm +
// a ~50-line fs.readFile loader, same dance as the frontend's lwk-loader.js —
// if the nodejs target ever stops being published.

import {
  Address,
  AssetId,
  EsploraClient,
  Mnemonic,
  Network,
  Pset,
  Signer,
  Transaction,
  TxBuilder,
  Update,
  Wollet,
  WolletDescriptor
} from "lwk_node";
import { WalletError } from "../errors.js";

// Re-export the classes the SDK uses so every other module goes through this
// wrapper (single import point = single place to swap in candidate A).
export { Address, AssetId, EsploraClient, Mnemonic, Network, Pset, Signer, Transaction, TxBuilder, Update, Wollet, WolletDescriptor };

// Namespace-style access for guardian checks (e.g. lwk.Pset.prototype.addDetails).
export const lwk = {
  Address,
  AssetId,
  EsploraClient,
  Mnemonic,
  Network,
  Pset,
  Signer,
  Transaction,
  TxBuilder,
  Update,
  Wollet,
  WolletDescriptor
};

let cachedMainnet: Network | null = null;

/** The SDK is mainnet-only in F3 (frontend parity — GT §1.2). */
export function mainnetNetwork(): Network {
  if (!cachedMainnet) cachedMainnet = Network.mainnet();
  return cachedMainnet;
}

/**
 * Frontend-parity mnemonic normalization (wallet.js:271-278): trim, collapse
 * any whitespace run into one space, lowercase. Non-strings become "".
 */
export function normalizeMnemonic(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Checksum validation is 100% inside LWK (`new Mnemonic(str)` throws).
 * Returns the normalized mnemonic string on success.
 */
export function validateMnemonic(raw: string): string {
  const normalized = normalizeMnemonic(raw);
  try {
    const m = new Mnemonic(normalized);
    m.free();
  } catch (err) {
    throw new WalletError("INVALID_MNEMONIC", "Invalid mnemonic (BIP39 checksum failed)", {
      cause: err
    });
  }
  return normalized;
}

/**
 * Derive the CT descriptor string (ct(slip77(...),elwpkh(...))) from a
 * mnemonic. The signer is freed before returning — callers that need to sign
 * materialize their own short-lived signer (per-op auth, spec §2.3).
 */
export function descriptorFromMnemonic(mnemonicStr: string): string {
  const normalized = validateMnemonic(mnemonicStr);
  const network = mainnetNetwork();
  const mnemonic = new Mnemonic(normalized);
  const signer = new Signer(mnemonic, network);
  try {
    return signer.wpkhSlip77Descriptor().toString();
  } finally {
    signer.free();
    mnemonic.free();
  }
}

/** Build a view-only (watch) Wollet from a CT descriptor string. */
export function buildWollet(descriptor: string): Wollet {
  return new Wollet(mainnetNetwork(), new WolletDescriptor(descriptor));
}

/** Generate a fresh 12-word mnemonic from LWK's internal RNG. */
export function generateMnemonic(): string {
  const m = Mnemonic.fromRandom(12);
  try {
    return m.toString();
  } finally {
    m.free();
  }
}
