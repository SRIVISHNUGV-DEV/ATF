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
import { readRuntimeManifest, writeRuntimeManifest, findFreePort } from "../core/ports";

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

interface PackageRoot {
  dir: string;
  /** true when running from a source checkout (scripts/serve.ts + apps/dashboard exist). */
  dev: boolean;
}

/**
 * Resolve the AgentIX package root. Returns both the path and whether it's a
 * source checkout (dev) or a bundled npm install.
 */
function findPackageRoot(): PackageRoot | null {
  const candidates = [
    resolve(__dirname, "..", ".."), // src/tools -> package root (dev)
    resolve(__dirname, ".."), // bundle/..
    resolve(__dirname), // bundle dir (bundled MCP server)
    process.cwd(),
  ];
  for (const dir of candidates) {
    const hasServe = existsSync(join(dir, "scripts", "serve.ts"));
    const hasDashboard = existsSync(join(dir, "apps", "dashboard", ".next"));
    const hasServerJs = existsSync(join(dir, "server.js"));
    // Dev = source checkout with serve.ts AND dashboard, but NO prebuilt server.js.
    // When server.js exists, we're in a bundled npm install — use the prebuilt
    // entrypoint even if serve.ts was copied alongside it for reference.
    const isDev = hasServe && hasDashboard && !hasServerJs;
    const isBundled = hasServerJs;
    if (isDev || isBundled) {
      return { dir, dev: isDev };
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
  const pkg = findPackageRoot();
  if (!pkg) {
    return {
      running: false,
      alreadyRunning: false,
      message:
        "Could not locate the AgentIX package. " +
        "Start the stack from your AgentIX source checkout with: bun run serve",
    };
  }

  // 3. Spawn the launcher detached. Its stdio is ignored so the parent (this
  //    MCP call) can return; serve.ts owns the API + dashboard child processes.
  let child;
  if (pkg.dev) {
    // Source checkout: use the full launcher (API + dashboard)
    const args = ["x", "tsx", join("scripts", "serve.ts")];
    if (opts.prod) args.push("--prod");
    if (!opts.openBrowser) args.push("--no-open");
    child = spawn("bun", args, {
      cwd: pkg.dir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
  } else {
    // Bundled npm install: start API server, then dashboard if present.
    // Step 1: Start the API server (node server.js).
    const serverJs = join(pkg.dir, "server.js");
    const apiProc = spawn(process.execPath, [serverJs], {
      cwd: pkg.dir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    apiProc.unref();
    child = apiProc; // for the manifest poll below

    // Step 2: If the dashboard exists, start it after the API is up.
    const dashboardDir = join(pkg.dir, "apps", "dashboard");
    const hasDashboard = existsSync(join(dashboardDir, ".next"));
    if (hasDashboard) {
      // Wait for the API to publish its port, then start the dashboard.
      // This runs in the background — we don't block the caller.
      (async () => {
        const host = "127.0.0.1";
        let apiPort = 0;
        for (let i = 0; i < 40 && !apiPort; i++) {
          await sleep(500);
          const m = readRuntimeManifest();
          if (m.apiPort) apiPort = m.apiPort;
        }
        if (!apiPort) return;

        const apiUrl = `http://${host}:${apiPort}`;
        const dashPort = parseInt(process.env.AGENTIX_DASHBOARD_UI_PORT || "3000", 10);

        // Resolve next binary: prefer root node_modules (where we install it
        // as a dependency of the published package), fall back to dashboard-local.
        let nextBin: string | null = null;
        try {
          const req = require("module").createRequire(join(pkg.dir, "package.json"));
          const pkgPath = req.resolve("next/package.json");
          const nextPkg = req("next/package.json");
          const binRel = typeof nextPkg.bin === "string" ? nextPkg.bin : nextPkg.bin?.next;
          if (binRel) nextBin = join(pkgPath, "..", binRel);
        } catch { /* next not found */ }

        let dashProgram: string;
        let dashArgs: string[];
        if (nextBin) {
          dashProgram = process.execPath;
          dashArgs = [nextBin, "start", "-p", String(dashPort)];
        } else {
          // Last resort: try npx
          dashProgram = process.platform === "win32" ? "npx.cmd" : "npx";
          dashArgs = ["next@14", "start", "-p", String(dashPort)];
        }

        const dash = spawn(dashProgram, dashArgs, {
          cwd: dashboardDir,
          env: {
            ...process.env,
            AGENTIX_API_URL: apiUrl,
            AGENTIX_API_TOKEN: readRuntimeManifest().apiToken || "",
          },
          stdio: "ignore",
          detached: true,
          shell: false,
        });
        dash.unref();

        // Record the dashboard port in the manifest.
        writeRuntimeManifest({ dashboardPort: dashPort, host });
      })();
    }
  }
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
