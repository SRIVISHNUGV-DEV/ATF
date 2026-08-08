# AgentIX V1 — Local-First AI Agent Credential Protocol Runtime

## Overview

AgentIX is a local-first runtime for AI agent credential management, wallet orchestration,
and zero-knowledge proof generation. It provides a CLI, REST API, MCP server, and dashboard
for managing ERC-4337 wallets, sessions, credentials, and on-chain transactions on Base Sepolia.

## Quick Start

```bash
npm install
npx agentix init
npx agentix doctor
```

## Architecture

- **CLI** (`src/index.ts`) — Commander.js, 30+ commands
- **REST API** (`src/runtime/server.ts`) — localhost-bound HTTP server
- **MCP Server** (`src/mcp/server.ts`) — Model Context Protocol for AI harness integration
- **Dashboard** (`apps/dashboard/`) — Next.js web UI
- **SDK** (`src/sdk/`) — ethers.js direct contract interaction
- **Compiler** (`packages/compiler/`) — 10-stage intent-to-execution-plan pipeline
- **ZK Prover** (`src/core/zk-prover.ts`) — Groth16/BN254 proof generation

---

## Known Design Limitations

This section documents architectural decisions that have known trade-offs. Each describes
the limitation, why it exists, and what a future version should address.

### 1. Foreign Keys Disabled in SQLite

**Status**: Intentional, documented.

The SQLite database runs with `PRAGMA foreign_keys = OFF`. This means there is no
database-level referential integrity between tables (e.g., credentials can reference
non-existent organizations, sessions can reference non-existent wallets).

**Why**: Three reasons:
1. Existing production databases may contain orphan records from before the schema
   stabilized. Enabling FK would block all writes to those databases.
2. SQLite does not support `ALTER TABLE ADD CONSTRAINT` — adding FK requires table
   recreation, which risks data loss on existing deployments.
3. The `migrateOldSchema()` function copies data between tables during migration,
   which would violate FK constraints mid-operation.

**Mitigation**: Referential integrity is enforced at the application level in service
layers and tools. Critical write paths validate that referenced entities exist before
inserting.

**Future**: V2 should use a proper migration framework (e.g., Knex, Drizzle) that
supports FK-safe migrations with rollback.

### 2. Four Independent Roots of Trust

**Status**: Architectural, documented.

The system has four independent roots of trust that are never cross-validated:
1. **Owner private key** (`AGENTIX_PRIVATE_KEY` env var) — signs on-chain transactions
2. **Machine master secret** (`~/.agentix/keys/master.key`) — encrypts session keys at rest
3. **API bearer token** (`~/.agentix/runtime.json`) — authenticates REST API calls
4. **Groth16 verification key** (`circuits/build/verification_key.json`) — verifies ZK proofs

**Why**: These serve different purposes and have different lifecycle requirements. The
owner key is user-managed (possibly in a hardware wallet), the master secret is
machine-local, the API token is session-scoped, and the VK is circuit-specific.

**Risk**: A compromise of any one root does not automatically compromise the others,
but there is no mechanism to detect inconsistency (e.g., API token valid but owner key
changed).

**Future**: V2 should implement a unified identity binding that ties all four roots
to a single verifiable identity.

### 3. MCP Client Is Fully Trusted

**Status**: Architectural, documented.

The MCP protocol has no authentication or authorization layer. Any MCP client (Claude Code,
Cursor, Copilot, etc.) can call any MCP tool with arbitrary arguments. The DASHBOARD_ONLY
gate is a code-level convention enforced in the tool handler, not a security boundary.

**Why**: The MCP protocol specification does not define authentication. The DASHBOARD_ONLY
list is defense-in-depth, not a security guarantee.

**Risk**: A modified or malicious MCP client could:
- Call `agentix_keygen` (now returns address only, private key stored server-side)
- Call `agentix_bundler_send` with arbitrary calldata
- Call `agentix_compile_intent` to probe the risk engine
- Call `agentix_approve_plan` (now DASHBOARD_ONLY)

**Mitigations applied**:
- `agentix_keygen` no longer returns private keys through MCP
- `agentix_approve_plan` moved to DASHBOARD_ONLY
- `agentix_wallet_create` moved to DASHBOARD_ONLY
- `agentix_policy_set` requires owner signature

**Future**: V2 should implement MCP tool-level authentication (e.g., per-tool permissions
based on the harness identity).

### 4. SDK Bypasses Compiler, Risk Engine, and Policy Checks

**Status**: Architectural, documented.

The SDK (`src/sdk/`) calls smart contracts directly via ethers.js, completely bypassing:
- The 10-stage compiler pipeline
- The risk engine
- The owner policy system
- The bundler risk gate

**Why**: The SDK is designed for programmatic use by trusted code (e.g., backend services)
that manages its own authorization. It is not intended for use by AI agents.

**Risk**: Any code using the SDK can execute arbitrary transactions without risk assessment
or policy enforcement.

**Future**: V2 should either route SDK calls through the compiler gateway or explicitly
mark the SDK as a privileged interface with its own auth mechanism.

### 5. On-Chain and Off-Chain Limits Can Diverge

**Status**: Architectural, documented.

The system has two independent limit systems:
1. **On-chain**: SessionManager enforces `dailySpendLimit`, `dailyTxLimit`, `maxValue`
   per session. These are enforced by the EVM and cannot be bypassed.
2. **Off-chain**: Owner policy (`owner_policies` table) enforces `dailyLimit`, `perTxLimit`,
   `allowedTargets`, `forbiddenActions`. These are enforced only by the local runtime.

**Why**: On-chain limits are per-session and enforced by the EVM. Off-chain limits are
per-wallet and enforced by the local runtime. They serve different purposes.

**Risk**: A UserOp submitted directly to the EntryPoint (bypassing the local bundler)
would enforce on-chain limits but NOT off-chain policy. The local runtime could also
have a stale view of on-chain state.

**Future**: V2 should unify these into a single policy model that is enforced both
on-chain and off-chain.

### 6. EventBus Is In-Memory Only

**Status**: Design limitation, documented.

The EventBus (`packages/core/eventbus`) stores events in an in-memory array (max 1000).
Events are lost on process restart.

**Why**: The EventBus is designed for real-time event routing within a single process
lifetime. Persistent events are stored in the SQLite `events` table separately.

**Risk**: If a process crashes between emitting an event and persisting it to SQLite,
the event is lost. The event indexer (which polls on-chain events) provides eventual
consistency.

**Future**: V2 should use a persistent event log (e.g., SQLite-backed) as the primary
event store, with the in-memory bus as a cache.

### 7. Race Conditions in Concurrent Credential Issuance

**Status**: Known limitation, documented.

Two concurrent `issueCredential()` calls for the same organization can produce
inconsistent state:
1. Both compute commitments independently
2. Both insert into the credentials table (different agent_ids — no collision)
3. Both try to update the Merkle tree (tree state race)
4. Both try to update the active root on-chain (second overwrites first)

**Why**: The system is designed for single-operator use. Concurrent credential issuance
from multiple processes is not a supported use case.

**Mitigation**: The SQLite busy timeout (5000ms) serializes database writes. The on-chain
root update is a single transaction that succeeds atomically. The tree is rebuilt from
the credentials table on startup, which converges to the correct state.

**Future**: V2 should use database-level advisory locks or a job queue to serialize
credential issuance per organization.

### 8. No Key Rotation Mechanism

**Status**: Design limitation, documented.

None of the four roots of trust support rotation:
- Owner private key: requires manual `changeOwner()` on each wallet
- Machine master secret: changing it invalidates all encrypted session keys
- API token: regenerated on each server restart (not persisted across restarts by default)
- Verification key: requires redeploying the Groth16Verifier contract

**Future**: V2 should implement automated key rotation with grace periods.

### 9. Two Separate Database Systems

**Status**: Architectural, documented.

The runtime uses SQLite (`better-sqlite3`) for state persistence. The SDK uses a JSON
file database (`src/sdk/database.ts`) that writes to `.agentix/db.json`. These are
completely independent and can diverge.

**Why**: The SDK is a standalone library that doesn't depend on the runtime. It uses a
simple JSON file for portability.

**Risk**: If both the SDK and the runtime are used against the same wallet, their views
of wallet state can diverge.

**Future**: V2 should unify on SQLite or provide explicit synchronization between the two.

### 10. TOCTOU Gap in Merkle Root Freshness

**Status**: Known limitation, documented.

ZK proof generation reads the current on-chain Merkle root, then generates a proof
against it. Between reading the root and submitting the proof, another credential
issuance could update the root, causing the proof to verify against stale state.

**Why**: This is inherent to any system that generates proofs off-chain against on-chain
state. The window is typically seconds.

**Mitigation**: The on-chain verifier rejects proofs whose public signals don't match
the current root. The proof simply needs to be regenerated.

**Future**: V2 could implement a root-staleness check that aborts proof generation if
the root changes during computation.

---

## Security Model

### Authentication

| Interface | Mechanism |
|-----------|-----------|
| CLI | None (local process, filesystem ACL) |
| REST API | Bearer token (timing-safe comparison) |
| MCP Server | None (stdio transport, trust the client) |
| Dashboard | Bearer token (proxied through Next.js) |
| SDK | None (caller provides signer) |
| On-chain | ECDSA signatures (EIP-191, EIP-712) |

### Authorization

| Action | Who Can Do It | Where Enforced |
|--------|--------------|----------------|
| Set owner policy | Wallet owner (EIP-191 signature required) | Application level |
| Create session | Wallet owner (via dashboard) | DASHBOARD_ONLY gate + on-chain |
| Revoke session | Wallet owner (via dashboard) | DASHBOARD_ONLY gate + on-chain |
| Approve plan | Human (via dashboard) | DASHBOARD_ONLY gate |
| Create wallet | Human (via dashboard) | DASHBOARD_ONLY gate |
| Issue credential | Issuer (on-chain) | Smart contract onlyIssuer |
| Execute transaction | Session key or owner key | On-chain onlyOwnerOrEntryPoint |

### Cryptographic Primitives

| Primitive | Use | Library |
|-----------|-----|---------|
| Groth16/BN254 | Credential proofs | snarkjs |
| Poseidon | Commitment, nullifier, revocation key | circomlibjs |
| AES-256-GCM | Session key encryption at rest | Node.js crypto |
| ECDSA/secp256k1 | Transaction signing, policy signing | ethers.js |
| SHA-256 | Artifact integrity, backup checksums | Node.js crypto |
| scrypt | Master secret derivation from env var | Node.js crypto |

---

## Development

```bash
bun install
bun run dev          # Start API server + dashboard
bun run test         # Run all tests
bun run test:unit    # Run unit tests only
bun run build        # Build for production
```

## License

BUSL-1.1 — see LICENSE file.
