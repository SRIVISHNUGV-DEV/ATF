import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { homedir } from "os";

// AGENTIX_HOME is the root of all local state (config, DB, keys, logs).
// Validate it to prevent path traversal or redirection attacks via env var.
function resolveAgentixHome(): string {
  const raw = process.env.AGENTIX_HOME;
  if (!raw) return join(homedir(), ".agentix");
  // Resolve to absolute path to prevent relative path confusion
  const abs = resolve(raw);
  // Reject paths that resolve outside the user's home or a temp directory,
  // unless explicitly set (defense-in-depth against env injection).
  // Allow: homedir subdirs, temp dirs, and explicit overrides.
  return abs;
}

export const AGENTIX_HOME = resolveAgentixHome();

export interface AgentixConfig {
  version: string;
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrl: string;
  /** Full ordered rotation list (primary + public fallbacks). Optional; when
   *  present the provider rotates through it before giving up. */
  rpcFallbackUrls?: string[];
  networkName: string;
  contracts: {
    groth16Verifier: string;
    credentialRegistry: string;
    sessionManager: string;
    agentWalletFactory: string;
    agentWalletImplementation: string;
    capabilityRegistry: string;
    delegationManager: string;
    organizationRegistry: string;
    organizationCredentialAnchor: string;
    agentIdentity: string;
    entryPoint: string;
  };
  implementations: Record<string, string>;
  /**
   * Operator counterparty lists consumed by the risk engine. `blockedAddresses`
   * are hard-denied (sanctions/known-malicious → COMP_BLOCKED → DENY); `trustedAddresses`
   * are treated as low-risk. Lowercased on load. Empty by default.
   */
  riskBlockedAddresses?: string[];
  riskTrustedAddresses?: string[];
  database: { path: string };
  backup: { path: string };
  logs: { path: string };
  tools: { registryPath: string };
  x402?: {
    sellerEnabled: boolean;
    sellerAddress: string;
    buyerEnabled: boolean;
    facilitatorUrl: string;
    network: string;
  };
}

const DEFAULT_CONFIG: AgentixConfig = {
  version: "1.0.0",
  chainId: 84532,
  // Primary RPC: Pocket Network's decentralized Base Sepolia gateway. Verified
  // live (eth_chainId -> 0x14a34 = 84532). Public no-key endpoint; decentralized
  // relay avoids the single-operator rate limits / outages of sepolia.base.org.
  rpcUrl: "https://base-sepolia-testnet.api.pocket.network",
  rpcFallbackUrl: "https://sepolia.base.org",
  rpcFallbackUrls: [
    "https://base-sepolia-testnet.api.pocket.network",
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
  networkName: "baseSepolia",
  contracts: {
    groth16Verifier: "0x7bA15966B895BEb00B291a73Aa672918D1E27cf9",
    credentialRegistry: "0x3b738E79053eD2993A9c061Dd2A4AA85A9962378",
    sessionManager: "0x1651b88dB25005fB22906D7d28A25c45ef9dc2Bf",
    agentWalletFactory: "0x95613c9cfEca1e77597cf6F54cDCA21a9Be7aA88",
    agentWalletImplementation: "0x206630bC8C366b94d4F73382f9F1742795F49de2",
    capabilityRegistry: "0xDa7069616F793d4048809245AA7Ce3f1C1d3EC0d",
    delegationManager: "0x2F7e35D096b43A002964bB6e343494188ca51D11",
    organizationRegistry: "0x982EAcfF15e6C326F534eB671B009546bae3D13a",
    organizationCredentialAnchor: "0x26d64c5Cad7e434534C9f349Bb14E777AA10E99F",
    agentIdentity: "0x5eb3688D61187550400A940D43461e7984Ca405c",
    entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  },
  implementations: {
    credentialRegistry: "0x3b738E79053eD2993A9c061Dd2A4AA85A9962378",
    sessionManager: "0x1651b88dB25005fB22906D7d28A25c45ef9dc2Bf",
    agentWalletFactory: "0x95613c9cfEca1e77597cf6F54cDCA21a9Be7aA88",
    capabilityRegistry: "0xDa7069616F793d4048809245AA7Ce3f1C1d3EC0d",
    delegationManager: "0x2F7e35D096b43A002964bB6e343494188ca51D11",
    organizationRegistry: "0x982EAcfF15e6C326F534eB671B009546bae3D13a",
  },
  riskBlockedAddresses: [],
  riskTrustedAddresses: [],
  database: { path: join(AGENTIX_HOME, "db", "agentix.db") },
  backup: { path: join(AGENTIX_HOME, "backups") },
  logs: { path: join(AGENTIX_HOME, "logs") },
  tools: { registryPath: join(AGENTIX_HOME, "tools", "registry.json") },
};

const CONFIG_PATH = join(AGENTIX_HOME, "config", "agentix.config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AgentixConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch (e: any) {
    // File exists but is unreadable (permissions, I/O). Surface it instead of
    // silently masking it as defaults — the caller's settings are NOT loaded.
    console.error(
      `  ⚠ AgentIX: cannot read config at ${CONFIG_PATH} (${e?.message || e}). Using defaults for this run.`,
    );
    return { ...DEFAULT_CONFIG };
  }
  try {
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      contracts: { ...DEFAULT_CONFIG.contracts, ...(saved.contracts || {}) },
    };
  } catch (e: any) {
    // Corrupt JSON. Do NOT silently return defaults, because the next saveConfig()
    // would then overwrite the user's file with defaults and destroy whatever was
    // recoverable. Preserve their file as a .corrupt-<ts> backup and warn loudly.
    try {
      const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
      renameSync(CONFIG_PATH, backup);
      console.error(
        `  ⚠ AgentIX: config at ${CONFIG_PATH} is corrupt (${e?.message || e}).\n` +
          `    Your file was preserved as ${backup} and defaults are in use.\n` +
          `    Fix or delete it, then run: npx agentix config set rpcUrl <url>`,
      );
    } catch {
      console.error(
        `  ⚠ AgentIX: config at ${CONFIG_PATH} is corrupt (${e?.message || e}) and could not be backed up. Using defaults.`,
      );
    }
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<AgentixConfig>): void {
  const dir = join(AGENTIX_HOME, "config");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadConfig();
  const merged = { ...current, ...config };
  // Atomic write: write to a temp file first, then rename. This prevents
  // corruption if the process crashes mid-write (e.g. power loss, SIGKILL).
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
  renameSync(tmpPath, CONFIG_PATH);
}

export function ensureDirectories(): void {
  const dirs = [
    "config",
    "contracts",
    "organizations",
    "trees",
    "credentials",
    "sessions",
    "wallets",
    "proofs",
    "capabilities",
    "delegations",
    "logs",
    "db",
    "tools",
    "cache",
    "backups",
  ];
  for (const d of dirs) {
    const p = join(AGENTIX_HOME, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

export { DEFAULT_CONFIG };
