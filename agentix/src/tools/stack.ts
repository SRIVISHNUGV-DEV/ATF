/**
 * stack.ts — start/inspect the AgentIX local stack (API server + dashboard).
 *
 * The heavy lifting lives in scripts/serve.ts, which starts the API server
 * first (letting it pick a free port near 3001), records the port in
 * AGENTIX_HOME/runtime.json, then starts the Next.js dashboard on a free port
 * near 3000 pointed at the real API URL. This module wraps that launcher so it
 * can be driven programmatically (from the MCP server or CLI) and reports the
 * resolved URLs.
 *
 * Idempotency: before spawning anything we probe the runtime manifest and hit
 * the API's /api/health. If the stack is already live we return the existing
 * URLs instead of starting a duplicate.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { readRuntimeManifest } from "../core/ports";

export interface StackStatus {
  running: boolean;
  dashboardUrl?: string;
  apiUrl?: string;
  host?: string;
  apiPort?: number;
  dashboardPort?: number;
  apiPid?: number;
  message: string;
}

export interface StackStartResult extends StackStatus {
  alreadyRunning: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Probe a URL's /api/health; true if it answers 200 within the timeout. */
async function apiHealthy(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the AgentIX package root that contains scripts/serve.ts and
 * apps/dashboard. In the dev tree this walks up from this file; in a bundled
 * install those scripts aren't present and we say so explicitly.
 */
function findPackageRoot(): string | null {
  // From src/tools/stack.ts, the package root is two levels up. When bundled to
  // dist-publish/index.js, __dirname is the bundle dir. Check a few candidates.
  const candidates = [
    resolve(__dirname, "..", ".."), // src/tools -> package root (dev)
    resolve(__dirname, ".."), // bundle/.. 
    resolve(__dirname), // bundle dir
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "scripts", "serve.ts")) && existsSync(join(dir, "apps", "dashboard"))) {
      return dir;
    }
  }
  return null;
}

/**
 * Read the current stack status from the runtime manifest and verify the API
 * is actually answering. Returns running:false if nothing is up.
 */
export async function getStackStatus(): Promise<StackStatus> {
  const manifest = readRuntimeManifest();
  const host = manifest.host || "127.0.0.1";
  if (!manifest.apiPort) {
    return { running: false, message: "AgentIX stack is not running (no runtime manifest)." };
  }
  const apiUrl = `http://${host}:${manifest.apiPort}`;
  const healthy = await apiHealthy(apiUrl);
  if (!healthy) {
    return {
      running: false,
      message: "Runtime manifest exists but the API is not responding — the stack is not running (stale manifest).",
    };
  }
  const dashboardUrl = manifest.dashboardPort
    ? `http://${host}:${manifest.dashboardPort}`
    : undefined;
  return {
    running: true,
    dashboardUrl,
    apiUrl,
    host,
    apiPort: manifest.apiPort,
    dashboardPort: manifest.dashboardPort,
    apiPid: manifest.apiPid,
    message: dashboardUrl
      ? `AgentIX is running. Dashboard: ${dashboardUrl} — API: ${apiUrl}`
      : `AgentIX API is running at ${apiUrl} (dashboard port not yet recorded).`,
  };
}

/**
 * Start the local stack if it isn't already running. Spawns scripts/serve.ts
 * detached so it outlives the caller, then polls the runtime manifest until
 * both the API and dashboard ports are published (or a timeout elapses).
 */
export async function startStack(opts: { prod?: boolean; openBrowser?: boolean } = {}): Promise<StackStartResult> {
  // 1. Idempotency — if it's already up, just report the URLs.
  const existing = await getStackStatus();
  if (existing.running) {
    return { ...existing, alreadyRunning: true };
  }

  // 2. Locate the package root that carries the launcher + dashboard.
  const root = findPackageRoot();
  if (!root) {
    return {
      running: false,
      alreadyRunning: false,
      message:
        "Could not locate the AgentIX launcher (scripts/serve.ts) or dashboard (apps/dashboard). " +
        "Start the stack from your AgentIX source checkout with: bun run serve",
    };
  }

  // 3. Spawn the launcher detached. Its stdio is ignored so the parent (this
  //    MCP call) can return; serve.ts owns the API + dashboard child processes.
  const args = ["x", "tsx", join("scripts", "serve.ts")];
  if (opts.prod) args.push("--prod");
  if (!opts.openBrowser) args.push("--no-open");

  const child = spawn("bun", args, {
    cwd: root,
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32",
  });
  child.unref();

  // 4. Poll the manifest until the API port appears AND answers health, then
  //    wait a little longer for the dashboard port to be recorded.
  const host = "127.0.0.1";
  let apiPort = 0;
  for (let i = 0; i < 60 && !apiPort; i++) {
    await sleep(500);
    const m = readRuntimeManifest();
    if (m.apiPort && (await apiHealthy(`http://${m.host || host}:${m.apiPort}`))) {
      apiPort = m.apiPort;
    }
  }

  if (!apiPort) {
    return {
      running: false,
      alreadyRunning: false,
      message:
        "Launched the stack but the API server did not come up within 30s. " +
        "Check for errors by running `bun run serve` directly in the AgentIX source dir.",
    };
  }

  // Dashboard boots slower (Next dev compile). Give it a window to register.
  let dashboardPort = 0;
  for (let i = 0; i < 60 && !dashboardPort; i++) {
    const m = readRuntimeManifest();
    if (m.dashboardPort) {
      dashboardPort = m.dashboardPort;
      break;
    }
    await sleep(500);
  }

  const apiUrl = `http://${host}:${apiPort}`;
  const dashboardUrl = dashboardPort ? `http://${host}:${dashboardPort}` : undefined;

  return {
    running: true,
    alreadyRunning: false,
    dashboardUrl,
    apiUrl,
    host,
    apiPort,
    dashboardPort: dashboardPort || undefined,
    apiPid: readRuntimeManifest().apiPid,
    message: dashboardUrl
      ? `AgentIX stack started. Dashboard: ${dashboardUrl} — API: ${apiUrl}. ` +
        `The dashboard may take a few more seconds to finish its first compile.`
      : `AgentIX API started at ${apiUrl}. The dashboard is still booting — ` +
        `re-run stack status in a few seconds for its URL.`,
  };
}
