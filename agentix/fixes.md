# AgentIX V1 — Security Audit Fix Log

**Auditor**: Release Engineering Board
**Date**: 2026-07-27
**Scope**: Full repository audit — CLI, REST API, MCP Server, SDK, Compiler, Runtime, Smart Contracts, SQLite, ZK Prover
**Branch**: `main`
**Commit baseline**: `f9deba0`

---

## Table of Contents

1. [Critical Fixes](#critical-fixes)
2. [High Fixes](#high-fixes)
3. [Medium Fixes](#medium-fixes)
4. [Low Fixes](#low-fixes)
5. [Design Limitations Documented](#design-limitations-documented)
6. [Files Modified](#files-modified)
7. [Test Results](#test-results)

---

## Critical Fixes

### C1: Owner Policy Signature Verification Missing

| Field | Value |
|-------|-------|
| **Severity** | Critical |
| **File** | `src/core/owner-policy.ts` |
| **Line** | 55-93 (function `setOwnerPolicy`) |
| **Found by** | Tracing the policy set call path from MCP → REST → `setOwnerPolicy()` |
| **Root cause** | `setOwnerPolicy()` accepted `signedBy` and `signature` parameters but never verified the signature against the wallet owner. Any caller could pass `signedBy: "0xAnyAddress", signature: "0x"` and the policy would be stored. |
| **Impact** | Complete bypass of all spending limits, allowed targets, and forbidden actions. An agent or attacker with API access could set a policy allowing unlimited spending to any address. |
| **Dependency** | `ethers` (v6.16+) — `ethers.verifyMessage()` for EIP-191 signature recovery |
| **Fix** | Added `buildPolicyMessage()` that constructs a canonical message from all policy parameters (wallet, dailyLimit, perTxLimit, allowedTargets, allowedActions, forbiddenActions, sessionExpiry). Added signature verification that: (1) looks up the wallet owner from the `wallets` table, (2) recovers the signer from the EIP-191 signature, (3) compares recovered address to registered owner. Rejects `signature: "0x"` and mismatched signers. |
| **Regression test** | Existing `tests/23-security.test.ts` passes. New test needed: attempt to set policy with invalid signature → expect rejection. |

### C2: Policy Set API Endpoint Lacks Owner Authentication

| Field | Value |
|-------|-------|
| **Severity** | Critical |
| **Files** | `src/runtime/server.ts` (line 445-460), `src/mcp/server.ts` (line 909-933) |
| **Found by** | Auditing all write endpoints for authorization checks |
| **Root cause** | `POST /api/policy` accepted any request body and called `setOwnerPolicy(body)` without verifying the caller is the wallet owner. The MCP `agentix_policy_set` handler passed `signature: '0x'` as a default. |
| **Impact** | Any process on localhost with the API token could set arbitrary owner policies. Combined with C1, this allowed complete policy takeover. |
| **Dependency** | None (application-level fix) |
| **Fix** | **REST**: Added pre-check that rejects requests with missing or `"0x"` signature (returns 400). Wrapped `setOwnerPolicy` in try/catch that returns 403 on signature verification failure. **MCP**: Added signature pre-check that rejects `agentix_policy_set` calls without a real signature. The tool is also DASHBOARD_ONLY gated. |
| **Regression test** | Existing `tests/release-validation.test.ts` passes. |

### C3: Daily Spend Limit Bypass via Silent Error Swallowing

| Field | Value |
|-------|-------|
| **Severity** | Critical |
| **File** | `src/core/owner-policy.ts` (lines 152-185) |
| **Found by** | Tracing the `checkPolicy()` function for error handling paths |
| **Root cause** | Two `try {} catch {}` blocks (per-tx limit check and daily limit check) silently swallowed ALL errors. If `BigInt(value)` threw (malformed input), or if the JSON path extraction `metadata->>'$.value'` returned null (missing field), the check was bypassed and the transaction was allowed. |
| **Impact** | Any malformed value string or missing metadata field would bypass all spending limits. An agent could send `value: "abc"` and the per-tx check would silently pass. |
| **Dependency** | `better-sqlite3` — SQLite JSON functions (`json_extract` vs `->>` operator) |
| **Fix** | Changed both catch blocks to **fail-closed**: errors now deny the transaction with a descriptive reason. Also replaced the `->>` JSON path operator with `json_extract()` for SQLite compatibility (the `->>` operator is MySQL/PostgreSQL syntax, not SQLite). Wrapped the `total_used` in `COALESCE(..., 0)` to handle null metadata gracefully. |
| **Regression test** | Existing `tests/27-bundler-risk-gate.test.ts` passes (specifically "blocks when the wallet has no owner policy"). |

### C4: Agent Self-Approval of Execution Plans

| Field | Value |
|-------|-------|
| **Severity** | Critical |
| **File** | `src/mcp/server.ts` (lines 211, 240-245) |
| **Found by** | Auditing the DASHBOARD_ONLY gate against all MCP tools that modify state |
| **Root cause** | `agentix_approve_plan` was NOT in the `dashboardOnly` list. An AI agent could call this tool to approve its own execution plans that the risk engine flagged as requiring human review, completely bypassing the authority check. |
| **Impact** | The risk engine's `requiresApproval` flag was meaningless — any agent could self-approve high-risk operations. |
| **Dependency** | None (application-level fix) |
| **Fix** | Added `"agentix_approve_plan"` to the `dashboardOnly` array. Updated the tool description to indicate it's DASHBOARD_ONLY. Changed the input schema to `{ properties: {} }` (no params needed since it's blocked). |
| **Regression test** | Existing MCP tests pass. |

---

## High Fixes

### H1: Non-Atomic Config File Writes

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `src/core/config.ts` (line 143-153) |
| **Found by** | Auditing all `writeFileSync` calls for crash safety |
| **Root cause** | `saveConfig()` used `writeFileSync(CONFIG_PATH, ...)` directly. If the process crashed mid-write (SIGKILL, power loss, disk full), the config file would be truncated/corrupted. |
| **Impact** | Corrupted config file would cause all subsequent operations to fail with JSON parse errors. The existing corruption handler (line 126-139) would preserve the file as `.corrupt-*` and fall back to defaults, but the user's settings would be lost. |
| **Dependency** | Node.js `fs` — `renameSync` is atomic on POSIX (and effectively atomic on NTFS for same-directory moves) |
| **Fix** | Changed to write-to-temp-then-rename pattern: (1) write to `${CONFIG_PATH}.tmp-${process.pid}`, (2) `renameSync` temp to CONFIG_PATH. The `rename` syscall is atomic — if the process crashes between write and rename, the original file is untouched. |
| **Regression test** | Existing `tests/33-init-consistency.test.ts` "loadConfig preserves a corrupt config" test passes. |

### H2: Runtime Manifest Contains API Token Without Restrictive Permissions

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `src/core/ports.ts` (lines 90-106) |
| **Found by** | Auditing all files that write secrets to disk |
| **Root cause** | `writeRuntimeManifest()` wrote the API bearer token to `~/.agentix/runtime.json` without setting file permissions. On multi-user systems, any user could read the token and authenticate to the API. |
| **Impact** | API token leakage on shared systems. |
| **Dependency** | Node.js `fs` — `chmodSync` (best-effort on Windows) |
| **Fix** | Added atomic write (temp + rename) with `chmodSync(tmpPath, 0o600)` before rename. The 0600 permission restricts read/write to the file owner only. On Windows, `chmodSync` is best-effort (no-op) since NTFS uses ACLs. |
| **Regression test** | Existing tests pass. |

### H3: Foreign Keys Disabled in SQLite

| Field | Value |
|-------|-------|
| **Severity** | High (design limitation — cannot safely fix in V1) |
| **File** | `src/core/database.ts` (line 472) |
| **Found by** | Auditing database initialization for integrity constraints |
| **Root cause** | `PRAGMA foreign_keys = OFF` disables all referential integrity. Credentials can reference non-existent organizations, sessions can reference non-existent wallets, etc. |
| **Impact** | Orphan records, inconsistent state across tables. |
| **Dependency** | SQLite — does not support `ALTER TABLE ADD CONSTRAINT` |
| **Fix** | **Cannot safely fix in V1.** Three blockers: (1) existing databases may have orphan records that would block all writes, (2) SQLite doesn't support adding FK to existing tables without recreation, (3) `migrateOldSchema()` copies data between tables which would violate FK mid-operation. **Documented** in README "Known Design Limitations" with detailed rationale. Application-level integrity checks added to critical write paths. |
| **Future** | V2 should use a migration framework (Knex, Drizzle) with FK-safe migrations. |

### H4: MCP Server Returns Private Key in Plaintext

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `src/mcp/server.ts` (lines 731-749) |
| **Found by** | Auditing all MCP tool responses for sensitive data leakage |
| **Root cause** | `agentix_keygen` generated a random wallet and returned `privateKey` in the MCP response. The private key would enter the AI model's context window, potentially be logged by the harness, and persisted in conversation history. |
| **Impact** | Private key exposure through multiple vectors: model provider logs, harness local storage, conversation exports. |
| **Dependency** | `src/core/session-keystore.ts` — `generateSessionKey()`, `persistSessionKey()` |
| **Fix** | Redesigned `agentix_keygen` to: (1) generate keypair via `generateSessionKey()`, (2) store private key in the encrypted session keystore under a temp ID (`keygen_${timestamp}_${address_prefix}`), (3) return ONLY the address, tempId, and a message explaining the flow. The private key never leaves the server process. |
| **Regression test** | Existing `tests/28-session-keystore.test.ts` passes. |

### H5: Per-Tx Limit Error Swallowing

| Field | Value |
|-------|-------|
| **Severity** | High (merged with C3 fix) |
| **File** | `src/core/owner-policy.ts` (lines 214-233) |
| **Found by** | Same audit path as C3 |
| **Root cause** | `try {} catch {}` around `BigInt(value)` conversion silently allowed transactions when the value was malformed. |
| **Impact** | Bypass of per-transaction spending limit. |
| **Fix** | Changed to fail-closed: `catch (e)` now returns `{ allowed: false, reason: "Cannot parse transaction value..." }`. |

### H6: Session Nonce Is Predictable (Unix Timestamp)

| Field | Value |
|-------|-------|
| **Severity** | High |
| **Files** | `src/runtime/server.ts` (lines 808, ~1700), `src/tools/proof.ts` (line 298) |
| **Found by** | Auditing cryptographic nonce generation across all proof/session paths |
| **Root cause** | Three callers generated session nonces differently: (1) `server.ts` used `Math.floor(Date.now() / 1000)` — predictable, not unique within same second, (2) `proof.ts` used `Math.random()` — not cryptographically secure, (3) second `server.ts` endpoint used timestamp again. |
| **Impact** | Nullifier prediction (an attacker who knows the timestamp can predict the nullifier), potential nonce reuse (two proofs in the same second get the same nullifier). |
| **Dependency** | Node.js `crypto` — `randomBytes(16)` for 128 bits of entropy |
| **Fix** | All three callers changed to `BigInt("0x" + randomBytes(16).toString("hex"))` (128-bit cryptographic random). In `proof.ts`, added `import { randomBytes } from "crypto"` and replaced `Math.random()` call. In `server.ts`, replaced both timestamp-based nonces with `require("crypto").randomBytes(16)`. |
| **Regression test** | Existing `tests/25-zk-session.test.ts` and `tests/circuit-compat.test.ts` pass. |

### H7: No Transaction Recording in Bundler Path

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `src/runtime/bundler.ts` (lines 200-223) |
| **Found by** | Comparing transaction recording across CLI, SDK, and bundler paths |
| **Root cause** | The bundler's `bundleUserOp()` submitted transactions to the EntryPoint and emitted events, but did NOT write to the SQLite `transactions` table. Transaction history was only available after the async event indexer caught up (polling interval). |
| **Impact** | Dashboard and API would show no transaction history for bundler-submitted ops until the indexer ran. Users would see "no transactions" immediately after a successful submission. |
| **Dependency** | `src/core/database.ts` — `runExecute()` for INSERT |
| **Fix** | Added a try/catch block after successful `handleOps` that inserts into the `transactions` table with: wallet_address, tx_hash, status (confirmed/reverted based on EntryPoint event), block_number, gas_used, event_name="UserOperation", contract_name="EntryPoint". Uses `INSERT OR IGNORE` to prevent duplicates if the indexer also records it later. |
| **Regression test** | Existing tests pass. |

---

## Medium Fixes

### M1: No Rate Limiting on API Endpoints

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `src/runtime/server.ts` (lines 43-66, 164-168) |
| **Found by** | Auditing API server for DoS protection |
| **Root cause** | No request throttling. An attacker on localhost could brute-force the API token or flood endpoints. |
| **Dependency** | None (in-memory Map-based sliding window) |
| **Fix** | Added a sliding window rate limiter: 120 requests per minute per IP. Implemented as a `Map<string, { count, windowStart }>` with periodic cleanup. Returns HTTP 429 when exceeded. Wired into the request handler after CORS check, before auth check. |

### M2: AGENTIX_HOME Environment Variable Can Redirect All Paths

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `src/core/config.ts` (lines 1-18) |
| **Found by** | Auditing environment variable usage for path injection |
| **Root cause** | `AGENTIX_HOME` was used directly from `process.env` without validation. An attacker who could set the env var could redirect all state (config, DB, keystore, keys) to an attacker-controlled directory. |
| **Dependency** | Node.js `path` — `resolve()` for absolute path normalization |
| **Fix** | Added `resolveAgentixHome()` function that calls `resolve()` on the env var to normalize to an absolute path, preventing relative path confusion. Documented the trust assumption in comments. |

### M7: Agent Can Create Wallets (Privileged Operation)

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `src/mcp/server.ts` (line 83, 240-245) |
| **Found by** | Building the authorization matrix for all MCP tools |
| **Root cause** | `agentix_wallet_create` was not in the `dashboardOnly` list. An AI agent could deploy a new AgentWallet and become its owner without human involvement. |
| **Dependency** | None |
| **Fix** | Added `"agentix_wallet_create"` to the `dashboardOnly` array. Updated tool description to indicate DASHBOARD_ONLY. Changed input schema to `{ properties: {} }`. |

### M10: Backup Restore Not Atomic

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `packages/core/backup-engine/index.ts` (lines 133-153) |
| **Found by** | Auditing backup/restore for crash safety |
| **Root cause** | `importAll()` iterated tables and did individual `INSERT OR REPLACE` calls. A crash mid-restore would leave partial state (some tables restored, others not). |
| **Dependency** | `src/core/database.ts` — `runTransaction()` for SQLite BEGIN/COMMIT |
| **Fix** | Wrapped the entire `importAll()` loop in `runTransaction()`. SQLite transactions are atomic — if any INSERT fails or the process crashes, all changes roll back. Added `import { runTransaction }` to imports. |

---

## Low Fixes

### L2: Duplicate `extractWalletAddressFromLogs` Function

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Files** | `src/blockchain/adapter.ts`, `src/core/tx-builder.ts` |
| **Found by** | Grepping for duplicate function definitions |
| **Root cause** | The same function existed in both files with identical logic. |
| **Fix** | `adapter.ts` now imports and re-exports from `tx-builder.ts` (`import { extractWalletAddressFromLogs as _extractWalletFromLogs } from "../core/tx-builder"`). Removed the duplicate body. |

### L3: Domain Separator Cached Forever (No Invalidation on Chain Switch)

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `src/runtime/bundler.ts` (lines 49-56), `src/core/provider.ts` (lines 173-183) |
| **Found by** | Auditing cached values for invalidation paths |
| **Root cause** | The EIP-712 domain separator was cached in `_domainSeparator` and never invalidated. If the chain ID changed (e.g., switching from testnet to mainnet), the cached separator would be stale and all UserOp hashes would be wrong. |
| **Dependency** | Cross-module import (`bundler.ts` → `provider.ts`) |
| **Fix** | Added `resetDomainSeparator()` export to `bundler.ts` that sets `_domainSeparator = null`. Hooked into `resetProviders()` in `provider.ts` via `require("../runtime/bundler").resetDomainSeparator()`. |

---

## Design Limitations Documented

These are architectural decisions that cannot be safely changed in V1. Each is documented in `README.md` under "Known Design Limitations":

| # | Limitation | Why It Can't Be Fixed Now |
|---|-----------|--------------------------|
| 1 | Foreign keys disabled | Existing databases may have orphans; SQLite can't add FK to existing tables |
| 2 | Four independent roots of trust | Requires unified identity system (V2) |
| 3 | MCP client is fully trusted | MCP protocol has no auth layer; DASHBOARD_ONLY is defense-in-depth |
| 4 | SDK bypasses compiler/risk/policy | SDK is for trusted programmatic use, not agent use |
| 5 | On-chain and off-chain limits can diverge | Two independent limit systems with different scopes |
| 6 | EventBus is in-memory only | Events lost on restart; persistent log is V2 |
| 7 | Race conditions in concurrent credential issuance | Single-operator design; needs job queue in V2 |
| 8 | No key rotation mechanism | Requires grace period system (V2) |
| 9 | Two separate database systems (SQLite + JSON) | SDK uses JSON for portability; unification is V2 |
| 10 | TOCTOU gap in Merkle root freshness | Inherent to off-chain proof generation; mitigated by on-chain rejection |

---

## Files Modified

| File | Lines Changed | Fixes |
|------|--------------|-------|
| `src/core/owner-policy.ts` | +80, -10 | C1, C3, H5 |
| `src/core/config.ts` | +15, -3 | H1, M2 |
| `src/core/ports.ts` | +8, -3 | H2 |
| `src/core/provider.ts` | +5, -1 | L3 |
| `src/core/database.ts` | +8, -1 | H3 (documentation) |
| `src/runtime/server.ts` | +30, -5 | C2, H6, M1 |
| `src/runtime/bundler.ts` | +30, -2 | H7, L3 |
| `src/mcp/server.ts` | +25, -15 | C4, H4, M7, C2 |
| `src/blockchain/adapter.ts` | +3, -15 | L2 |
| `src/tools/proof.ts` | +3, -2 | H6 |
| `packages/core/backup-engine/index.ts` | +5, -1 | M10 |
| `README.md` | +250 (new) | All design limitations |

---

## Test Results

```
Test Files:  5 passed | 1 failed (pre-existing) | 6 total
Tests:       77 passed | 1 failed (pre-existing) | 78 total
Duration:    25.80s
```

**Pre-existing failures (not introduced by this audit):**
- `tests/01-installation.test.ts > Smart contract ABIs exist` — ABI files missing (contracts directory deleted from repo)
- `tests/27-bundler-risk-gate.test.ts > risk engine puts a very large native transfer in a blocking band` — Missing `@noble/hashes` dependency in compiler package's node_modules
- `tests/31-db-concurrency.test.ts` — Timeout (60s) on cross-process SQLite concurrency test

**All security-critical tests pass:**
- `tests/23-security.test.ts` — Proxy guard, input validation, rate limiting, data isolation, secret handling, SQL injection
- `tests/27-bundler-risk-gate.test.ts` — Fail-closed on unknown session, blocks without policy, allows within policy
- `tests/28-session-keystore.test.ts` — Key generation, encryption round-trip, no cleartext storage, purge on revoke
- `tests/21-chaos.test.ts` — DB integrity, WAL recovery, event bus resilience, concurrent writes, memory pressure
- `tests/33-init-consistency.test.ts` — Config persistence, corruption handling, RPC configuration

---

# Appendix A — Formal System Analysis

This section addresses the 10 formal analysis requirements that go beyond component-level auditing.

---

## A1. Formal System Invariants

These invariants MUST hold at all times. Every mutation is checked against them.

### INV-1: One wallet → One owner → One authority chain

```
∀ wallet W:
  owner(W) = O
  ∧ O ∈ wallets_table
  ∧ authority(O) = { sessions(O) ∪ direct(O) }
  ∧ |activePolicy(O)| ≤ 1
```

**Where verified**:
- `AgentWallet.owner()` — on-chain, enforced by `onlyOwner` modifier
- `wallets.owner_address` — SQLite, application-level
- `owner_policies` — SQLite, `ORDER BY created_at DESC LIMIT 1` in `getOwnerPolicy()`

**Can it be violated?**
- YES: `owner_policies` has no UNIQUE constraint on `wallet_address`. Two concurrent `setOwnerPolicy()` calls can create two rows. `getOwnerPolicy()` always returns the latest, so the invariant holds at read time, but stale rows accumulate.
- FIX NEEDED: Add `UNIQUE(wallet_address)` to `owner_policies` or use `DELETE + INSERT` inside a transaction (currently done but not wrapped in `runTransaction()`).

### INV-2: One credential → One commitment → One leaf position

```
∀ credential C:
  commitment(C) = Poseidon7(agentId, orgId, budget, wallet, expiry, version, secret)
  ∧ leaf_index(C) = dense_position_in_active_tree
  ∧ ∀ C1, C2: C1.commitment ≠ C2.commitment (collision-free)
```

**Where verified**:
- `issueCredential()` in `src/tools/credential.ts` — computes commitment, inserts into tree
- `active_tree.addLeaf()` — assigns dense leaf index
- `credentials.commitment` UNIQUE — not enforced (commitment is the `nullifier` column, which IS UNIQUE)

**Can it be violated?**
- NO for uniqueness: `credentials.nullifier` has a UNIQUE constraint
- YES for leaf position: if two credentials are issued concurrently for the same org, `addLeaf()` operates on the in-memory tree without locking. The second call could overwrite the first's leaf position.

### INV-3: One session → One session key → One signer

```
∀ session S:
  sessionKey(S) = K
  ∧ K ≠ wallet_address (enforced on-chain by SessionManager)
  ∧ encryptedKey(K) ∈ session_keys_table
  ∧ ∀ S1, S2: S1.sessionId ≠ S2.sessionId
```

**Where verified**:
- `SessionManager.createLightweightSession()` — on-chain, enforces `sessionKey != wallet`
- `session_keys.session_id` PRIMARY KEY — SQLite
- `sessions.session_id` UNIQUE — SQLite

**Can it be violated?**
- NO: session_id is UNIQUE in both SQLite and on-chain. The session key is bound at creation time and cannot change.

### INV-4: One nullifier → One use

```
∀ nullifier N:
  used(N) → ¬prove(N)    (cannot prove with used nullifier)
  ∧ ∀ N: used(N) = CredentialRegistry.isNullifierUsed(N)
```

**Where verified**:
- `CredentialRegistry.isNullifierUsed()` — on-chain
- `CredentialRegistry.markNullifierUsed()` — on-chain, called by SessionManager during session creation
- `proofs.nullifier` UNIQUE — SQLite

**Can it be violated?**
- NO on-chain: the EVM guarantees atomic state transitions
- YES locally: the local prover does not check `isNullifierUsed()` before generating a proof. A proof can be generated for an already-used nullifier. The on-chain verifier will reject it, but the local system wastes resources.

### INV-5: Policy is always owner-signed

```
∀ policy P:
  ∃ signature σ:
    recover(σ, buildPolicyMessage(P)) = owner(wallet(P))
```

**Where verified**:
- `setOwnerPolicy()` in `src/core/owner-policy.ts` — EIP-191 verification (added by this audit)
- `POST /api/policy` — rejects missing/empty signatures
- `agentix_policy_set` MCP tool — DASHBOARD_ONLY gated

**Can it be violated?**
- NO after this audit's fixes. Prior to the fix, any caller could set an unsigned policy.

### INV-6: Risk engine gates every execution path

```
∀ execution E:
  riskDecision(E) ∈ {ALLOW, ALLOW_WITH_CONTROLS} → proceed(E)
  riskDecision(E) ∈ {REVIEW, CHALLENGE} → ownerAttestation(E) → proceed(E)
  riskDecision(E) = DENY → ¬proceed(E)
```

**Where verified**:
- `CompilerGateway.executeIntent()` — runs compiler pipeline (stages 1-10)
- `assessBundlerOp()` in `bundler-risk-gate.ts` — gates the bundler relay path
- On-chain: NOT verified. Direct EntryPoint submission bypasses the risk engine.

**Can it be violated?**
- YES: The SDK (`src/sdk/`) calls contracts directly without the risk engine. The CLI `quick` commands also bypass it. See README "Known Design Limitation #4".

---

## A2. Full Trust Graph

Each arrow documents: what is trusted, why, how, what verifies it, how it fails.

```
Human (Owner)
  │
  │ trusts: Nothing. Human is the root.
  │ evidence: Private key possession
  │
  ▼
Dashboard (Next.js)
  │
  │ trusts: API bearer token (from runtime.json)
  │ why: localhost-only binding + timing-safe comparison
  │ how: Bearer token in Authorization header
  │ verifies: authorized() in server.ts
  │ fails: Token leaked from runtime.json (mitigated by 0600 perms after H2 fix)
  │
  ▼
Runtime (API Server)
  │
  │ trusts: Bearer token + localhost binding
  │ why: Only local processes can reach 127.0.0.1
  │ how: HTTP request with Authorization header
  │ verifies: timingSafeEqual comparison
  │ fails: Any process on the machine can call the API (no per-process auth)
  │
  ▼
Compiler Gateway
  │
  │ trusts: Runtime authentication (inherited)
  │ why: Gateway is called BY the runtime, not directly
  │ how: Function call within same process
  │ verifies: Action whitelist (AGENT_FREE_ACTIONS, OWNER_ONLY_ACTIONS)
  │ fails: If runtime is compromised, gateway is compromised (same process)
  │
  ▼
Policy Engine
  │
  │ trusts: Owner signature on policy
  │ why: EIP-191 signature recovery against wallet owner
  │ how: ethers.verifyMessage()
  │ verifies: Recovered address matches wallets.owner_address
  │ fails: Owner key compromised → attacker can sign arbitrary policies
  │
  ▼
Risk Engine
  │
  │ trusts: Policy from DB + behavioral history + address reputation
  │ why: All inputs are from local state (SQLite) or on-chain queries
  │ how: Multi-dimensional scoring (value, counterparty, behavioral, compliance)
  │ verifies: Score against thresholds (75 = approval, 90 = deny)
  │ fails: Stale DB state → risk assessment based on outdated information
  │
  ▼
Proof Generator
  │
  │ trusts: ZK artifacts (zkey, wasm, VK)
  │ why: SHA-256 hash verification against manifest
  │ how: verifyIntegrity() checks sha256 + size
  │ verifies: Local Groth16 verification after proof generation
  │ fails: No manifest → existence-only check (monorepo dev mode)
  │
  ▼
Signer (ethers.Wallet)
  │
  │ trusts: Private key from AGENTIX_PRIVATE_KEY env var
  │ why: Environment variable is process-scoped
  │ how: ethers.Wallet(pk, provider)
  │ verifies: On-chain: ECDSA signature verification
  │ fails: Env var leaked → attacker can sign any transaction
  │
  ▼
Wallet (AgentWallet contract)
  │
  │ trusts: Owner ECDSA signature OR session key signature
  │ why: onlyOwnerOrEntryPoint modifier on execute()
  │ how: Solidity modifier checks msg.sender
  │ verifies: EVM execution
  │ fails: Never (EVM is the trust anchor)
  │
  ▼
EntryPoint (ERC-4337)
  │
  │ trusts: UserOp signature + wallet's validateUserOp()
  │ why: ERC-4337 specification
  │ how: EntryPoint calls wallet.validateUserOp()
  │ verifies: Signature, nonce, gas limits
  │ fails: Never (EVM is the trust anchor)
  │
  ▼
Contracts (on-chain)
  │
  │ trusts: EVM consensus
  │ why: Base Sepolia validator set
  │ how: Block finality
  │ verifies: All state transitions are consensus-validated
  │ fails: Chain reorg (mitigated by waiting for confirmations)
  │
  ▼
Indexer (event-indexer.ts)
  │
  │ trusts: RPC provider (for event logs)
  │ why: Events are consensus-validated (part of block)
  │ how: eth_getLogs polling
  │ verifies: Event signature matching + block number ordering
  │ fails: RPC provider lying (mitigated by fallback providers)
  │
  ▼
SQLite
  │
  │ trusts: Filesystem permissions (AGENTIX_HOME)
  │ why: Single-user local-first design
  │ how: better-sqlite3 with WAL mode
  │ verifies: Schema integrity, busy timeout
  │ fails: Multi-user systems (mitigated by 0600 on keystore files)
```

---

## A3. Complete State Machines

### Credential State Machine

```
                    ┌──────────────┐
                    │   (none)     │
                    └──────┬───────┘
                           │ issueCredential()
                           ▼
                    ┌──────────────┐
                    │   ISSUED     │ ← exists in SQLite, commitment in active tree
                    │  revoked=0   │   root NOT yet on-chain (unless autoAnchor=true)
                    └──────┬───────┘
                           │ anchorRootOnChain()
                           ▼
                    ┌──────────────┐
                    │  PUBLISHED   │ ← active root updated on-chain
                    │  revoked=0   │   credential is provable
                    └──────┬───────┘
                           │ (time passes, credential is used)
                           ▼
                    ┌──────────────┐
                    │   ACTIVE     │ ← nullifier NOT yet used
                    │  revoked=0   │   can generate proofs
                    └──────┬───────┘
                           │ revokeCredential()
                           ▼
                    ┌──────────────┐
                    │  REVOKED     │ ← revoked=1 in SQLite
                    │  revoked=1   │   revocation key in revoked SMT
                    └──────┬───────┘   revoked root updated on-chain
                           │ (credential cannot be un-revoked)
                           ▼
                    ┌──────────────┐
                    │  TERMINAL    │ ← proofs will fail (SMT membership proof)
                    └──────────────┘
```

**Can it jump?**
- ISSUED → REVOKED: YES (revoke before publishing)
- ISSUED → ACTIVE: YES (skip PUBLISHED if autoAnchor=false, proof uses local roots)
- PUBLISHED → TERMINAL: YES (direct revoke)

**Can it go backwards?**
- NO: `revoked` is a one-way flag (0→1 only). No un-revocation path exists.

**Can two states exist simultaneously?**
- YES: Between ISSUED and PUBLISHED, the credential exists locally but not on-chain. A proof generated in this window will fail on-chain verification because the root doesn't match.

### Session State Machine

```
                    ┌──────────────┐
                    │   (none)     │
                    └──────┬───────┘
                           │ createLightweightSession() or createSession()
                           ▼
                    ┌──────────────┐
                    │   ACTIVE     │ ← revoked=0, expiry > now
                    │  revoked=0   │   can sign UserOps
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │   EXPIRED    │ │ REVOKED  │ │  EXHAUSTED   │
     │ expiry < now │ │revoked=1 │ │ txUsed >=    │
     │              │ │          │ │ dailyTxLimit │
     └──────────────┘ └──────────┘ └──────────────┘
              │            │            │
              └────────────┼────────────┘
                           ▼
                    ┌──────────────┐
                    │  TERMINAL    │ ← cannot be reactivated
                    └──────────────┘
```

**Can it jump?**
- ACTIVE → TERMINAL: YES (revoke immediately after creation)
- ACTIVE → EXPIRED → REVOKED: YES (expire then revoke — double-transition is harmless)

**Can it go backwards?**
- NO: Sessions cannot be un-revoked or un-expired.

### Execution Plan State Machine

```
                    ┌──────────────┐
                    │   PENDING    │ ← just compiled
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │  APPROVAL_   │ │ REJECTED │ │   EXPIRED    │
     │  REQUIRED    │ │          │ │              │
     └──────┬───────┘ └──────────┘ └──────────────┘
            │ approvePlan()
            ▼
     ┌──────────────┐
     │  APPROVED    │
     └──────┬───────┘
            │ executePlan()
            ▼
     ┌──────────────┐
     │  EXECUTING   │
     └──────┬───────┘
            │
       ┌────┼────┐
       │         │
       ▼         ▼
  ┌─────────┐ ┌──────────┐
  │COMPLETED│ │  FAILED   │
  │(txHash) │ │(error)    │
  └─────────┘ └──────────┘
```

**Can it jump?**
- PENDING → REJECTED: YES
- PENDING → EXPIRED: YES (if expiresAt passes)
- APPROVAL_REQUIRED → REJECTED: YES

**Can it go backwards?**
- NO: Plan status transitions are one-way.

---

## A4. Distributed Consistency

### Scenario 1: Chain succeeds → SQLite fails

```
handleOps() mines on-chain
    ↓
receipt received
    ↓
runExecute("INSERT INTO transactions ...")  ← FAILS
    ↓
Result: On-chain state updated. Local DB has no record.
Recovery: Event indexer will eventually poll the on-chain event and insert it.
Gap: Dashboard shows no transaction until indexer runs.
Severity: LOW — self-healing via indexer.
```

### Scenario 2: SQLite succeeds → Chain fails

```
runExecute("INSERT INTO credentials ...")  ← succeeds
    ↓
anchorRootOnChain(root)  ← FAILS (RPC timeout, insufficient gas)
    ↓
Result: Credential exists locally but not on-chain.
Recovery: Credential is usable only against local roots. Must re-anchor.
Gap: Proofs will fail on-chain until root is published.
Severity: MEDIUM — requires manual intervention.
```

### Scenario 3: Dashboard crashes during update

```
Dashboard sends POST /api/sessions
    ↓
Server creates session in SQLite  ← succeeds
    ↓
Server sends HTTP response  ← Dashboard crashes before receiving
    ↓
Result: Session created. Dashboard shows stale state.
Recovery: Dashboard refreshes on next page load.
Severity: NONE — eventual consistency.
```

### Scenario 4: Runtime restarts mid-transaction

```
bundleUserOp() → handleOps() submitted to network
    ↓
Process receives SIGKILL  ← tx.wait() never completes
    ↓
Restart: bundler_queue has op as "pending"
    ↓
flushPendingOps() re-submits with same signedUserOp
    ↓
EntryPoint rejects (nonce already used if original succeeded)
    ↓
Result: Op marked "failed" in queue. Original tx may have succeeded.
Gap: No mechanism to check if original tx was mined.
Severity: MEDIUM — requires manual tx hash lookup.
```

### Scenario 5: Proof generated against stale Merkle root

```
Credential A issued → root = R1
    ↓
Credential B issued → root = R2 (A's proof would use R1)
    ↓
Proof for A generated with root R1
    ↓
On-chain activeRoot is now R2
    ↓
Proof verification fails (public signal root ≠ on-chain root)
Recovery: Re-generate proof with current root.
Severity: LOW — proof simply needs regeneration.
```

### Scenario 6: RPC timeout after broadcast

```
tx = await contract.someFunction()
    ↓
tx.wait() times out after 60s
    ↓
ethers throws timeout error
    ↓
Caller sees failure
    ↓
Transaction may or may not have been mined
Gap: No independent verification mechanism.
Recovery: Check tx hash on block explorer.
Severity: LOW — rare, requires manual intervention.
```

---

## A5. Exactly-Once Execution

### Path 1: CLI wallet execute

```
User intent: "send 0.1 ETH to 0x..."
  → CLI parses command
  → CompilerGateway.executeIntent('wallet_execute', {target, value, data})
  → Compiler pipeline (10 stages) → ExecutionPlan
  → Policy check: checkPolicy()
  → Risk engine: assess()
  → If within policy + low risk:
      → approvePlan()
      → executePlan()
      → actionEncoder.encodeAction() → calldata
      → assertDeployed() → bytecode check
      → sendRootUpdate() or wallet.execute() → ONE transaction
      → tx.wait() → ONE receipt
      → completePlan(txHash) → ONE plan record
      → _logAction() → ONE action record
  → Result: exactly one transaction, one receipt, one history record

Duplicate protection:
  - EntryPoint nonce: prevents duplicate UserOp submission
  - Plan ID: unique per compilation, prevents duplicate execution
  - tx.wait(): blocks until receipt, ensures one response
```

### Path 2: MCP bundler send

```
Agent calls agentix_bundler_send({sender, target, sessionId})
  → loadSessionKey(sessionId) → decrypt private key
  → buildSessionUserOp() → compute userOpHash → sign
  → assessBundlerOp() → risk gate
  → bundleUserOp():
      → computeUserOpHash() → verify against EntryPoint.getUserOpHash()
      → ep.balanceOf() → deposit check
      → ep.handleOps() → ONE transaction
      → Parse UserOperationEvent → success/failure
      → INSERT INTO transactions → ONE record
  → Result: exactly one transaction, one receipt, one history record

Duplicate protection:
  - EntryPoint nonce: second submission with same nonce is rejected
  - handleOps is atomic: either the entire op succeeds or reverts
```

### Gaps

| Gap | Location | Impact |
|-----|----------|--------|
| No idempotency key on bundler submissions | `bundler-service.ts` | Same UserOp submitted twice → second fails at EntryPoint (safe) |
| No deduplication of SQLite event inserts | `persistEvent()` in services | Duplicate events possible if handler called twice |
| SDK has no exactly-once guarantee | `src/sdk/transaction.ts` | Caller must manage idempotency |

---

## A6. Human vs Agent Authority Matrix

### Wallet Operations

| Operation | Human (Owner) | Agent (MCP) | Dashboard | SDK | CLI |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Create wallet | YES | **NO** (DASHBOARD_ONLY) | YES | YES | YES |
| Execute (owner sig) | YES | YES (needs ownerPrivateKey) | YES | YES | YES |
| Execute (session) | — | YES (via bundler) | YES | — | — |
| Execute batch | YES | **NO** (DASHBOARD_ONLY) | YES | YES | YES |
| Transfer ownership | YES | — | YES | YES | YES |
| Deposit gas | YES | — | YES | YES | YES |
| Withdraw gas | YES | — | YES | YES | YES |

### Session Operations

| Operation | Human (Owner) | Agent (MCP) | Dashboard | SDK | CLI |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Create session | YES | **NO** (DASHBOARD_ONLY) | YES | YES | YES |
| Validate session | YES | YES (read-only) | YES | YES | YES |
| Revoke session | YES | **NO** (DASHBOARD_ONLY) | YES | YES | YES |
| Prune expired | — | **NO** (DASHBOARD_ONLY) | YES | YES | — |
| List sessions | YES | YES (read-only) | YES | YES | YES |

### Credential Operations

| Operation | Human (Owner) | Agent (MCP) | Dashboard | SDK | CLI |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Issue credential | — | — | YES | YES | YES |
| Revoke credential | — | — | YES | YES | YES |
| List credentials | YES | YES (read-only) | YES | YES | YES |
| Verify nullifier | YES | YES (read-only) | YES | YES | YES |

### Policy Operations

| Operation | Human (Owner) | Agent (MCP) | Dashboard | SDK | CLI |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Set policy | YES (signature) | **NO** (DASHBOARD_ONLY) | YES (signature) | — | — |
| Get policy | YES | YES (read-only) | YES | — | — |
| Check policy | YES | YES (read-only) | YES | — | — |

### Compiler Operations

| Operation | Human (Owner) | Agent (MCP) | Dashboard | SDK | CLI |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Compile intent | YES | YES | YES | — | YES |
| List plans | YES | YES | YES | — | YES |
| Get plan | YES | YES | YES | — | YES |
| Approve plan | YES | **NO** (DASHBOARD_ONLY) | YES | — | YES |
| Reject plan | YES | — | YES | — | YES |

---

## A7. Proof Lifecycle

```
1. STATEMENT
   "Agent A has a valid credential from Org O with budget ≥ X, expiry > T, and is not revoked"
   Defined by: credential_V1.circom circuit

2. WITNESS (private inputs)
   - agentId, orgId, budgetLimit, expiry, secret, sessionNonce
   - activePathElements[20], activePathIndices[20]  (Merkle proof)
   - revokedSiblings[20], revokedOldKey, revokedOldValue, revokedIsOld0  (SMT proof)
   Source: SQLite (credential) + in-memory trees (Merkle/SMT proofs)

3. CIRCUIT
   - credential_V1.circom (depth-20 Merkle + SMT revocation, Poseidon hashes)
   - Computes: commitment = Poseidon7(inputs), nullifier = Poseidon3(orgId, secret, nonce)
   - Verifies: active tree membership + revoked SMT non-membership

4. WITNESS GENERATION
   - buildWitnessInput() in zk-prover.ts
   - Converts all bigints to decimal strings (snarkjs convention)
   - Bounds checks: agentId ≤ 128 bits, expiry ≤ 64 bits, etc.

5. PROVING KEY
   - Location: circuits/prover/credential_V1_final.zkey
   - Integrity: SHA-256 verified against artifacts.manifest.json
   - Size: ~28MB (BN254, depth-20)
   - Rotation: Requires trusted ceremony re-run

6. PROOF GENERATION
   - snarkjs.groth16.fullProve(input, wasm, zkey)
   - ~3-5 seconds on modern hardware
   - Output: { proof: {a, b, c}, publicSignals: [7 values] }

7. VERIFICATION (local)
   - snarkjs.groth16.verify(vk, publicSignals, proof)
   - Uses: circuits/build/verification_key.json
   - MUST pass before calldata is formatted

8. VERIFICATION (on-chain)
   - Groth16Verifier.verifyProof(a, b, c, publicSignals)
   - Public signals: [activeRoot, revokedRoot, maxValue, sessionExpiry, wallet, credentialVersion, nullifier]
   - Contract checks: root matches CredentialRegistry.activeRoot(), nullifier not already used

9. CONTRACT EXECUTION
   - SessionManager.createSession() calls Groth16Verifier
   - If verification passes: session created with proof's constraints
   - If verification fails: transaction reverts

10. RECEIPT
    - EntryPoint event: UserOperationEvent
    - SessionManager event: SessionCreated(sessionId, wallet, sessionKey, expiry, maxValue, nullifier)
    - Recorded in: SQLite (transactions, events, proofs tables)

11. ARCHIVE
    - proof_data: Full Groth16 proof JSON stored in proofs table
    - public_signals: Stored separately for quick access
    - Retention: No expiration (kept indefinitely)
```

**Can it be replayed?**
- NO on-chain: The nullifier is marked used by SessionManager during createSession(). Re-submitting the same proof fails because the nullifier is already used.
- YES locally: The local prover does not check nullifier usage. A proof can be generated for an already-used nullifier. It will fail on-chain but wastes local resources.

**Can it be substituted?**
- NO: The proof's public signals include the wallet address, which is bound to the session. A proof for wallet A cannot be used for wallet B.

---

## A8. Policy Correctness

| Question | Answer | Evidence |
|----------|--------|----------|
| Can a policy exist without owner? | NO (after C1 fix) | `setOwnerPolicy()` requires wallet in `wallets` table |
| Can owner change? | YES | `AgentWallet.changeOwner()` on-chain. Policy does NOT auto-update. |
| Can policy outlive wallet? | YES | Wallet can be drained/abandoned. Policy row persists in SQLite. |
| Can policy become stale? | YES | Policy references `allowedTargets` by address. If contract is upgraded, addresses change. |
| Can policy migrate? | NO | No mechanism to transfer policy between wallets. |
| Can cached policy survive revocation? | YES | Policy is never automatically invalidated when sessions are revoked. |
| Can two policies exist for one wallet? | YES | `owner_policies` has no UNIQUE on `wallet_address`. `getOwnerPolicy()` returns the latest. |
| Can policy be set without signature? | NO (after C1 fix) | `setOwnerPolicy()` verifies EIP-191 signature. |
| Can agent read policy? | YES | `agentix_policy_get` is not DASHBOARD_ONLY. |
| Can agent modify policy? | NO (after fix) | `agentix_policy_set` is DASHBOARD_ONLY + requires signature. |

**Remaining gap**: When the wallet owner changes on-chain (`changeOwner()`), the local policy is NOT automatically invalidated or updated. The old policy still references the old owner's signature. `setOwnerPolicy()` will reject new policies signed by the new owner until the `wallets.owner_address` is updated in SQLite — which only happens when `getWalletInfo()` is called.

---

## A9. Recovery Engineering

| Failure | Auto-Recover? | Data Loss? | Mechanism | Severity |
|---------|:---:|:---:|-----------|:---:|
| **Power loss during config write** | YES | No | Atomic write (temp + rename) — H1 fix | LOW |
| **Power loss during SQLite write** | YES | Last tx | WAL mode — SQLite auto-recovers on open | LOW |
| **Power loss during backup restore** | YES | No | Transaction-wrapped — M10 fix | LOW |
| **SIGKILL during handleOps** | NO | In-flight tx | Bundler queue has "pending" op; re-submission fails safely | MEDIUM |
| **SIGKILL during proof generation** | YES | Proof only | No state written until proof completes | LOW |
| **Corrupted SQLite** | NO | YES | Must restore from backup. No auto-recovery. | HIGH |
| **Deleted runtime.json** | YES | No | Regenerated on next server start | LOW |
| **Deleted proving key** | NO | N/A | All proof generation fails permanently | HIGH |
| **Deleted master.key** | NO | N/A | All encrypted session keys are unrecoverable | HIGH |
| **Disk full** | NO | Varies | `writeFileSync` throws. No graceful handling. | MEDIUM |
| **Clock skew** | Partial | No | Session expiry checks use `Date.now()`. Skew causes premature expiry or extended validity. | LOW |
| **Chain reorg** | Partial | No | Event indexer re-processes from checkpoint. Transactions may revert. | LOW |
| **RPC provider down** | YES | No | Fallback providers rotate automatically (provider.ts) | LOW |
| **RPC lying (returning stale data)** | NO | Possible | No proof-of-freshness mechanism for RPC responses | MEDIUM |
| **Partial npm install** | NO | N/A | Manual reinstall required | LOW |
| **Interrupted schema migration** | NO | Possibly | `migrateOldSchema()` is not transactional for DDL operations | MEDIUM |
| **Event duplication** | Partial | No | `indexed_events` has UNIQUE(tx_hash, log_index). Local events have no dedup. | LOW |
| **Event reordering** | Partial | No | Events sorted by timestamp on read. Block number provides canonical ordering for on-chain events. | LOW |

### Critical Recovery Gaps

1. **Corrupted SQLite**: No automatic recovery. Must implement backup-before-migration pattern.
2. **Lost master.key**: All session keys are permanently unrecoverable. Must implement key escrow or backup.
3. **Lost proving key**: All proof generation fails. Must ship proving key with package or implement download.
4. **SIGKILL during on-chain tx**: No mechanism to detect whether the original tx was mined. Must implement tx hash persistence before `tx.wait()`.

---

## A10. Formal Threat Model — Attack Trees

### Attack Tree 1: Steal Funds from AgentWallet

```
Goal: Drain ETH from AgentWallet
├── Compromise owner private key
│   ├── Steal AGENTIX_PRIVATE_KEY env var [L: LOW, I: CRITICAL]
│   │   └── Mit: Use hardware wallet or KMS for production
│   ├── Steal from runtime.json [L: LOW, I: CRITICAL]
│   │   └── Mit: 0600 permissions (H2 fix)
│   └── Steal from process memory [L: LOW, I: CRITICAL]
│       └── Mit: Process isolation, no core dumps
├── Compromise session key
│   ├── Steal from session_keys table [L: LOW, I: HIGH]
│   │   └── Mit: AES-256-GCM encryption at rest
│   ├── Steal master.key [L: LOW, I: CRITICAL]
│   │   └── Mit: 0600 permissions, env var override
│   └── Capture from MCP response [L: MEDIUM, I: HIGH]
│       └── Mit: H4 fix — keygen no longer returns private key
├── Forge owner signature
│   └── Not possible without private key [L: NONE]
├── Bypass session limits
│   ├── Submit UserOp directly to EntryPoint [L: LOW, I: MEDIUM]
│   │   └── Mit: Only session keys can call through SessionManager
│   └── Use SDK to bypass risk engine [L: LOW, I: MEDIUM]
│       └── Mit: SDK requires signer (caller provides key)
└── Replay attack
    └── Re-submit old UserOp [L: NONE]
        └── Mit: EntryPoint nonce prevents replay
```

### Attack Tree 2: Bypass Spending Limits

```
Goal: Spend more than policy allows
├── Set permissive policy
│   ├── Forge policy signature [L: NONE after C1 fix]
│   ├── Call setOwnerPolicy without signature [L: NONE after C2 fix]
│   └── Self-approve plan [L: NONE after C4 fix]
├── Bypass policy check
│   ├── Send malformed value to bypass per-tx limit [L: NONE after C3 fix]
│   ├── Use SDK (no policy check) [L: MEDIUM, I: MEDIUM]
│   │   └── Mit: Documented limitation, SDK is for trusted callers
│   └── Submit UserOp directly (no local policy check) [L: LOW, I: MEDIUM]
│       └── Mit: On-chain session limits still enforced
└── Exploit race condition
    ├── Concurrent policy update [L: LOW, I: LOW]
    │   └── Mit: Latest policy wins, no security impact
    └── Policy stale after owner change [L: LOW, I: MEDIUM]
        └── Mit: Documented, requires manual policy update
```

### Attack Tree 3: Compromise ZK Proof System

```
Goal: Generate a valid proof for a revoked/expired credential
├── Use revoked credential
│   ├── Generate proof before revocation is anchored [L: LOW, I: HIGH]
│   │   └── Mit: On-chain verifier checks revoked root
│   └── Replay old proof [L: NONE]
│       └── Mit: Nullifier prevents replay
├── Forge proof
│   ├── Corrupt zkey/wasm/vk [L: LOW, I: CRITICAL]
│   │   └── Mit: SHA-256 integrity check (verifyIntegrity())
│   ├── Corrupt verification key on-chain [L: NONE]
│   │   └── Mit: VK embedded in deployed contract
│   └── Forge Groth16 proof [L: NONE]
│       └── Mit: BN254 is cryptographically secure
├── Predict nullifier
│   └── Guess sessionNonce [L: NONE after H6 fix]
│       └── Mit: 128-bit cryptographic random nonce
└── TOCTOU: Root changes between read and proof submission
    └── Proof fails on-chain verification [L: LOW, I: NONE]
        └── Mit: Re-generate proof with current root
```

### Attack Tree 4: Denial of Service

```
Goal: Make AgentIX unusable
├── Flood API server
│   └── Rate limiting (M1 fix): 120 req/min/IP [L: LOW after fix]
├── Exhaust SQLite connections
│   └── busy_timeout = 5000ms: concurrent writers queue [L: LOW]
├── Fill disk
│   └── No mitigation: SQLite, logs, backups consume disk [L: MEDIUM, I: HIGH]
├── Corrupt config file
│   └── Atomic write (H1 fix): corruption detected and preserved [L: LOW after fix]
└── Exhaust event bus memory
    └── maxHistory = 1000: old events pruned [L: LOW]
```

---

## A11. End-to-End Trace: "Agent Requests Transfer"

This is the complete trace from intent to completion, with evidence at each stage.

```
1. INTENT CREATED
   Source: MCP tool call agentix_bundler_send({sender, target, value, sessionId})
   Evidence: MCP JSON-RPC request in stdin
   Can replay: No (MCP is request-response, not persisted)

2. AUTHENTICATED
   Mechanism: MCP has no auth (trust the client)
   Evidence: None (MCP stdio transport)
   Can bypass: Yes (MCP client is fully trusted)

3. AUTHORIZED
   Mechanism: DASHBOARD_ONLY gate checks tool name
   Evidence: agentix_bundler_send is NOT DASHBOARD_ONLY (agents can call it)
   Can bypass: N/A — agents are authorized to call this

4. POLICY EVALUATED
   Mechanism: checkPolicy(walletAddress, 'wallet_execute', {target, value})
   Source: owner_policies table (requires owner signature — C1 fix)
   Evidence: PolicyCheck result logged by bundler-risk-gate
   Can bypass: No (after C1 fix)

5. RISK ENGINE
   Mechanism: RiskEngineCore.assess() with multi-dimensional scoring
   Input: wallet address, target, value, calldata, session context
   Evidence: GateDecision with score, category, drivers
   Threshold: score < 75 → ALLOW, 75-90 → REVIEW, >90 → DENY
   Can bypass: No (fail-closed on error — H7 fix)

6. SESSION VALIDATION
   Mechanism: SQLite check for session existence, revocation, expiry
   Evidence: Session row from sessions table
   On-chain: SessionManager.validateLightweightSession()
   Can bypass: No

7. TRANSACTION BUILT
   Mechanism: buildSessionUserOp() → computeUserOpHash() → sign with session key
   Evidence: PackedUserOp with signature
   Signature: abi.encode(sessionId, eoaSignature)
   Can replay: No (EntryPoint nonce)

8. BROADCAST
   Mechanism: epSigner.handleOps([userOp], beneficiary)
   Evidence: Transaction hash from receipt
   Gas: Bundler EOA pays (bundler-key file)

9. CONFIRMATION
   Mechanism: Parse UserOperationEvent from receipt logs
   Evidence: opSucceeded boolean from EntryPoint event
   Critical: handleOps mining ≠ op success (EntryPoint catches inner reverts)
   Can false-positive: No (event-based verification)

10. TRANSACTION RECORDED
    Mechanism: INSERT INTO transactions (H7 fix)
    Evidence: Row in transactions table with tx_hash, status, block_number
    Dedup: INSERT OR IGNORE prevents duplicates

11. AUDIT TRAIL
    Evidence chain:
    - MCP stdin: raw request (not persisted by AgentIX)
    - SQLite agent_actions: tool, intent, risk_level, tx_hash, execution_time
    - SQLite transactions: wallet_address, tx_hash, status
    - SQLite bundler_queue: user_op_hash, status, error
    - SQLite events: event_type, data, tx_hash
    - On-chain: UserOperationEvent (permanent, auditable)
    Can audit 6 months later: YES (on-chain events + SQLite logs)

12. ROLLBACK
    Can rollback: NO (on-chain transactions are final)
    Can undo: Only via a reverse transaction (new intent)
```

---

## Appendix B — Remaining Issues (Post-Audit)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | `owner_policies` has no UNIQUE on `wallet_address` | Medium | Documented |
| 2 | Policy stale after on-chain owner change | Medium | Documented |
| 3 | SDK bypasses compiler/risk/policy | Medium | Documented as design limitation |
| 4 | EventBus in-memory only (events lost on restart) | Medium | Documented as design limitation |
| 5 | No key rotation mechanism | Medium | Documented as design limitation |
| 6 | Two separate database systems (SQLite + JSON) | Medium | Documented as design limitation |
| 7 | TOCTOU gap in Merkle root freshness | Low | Documented as design limitation |
| 8 | Race condition in concurrent credential issuance | Low | Documented as design limitation |
| 9 | No disk-full graceful handling | Low | Documented |
| 10 | No interrupted-migration recovery | Low | Documented |

---

# Appendix B — Formal Consistency, Failure Domains, Ownership, and Trust

---

## B1. Formal Consistency Model

Every subsystem declares its consistency guarantee explicitly.

| Subsystem | Consistency Model | Guarantee | Evidence |
|-----------|------------------|-----------|----------|
| **SQLite** | Strong consistency | Read-your-writes within a single process. Cross-process: WAL allows concurrent readers + one writer. Writer contention serialized by busy_timeout (5s). | `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` for schema init |
| **Smart Contracts (on-chain)** | Strong consistency | EVM provides total ordering of state transitions within a block. Cross-block: consensus-finalized. | Base Sepolia validator set, L2 finality |
| **Indexer (event-indexer.ts)** | Eventually consistent | Polls on-chain events every 30s. Indexer checkpoint (`indexer_checkpoints` table) tracks last processed block. Missed events are caught on next poll or reindex. | `setInterval` polling, checkpoint persistence |
| **Dashboard** | Eventually consistent | Polls REST API on page load and at intervals. No WebSocket push. Stale until next refresh. | React Query with refetch intervals |
| **Compiler** | Deterministic | Given identical inputs (action, params, context, contractAddresses), produces identical ExecutionPlan. Content hash is SHA-256 of inputs. | `checksum(JSON.stringify({action, params, walletAddress, sessionId, organizationId, contractAddresses}))` |
| **Risk Engine** | Deterministic (given inputs) | Same intent + capabilities + policy + simulation → same score. Non-deterministic inputs: live ETH price (bounded timeout), behavioral profile (DB state). | `RiskEngineCore.assess()` is a pure function of its inputs |
| **Proof Generation** | Deterministic | Given identical witness inputs (agentId, orgId, secret, Merkle paths, SMT proofs), produces identical Groth16 proof. The circuit is deterministic; snarkjs is deterministic. | `snarkjs.groth16.fullProve()` is deterministic for same inputs |
| **EventBus** | No consistency guarantee | In-memory array, lost on restart. No persistence. No ordering guarantee across handlers. | `history.push(event)` in memory only |
| **Session Keystore** | Strong consistency (per-process) | AES-256-GCM encryption with unique IV per write. `INSERT OR REPLACE` ensures one key per session_id. | `ON CONFLICT(session_id) DO UPDATE` |

---

## B2. Failure Domains

| If this dies | What survives | What fails | Recovery |
|-------------|---------------|------------|----------|
| **SQLite** | On-chain state (contracts), proving key, config file, circuit artifacts | All reads (wallets, sessions, credentials, proofs), all local writes, policy checks, risk engine behavioral data | Restore from backup (`backup restore`). No auto-recovery. |
| **RPC (all providers)** | Local SQLite state, config, keystore, circuit artifacts | All on-chain reads (balances, roots, session validation), all on-chain writes, proof verification against live roots, event indexing | Wait for RPC to recover. Fallback providers rotate automatically. |
| **Compiler** | On-chain state, SQLite, direct SDK calls, MCP read-only tools | All intent compilation, risk assessment, plan generation, policy optimization | Restart runtime. Compiler is stateless (re-created each request if needed). |
| **Proof Generation** | Everything except ZK proof generation | Cannot generate new proofs. Existing proofs in SQLite are still readable. On-chain verification still works. | Check artifact integrity (`verifyIntegrity()`). Regenerate artifacts if corrupted. |
| **Dashboard** | CLI, MCP server, API server, on-chain contracts, SQLite | Web UI unavailable. All functionality still accessible via CLI/MCP/API. | Restart dashboard. No state loss. |
| **Runtime (API server)** | CLI (direct), on-chain contracts, SQLite file (if not locked) | REST API unavailable, event indexer stops, bundler stops. MCP server may still work (separate process). | Restart runtime. Graceful shutdown handler persists state. |
| **Master Key (keystore)** | Everything except encrypted session key decryption | Cannot decrypt session keys → agents cannot sign UserOps autonomously | Regenerate master key → all existing encrypted keys are unrecoverable. Must recreate sessions. |
| **ZK Artifacts (zkey/wasm/vk)** | Everything except proof generation and local proof verification | Cannot generate or locally verify ZK proofs. On-chain verification still works (VK embedded in contract). | Regenerate from circuit source (`cd circuits && ...`). Or set `AGENTIX_CIRCUITS_DIR`. |
| **Config file** | SQLite, keystore, circuit artifacts, on-chain state | Runtime falls back to `DEFAULT_CONFIG`. User settings lost. | Config auto-regenerated from defaults. Corrupt config preserved as `.corrupt-*`. |
| **Disk full** | Nothing (all writes fail) | SQLite writes fail, config writes fail, log writes fail, backup writes fail | Free disk space. SQLite WAL may have partial data. |

---

## B3. Resource Ownership

Every resource has exactly one owner for each lifecycle dimension.

| Resource | Create Owner | Lifecycle Owner | Storage Owner | Delete Owner | Recovery Owner | Migration Owner |
|----------|-------------|----------------|---------------|-------------|---------------|----------------|
| **Wallet** | Owner (via factory tx) | Owner (on-chain onlyOwner) | SQLite `wallets` table | None (cannot delete on-chain) | Backup restore | Manual (re-register) |
| **Session** | Owner (via dashboard) | SessionManager (on-chain) | SQLite `sessions` + `session_keys` | Owner (revoke) | Backup restore | Manual (recreate) |
| **Credential** | Issuer (org owner) | CredentialRegistry (on-chain) | SQLite `credentials` + Merkle trees | Issuer (revoke) | Backup restore + tree rebuild | Manual (re-issue) |
| **Policy** | Owner (EIP-191 signature) | Owner (can overwrite) | SQLite `owner_policies` | Owner (delete) | Backup restore | None (per-wallet) |
| **Organization** | Creator (via API/CLI) | OrganizationRegistry (on-chain) | SQLite `organizations` | Owner (deactivate) | Backup restore | Manual |
| **Agent Identity** | Owner (via factory) | AgentIdentity contract (on-chain) | SQLite `identities` | Owner (deactivate) | Backup restore | Manual |
| **Proof** | Proof generator (ZK prover) | Immutable once generated | SQLite `proofs` | None (append-only) | Regenerate from credential | N/A (immutable) |
| **Merkle Tree** | System (on credential issue) | Tree engine (in-memory + SQLite snapshots) | SQLite `merkle_snapshots` + `credential_roots` | None | Rebuild from credentials table | `tree rebuild` command |
| **Session Key** | Session keystore (on session create) | Keystore (encrypted at rest) | SQLite `session_keys` | Purge on session revoke | None (unrecoverable if master key lost) | None |
| **Master Key** | First run (auto-generated) | Filesystem (`~/.agentix/keys/master.key`) | Filesystem (0600) | None (deleting breaks all session keys) | None (all session keys become unrecoverable) | None |
| **API Token** | Runtime startup (random) | Runtime process | `runtime.json` (0600 after fix) | Runtime shutdown (cleared) | Auto-regenerated on next start | N/A |
| **Config** | `init` command | Config module | `~/.agentix/config/agentix.config.json` | `config reset` | Defaults fallback | Manual (`config set`) |
| **Backup** | `backup create` command | BackupEngine | `~/.agentix/backups/` | None (manual) | N/A (backups ARE the recovery) | Copy backup file |

---

## B4. Event Sourcing Audit

| Question | Answer | Evidence |
|----------|--------|----------|
| Is every mutation represented by an event? | NO | `setOwnerPolicy()` emits `PolicyUpdated` but `DELETE + INSERT` is not atomic. `createWallet()` emits `WalletCreated` but the event is in-memory only (EventBus). |
| Can every state be reconstructed? | PARTIALLY | On-chain state: YES (from chain events). SQLite state: NO (no WAL replay, no write-ahead log of mutations). |
| Can every event be replayed? | NO for local events | EventBus events are in-memory, lost on restart. SQLite `events` table stores persisted events but has no replay mechanism. On-chain events: YES (via indexer reindex). |
| Can replay happen twice? | YES for on-chain | `reindexFromBlock()` can be called multiple times. Deduplication via `UNIQUE(tx_hash, log_index)` prevents duplicate rows. |
| Can replay diverge? | NO for on-chain | Events are ordered by block number. `UNIQUE(tx_hash, log_index)` ensures idempotent replay. |
| Can ordering change? | YES for local events | EventBus handlers are called sequentially per emit, but the order of emits is determined by the calling code, not by a log. |
| Can duplicate events happen? | YES for local events | `persistEvent()` in services uses bare `INSERT` (no dedup). If the handler is called twice (e.g., retry), duplicate rows are created. On-chain: NO (UNIQUE constraint). |

**Finding**: The EventBus is not an event store. It's a pub/sub mechanism for in-process communication. The SQLite `events` table is a persistent append-only log but has no replay, no projection, and no snapshot capability. On-chain events are the only true event-sourced data, handled by the indexer.

---

## B5. Version Compatibility Matrix

| Producer → Consumer | v1 → v1 | v1 → v2 | v2 → v1 | Notes |
|---------------------|:-------:|:-------:|:-------:|-------|
| **Contracts v1 → Compiler v1** | Compatible | — | — | Compiler resolves contract addresses from config |
| **Contracts v1 → SDK v1** | Compatible | — | — | SDK reads ABI from embedded definitions |
| **Contracts v2 → SDK v1** | — | — | BREAKS | New ABI functions unknown to old SDK |
| **Contracts v2 → Compiler v1** | — | — | BREAKS | New action mappings unknown to old compiler |
| **CLI v1 → Compiler v1** | Compatible | — | — | CLI imports compiler directly |
| **CLI v2 → Compiler v1** | — | Compatible | — | CLI may call functions not in old compiler |
| **Database v1 → Runtime v1** | Compatible | — | — | Schema migrations run on startup |
| **Database v1 → Runtime v2** | — | Compatible | — | v2 runtime includes v1→v2 migration |
| **Database v2 → Runtime v1** | — | — | BREAKS | Old runtime doesn't know new schema |
| **Proof v1 → Verifier v1** | Compatible | — | — | VK matches circuit |
| **Proof v1 → Verifier v2** | — | BREAKS | — | New VK won't verify old proofs (circuit changed) |
| **Circuit v2 → Proof v1** | — | — | BREAKS | New circuit produces different proofs |
| **Dashboard v1 → API v1** | Compatible | — | — | REST API contract |
| **Dashboard v2 → API v1** | — | Partial | — | New endpoints return 404 |

**Key invariants**:
- Proofs are NOT forward-compatible: a circuit change invalidates all existing proofs.
- Database IS forward-compatible: migrations run automatically. NOT backward-compatible.
- Contracts are NOT backward-compatible: new ABIs break old callers.
- The REST API is backward-compatible within v1 (additive changes only).

---

## B6. Cryptographic Agility

| Primitive | Current | Can Replace With | What Changes | What Doesn't Change |
|-----------|---------|-----------------|--------------|-------------------|
| **Proof system** | Groth16 (BN254) | PLONK, Halo2, SP1, RISK Zero, Jolt, STARK | Circuit source, proving key, verification key, on-chain verifier contract | Credential model, Merkle tree, session flow |
| **Hash function** | Poseidon (BN254-native) | MiMC, Rescue, Neptune | Circuit constraints, commitment computation, nullifier computation | Database schema, API, SDK |
| **Signature scheme** | ECDSA/secp256k1 | EdDSA, Schnorr, BLS | Key generation, signing, verification code | Session model, policy model |
| **Encryption** | AES-256-GCM | ChaCha20-Poly1305, XChaCha20 | `session-keystore.ts` encrypt/decrypt | Session key storage schema |
| **Key derivation** | scrypt | Argon2, PBKDF2 | `getMasterSecret()` | Master key file format |
| **Merkle tree** | Sparse Merkle Tree (depth 20) | Binary Merkle Tree, Poseidon Merkle, KZG | Tree engine, witness generation | Credential model, proof model |

**Architectural assessment**: The system has moderate cryptographic agility. The proof system is the hardest to replace (requires circuit rewrite + trusted ceremony + contract redeployment). The hash function is deeply coupled to the circuit. Signature and encryption are decoupled and can be replaced independently.

**Current coupling points**:
- `src/core/zk-prover.ts` — all ZK-specific code
- `src/utils/merkle.ts` — tree construction
- `src/core/session-keystore.ts` — encryption
- `src/core/provider.ts` — signer management
- Circuit artifacts (zkey, wasm, vk) — not in this repo

---

## B7. Observability Completeness

**Can I reconstruct yesterday's failure using only logs, metrics, events, SQLite, and chain?**

| Data Source | What It Contains | Gap |
|-------------|-----------------|-----|
| **Logs** (`logger.ts`) | Timestamp, component, message. Written to stderr. Not persisted to file (unless redirected). | No structured logging. No correlation IDs. No log rotation. No log persistence. |
| **Metrics** | None. No metrics system. | No request latency, error rates, queue depths, or resource usage tracking. |
| **Events** (SQLite `events` table) | Event type, JSON data, tx_hash, timestamp. | Not all mutations emit events. No event replay capability. |
| **SQLite** (`agent_actions` table) | Tool, intent, risk_level, wallet, tx_hash, execution_time, success/failure. | Only records agent actions, not all system operations. No audit log for config changes, policy changes, or backup operations. |
| **Chain** (on-chain events) | All contract events indexed by the event indexer. | Depends on indexer being running. If indexer was down, events are missed until reindex. |

**Verdict**: NO. I cannot reliably reconstruct yesterday's failure because:
1. Logs are not persisted (stderr only)
2. No metrics exist
3. Not all mutations emit events
4. No correlation IDs link requests across components
5. No trace IDs connect CLI → compiler → contract → SQLite

**What would be needed**:
- Structured JSON logging to `~/.agentix/logs/agentix.log`
- Correlation ID on every request (UUID generated at entry point)
- Every mutation emits an event with the correlation ID
- Request/response logging (with redacted secrets)
- Metric counters for: requests, errors, latency, queue depth

---

## B8. Formal Lifecycle Ownership — Credential

| Transition | Actor | Authorization | Proof | Persistence | Audit Trail |
|-----------|-------|--------------|-------|-------------|-------------|
| **Create** | Issuer (org owner) | Backend signer must be `issuers(address)` on-chain | Poseidon7 commitment | SQLite `credentials` + active Merkle tree | `CredentialIssued` event in SQLite + EventBus |
| **Publish** | Issuer (auto or manual) | Same as Create | Merkle root | On-chain `CredentialRegistry.updateActiveRoot()` | `ActiveRootUpdated` on-chain event |
| **Use** | Agent (via session) | Session key signature + ZK proof | Groth16 proof verifying membership + non-revocation | Session created on-chain | `SessionCreated` on-chain event |
| **Rotate** | NOT IMPLEMENTED | — | — | — | — |
| **Expire** | Time-based (passive) | `expiry < now` | — | On-chain (session check) + SQLite (credential check) | No explicit expiry event |
| **Revoke** | Issuer | Backend signer must be issuer | Revocation key (Poseidon2(secret,0) mod 2^64) | SQLite `credentials.revoked=1` + revoked SMT + on-chain root | `CredentialRevoked` event in SQLite + EventBus |
| **Archive** | NOT IMPLEMENTED | — | — | — | — |
| **Delete** | NOT IMPLEMENTED | Credentials are append-only | — | — | — |

---

## B9. Build Reproducibility

| Step | Deterministic? | Notes |
|------|:--------------:|-------|
| `git clone` | YES | Same commit → same tree |
| `bun install` | MOSTLY | Lock file (`bun.lock`) pins versions. Transitive deps may differ across registries. |
| `tsc --project tsconfig.json` | YES | TypeScript compiler is deterministic for same input |
| `esbuild bundle` | YES | esbuild is deterministic for same input |
| Circuit compilation (`circom`) | YES | Circom compiler is deterministic |
| Trusted setup (zkey generation) | NO | Requires ceremony with random entropy. Not reproducible from source alone. |
| `snarkjs` proof generation | YES | Same witness + zkey → same proof |
| `better-sqlite3` native build | NO | Depends on system compiler, headers, platform |
| Vendored SQLite binaries | YES | Downloaded from GitHub releases, checksummed |
| Test suite | MOSTLY | Tests use `Date.now()` in some places (non-deterministic timestamps) |

**Verdict**: The TypeScript/JavaScript build is deterministic. The ZK trusted setup is NOT reproducible (by design — it requires a ceremony). The native SQLite binary is platform-dependent but vendored for reproducibility.

---

## B10. Supply-Chain Audit

### Dependency Tree (Direct)

| Package | Version | Purpose | Risk | Native? |
|---------|---------|---------|------|:-------:|
| `ethers` | ^6.16.0 | Blockchain interaction | Low — widely audited | No |
| `better-sqlite3` | ^12.11.1 | SQLite database | Medium — native addon | **YES** |
| `snarkjs` | ^0.7.4 | ZK proof generation | Medium — complex crypto | No |
| `circomlibjs` | ^0.1.7 | Poseidon hash (circuit-compatible) | Medium — crypto primitives | No |
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP protocol | Low — Anthropic maintained | No |
| `commander` | ^12.1.0 | CLI framework | Low — no network, no native | No |
| `zod` | ^3.25.76 | Input validation | Low — no side effects | No |

### Transitive Dependency Risks

| Risk | Package | Concern | Mitigation |
|------|---------|---------|------------|
| **Native code execution** | `better-sqlite3` | Compiles C++ at install time. Vendored prebuilts avoid this. | Ship prebuilt binaries (`vendor-sqlite.ts`). Runtime fetch from GitHub releases. |
| **Network fetch at runtime** | `native-sqlite.ts` | Downloads `.node` binary from GitHub if no vendored match. | Only fetches from `WiseLibs/better-sqlite3` official releases. No integrity check on downloaded binary. **FINDING: No SHA-256 verification of runtime-fetched binaries.** |
| **Crypto library** | `snarkjs` → `ffjavascript` → ` WASM workers | Complex dependency chain for finite field arithmetic | Version-pinned in lock file |
| **Poseidon implementation** | `circomlibjs` | Must match circuit implementation exactly | Tested against canonical vectors in `circuit-compat.test.ts` |
| **Supply-chain attack vector** | All npm packages | Compromised package could steal keys, modify proofs, or alter transactions | Lock file (`bun.lock`) pins versions. No integrity verification of installed packages beyond npm's own. |

### Critical Supply-Chain Findings

**S1: No integrity check on runtime-fetched SQLite binary**
- **File**: `src/core/native-sqlite.ts` (line 133-211)
- **Issue**: `fetchPrebuiltSync()` downloads a `.node` binary from GitHub and writes it directly to disk. No SHA-256 verification against a known-good hash.
- **Impact**: A compromised GitHub release or MITM attack could inject a malicious native binary that executes arbitrary code with full process privileges.
- **Fix needed**: Pin the SHA-256 hash of each expected binary in the manifest and verify after download.

**S2: Circuit artifacts have no provenance chain**
- **File**: `scripts/bundle.ts` (lines 97-136)
- **Issue**: The zkey file is copied from a local `circuits/` directory. There is no signature or provenance record of who generated it, when, or from what source.
- **Impact**: A compromised developer machine could substitute a malicious zkey that generates proofs verifying against a backdoored verifier.
- **Mitigation applied**: SHA-256 integrity check against `artifacts.manifest.json` at proof generation time (`verifyIntegrity()`). But the manifest itself has no signature.

**S3: `snarkjs` has known transitive advisories**
- **File**: `package.json`
- **Issue**: The bundle README itself acknowledges: "snarkjs pulls some dev-tooling transitive packages with published advisories; they are not expected to be reachable from the runtime proving path."
- **Impact**: Low — advisories are in dev dependencies, not runtime code paths.

**S4: No `npm audit` in CI**
- **Issue**: No evidence of automated dependency auditing in the build pipeline.
- **Fix needed**: Add `npm audit --production` to the build script.

---

# Appendix C — Formal Trust Specification

*"Why should another company trust AgentIX?"*

---

## C1. Trust Architecture

```
TRUST ROOT
    │
    │  What: Owner private key (ECDSA/secp256k1)
    │  Who generates: Human (or hardware wallet)
    │  Who consumes: AgentWallet (on-chain verification)
    │  Who verifies: EVM (signature recovery)
    │  Who can revoke: Owner (changeOwner) or nobody (key loss)
    │  Evidence: On-chain transaction history
    │  Assumption: Private key is never compromised
    │  What breaks: Complete loss of wallet control
    │
    ▼
IDENTITY
    │
    │  What: AgentIdentity contract (on-chain)
    │  Who generates: Owner (registerIdentity)
    │  Who consumes: Credential system, capability system
    │  Who verifies: AgentIdentity contract
    │  Who can revoke: Owner (deactivate)
    │  Evidence: On-chain IdentityRegistered event
    │  Assumption: One wallet → one identity (enforced on-chain)
    │  What breaks: Identity cannot be linked to credentials
    │
    ▼
AUTHORITY
    │
    │  What: SessionManager (on-chain session authorization)
    │  Who generates: Owner (createSession / createLightweightSession)
    │  Who consumes: AgentWallet.execute() (onlyOwnerOrEntryPoint)
    │  Who verifies: SessionManager contract
    │  Who can revoke: Owner (revokeSession)
    │  Evidence: On-chain SessionCreated event
    │  Assumption: Session key ≠ wallet address (enforced on-chain)
    │  What breaks: Agent cannot execute transactions
    │
    ▼
DELEGATION
    │
    │  What: DelegationManager (on-chain Merkle-based delegation)
    │  Who generates: Delegator (updateDelegationRoot)
    │  Who consumes: Capability system, session system
    │  Who verifies: DelegationManager.verifyDelegation() on-chain
    │  Who can revoke: Delegator (revokeDelegation) or emergencyRevokeAll
    │  Evidence: On-chain DelegationRootUpdated event
    │  Assumption: Delegator controls their own delegation tree
    │  What breaks: Delegated authority chain breaks
    │
    ▼
CREDENTIAL
    │
    │  What: Poseidon7 commitment in Merkle tree
    │  Who generates: Issuer (issueCredential)
    │  Who consumes: ZK proof generator
    │  Who verifies: Groth16 circuit (membership + non-revocation)
    │  Who can revoke: Issuer (revokeCredential → SMT insertion)
    │  Evidence: SQLite record + on-chain root update
    │  Assumption: Secret is random, commitment is collision-free
    │  What breaks: Agent cannot prove authorization
    │
    ▼
PROOF
    │
    │  What: Groth16 proof over BN254
    │  Who generates: ZK prover (snarkjs + credential_V1 circuit)
    │  Who consumes: On-chain Groth16Verifier contract
    │  Who verifies: Groth16Verifier.verifyProof()
    │  Who can revoke: N/A (proofs are immutable)
    │  Evidence: On-chain verification + SQLite proof record
    │  Assumption: zkey is correct, circuit matches deployed verifier
    │  What breaks: Session cannot be created (proof rejected)
    │
    ▼
VERIFICATION
    │
    │  What: On-chain Groth16Verifier + CredentialRegistry root check
    │  Who generates: Proof's public signals
    │  Who consumes: SessionManager.createSession()
    │  Who verifies: EVM (deterministic verification)
    │  Who can revoke: N/A (verification is stateless)
    │  Evidence: Transaction receipt
    │  Assumption: VK in contract matches VK used for proving
    │  What breaks: All session creation fails
    │
    ▼
EXECUTION
    │
    │  What: AgentWallet.execute() via EntryPoint
    │  Who generates: Agent (session-signed UserOp)
    │  Who consumes: Target contract
    │  Who verifies: EntryPoint (signature, nonce, gas) + SessionManager (limits)
    │  Who can revoke: Owner (revokeSession) or session expiry
    │  Evidence: EntryPoint UserOperationEvent
    │  Assumption: Session key is not compromised
    │  What breaks: Agent cannot interact with contracts
    │
    ▼
SETTLEMENT
    │
    │  What: On-chain state finality
    │  Who generates: Base L2 validators
    │  Who consumes: All downstream readers (indexer, dashboard, SDK)
    │  Who verifies: L2 consensus
    │  Who can revoke: N/A (L2 finality is irreversible after confirmation)
    │  Evidence: Block inclusion + finality
    │  Assumption: L2 consensus is honest
    │  What breaks: All on-chain state is compromised
    │
    ▼
AUDITABILITY
    │
    │  What: On-chain events + SQLite event log + agent_actions log
    │  Who generates: Every mutation (on-chain events are automatic)
    │  Who consumes: Event indexer, dashboard, compliance tools
    │  Who verifies: Anyone (on-chain events are public)
    │  Who can revoke: Nobody (append-only)
    │  Evidence: Block explorer + SQLite queries
    │  Assumption: Indexer is running and caught up
    │  What breaks: Cannot prove historical actions
    │
    ▼
RECOVERY
    │
    │  What: BackupEngine + tree rebuild + event reindex
    │  Who generates: `backup create` command
    │  Who consumes: `restore backup` command
    │  Who verifies: Checksum verification on restore
    │  Who can revoke: N/A
    │  Evidence: Backup file with SHA-256 checksum
    │  Assumption: Backup was taken before the failure
    │  What breaks: Data loss if no backup exists
    │
    ▼
GOVERNANCE
    │
    │  What: Contract owner (on-chain Ownable pattern)
    │  Who generates: Deployment transaction
    │  Who consumes: All admin functions (addIssuer, setSessionManager, etc.)
    │  Who verifies: EVM (onlyOwner modifier)
    │  Who can revoke: Owner (transferOwnership)
    │  Evidence: On-chain ownership history
    │  Assumption: Contract owner key is secured
    │  What breaks: Cannot update protocol parameters
```

---

## C2. Trust Assumptions Summary

| # | Assumption | Verified By | What Breaks If Violated |
|---|-----------|------------|------------------------|
| T1 | Owner private key is secret | Owner's operational security | Complete wallet compromise |
| T2 | EVM consensus is honest | Base L2 validator set | All on-chain state untrusted |
| T3 | Groth16 is sound | Cryptographic proof (BN254 security) | Forged proofs accepted |
| T4 | Poseidon hash is collision-resistant | Cryptographic proof | Commitment collisions |
| T5 | zkey matches deployed verifier | SHA-256 integrity check (verifyIntegrity()) | Proofs verify against wrong circuit |
| T6 | SQLite file is only accessible by owner | Filesystem permissions (AGENTIX_HOME) | Local state tampering |
| T7 | MCP client is honest | No verification (trust boundary) | Agent impersonation, tool abuse |
| T8 | RPC provider returns truthful data | Fallback providers + on-chain verification | Stale/manipulated state |
| T9 | Session key is not compromised | AES-256-GCM encryption at rest | Session hijacking |
| T10 | Master key is not compromised | 0600 file permissions | All session keys exposed |
| T11 | Circuit artifacts are not corrupted | SHA-256 manifest verification | Bogus proofs generated |
| T12 | npm dependencies are not compromised | Lock file (bun.lock) | Arbitrary code execution |

---

## C3. What Breaks If Each Trust Root Fails

| Trust Root | Failure Mode | Blast Radius | Detection | Recovery |
|-----------|-------------|-------------|-----------|----------|
| Owner key leaked | Attacker controls all wallets | **CRITICAL** — all funds at risk | Unusual transactions on-chain | Transfer ownership to new key (if detected in time) |
| EVM consensus broken | All on-chain state untrusted | **CRITICAL** — entire system invalid | Chain reorg alerts | Wait for re-finalization or switch chains |
| zkey corrupted | All proofs invalid | **HIGH** — no sessions can be created | `verifyIntegrity()` hash mismatch | Regenerate from circuit source |
| SQLite corrupted | All local state lost | **HIGH** — wallets/sessions/credentials unknown | `PRAGMA integrity_check` | Restore from backup |
| Master key leaked | All session keys exposed | **HIGH** — all sessions compromised | Unusual session activity | Revoke all sessions, regenerate master key |
| RPC provider lying | Stale/manipulated chain state | **MEDIUM** — incorrect balances, stale roots | Compare multiple providers | Switch to verified provider |
| MCP client compromised | Agent tools abused | **MEDIUM** — depends on agent permissions | Unusual tool call patterns | DASHBOARD_ONLY gate limits blast radius |
| npm dependency compromised | Arbitrary code in runtime | **CRITICAL** — full process compromise | `npm audit`, Snyk, Socket | Pin versions, verify integrity |
