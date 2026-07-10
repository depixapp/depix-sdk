// Wallet capabilities the conversion flows (§5) depend on — a NARROW seam so
// wallet.ts stays additive (one `convert` field + this hooks object) while the
// PR4 SideSwap logic (and PR5 Boltz, wired the same way) lives entirely under
// src/convert/. Everything here already exists on DepixWallet; the hooks object
// just forwards to it.
//
// Why a seam and not free functions: the choke point (§4.3), the BRL valuator
// (§4.4), the per-instance op mutex (§4.3 TOCTOU) and the encrypted seed all
// live on the wallet instance. A conversion MUST route enforce→sign→record
// through the SAME opMutex as send()/withdraw() so the rolling-24h accountant
// stays correct across every signing caller (guardrails.ts caller contract).

import type { Wollet } from "lwk_node";
import type { AssetKey } from "../assets.js";
import type { GuardrailIntent } from "../guardrails/guardrails.js";
import type { Logger } from "../logger.js";
import { Mnemonic, Signer, mainnetNetwork } from "../engine/lwk.js";
import type { Pset } from "../engine/lwk.js";

export interface ConvertWalletHooks {
  readonly dataDir: string;
  readonly logger: Logger;
  /** The synced view-only Wollet (replays the persisted Update chain). */
  ensureWollet(): Promise<Wollet>;
  /**
   * A FRESH receive address of this wallet (§3.1) — subject to the backup gate
   * (§2.9): throws BACKUP_REQUIRED until a backup is confirmed. Used as the
   * swap recv address (funds return to us) and the peg-in recv address.
   */
  getReceiveAddress(): Promise<string>;
  /**
   * The decrypted mnemonic, materialized per signing op and dropped by the
   * caller immediately (§2.3). Never logged, never retained.
   */
  decryptMnemonic(): Promise<string>;
  /** BRL-cent valuation of an asset amount; fails CLOSED (QUOTES_UNAVAILABLE) for non-DePix (§4.4). */
  valuate(asset: AssetKey, amountSats: bigint): Promise<number>;
  /** The guardrail choke point (§4.3) — called BEFORE anything signs. */
  enforceGuardrails(intent: GuardrailIntent): Promise<void>;
  /** Account a signed op into the rolling-24h window (§4.5), at signing time. */
  recordSpend(brlCents: number, kind: string): Promise<void>;
  /** The per-instance op mutex — serializes enforce→sign→record with send()/withdraw(). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Broadcast a finalized PSET through the provider chain (§2.6). */
  broadcast(finalized: Pset): Promise<string>;
  /** Throws WALLET_NOT_FOUND if the wallet was closed. */
  assertOpen(): void;
  now(): number;
}

/**
 * Sign a PSET with an ephemeral signer materialized for THIS operation only and
 * zeroed in finally (per-op auth §2.3, parity with wallet.js:2601-2607). JS
 * strings are immutable, so the best available "zeroing" for the decrypted
 * mnemonic is freeing the wasm objects and dropping references on scope exit.
 * The PSET must already have its details populated (addDetails for foreign
 * PSETs, or built internally).
 */
export async function signWithEphemeralSigner(
  hooks: ConvertWalletHooks,
  pset: InstanceType<typeof Pset>
): Promise<InstanceType<typeof Pset>> {
  const network = mainnetNetwork();
  let mnemonic: InstanceType<typeof Mnemonic> | null = null;
  let signer: InstanceType<typeof Signer> | null = null;
  try {
    mnemonic = new Mnemonic(await hooks.decryptMnemonic());
    signer = new Signer(mnemonic, network);
    return signer.sign(pset);
  } finally {
    try {
      signer?.free();
      mnemonic?.free();
    } catch {
      // best effort
    }
  }
}
