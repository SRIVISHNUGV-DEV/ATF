import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// These tests defend the Beta-1 "UI must match execution" fixes in the init
// flow. Each isolates AGENTIX_HOME to a fresh temp dir and resets the module
// registry so config.ts re-captures AGENTIX_HOME (a module-load-time const)
// from env — pointing at the throwaway dir, never the developer's ~/.agentix.

let HOME: string;
const PREV_HOME = process.env.AGENTIX_HOME;

beforeEach(() => {
  HOME = join(tmpdir(), `agentix-init-consistency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(HOME, { recursive: true });
  process.env.AGENTIX_HOME = HOME;
  // Drop cached modules so the next import re-reads AGENTIX_HOME from env.
  vi.resetModules();
});

afterEach(() => {
  try { if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (PREV_HOME) process.env.AGENTIX_HOME = PREV_HOME;
  else delete process.env.AGENTIX_HOME;
});

describe("33. init/config behavioral consistency (Beta-1)", () => {
  it("plain init (no --rpc) writes the config file so doctor reports it initialized", async () => {
    const { initializeFullRuntime } = await import("../src/tools/wizard");
    const result = await initializeFullRuntime(undefined, false);
    expect(result.success).toBe(true);
    // The core bug: the config file must exist on disk after a plain init,
    // otherwise `doctor` tells the user to run the command they just ran.
    const configPath = join(HOME, "config", "agentix.config.json");
    expect(existsSync(configPath)).toBe(true);
  });

  it("plain init reports 'Connect harnesses' as a skip, never a completed step", async () => {
    const { initializeFullRuntime } = await import("../src/tools/wizard");
    const result = await initializeFullRuntime(undefined, false);
    const connectStep = result.steps.find((s: any) => s.name === "Connect harnesses");
    expect(connectStep).toBeDefined();
    // Must be a skip (⏭), NOT "done" (green ✔ that would imply IDE configs were wired).
    expect(connectStep.status).toBe("skip");
    expect(connectStep.message).not.toMatch(/already exists/);
  });

  it("plain init 'Configure network' skip message does not claim 'already exists'", async () => {
    const { initializeFullRuntime } = await import("../src/tools/wizard");
    const result = await initializeFullRuntime(undefined, false);
    const netStep = result.steps.find((s: any) => s.name === "Configure network");
    expect(netStep).toBeDefined();
    expect(netStep.status).toBe("skip");
    // On a fresh machine nothing "already exists" — the message must state the
    // real reason (no --rpc given) instead of a misleading stale-state string.
    expect(netStep.message).not.toMatch(/already exists/);
    expect(netStep.message).toMatch(/rpc/i);
  });

  it("init --rpc persists the RPC and marks the step done", async () => {
    const { initializeFullRuntime } = await import("../src/tools/wizard");
    const rpc = "https://example-rpc.invalid/v2/testkey";
    const result = await initializeFullRuntime(rpc, false);
    const netStep = result.steps.find((s: any) => s.name === "Configure network");
    expect(netStep.status).toBe("done");
    const { loadConfig } = await import("../src/core/config");
    expect(loadConfig().rpcUrl).toBe(rpc);
  });

  it("loadConfig preserves a corrupt config as a .corrupt backup instead of silently eating it", async () => {
    const cfgDir = join(HOME, "config");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "agentix.config.json");
    writeFileSync(cfgPath, "{ this is not valid json ]");

    const { loadConfig } = await import("../src/core/config");
    const cfg = loadConfig(); // must not throw
    expect(cfg).toBeDefined();
    expect(cfg.rpcUrl).toBeTruthy(); // fell back to defaults, still usable

    // The corrupt file must be preserved (renamed), NOT left in place to be
    // overwritten by the next saveConfig — the user's data is recoverable.
    const files = readdirSync(cfgDir);
    expect(files.some((f) => f.includes("corrupt"))).toBe(true);
    expect(existsSync(cfgPath)).toBe(false);
  });
});
