# AgentIX Project and Security Audit

Date: 2026-08-08

## Executive assessment

AgentIX is a local-first control plane for AI-agent identities, credentials, ERC-4337
wallets, delegated sessions, policy/risk evaluation, and zero-knowledge credential
proofs. It exposes the same local state and workflows through a CLI, localhost REST API,
Next.js dashboard, TypeScript SDK, and MCP tools.

The project is valuable as a developer platform and testnet reference implementation. It
combines components that are usually fragmented: agent identity, wallet/session lifecycle,
credential Merkle trees, ZK proofs, transaction planning, policy checks, indexing, and AI
harness integration. Its best near-term use is controlled experimentation, internal agent
automation, protocol demos, and integration testing on Base Sepolia.

It is not yet an appropriate mainnet custody or multi-user security boundary. The current
design assumes one trusted OS user, trusted MCP clients, trusted SDK callers, trusted
credential issuers, and trusted contract administrators. Several security controls are
off-chain and can be bypassed by submitting transactions directly on-chain.

## System map

| Area | Location | Role |
| --- | --- | --- |
| CLI | `src/index.ts`, `src/tools/` | Setup, lifecycle management, diagnostics, backup, proof and transaction commands |
| Runtime API | `src/runtime/server.ts` | Loopback HTTP control plane for local state and operations |
| Dashboard | `apps/dashboard/` | Next.js operator UI; proxies requests to the runtime without exposing its token to browser code |
| MCP server | `src/mcp/server.ts` | Makes AgentIX tools available to AI coding/agent harnesses over stdio |
| SDK | `src/sdk/` | Direct ethers-based programmatic contract interface |
| Compiler | `packages/compiler/` | Ten-stage intent parsing, validation, capability resolution, policy generation, simulation, risk and plan pipeline |
| Bundler | `src/runtime/bundler*` | ERC-4337 UserOperation construction, risk gating and submission |
| Services | `packages/services/` | Organizations, credentials, wallets, sessions, proof and authority workflows |
| Persistence | `src/core/database.ts`, `packages/core/database/` | Local SQLite runtime state; SDK also has a separate JSON database |
| Trees and ZK | `src/trees/`, `packages/core/tree-engine/`, `src/core/zk-prover.ts` | Credential/revocation Merkle state and Groth16 proving |
| Indexer/events | `packages/indexer/`, `src/core/event-indexer.ts`, `packages/core/eventbus/` | On-chain event ingestion and local event routing |
| Smart contracts | `../contracts/src/` | Upgradeable registries, wallet factory, agent wallets, sessions, delegations, organizations and verifier |

## Trust boundaries

1. The operating-system account and `AGENTIX_HOME` filesystem are trusted.
2. The REST API is loopback-only and bearer-token protected. The token is stored in a
   permission-restricted runtime manifest.
3. The dashboard server is trusted to read that manifest and inject the bearer token.
4. MCP clients are fully trusted. MCP stdio has no AgentIX authentication or per-client
   authorization.
5. SDK callers are privileged and bypass compiler, policy and risk controls.
6. Contract owners, issuers, wallet-factory configuration and verifier artifacts are trusted.
7. Off-chain policy is advisory unless equivalent restrictions are enforced by contracts.

## What is working well

- Runtime binds to `127.0.0.1`, authenticates protected API routes, uses timing-safe token
  comparison, restricts browser origins, rate-limits clients, and caps request bodies.
- Runtime token and session keystore secret are written with restrictive permissions where
  the platform supports them.
- Session private keys use AES-256-GCM at rest and are not returned through MCP key generation.
- Core SQL access uses parameterized queries and SQLite WAL/busy-timeout handling.
- Owner-sensitive MCP operations such as plan approval and wallet creation are dashboard-only.
- The compiler and bundler include explicit policy/risk stages rather than directly executing
  natural-language requests.
- TypeScript compilation succeeds and the focused security/production suites pass.

## Findings

### Critical architectural risks

- MCP is not an authorization boundary. A compromised configured harness can invoke powerful
  tools, including session-signed bundler operations. Dashboard-only checks reduce exposure
  but do not provide harness identity or granular permissions.
- The SDK directly calls contracts and bypasses compiler, simulation, policy, approval and
  risk gates. It must be documented and deployed as a privileged administration interface.
- Off-chain policy can be bypassed by direct EntryPoint/contract submission. Only on-chain
  session and wallet restrictions are authoritative.
- Four independent trust roots exist: owner signer, machine keystore secret, API token and ZK
  verification key. There is no common identity binding or coordinated rotation/recovery.

### High-priority engineering risks

- SQLite foreign keys are disabled. Application checks can regress and leave orphaned or
  contradictory records. A versioned, transactional migration to enforced constraints is
  needed before multi-user operation.
- Credential issuance and Merkle root updates are not serialized per organization. Concurrent
  issuers/processes can race and temporarily publish a root that omits another issuance.
- The in-memory EventBus is not the source of truth. Process failure between emission and
  persistence can lose events.
- Runtime and SDK use different databases, so the same wallet can have divergent local state.
- There is no complete rotation workflow for encrypted session keys, API credentials, wallet
  ownership, or proving/verifying artifacts.
- `AgentWalletFactory` synchronously calls the configured `AgentIdentity` during wallet
  creation. A faulty configured identity contract can halt new wallet creation. This is an
  administrator/configuration availability risk rather than an unprivileged attack.

### Medium and operational risks

- Many API request bodies are still consumed as untyped objects. Canonical Zod schemas cover
  only selected high-value routes; every state-changing route should have strict schemas,
  unknown-key rejection, numeric bounds and address/hex validation.
- The API token grants broad local control with no scopes, expiry, per-operation approval or
  replay-resistant request signing.
- API rate limiting is process-local and keyed only by socket address. All dashboard traffic
  shares one loopback identity, and restart clears counters.
- Proof generation has an unavoidable root-freshness TOCTOU window. Submission correctly
  rejects a stale proof, but the runtime should detect root changes before returning success.
- Contract `AgentWallet.initialize` silently ignores ERC-1820 registration failure. This is
  primarily ERC-777 compatibility/observability risk, not wallet authorization compromise.
- Dependency vulnerability status is not established by local tests. Registry-backed audit,
  SBOM generation and lockfile scanning must be part of release CI.
- Existing security tests are shallow in several places: some only prove imports work, one API
  secret test silently skips when the server is unavailable, and there are no adversarial API
  authorization/origin/body-parser integration tests.

## Fixes applied in this audit

- Malformed non-empty JSON bodies now return HTTP 400 instead of silently becoming `{}`.
- Oversized bodies are classified as HTTP 413 instead of a generic internal error.
- Dashboard proxy failures no longer disclose the internal runtime target URL or raw fetch
  error details to browser clients.

## Current contract-audit status

The sibling contract package contains extensive Hardhat/Foundry, fuzz, invariant and
adversarial tests plus prior audit reports. Those reports are useful but not fully current:
the reported missing `SessionManager` wallet-factory events are already fixed in source.
Current unresolved source-level concerns include the synchronous identity-registration
availability dependency and silent ERC-1820 registration failure. Neither is a demonstrated
unprivileged asset-theft path.

Contract changes were not made in this pass because the active writable workspace is the
`agentix` package, while `../contracts` is outside that boundary. Any contract modification
also requires storage-layout review, full Foundry/Hardhat regression tests, ABI regeneration,
deployment migration planning and an independent audit before production use.

## Recommended release gates

1. Add authenticated MCP capability profiles and default-deny mutating tools for AI clients.
2. Route untrusted SDK/agent operations through one policy-enforced execution gateway.
3. Add strict schemas and adversarial integration tests for every mutating REST endpoint.
4. Serialize credential/tree mutations per organization and make root publication a durable job.
5. Unify persistence and introduce transactional migrations with foreign keys.
6. Implement key/token rotation, revocation, recovery and operator-visible audit trails.
7. Run dependency/SBOM scanning and secret scanning in CI on every release.
8. Repeat an independent Solidity audit against the exact deployment commit and artifacts.

## Verification performed

- `tsc --noEmit`: passed.
- Focused Vitest security and production-readiness suites: 25/25 passed.
- Manual source review covered runtime authentication/CORS/body handling, dashboard proxy,
  runtime-token storage, encrypted session-key storage, MCP sensitive-tool gates, compiler
  boundary, documented architecture limitations and current Solidity findings.

This is a source audit, not a guarantee that every vulnerability has been found. Mainnet use
requires deployment configuration review, dependency/secret scanning, live RPC and bundler
testing, contract bytecode verification, and independent adversarial review.
