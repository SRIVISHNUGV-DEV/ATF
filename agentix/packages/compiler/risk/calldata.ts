// ─────────────────────────────────────────────────────────────────────────────
// Calldata decoder — token-aware value extraction
//
// The risk engine's economic view used to see ONLY native (ETH) value, read from
// `params.value`. But an AgentWallet executes `execute(target, value, data)`, and
// the vast majority of real agent payments move ERC-20 tokens via `data` while
// `value` is 0. That meant a multi-million-dollar USDC transfer scored identically
// to a no-op (VALUE_NONE), and the real recipient (encoded in `data`) never reached
// the counterparty/compliance assessors — only the token *contract* did.
//
// This module decodes the inner call so the engine can reason about what a UserOp
// actually does: which token, to whom, how much, and whether it's an approval
// (especially an unlimited one — the single most-abused ERC-20 primitive in drains).
//
// Pure, dependency-light (only ethers for ABI decode), never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers';

/** 4-byte selectors for the ERC-20 methods that move or authorize value. */
const SELECTORS = {
  transfer: '0xa9059cbb',       // transfer(address,uint256)
  transferFrom: '0x23b872dd',   // transferFrom(address,address,uint256)
  approve: '0x095ea7b3',        // approve(address,uint256)
  increaseAllowance: '0x39509351', // increaseAllowance(address,uint256)
} as const;

/** The uint256 max — the canonical "unlimited approval" amount. */
const UINT256_MAX = (1n << 256n) - 1n;
/** Threshold above which an approval is treated as effectively unlimited. */
const NEAR_UNLIMITED = UINT256_MAX / 2n;

export type TokenOpKind = 'transfer' | 'transferFrom' | 'approve' | 'increaseAllowance';

export interface DecodedTokenOp {
  kind: TokenOpKind;
  /** The ERC-20 contract the call targets (the `target` of execute()). */
  token: string;
  /**
   * The economically-relevant counterparty:
   *  - transfer/transferFrom → the recipient (`to`)
   *  - approve/increaseAllowance → the spender being authorized
   */
  counterparty: string;
  /** For transferFrom, the address funds are pulled FROM. */
  from?: string;
  /** Raw token amount (base units). For transfers this is value moved; for approvals, the allowance. */
  amount: bigint;
  /** True when the approval amount is unlimited (== uint256 max) or effectively so. */
  isUnlimitedApproval: boolean;
  /** True for approve/increaseAllowance — authorizes future spending rather than moving value now. */
  isApproval: boolean;
}

export interface DecodedExecute {
  /** Native wei moved by execute()'s `value` argument. */
  nativeWei: bigint;
  /** The raw inner call target (the contract execute() calls). */
  target: string;
  /** Decoded ERC-20 op if the inner calldata matched a known token method, else null. */
  token: DecodedTokenOp | null;
}

const abi = ethers.AbiCoder.defaultAbiCoder();

function selectorOf(data: string): string {
  if (!data || data.length < 10) return '';
  return data.slice(0, 10).toLowerCase();
}

/**
 * Decode the inner calldata of an AgentWallet execute(target, value, data) into a
 * token op when it matches a known ERC-20 method. Returns null for unrecognized
 * calldata (native transfer, arbitrary contract call) — the caller keeps treating
 * those via the native-value path.
 */
export function decodeTokenCall(target: string, innerData: string | undefined): DecodedTokenOp | null {
  const data = (innerData || '0x').toLowerCase();
  const sel = selectorOf(data);
  if (!sel) return null;

  try {
    if (sel === SELECTORS.transfer) {
      const [to, amount] = abi.decode(['address', 'uint256'], '0x' + data.slice(10));
      return {
        kind: 'transfer',
        token: target.toLowerCase(),
        counterparty: String(to).toLowerCase(),
        amount: BigInt(amount),
        isUnlimitedApproval: false,
        isApproval: false,
      };
    }

    if (sel === SELECTORS.transferFrom) {
      const [from, to, amount] = abi.decode(['address', 'address', 'uint256'], '0x' + data.slice(10));
      return {
        kind: 'transferFrom',
        token: target.toLowerCase(),
        counterparty: String(to).toLowerCase(),
        from: String(from).toLowerCase(),
        amount: BigInt(amount),
        isUnlimitedApproval: false,
        isApproval: false,
      };
    }

    if (sel === SELECTORS.approve || sel === SELECTORS.increaseAllowance) {
      const [spender, amount] = abi.decode(['address', 'uint256'], '0x' + data.slice(10));
      const amt = BigInt(amount);
      return {
        kind: sel === SELECTORS.approve ? 'approve' : 'increaseAllowance',
        token: target.toLowerCase(),
        counterparty: String(spender).toLowerCase(),
        amount: amt,
        isUnlimitedApproval: amt >= NEAR_UNLIMITED,
        isApproval: true,
      };
    }
  } catch {
    // Malformed calldata for the selector — treat as unrecognized rather than throwing.
    return null;
  }

  return null;
}

/**
 * Decode a full execute(target, value, data) view. `nativeWei` is the native value;
 * `token` is the decoded ERC-20 op when the inner data matches a known method.
 */
export function decodeExecuteCall(params: {
  target: string;
  value: string | bigint | undefined;
  data?: string;
}): DecodedExecute {
  let nativeWei = 0n;
  try {
    nativeWei = typeof params.value === 'bigint' ? params.value : BigInt(params.value ?? '0');
  } catch {
    nativeWei = 0n;
  }
  return {
    nativeWei,
    target: (params.target || '').toLowerCase(),
    token: decodeTokenCall(params.target || '', params.data),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Known-token registry
//
// Maps well-known ERC-20 addresses to symbol + decimals so the engine can turn a
// raw base-unit amount into a human/USD notional. Stablecoins are priced at $1 for
// notional purposes (close enough for risk banding). Unknown tokens still get
// scored on counterparty/approval risk, just without a USD figure.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownToken {
  symbol: string;
  decimals: number;
  /** USD price per whole token. Stables ≈ 1. 0 = unknown/unpriced. */
  usd: number;
}

const KNOWN_TOKENS: Record<string, KnownToken> = {
  // Base Sepolia (chain 84532)
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6, usd: 1 },
  // Base mainnet USDC (in case config points at mainnet)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, usd: 1 },
  // Base mainnet DAI
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18, usd: 1 },
};

export function lookupToken(address: string): KnownToken | undefined {
  return KNOWN_TOKENS[(address || '').toLowerCase()];
}

/** For tests / dynamic registration. */
export function registerKnownToken(address: string, token: KnownToken): void {
  KNOWN_TOKENS[address.toLowerCase()] = token;
}

/**
 * Convert a raw base-unit token amount to a USD notional using the known-token
 * registry. Returns 0 when the token is unknown/unpriced (risk still scores it via
 * the counterparty + approval dimensions, just without a dollar figure).
 */
export function tokenNotionalUsd(address: string, amount: bigint): { usd: number; symbol?: string; decimals?: number } {
  const t = KNOWN_TOKENS[(address || '').toLowerCase()];
  if (!t || t.usd <= 0) return { usd: 0, symbol: t?.symbol, decimals: t?.decimals };
  // amount / 10^decimals * usd, done with a fractional split to avoid overflow/precision loss.
  const denom = 10n ** BigInt(t.decimals);
  const whole = amount / denom;
  const frac = amount % denom;
  const usd = Number(whole) * t.usd + (Number(frac) / Number(denom)) * t.usd;
  return { usd, symbol: t.symbol, decimals: t.decimals };
}

export { UINT256_MAX, NEAR_UNLIMITED };
