import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir, platform } from "os";
import { resolveMCPLaunchCommand, findMCPServerEntry } from "./base";
import { MCPEntry } from "./types";

/** Root of the AgentIX data dir (mirrors src/core/config.AGENTIX_HOME without importing it). */
function agentixHome(): string {
  return process.env.AGENTIX_HOME || join(homedir(), ".agentix");
}

/**
 * Universal MCP connector.
 *
 * Specific adapters (claude-code, cursor, …) cover the harnesses we know by name.
 * This module is the catch-all: it wires AgentIX into ANY harness that speaks
 * MCP, including ones we've never heard of, by operating on the three JSON
 * schemas the ecosystem actually uses — then, as a final fallback, prints a
 * copy-pasteable snippet the user can drop into any client by hand.
 *
 * The three known MCP config schemas:
 *   1. "mcpServers"  → { mcpServers: { <name>: { command, args, env } } }
 *                      Claude Desktop/Code, Cursor, Windsurf, Cline, Gemini, …
 *   2. "servers"     → { servers:    { <name>: { type:"stdio", command, args } } }
 *                      VS Code / GitHub Copilot.
 *   3. "mcp"         → { mcp:        { <name>: { type:"local", command:[bin,...args] } } }
 *                      OpenCode.
 */

export type MCPSchema = "mcpServers" | "servers" | "mcp";

export const MCP_KEY = "agentix";

/** Detect which schema a parsed config already uses. Falls back to "mcpServers". */
export function detectSchema(config: any): MCPSchema {
  if (config && typeof config === "object") {
    if (config.servers && typeof config.servers === "object") return "servers";
    if (config.mcp && typeof config.mcp === "object") return "mcp";
    if (config.mcpServers && typeof config.mcpServers === "object") return "mcpServers";
  }
  return "mcpServers";
}

/** Read the AgentIX entry from a parsed config, normalized to {command,args}, or null. */
export function readUniversalEntry(config: any, key = MCP_KEY): MCPEntry | null {
  if (!config || typeof config !== "object") return null;
  const raw = config.mcpServers?.[key] || config.servers?.[key] || config.mcp?.[key];
  if (!raw || typeof raw !== "object") return null;
  // OpenCode stores command as [bin, ...args]; normalize so callers can inspect it.
  if (Array.isArray(raw.command)) {
    const [command, ...args] = raw.command;
    return typeof command === "string" ? { command, args: args.filter((a: any) => typeof a === "string") } : null;
  }
  if (typeof raw.command !== "string") return null;
  return { ...raw, args: Array.isArray(raw.args) ? raw.args : [] };
}

function pathArgExists(entry: MCPEntry): boolean {
  const fileArg = (entry.args || []).find((a) => /[\\/]/.test(a) && /\.(js|ts|cjs|mjs)$/.test(a));
  return fileArg ? existsSync(fileArg.replace(/\\\\/g, "\\")) : true;
}

function universalEntryIsValid(entry: MCPEntry | null): boolean {
  if (!entry?.command) return false;
  if (entry.command === "agentix-mcp") return true;
  if (entry.command === "node" || entry.command === process.execPath || entry.command === "npx") {
    return pathArgExists(entry);
  }
  return true;
}

/** Write the AgentIX launch entry into a parsed config using the given schema (in place). */
export function applyUniversalEntry(config: any, entry: MCPEntry, schema: MCPSchema, key = MCP_KEY): void {
  if (schema === "servers") {
    if (!config.servers) config.servers = {};
    config.servers[key] = { type: "stdio", command: entry.command, args: entry.args || [] };
  } else if (schema === "mcp") {
    if (!config.mcp) config.mcp = {};
    config.mcp[key] = { type: "local", command: [entry.command, ...(entry.args || [])], enabled: true };
  } else {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[key] = entry;
  }
}

/**
 * Wire AgentIX into a single MCP config file, in whatever schema it already uses
 * (or a default for new files). Creates parent dirs and the file if needed.
 * Idempotent — re-running refreshes the entry to the current launch command.
 *
 * Returns success:false without modifying the file if no launchable MCP server
 * can be resolved (prevents writing stale/broken paths).
 */
export function connectConfigFile(
  configPath: string,
  opts: { schema?: MCPSchema; key?: string; agentixPath?: string } = {}
): { success: boolean; path: string; schema: MCPSchema; created: boolean; message: string } {
  const key = opts.key || MCP_KEY;
  let config: any = {};
  let created = true;
  if (existsSync(configPath)) {
    created = false;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e: any) {
      return { success: false, path: configPath, schema: "mcpServers", created: false,
        message: `Refusing to overwrite unparseable JSON: ${e.message}` };
    }
  }

  const schema = opts.schema || detectSchema(config);
  const existing = readUniversalEntry(config, key);
  if (universalEntryIsValid(existing)) {
    return {
      success: true, path: configPath, schema, created,
      message: `${configPath} already contains a launchable AgentIX MCP entry (${schema})`,
    };
  }

  const entry = resolveMCPLaunchCommand(opts.agentixPath || "");
  if (!entry) {
    return {
      success: false, path: configPath, schema, created,
      message: "No launchable MCP server found. Install @corven/agentix globally or build the project."
    };
  }

  try {
    applyUniversalEntry(config, entry, schema, key);
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { success: true, path: configPath, schema, created,
      message: `${created ? "Created" : "Updated"} ${configPath} (${schema})` };
  } catch (e: any) {
    return { success: false, path: configPath, schema, created, message: e.message };
  }
}

/**
 * Directories where MCP-supporting harnesses tend to keep their config, across
 * platforms. We scan these for files that already contain an MCP block so we can
 * wire in AgentIX even for harnesses we have no named adapter for.
 */
function discoveryRoots(): string[] {
  const home = homedir();
  const roots = new Set<string>([home, join(home, ".config")]);
  const p = platform();
  if (p === "win32") {
    const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    roots.add(appdata);
    roots.add(local);
  } else if (p === "darwin") {
    roots.add(join(home, "Library", "Application Support"));
  }
  return [...roots];
}

/** Filenames that are, or commonly hold, an MCP server block. */
const MCP_FILENAMES = [
  "mcp.json", "mcp_config.json", "settings.json", "config.json",
  "opencode.json", "claude_desktop_config.json", ".mcp.json",
];

/** True if a parsed JSON object contains a recognizable MCP server block. */
function hasMCPBlock(config: any): boolean {
  return !!(config && typeof config === "object" &&
    (config.mcpServers || config.servers || config.mcp));
}

/**
 * Discover MCP config files on disk by scanning known harness roots one level
 * deep (immediate child dirs plus a few well-known dotfiles). Returns every file
 * that already contains an MCP block — these are live harness configs we can wire.
 * Bounded (no recursive walk) so it stays fast and never wanders the whole disk.
 */
export function discoverMCPConfigs(): string[] {
  const found = new Set<string>();
  const home = homedir();

  // 1. Well-known top-level dotfiles that ARE the config (not in a subdir).
  for (const f of [".claude.json", ".mcp.json"]) {
    const p = join(home, f);
    if (safeHasMCP(p)) found.add(p);
  }

  // 2. Scan each root's immediate child dirs for the known MCP filenames.
  for (const root of discoveryRoots()) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const childDir = join(root, name);
      let isDir = false;
      try { isDir = statSync(childDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      for (const f of MCP_FILENAMES) {
        const p = join(childDir, f);
        if (safeHasMCP(p)) found.add(p);
      }
      // VS Code-style nested globalStorage/<ext>/mcp.json (one extra level).
      const gs = join(childDir, "User", "globalStorage");
      let exts: string[] = [];
      try { exts = readdirSync(gs); } catch { exts = []; }
      for (const ext of exts) {
        const p = join(gs, ext, "mcp.json");
        if (safeHasMCP(p)) found.add(p);
      }
    }
  }
  return [...found];
}

function safeHasMCP(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return hasMCPBlock(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return false;
  }
}

export interface UniversalConnectResult {
  wired: { path: string; schema: MCPSchema; created: boolean }[];
  failed: { path: string; message: string }[];
  snippet: string;
}

/**
 * Discover every MCP config on the machine and wire AgentIX into each. Optionally
 * accepts extra explicit paths (e.g. a project-local .mcp.json) to include.
 * Returns what was wired, what failed, and a manual snippet for anything missed.
 */
export function connectUniversal(extraPaths: string[] = []): UniversalConnectResult {
  const paths = new Set<string>([...discoverMCPConfigs(), ...extraPaths]);
  const wired: UniversalConnectResult["wired"] = [];
  const failed: UniversalConnectResult["failed"] = [];
  for (const path of paths) {
    const r = connectConfigFile(path);
    if (r.success) wired.push({ path: r.path, schema: r.schema, created: r.created });
    else failed.push({ path: r.path, message: r.message });
  }
  return { wired, failed, snippet: manualSnippet() };
}

/**
 * A copy-pasteable MCP server entry for any harness we can't wire automatically.
 * This is the ultimate fallback: it works with ANY MCP client, since the user
 * just drops it into whatever config that client documents.
 */
export function manualSnippet(key = MCP_KEY): string {
  const entry = resolveMCPLaunchCommand("");
  if (!entry) {
    return JSON.stringify({
      error: "No launchable MCP server found",
      fix: "npm install -g @corven/agentix",
    }, null, 2);
  }
  const block = { mcpServers: { [key]: entry } };
  return JSON.stringify(block, null, 2);
}

/** Absolute path to the resolved MCP server file, for diagnostics/UX. */
export function mcpServerPath(): string | null {
  return findMCPServerEntry();
}

/** Canonical location of the portable, harness-agnostic MCP config file. */
export function universalMCPFilePath(): string {
  return join(agentixHome(), "mcp.json");
}

export interface UniversalMCPFileResult {
  success: boolean;
  path: string;
  created: boolean;
  message: string;
}

/**
 * Write ONE portable MCP config file at ~/.agentix/mcp.json that ANY MCP client
 * can be pointed at, instead of mutating every harness's own config on the
 * machine. This is the non-destructive way to expose AgentIX: the file is
 * self-contained and owned by AgentIX, so regenerating it can never corrupt a
 * harness's settings (the previous machine-wide rewrite could, and did).
 *
 * The file uses the universal `mcpServers` schema, which Claude Code/Desktop,
 * Cursor, Windsurf, Cline, Gemini and most others accept directly; the CLI
 * prints how to point a client at it (env var, --mcp-config flag, or a one-line
 * copy into the client's own config).
 *
 * Idempotent: refreshes the entry to the current launch command each run.
 * Returns success:false (without writing) if no launchable server is resolved.
 */
export function writeUniversalMCPFile(key = MCP_KEY): UniversalMCPFileResult {
  const filePath = universalMCPFilePath();
  const entry = resolveMCPLaunchCommand("");
  if (!entry) {
    return {
      success: false, path: filePath, created: false,
      message: "No launchable MCP server found. Install @corven/agentix globally or build the project.",
    };
  }

  // Preserve any other servers already present in a prior AgentIX-managed file
  // so re-running never drops a user's manual additions to this file.
  let config: any = { mcpServers: {} };
  let created = true;
  if (existsSync(filePath)) {
    created = false;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        config = parsed;
        if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
      }
    } catch {
      // Unparseable — start fresh; this file is AgentIX-owned, safe to replace.
      config = { mcpServers: {} };
    }
  }

  config.mcpServers[key] = entry;

  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2));
    return {
      success: true, path: filePath, created,
      message: `${created ? "Created" : "Updated"} ${filePath}`,
    };
  } catch (e: any) {
    return { success: false, path: filePath, created, message: e.message };
  }
}
