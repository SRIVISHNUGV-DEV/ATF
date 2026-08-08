import { build } from "esbuild";
import { rmSync, mkdirSync, existsSync, cpSync, writeFileSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");
const DIST = join(ROOT, "dist-publish");

function copyIfExists(srcRel: string, dstRel = srcRel): boolean {
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) return false;
  cpSync(src, join(DIST, dstRel), {
    recursive: true,
    filter: (p) => {
      const normalized = p.replace(/\\/g, "/");
      return !/(^|\/)node_modules(\/|$)/.test(normalized) &&
        !/(^|\.)tsbuildinfo$/.test(normalized) &&
        !/(^|\/)dist(\/|$)/.test(normalized) &&
        !/(^|\/)dist-publish(\/|$)/.test(normalized);
    },
  });
  return true;
}

async function main() {
  console.log("Cleaning dist-publish/...");
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const sharedConfig = {
    bundle: true,
    platform: "node" as const,
    target: "node18" as const,
    format: "cjs" as const,
    external: ["better-sqlite3"],
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: false,
    minify: false,
  };

  console.log("Bundling src/index.ts (CLI)...");
  await build({
    ...sharedConfig,
    entryPoints: [join(ROOT, "src/index.ts")],
    outfile: join(DIST, "index.js"),
    banner: { js: "#!/usr/bin/env node" },
  });

  console.log("Bundling src/mcp/server.ts (MCP server)...");
  await build({
    ...sharedConfig,
    entryPoints: [join(ROOT, "src/mcp/server.ts")],
    outfile: join(DIST, "mcp.js"),
  });

  console.log("Bundling src/runtime/server.ts (API server)...");
  await build({
    ...sharedConfig,
    entryPoints: [join(ROOT, "src/runtime/server.ts")],
    outfile: join(DIST, "server.js"),
  });

  // Copy bin scripts
  console.log("Copying bin scripts...");
  cpSync(join(ROOT, "bin"), join(DIST, "bin"), { recursive: true });

  // Ship TypeScript source alongside bundled entrypoints. The package still runs
  // through index.js/mcp.js/server.js, but sources are part of the public artifact
  // for inspection, debugging, and source-path MCP fallbacks.
  console.log("Copying TypeScript source files...");
  for (const dir of ["src", "packages"]) {
    if (!copyIfExists(dir)) throw new Error(`Required source directory missing: ${dir}`);
  }
  for (const file of ["tsconfig.json", "bun.lock"]) {
    if (copyIfExists(file)) console.log(`  ✓ ${file} copied`);
  }

  // Copy vendored better-sqlite3 prebuilt binaries. These are loaded at runtime
  // via the `nativeBinding` option (src/core/native-sqlite.ts), so the package
  // works without better-sqlite3's install-time script — which npm v12 no longer
  // runs by default. The bundled index.js resolves vendor/ relative to itself.
  console.log("Copying vendored better-sqlite3 binaries...");
  const VENDOR_SRC = join(ROOT, "vendor", "better-sqlite3");
  const VENDOR_DST = join(DIST, "vendor", "better-sqlite3");
  if (!existsSync(VENDOR_SRC)) {
    throw new Error(
      `vendor/better-sqlite3 missing — run "bun run scripts/vendor-sqlite.ts" first. ` +
        `Without it the published package cannot open its database.`,
    );
  }
  cpSync(VENDOR_SRC, VENDOR_DST, { recursive: true });
  const vendorManifest = JSON.parse(readFileSync(join(VENDOR_SRC, "manifest.json"), "utf8"));
  const vendorCount = Object.keys(vendorManifest.binaries || {}).length;
  console.log(`  ✓ ${vendorCount} SQLite binaries bundled (better-sqlite3@${vendorManifest.version})`);

  // Copy ZK circuit artifacts so the published package can prove standalone.
  // zk-prover resolves circuits/ by walking up from the bundle, so shipping them
  // at dist-publish/circuits/ makes proving work with zero extra setup.
  console.log("Copying ZK circuit artifacts...");
  const CIRCUITS_SRC = join(ROOT, "..", "circuits");
  const CIRCUITS_DST = join(DIST, "circuits");
  const artifactPaths = [
    "artifacts.manifest.json",
    join("prover", "credential_V1_final.zkey"),
    join("prover", "credential_V1_js", "credential_V1.wasm"),
    join("build", "verification_key.json"),
  ];
  let copied = 0;
  for (const rel of artifactPaths) {
    const src = join(CIRCUITS_SRC, rel);
    const dst = join(CIRCUITS_DST, rel);
    if (!existsSync(src)) {
      console.warn(`  ⚠ missing artifact, skipped: ${rel}`);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    copied++;
  }
  if (copied < artifactPaths.length) {
    // Fail hard: a package shipped without its circuit artifacts silently loses
    // ZK proving. Better to block the publish than to ship a broken release.
    // Set AGENTIX_ALLOW_PARTIAL_BUNDLE=1 to override (e.g. a CLI-only build).
    const msg =
      `Only ${copied}/${artifactPaths.length} circuit artifacts copied — ` +
      `the published package could NOT generate ZK proofs. Aborting bundle. ` +
      `Set AGENTIX_ALLOW_PARTIAL_BUNDLE=1 to override.`;
    if (process.env.AGENTIX_ALLOW_PARTIAL_BUNDLE === "1") {
      console.warn(`  ⚠ ${msg}`);
    } else {
      throw new Error(msg);
    }
  } else {
    console.log(`  ✓ ${copied} circuit artifacts bundled`);
  }

  // Copy the Next.js dashboard (source + build) so `agentix stack start` can
  // serve it. The .next directory contains the production build; the source is
  // included for inspection and for `next dev` in development mode.
  console.log("Copying dashboard (Next.js app)...");
  const DASHBOARD_SRC = join(ROOT, "apps", "dashboard");
  const DASHBOARD_DST = join(DIST, "apps", "dashboard");
  if (existsSync(DASHBOARD_SRC)) {
    cpSync(DASHBOARD_SRC, DASHBOARD_DST, {
      recursive: true,
      filter: (p) => {
        const normalized = p.replace(/\\/g, "/");
        return !/(^|\/)node_modules(\/|$)/.test(normalized) &&
          !/(^|\/)tsbuildinfo$/.test(normalized) &&
          !/(^|\/)cache(\/|$)/.test(normalized) &&
          !/(^|\/)\.commandcode(\/|$)/.test(normalized);
      },
    });
    console.log("  ✓ dashboard copied (source + .next build)");
  } else {
    console.warn("  ⚠ apps/dashboard not found — stack start will not serve a dashboard");
  }

  // Generate publish package.json — version tracks root package.json so the
  // published artifact can never drift from the source of truth (it did: root
  // was bumped while this literal stayed behind).
  console.log("Generating publish package.json...");
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const publishPkg = {
    name: "@corven/agentix",
    version: rootPkg.version,
    publishConfig: { access: "public" },
    description: "Local-first AI agent execution engine. Smart wallets, sessions, credentials, and risk-bound execution for AI agents on Base Sepolia.",
    bin: {
      agentix: "bin/agentix",
      "agentix-mcp": "bin/agentix-mcp",
    },
    files: [
      "index.js", "mcp.js", "server.js",
      "bin/", "src/", "packages/", "apps/",
      "circuits/", "vendor/", "tsconfig.json", "bun.lock",
    ],
    dependencies: {
      "better-sqlite3": "^12.11.1",
      "@modelcontextprotocol/sdk": "^1.29.0",
      "ethers": "^6.13.4",
      "snarkjs": "^0.7.5",
      "circomlibjs": "^0.1.7",
      "zod": "^3.25.76",
      "commander": "^12.1.0",
      "next": "^14.2.0",
      "react": "^18.3.0",
      "react-dom": "^18.3.0",
      "@tanstack/react-query": "^5.60.0",
      "ethers5": "npm:ethers@^5.8.0",
      "lucide-react": "^0.460.0",
      "class-variance-authority": "^0.7.1",
      "clsx": "^2.1.1",
      "tailwind-merge": "^2.6.0",
      "framer-motion": "^11.12.0",
    },
    // We ship prebuilt better-sqlite3 binaries for Node 22 (ABI 127) and Node 24
    // (ABI 137). Other versions fall back to better-sqlite3's own resolution,
    // which under npm v12 requires a source build (C toolchain).
    engines: { node: ">=18.0.0" },
    license: "MIT",
    keywords: ["ai-agent", "wallet", "credential", "web3", "erc4337", "zkp", "mcp", "agent-security"],
  };

  writeFileSync(join(DIST, "package.json"), JSON.stringify(publishPkg, null, 2));

  // Copy LICENSE so npm doesn't warn and the MIT grant ships with the package.
  // (This dir is wiped on every build; without this the LICENSE had to be re-copied
  // by hand after each bundle — automating it removes that recurring miss.)
  const licenseSrc = join(ROOT, "LICENSE");
  if (existsSync(licenseSrc)) {
    cpSync(licenseSrc, join(DIST, "LICENSE"));
    console.log("  ✓ LICENSE copied");
  } else {
    console.warn("  ⚠ LICENSE not found at repo root — publishing without it");
  }

  // Fix bin scripts to point to bundled files.
  // unbuilt native dependency (better-sqlite3 is the only native one) surfaces
  // an actionable message instead of a raw stack trace — keeping the CLI usable
  // out of the box even when a prebuilt binary didn't land.
  const shim = (entry: string) => `#!/usr/bin/env node
try {
  require('${entry}');
} catch (e) {
  if (e && (e.code === 'MODULE_NOT_FOUND' || /better-sqlite3|Could not locate the bindings/.test(String(e.message)))) {
    console.error('');
    console.error('  AgentIX could not load a required module (' + (e.message || e) + ').');
    console.error('  AgentIX ships prebuilt SQLite binaries for Node 22 and 24.');
    console.error('  Fix: run AgentIX on Node 22 or 24, or set AGENTIX_SQLITE_BINDING to a built better_sqlite3.node.');
    console.error('');
    process.exit(1);
  }
  throw e;
}
`;
  writeFileSync(join(DIST, "bin", "agentix"), shim("../index.js"));
  writeFileSync(join(DIST, "bin", "agentix-mcp"), shim("../mcp.js"));

  // Write README
  writeFileSync(join(DIST, "README.md"), `# AgentIX

Local-first runtime for AI agents on Base Sepolia: local SQLite state, MCP tools,
ERC-4337 smart-wallet workflows, credential/proof helpers, and risk-aware action
compilation. This package is the npm runtime artifact for \`@corven/agentix\`.

This README is intentionally explicit about what is included, what is beta, and
what is not shipped in the npm package.

## Install / Run

\`\`\`bash
npx @corven/agentix setup
# or, after global install:
npm i -g @corven/agentix
agentix setup
\`\`\`

The package exposes two binaries:

- \`agentix\` - CLI for setup, diagnostics, local runtime operations, MCP wiring,
  wallet/session/credential helpers, proof helpers, and stack/API commands.
- \`agentix-mcp\` - stdio MCP server for AI coding clients.

Data is local by default:

- \`~/.agentix/config/agentix.config.json\` - config
- \`~/.agentix/db/agentix.db\` - SQLite database
- \`~/.agentix/backups/\` - backups
- \`~/.agentix/logs/\` - logs

Set \`AGENTIX_HOME=/path/to/dir\` to relocate all runtime state.

## What Ships In This Npm Package

Included in the published package:

- Bundled Node entrypoints: \`index.js\`, \`mcp.js\`, \`server.js\`.
- CLI shims: \`bin/agentix\`, \`bin/agentix-mcp\`.
- TypeScript source: \`src/\` and \`packages/\` for inspection/debugging.
- ZK proving artifacts needed by the runtime:
  - \`circuits/prover/credential_V1_final.zkey\`
  - \`circuits/prover/credential_V1_js/credential_V1.wasm\`
  - \`circuits/build/verification_key.json\`
  - \`circuits/artifacts.manifest.json\`
- Vendored \`better-sqlite3\` native binaries for Node 22 and Node 24 on common
  macOS/Linux/Windows x64/arm64 targets.
- Runtime dependencies for CLI, MCP, SQLite, ethers, snarkjs, circomlibjs, zod,
  and commander.

Not included in the npm package:

- The Next.js dashboard application source/build under \`apps/dashboard\`.
- The source repo's development scripts except the bundled runtime behavior.
- A hosted cloud backend.
- Private keys, funded accounts, API keys, or production RPC credentials.
- Mainnet deployments.

## Requirements

- Node.js 18 or newer.
- Recommended: Node 22 or Node 24. These are the Node ABIs with shipped
  prebuilt SQLite binaries.
- If your Node/platform has no matching SQLite binary, either use Node 22/24 or
  set \`AGENTIX_SQLITE_BINDING\` to a locally built \`better_sqlite3.node\`.
- Network: Base Sepolia RPC. Public RPC fallbacks are configured by default;
  provider keys are optional for higher rate limits.

## Current Network / Contract Scope

AgentIX is currently wired for Base Sepolia only:

- Chain ID: \`84532\`
- Default public RPC rotation includes Pocket, Base, PublicNode, and dRPC Base
  Sepolia endpoints.
- Contract addresses are embedded in the default config and can be printed with:

\`\`\`bash
npx @corven/agentix contracts
\`\`\`

Mainnet is not supported by this package today.

## Main Commands

\`\`\`bash
npx @corven/agentix setup              # interactive/non-interactive first-run setup
npx @corven/agentix init               # initialize local dirs/db/config
npx @corven/agentix connect            # write MCP config and wire detected clients
npx @corven/agentix connect --print    # print copy-paste MCP JSON
npx @corven/agentix doctor             # comprehensive diagnostics
npx @corven/agentix health             # quick health check
npx @corven/agentix diagnostics        # diagnostic sections
npx @corven/agentix config show        # show local config
npx @corven/agentix rpc                # test configured RPC
npx @corven/agentix contracts          # print Base Sepolia contract addresses
npx @corven/agentix protocol           # protocol notes built into the CLI
\`\`\`

Domain commands exposed by the CLI:

\`\`\`bash
npx @corven/agentix org <create|get|list|deactivate|reactivate>
npx @corven/agentix cred <issue|revoke|get|list>
npx @corven/agentix session <create|validate|revoke|get|list>
npx @corven/agentix wallet <create|get|whitelist|execute|batch|deposit|withdraw>
npx @corven/agentix tree <status|rebuild|export|import|snapshot|restore>
npx @corven/agentix delegation <create|revoke|get|list>
npx @corven/agentix capability <register|revoke|get|list>
npx @corven/agentix proof <generate|verify|list>
npx @corven/agentix backup <create|list|restore|export|import>
npx @corven/agentix fund --network baseSepolia --amount 10
npx @corven/agentix stack <start|status>
npx @corven/agentix agent <create|wallet|session|whitelist|execute|balance|deposit|delegation|list>
npx @corven/agentix compile <intent-file>
npx @corven/agentix plans
npx @corven/agentix plan <plan-id>
\`\`\`

## MCP Integration

Start the MCP server directly:

\`\`\`bash
npx @corven/agentix mcp
# or
npx agentix-mcp
\`\`\`

Generate MCP config:

\`\`\`bash
npx @corven/agentix connect --print
\`\`\`

\`setup\` and \`connect\` write a portable AgentIX-owned MCP config at
\`~/.agentix/mcp.json\`. \`connect\` also attempts to wire detected MCP clients and
known harnesses when possible.

Named harness adapters exist for:

- Claude Code
- MimoCode
- OpenCode
- GitHub Copilot / VS Code MCP config shape
- Hermes
- Cursor
- Gemini
- OpenClaude

The universal connector also understands the common \`mcpServers\`, \`servers\`,
and \`mcp\` JSON shapes.

## MCP Tools: What Exists

The MCP server currently declares 71 tools. Most are read/query/compile helpers;
some submit transactions or create local/on-chain objects if configured with the
required keys and funded accounts.

Implemented non-dashboard MCP categories:

- System/config/RPC: health, stats, contracts, diagnostics, RPC test, protocol
  docs, config get/show.
- Wallet/identity: create wallet, owner execute, list/get/balance, identity get.
- Sessions: list, validate, find sessions by session key, session status.
- Organizations: list/get/get anchor.
- Credentials: list/get/history/nullifier check/oracle state.
- Capabilities: list/get/on-chain verify.
- Delegations: list, verify, verify chain, get root.
- Trees/proofs/events/logs: tree status, proof list/verify, events, session logs.
- Harnesses: scan and list detected harnesses.
- Transactions: list/get transaction history.
- Bundler: session-signed send, submit signed UserOp, status, flush, address.
- Agent key: generate key pair.
- Onboarding/funding: onboarding status, fund recommendations.
- Stack: start/status.
- Compiler/plans/policy: parse intent, compile intent, get/list/approve plan,
  policy get/check, capability envelope.

Dashboard-only MCP tools are intentionally blocked and return a \`DASHBOARD_ONLY\`
message instead of mutating owner state from an agent context:

- \`agentix_session_create\`
- \`agentix_session_revoke\`
- \`agentix_session_prune\`
- \`agentix_wallet_whitelist\`
- \`agentix_wallet_execute_batch\`
- \`agentix_config_set\`
- \`agentix_backup_create\`
- \`agentix_policy_set\`

## What Works Out Of The Box

With no private keys and no provider keys, a fresh install can:

- Create local config, directories, SQLite database, logs, and backup paths.
- Use public Base Sepolia RPC fallbacks.
- Run diagnostics and health checks.
- Start the MCP server.
- Generate MCP config for clients.
- Query local state tables.
- Compile/inspect intents and plans locally.
- Generate local agent key pairs.
- Show contract addresses and protocol documentation.
- Generate/list local backups once local state exists.
- Generate ZK proofs if the required local credential inputs exist, because the
  proving key and wasm are shipped.

## What Requires External Setup

These flows are present in code but require real external preconditions:

- On-chain writes require Base Sepolia ETH and configured signer/private key
  environment variables where the specific command/tool expects them.
- Wallet deployment/execution requires a working RPC, funded operator/bundler or
  owner path, and valid contract state.
- Organization approval/credential issuance assumes the deployed Base Sepolia
  contracts and authority flow are available.
- ZK credential/session flows require valid credential records and matching on-chain
  roots; the package ships proving artifacts, not pre-issued credentials.
- Higher reliability requires your own RPC provider key; public endpoints can rate
  limit or fail.

## What Does Not Exist / Not Supported Yet

- No mainnet support.
- No hosted service or cloud sync.
- No bundled Next.js dashboard in the npm artifact. The source repo contains a
  dashboard, but this npm package ships the CLI/API/MCP runtime, not the dashboard
  app. In a published install, \`stack start\` can start the bundled API server;
  a dashboard URL may not exist unless running from the source checkout.
- No production custody guarantee. Treat wallet/private-key flows as beta and use
  testnet funds only unless you have independently audited the contracts and runtime.
- No automatic purchase of ETH. \`fund\` only returns official provider/faucet links.
- No private-key storage magic for every flow. Some owner/operator paths require
  environment variables or explicit arguments.
- No guarantee every AI client accepts auto-wiring. MCP clients use different config
  formats; \`connect --print\` is the fallback.
- No claim that transitive dependencies are advisory-free. \`snarkjs\` pulls some
  dev-tooling transitive packages with published advisories; they are not expected
  to be reachable from the runtime proving path, but this remains upstream debt.

## Security Notes

- The local API server binds to \`127.0.0.1\` and is intended for local use only.
  Do not expose it to a network.
- The local API has no user authentication; local processes/browser pages that can
  reach it may trigger local runtime actions.
- Never commit \`.agentix\`, private keys, RPC keys, backups, or generated wallet
  material.
- The MCP server gives AI clients access to AgentIX tools. Only wire clients you
  trust with that local capability surface.
- This is Base Sepolia/testnet-oriented software. Use test funds.

## Package Audit Snapshot

This README describes package version \`${rootPkg.version}\` as generated by
\`bun run bundle\`.

Verified during packaging:

- The generated package manifest exposes \`agentix\` and \`agentix-mcp\` bins.
- The package allowlist includes bundled JS, TypeScript source, ZK artifacts,
  vendored SQLite binaries, and lock/config files needed for debugging.
- MCP tool declarations have handlers, except for the intentionally dashboard-only
  blocked tools listed above.
- The bundle/test pipeline is expected to pass with \`bun run build\` and
  \`bun run test\` from the source checkout before publishing.

## License

MIT
`);

  // Stats
  const indexSize = statSync(join(DIST, "index.js")).size;
  const mcpSize = statSync(join(DIST, "mcp.js")).size;
  const serverSize = statSync(join(DIST, "server.js")).size;
  const totalMB = ((indexSize + mcpSize + serverSize) / 1024 / 1024).toFixed(1);

  console.log(`\nDone! dist-publish/ ready for npm publish.`);
  console.log(`  CLI:      ${(indexSize / 1024).toFixed(0)} KB`);
  console.log(`  MCP:      ${(mcpSize / 1024).toFixed(0)} KB`);
  console.log(`  Server:   ${(serverSize / 1024).toFixed(0)} KB`);
  console.log(`  Total:    ${totalMB} MB`);
  console.log(`  Run: cd dist-publish && npm publish`);
  console.log(`  Users: npx agentix setup`);
}

main().catch((e) => { console.error(e); process.exit(1); });

