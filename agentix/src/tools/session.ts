import { ethers } from "ethers";
import { getContract, getReadonlyContract, getWalletContract } from "../contracts";
import { runExecute, runSingle } from "../core/database";
import { getSigner } from "../core/provider";
import { logger } from "../core/logger";

export interface SessionResult {
  success: boolean;
  sessionId?: string;
  sessionKey?: string;
  wallet?: string;
  expiry?: number;
  txHash?: string;
  error?: string;
  details?: any;
}

export async function createLightweightSession(
  walletAddress: string,
  sessionKey: string,
  dailySpendLimit: string,
  dailyTxLimit: number,
  expiry: number
): Promise<SessionResult> {
  try {
    const signer = getSigner();
    const wallet = getWalletContract(walletAddress);

    const sessionId = ethers.keccak256(
      ethers.solidityPacked(
        ["address", "address", "uint256"],
        [walletAddress, sessionKey, BigInt(Math.floor(Date.now() / 1000))]
      )
    );

    const ownerAddress = await wallet.owner();
    const message = ethers.solidityPacked(
      ["bytes32", "address", "uint256", "uint256", "uint64"],
      [sessionId, sessionKey, BigInt(dailySpendLimit), BigInt(dailyTxLimit), BigInt(expiry)]
    );
    const messageHash = ethers.keccak256(message);
    const ownerSig = await signer.signMessage(ethers.getBytes(messageHash));

    logger.info("session", `Creating lightweight session ${sessionId.slice(0, 20)}...`);

    const sessionMgr = getContract("SessionManager");
    const tx = await sessionMgr.createLightweightSession(
      sessionId,
      sessionKey,
      BigInt(dailySpendLimit),
      BigInt(dailyTxLimit),
      BigInt(expiry),
      [], // allowedTargets — empty means no target restriction
      ownerSig
    );
    const receipt = await tx.wait();

    runExecute(
      `INSERT OR REPLACE INTO sessions
       (session_id, wallet_address, session_key, session_type, daily_spend_limit, daily_tx_limit, expiry, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      sessionId,
      walletAddress,
      sessionKey,
      dailySpendLimit,
      dailyTxLimit,
      expiry,
      Math.floor(Date.now() / 1000)
    );

    logger.info("session", `Lightweight session created: ${sessionId}`);

    return {
      success: true,
      sessionId,
      sessionKey,
      wallet: walletAddress,
      expiry,
      txHash: receipt.hash,
    };
  } catch (e: any) {
    logger.error("session", `Failed to create session: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Read-only check of a lightweight session. SessionManager.validateLightweightSession is
 * state-changing and callable only by the session's bound AgentWallet, so it can't be called
 * directly by an off-chain tool. Simulate it with eth_call, spoofing msg.sender as the bound
 * wallet — this applies the contract's exact rules (revoked, expiry, signer, allowed target,
 * daily limits) without spending any of the session's allowance.
 */
export async function previewLightweightSessionValidation(
  sessionManager: ethers.Contract,
  sessionId: string,
  signer: string,
  valueWei: bigint | string,
  target: string = ethers.ZeroAddress
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const session = await sessionManager.getLightSession(sessionId);
    const boundWallet = session[0] as string;
    if (boundWallet === ethers.ZeroAddress) return { valid: false, reason: "Session not found" };
    const ok = await sessionManager.validateLightweightSession.staticCall(
      sessionId, signer, valueWei, target, { from: boundWallet }
    );
    return { valid: Boolean(ok) };
  } catch (e: any) {
    return { valid: false, reason: e.revert?.name || e.reason || e.shortMessage || e.message };
  }
}

export async function validateSession(
  sessionId: string,
  signerAddress: string,
  value: string,
  target?: string
): Promise<SessionResult> {
  try {
    const sessionMgr = getReadonlyContract("SessionManager");
    const check = await previewLightweightSessionValidation(
      sessionMgr,
      sessionId,
      signerAddress,
      ethers.parseEther(value || "0"),
      target || ethers.ZeroAddress
    );

    return {
      success: check.valid,
      sessionId,
      error: check.valid ? undefined : check.reason,
      details: { valid: check.valid, value, ...(check.reason ? { reason: check.reason } : {}) },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function revokeSession(
  sessionId: string,
  walletAddress: string
): Promise<SessionResult> {
  try {
    const sessionMgr = getContract("SessionManager");
    const tx = await sessionMgr.revokeLightweightSession(sessionId, walletAddress);
    const receipt = await tx.wait();

    runExecute("UPDATE sessions SET revoked = 1, revoked_at = ? WHERE session_id = ?", Math.floor(Date.now() / 1000), sessionId);

    logger.info("session", `Session revoked: ${sessionId}`);

    return {
      success: true,
      sessionId,
      txHash: receipt.hash,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function getSession(sessionId: string): Promise<SessionResult> {
  try {
    const sessionMgr = getReadonlyContract("SessionManager");
    const sessionType = await sessionMgr.getSessionType(sessionId);

    if (sessionType === 1) {
      const light = await sessionMgr.getLightSession(sessionId);
      return {
        success: true,
        sessionId,
        sessionKey: light.sessionKey,
        wallet: light.sessionWallet,
        expiry: Number(light.expiry),
        details: {
          type: "lightweight",
          dailySpendLimit: light.dailySpendLimit.toString(),
          dailyTxLimit: Number(light.dailyTxLimit),
          dailySpendUsed: light.dailySpendUsed.toString(),
          dailyTxUsed: Number(light.dailyTxUsed),
          revoked: light.revoked,
        },
      };
    }

    const session = await sessionMgr.sessions(sessionId);
    return {
      success: true,
      sessionId,
      sessionKey: session.sessionKey,
      wallet: session.wallet,
      expiry: Number(session.expiry),
      details: {
        type: "full",
        maxValue: session.maxValue.toString(),
        valueUsed: session.valueUsed.toString(),
        revoked: session.revoked,
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function listWalletSessions(walletAddress: string): Promise<SessionResult[]> {
  try {
    const sessionMgr = getReadonlyContract("SessionManager");
    const sessionIds = await sessionMgr.getWalletSessions(walletAddress);

    const results: SessionResult[] = [];
    for (const sid of sessionIds) {
      const result = await getSession(sid);
      results.push(result);
    }
    return results;
  } catch (e: any) {
    return [{ success: false, error: e.message }];
  }
}
