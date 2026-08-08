/**
 * 32-risk-token-aware.test.ts — proves the risk engine sees ERC-20 value.
 *
 * BEFORE this work the economic view read only native `value`. An execute() that
 * moved millions of USDC via inner calldata (value == 0) scored as VALUE_NONE / 0
 * — a token drain was invisible, and the token contract (not the real recipient)
 * was all the counterparty/compliance assessors ever saw. These tests pin the fix:
 *   1. A large known-token (USDC) transfer scores high and lands in a blocking band.
 *   2. An unlimited approval raises the dedicated VALUE_APPROVE_UNLIMITED signal.
 *   3. A transfer to a blocklisted recipient (decoded from calldata) forces DENY.
 *   4. An unknown/unpriced token transfer is no longer scored as a no-op.
 *   5. A plain native transfer still works (no regression).
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { RiskEngineCore } from "../packages/compiler/risk/engine";
import { registerKnownToken, decodeTokenCall } from "../packages/compiler/risk/calldata";
import { RiskEngineConfig } from "../packages/compiler/types/compilation";

// A deterministic known token so notional is stable without a price oracle.
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // Base Sepolia USDC (in registry)
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const BLOCKED = "0x9999999999999999999999999999999999999999";
const WALLET = "0x2222222222222222222222222222222222222222";

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);

function transferData(to: string, amount: bigint): string {
  return erc20.encodeFunctionData("transfer", [to, amount]);
}
function approveData(spender: string, amount: bigint): string {
  return erc20.encodeFunctionData("approve", [spender, amount]);
}

function cfg(over: Partial<RiskEngineConfig> = {}): RiskEngineConfig {
  return {
    approvalThreshold: 75,
    denyThreshold: 90,
    weights: {},
    behavioralEnabled: false, // no DB dependence in tests
    notionalEnabled: false,   // no ETH price network call
    trustedAddresses: [],
    blockedAddresses: [],
    ...over,
  };
}

function tokenIntent(target: string, data: string, value = "0") {
  return {
    intent: {
      action: "wallet_execute",
      normalizedAction: "wallet_execute",
      source: "bundler",
      requestedAt: Math.floor(Date.now() / 1000),
      agent: { walletAddress: WALLET },
      params: { walletAddress: WALLET, target, value, data, calldata: data },
      limits: {},
    } as any,
    capabilities: { canExecute: true, missingExplicit: [], mustDelegate: [] } as any,
  };
}

describe("risk engine — token-aware value", () => {
  it("decodeTokenCall extracts recipient + amount from ERC-20 transfer calldata", () => {
    const amount = 1_000_000n * 10n ** 6n; // 1,000,000 USDC
    const decoded = decodeTokenCall(USDC, transferData(RECIPIENT, amount));
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe("transfer");
    expect(decoded!.counterparty).toBe(RECIPIENT.toLowerCase());
    expect(decoded!.amount).toBe(amount);
  });

  it("a large USDC transfer (value==0) is scored high, not as a no-op", async () => {
    registerKnownToken(USDC, { symbol: "USDC", decimals: 6, usd: 1 });
    const amount = 1_000_000n * 10n ** 6n; // $1,000,000
    const r = await new RiskEngineCore(cfg()).assess(
      tokenIntent(USDC, transferData(RECIPIENT, amount))
    );
    // The value dimension must fire on the token transfer.
    const hasTokenSignal = r.signals.some((s: any) => s.code === "VALUE_TOKEN");
    expect(hasTokenSignal).toBe(true);
    expect(r.dimensionScores.value).toBeGreaterThan(75);
    expect(["REVIEW", "CHALLENGE", "DENY"]).toContain(r.decision);
  });

  it("an unlimited approval raises VALUE_APPROVE_UNLIMITED", async () => {
    const max = (1n << 256n) - 1n;
    const r = await new RiskEngineCore(cfg()).assess(
      tokenIntent(USDC, approveData(SPENDER, max))
    );
    const codes = r.signals.map((s: any) => s.code);
    expect(codes).toContain("VALUE_APPROVE_UNLIMITED");
    expect(r.dimensionScores.value).toBeGreaterThanOrEqual(75);
  });

  it("a transfer to a blocklisted recipient (from calldata) is forced to DENY", async () => {
    const amount = 100n * 10n ** 6n; // small $100 — decision must come from the blocklist, not value
    const r = await new RiskEngineCore(cfg({ blockedAddresses: [BLOCKED] })).assess(
      tokenIntent(USDC, transferData(BLOCKED, amount))
    );
    const codes = r.signals.map((s: any) => s.code);
    expect(codes).toContain("COMP_BLOCKED");
    expect(r.decision).toBe("DENY");
  });

  it("an unknown/unpriced token transfer is not scored as a no-op", async () => {
    const UNKNOWN = "0x4444444444444444444444444444444444444444";
    const r = await new RiskEngineCore(cfg()).assess(
      tokenIntent(UNKNOWN, transferData(RECIPIENT, 5000n * 10n ** 18n))
    );
    const codes = r.signals.map((s: any) => s.code);
    expect(codes).toContain("VALUE_TOKEN_UNPRICED");
    expect(codes).not.toContain("VALUE_NONE");
    expect(r.dimensionScores.value).toBeGreaterThan(25);
  });

  it("a plain native transfer still scores via the native path (no regression)", async () => {
    const r = await new RiskEngineCore(cfg()).assess({
      intent: {
        action: "wallet_execute",
        normalizedAction: "wallet_execute",
        source: "bundler",
        requestedAt: Math.floor(Date.now() / 1000),
        agent: { walletAddress: WALLET },
        params: { walletAddress: WALLET, target: RECIPIENT, value: (1000n * 10n ** 18n).toString() },
        limits: {},
      } as any,
      capabilities: { canExecute: true, missingExplicit: [], mustDelegate: [] } as any,
    });
    const codes = r.signals.map((s: any) => s.code);
    expect(codes.some((c: string) => c === "VALUE_ETH" || c === "VALUE_NOTIONAL")).toBe(true);
    expect(r.dimensionScores.value).toBeGreaterThan(50);
  });
});
