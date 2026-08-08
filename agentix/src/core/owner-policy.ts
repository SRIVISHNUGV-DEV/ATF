import { ethers } from 'ethers';
import { runExecute, runQueryCamel, runSingleCamel, runSingle } from './database';
import { getEventBus } from '../../packages/core/eventbus';
import { logger } from './logger';

export interface OwnerPolicy {
  id: string;
  walletAddress: string;
  dailyLimit: string;
  perTxLimit: string;
  allowedTargets: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  sessionExpiry: number;
  autoCreateSessions: boolean;
  signedBy: string;
  signature: string;
  createdAt: number;
  expiresAt: number;
}

export interface PolicyCheck {
  allowed: boolean;
  reason?: string;
  category: 'within_policy' | 'exceeds_limit' | 'forbidden_target' | 'forbidden_action' | 'no_policy';
}

const DEFAULT_FORBIDDEN = [
  'changeOwner',
  'upgradeImplementation',
  'withdrawDeposit',
  'selfdestruct',
  'setAdmin',
];

export function initPolicySchema(): void {
  runExecute(`
    CREATE TABLE IF NOT EXISTS owner_policies (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      daily_limit TEXT NOT NULL DEFAULT '0.1',
      per_tx_limit TEXT NOT NULL DEFAULT '0.05',
      allowed_targets TEXT NOT NULL DEFAULT '[]',
      allowed_actions TEXT NOT NULL DEFAULT '["erc20.transfer","erc20.approve","wallet.execute"]',
      forbidden_actions TEXT NOT NULL DEFAULT '[]',
      session_expiry INTEGER NOT NULL DEFAULT 86400,
      auto_create_sessions INTEGER NOT NULL DEFAULT 1,
      signed_by TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Build the canonical message that the owner must sign to authorize a policy.
 * The signature covers all policy parameters to prevent tampering.
 */
function buildPolicyMessage(params: {
  walletAddress: string;
  dailyLimit: string;
  perTxLimit: string;
  allowedTargets: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  sessionExpiry: number;
}): string {
  return [
    'AgentIX Owner Policy',
    `wallet: ${params.walletAddress}`,
    `dailyLimit: ${params.dailyLimit}`,
    `perTxLimit: ${params.perTxLimit}`,
    `allowedTargets: ${[...params.allowedTargets].sort().join(',')}`,
    `allowedActions: ${[...params.allowedActions].sort().join(',')}`,
    `forbiddenActions: ${[...params.forbiddenActions].sort().join(',')}`,
    `sessionExpiry: ${params.sessionExpiry}`,
  ].join('\n');
}

export async function setOwnerPolicy(params: {
  walletAddress: string;
  dailyLimit: string;
  perTxLimit: string;
  allowedTargets: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  sessionExpiry: number;
  autoCreateSessions: boolean;
  signedBy: string;
  signature: string;
}): Promise<OwnerPolicy> {
  // ── Signature verification ───────────────────────────────────────
  // The policy MUST be signed by the wallet's registered owner. Without this
  // check, any caller could set arbitrary spending policies for any wallet.
  const walletRow = runSingle<{ owner_address: string }>(
    'SELECT owner_address FROM wallets WHERE wallet_address = ?',
    params.walletAddress
  );
  const expectedOwner = walletRow?.owner_address;
  if (!expectedOwner) {
    throw new Error(`Wallet ${params.walletAddress} not found in local database. Cannot set policy for unknown wallet.`);
  }

  if (!params.signature || params.signature === '0x') {
    throw new Error(
      'Policy signature required. The wallet owner must sign the policy parameters. ' +
      `Expected signer: ${expectedOwner}`
    );
  }

  // Verify the signature covers the policy content
  const message = buildPolicyMessage(params);
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, params.signature);
  } catch (e: any) {
    throw new Error(`Invalid policy signature: ${e.message}. The owner must sign the policy message with EIP-191.`);
  }

  if (recoveredAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(
      `Policy signature mismatch: signed by ${recoveredAddress}, but wallet owner is ${expectedOwner}. ` +
      'Only the wallet owner can set spending policies.'
    );
  }

  logger.info('owner-policy', `Signature verified for policy on wallet ${params.walletAddress} (signed by ${recoveredAddress})`);

  const id = `policy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);

  // Deactivate existing policy for this wallet
  runExecute(
    'DELETE FROM owner_policies WHERE wallet_address = ?',
    params.walletAddress
  );

  runExecute(
    `INSERT INTO owner_policies
     (id, wallet_address, daily_limit, per_tx_limit, allowed_targets, allowed_actions,
      forbidden_actions, session_expiry, auto_create_sessions, signed_by, signature, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    id,
    params.walletAddress,
    params.dailyLimit,
    params.perTxLimit,
    JSON.stringify(params.allowedTargets),
    JSON.stringify(params.allowedActions),
    JSON.stringify([...DEFAULT_FORBIDDEN, ...params.forbiddenActions]),
    params.sessionExpiry,
    params.autoCreateSessions ? 1 : 0,
    params.signedBy,
    params.signature,
    now
  );

  await getEventBus().emit({ type: "PolicyUpdated", data: { walletAddress: params.walletAddress, policyId: id } });

  return getOwnerPolicy(params.walletAddress)!;
}

export function getOwnerPolicy(walletAddress: string): OwnerPolicy | null {
  const row = runSingleCamel<any>(
    'SELECT * FROM owner_policies WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 1',
    walletAddress
  );
  if (!row) return null;

  return {
    id: row.id,
    walletAddress: row.walletAddress,
    dailyLimit: row.dailyLimit,
    perTxLimit: row.perTxLimit,
    allowedTargets: JSON.parse(row.allowedTargets || '[]'),
    allowedActions: JSON.parse(row.allowedActions || '[]'),
    forbiddenActions: JSON.parse(row.forbiddenActions || '[]'),
    sessionExpiry: row.sessionExpiry,
    autoCreateSessions: row.autoCreateSessions === 1,
    signedBy: row.signedBy,
    signature: row.signature,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function checkPolicy(walletAddress: string, action: string, params: Record<string, unknown>): PolicyCheck {
  const policy = getOwnerPolicy(walletAddress);

  if (!policy) {
    return { allowed: false, reason: 'No owner policy set. Owner must configure policy first.', category: 'no_policy' };
  }

  // Check forbidden actions
  if (policy.forbiddenActions.includes(action)) {
    return { allowed: false, reason: `Action "${action}" is forbidden by owner policy.`, category: 'forbidden_action' };
  }

  // Check allowed actions
  if (policy.allowedActions.length > 0 && !policy.allowedActions.includes(action)) {
    return { allowed: false, reason: `Action "${action}" is not in the allowed actions list.`, category: 'forbidden_action' };
  }

  // Check target allowlist
  const target = (params.target || params.recipient || params.delegatee || '') as string;
  if (target && policy.allowedTargets.length > 0) {
    const targetLower = target.toLowerCase();
    const allowed = policy.allowedTargets.some((t) => t.toLowerCase() === targetLower);
    if (!allowed) {
      return { allowed: false, reason: `Target "${target}" is not in the allowed targets list.`, category: 'forbidden_target' };
    }
  }

  // Check per-tx limit. Fail-closed on parse errors.
  const value = (params.value || '0') as string;
  try {
    const valueWei = BigInt(value);
    const perTxWei = BigInt(policy.perTxLimit);
    if (valueWei > perTxWei) {
      return {
        allowed: false,
        reason: `Value ${value} wei exceeds per-tx limit of ${policy.perTxLimit} wei.`,
        category: 'exceeds_limit',
      };
    }
  } catch (e: any) {
    logger.warn('owner-policy', `Per-tx limit check failed for value "${value}": ${e.message}`);
    return {
      allowed: false,
      reason: `Cannot parse transaction value "${value}": ${e.message}. Denying for safety.`,
      category: 'exceeds_limit',
    };
  }

  // Check daily limit. Uses the agent_actions table's metadata JSON to sum
  // previous transaction values. The COALESCE handles the case where no prior
  // actions exist today. Errors here are NOT silently swallowed — a failure to
  // check the daily limit must block the transaction (fail-closed).
  const todayStart = Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 86400);
  try {
    const row = runSingle<{ total_used: number | string | null }>(
      `SELECT COALESCE(SUM(COALESCE(CAST(json_extract(metadata, '$.value') AS INTEGER), 0)), 0) as total_used
       FROM agent_actions
       WHERE wallet_address = ? AND timestamp > ? AND success = 1`,
      walletAddress, todayStart
    );
    const usedWei = BigInt(row?.total_used || '0');
    const dailyWei = BigInt(policy.dailyLimit);
    const requestedWei = BigInt(value || '0');
    if (usedWei + requestedWei > dailyWei) {
      return {
        allowed: false,
        reason: `Daily limit exceeded. Used: ${usedWei}, Requested: ${requestedWei}, Limit: ${dailyWei}.`,
        category: 'exceeds_limit',
      };
    }
  } catch (e: any) {
    // Fail-closed: if we cannot verify the daily spend, deny the transaction.
    logger.warn('owner-policy', `Daily limit check failed for ${walletAddress}: ${e.message}`);
    return {
      allowed: false,
      reason: `Daily limit check failed: ${e.message}. Denying for safety.`,
      category: 'exceeds_limit',
    };
  }

  return { allowed: true, category: 'within_policy' };
}

export function deleteOwnerPolicy(walletAddress: string): void {
  runExecute('DELETE FROM owner_policies WHERE wallet_address = ?', walletAddress);
}
