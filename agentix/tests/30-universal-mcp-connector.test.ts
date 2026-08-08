import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectSchema,
  applyUniversalEntry,
  readUniversalEntry,
  connectConfigFile,
  manualSnippet,
} from "../packages/core/harness-adapter/universal";

/**
 * Regression suite for the universal (adapter-less) MCP connector — the code
 * path that was shipping broken (wrong file, unlaunchable command) with zero
 * coverage. These tests pin the three MCP config schemas and the write path.
 */
describe("30. Universal MCP Connector", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentix-uni-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe("schema detection", () => {
    it("detects the VS Code `servers` schema", () => {
      expect(detectSchema({ servers: { foo: {} } })).toBe("servers");
    });
    it("detects the OpenCode `mcp` schema", () => {
      expect(detectSchema({ mcp: { foo: {} } })).toBe("mcp");
    });
    it("detects the standard `mcpServers` schema", () => {
      expect(detectSchema({ mcpServers: { foo: {} } })).toBe("mcpServers");
    });
    it("defaults to `mcpServers` for an empty/new config", () => {
      expect(detectSchema({})).toBe("mcpServers");
    });
  });

  describe("applyUniversalEntry writes each schema correctly", () => {
    const entry = { command: "node", args: ["/pkg/mcp.js"] };

    it("mcpServers: writes {command,args} verbatim", () => {
      const cfg: any = {};
      applyUniversalEntry(cfg, entry, "mcpServers");
      expect(cfg.mcpServers.agentix).toEqual({ command: "node", args: ["/pkg/mcp.js"] });
    });

    it("servers: adds type:stdio (VS Code / Copilot)", () => {
      const cfg: any = {};
      applyUniversalEntry(cfg, entry, "servers");
      expect(cfg.servers.agentix).toEqual({ type: "stdio", command: "node", args: ["/pkg/mcp.js"] });
    });

    it("mcp: collapses to a command array with type:local + enabled (OpenCode)", () => {
      const cfg: any = {};
      applyUniversalEntry(cfg, entry, "mcp");
      expect(cfg.mcp.agentix).toEqual({ type: "local", command: ["node", "/pkg/mcp.js"], enabled: true });
    });

    it("preserves sibling entries when adding ours", () => {
      const cfg: any = { mcpServers: { other: { command: "x" } } };
      applyUniversalEntry(cfg, entry, "mcpServers");
      expect(cfg.mcpServers.other).toEqual({ command: "x" });
      expect(cfg.mcpServers.agentix).toBeDefined();
    });
  });

  describe("readUniversalEntry normalizes every schema back to {command,args}", () => {
    it("reads the OpenCode command array back into {command,args}", () => {
      const cfg = { mcp: { agentix: { type: "local", command: ["node", "/pkg/mcp.js"] } } };
      expect(readUniversalEntry(cfg)).toEqual({ command: "node", args: ["/pkg/mcp.js"] });
    });
    it("reads the servers schema", () => {
      const cfg = { servers: { agentix: { type: "stdio", command: "node", args: ["/x"] } } };
      expect(readUniversalEntry(cfg)?.command).toBe("node");
    });
    it("returns null when no agentix entry present", () => {
      expect(readUniversalEntry({ mcpServers: {} })).toBeNull();
    });
    it("returns null for malformed agentix entries", () => {
      expect(readUniversalEntry({ mcpServers: { agentix: { command: 42 } } })).toBeNull();
      expect(readUniversalEntry({ mcp: { agentix: { command: [] } } })).toBeNull();
    });
  });

  describe("connectConfigFile", () => {
    it("creates a new config file with the default schema", () => {
      const p = join(dir, "new-harness", "mcp.json");
      const r = connectConfigFile(p);
      expect(r.success).toBe(true);
      expect(r.created).toBe(true);
      expect(existsSync(p)).toBe(true);
      const written = JSON.parse(readFileSync(p, "utf-8"));
      expect(written.mcpServers.agentix).toBeDefined();
    });

    it("merges into an existing file WITHOUT clobbering other servers", () => {
      const p = join(dir, "mcp.json");
      writeFileSync(p, JSON.stringify({ mcpServers: { existing: { command: "keep" } } }));
      const r = connectConfigFile(p);
      expect(r.success).toBe(true);
      expect(r.created).toBe(false);
      const written = JSON.parse(readFileSync(p, "utf-8"));
      expect(written.mcpServers.existing).toEqual({ command: "keep" });
      expect(written.mcpServers.agentix).toBeDefined();
    });

    it("is idempotent when the existing agentix entry is launchable", () => {
      const p = join(dir, "mcp.json");
      const existing = { command: "node", args: [process.execPath] };
      writeFileSync(p, JSON.stringify({ mcpServers: { agentix: existing } }));
      const r = connectConfigFile(p);
      expect(r.success).toBe(true);
      const written = JSON.parse(readFileSync(p, "utf-8"));
      expect(written.mcpServers.agentix).toEqual(existing);
    });

    it("heals a stale existing agentix file path", () => {
      const p = join(dir, "mcp.json");
      const stale = join(dir, "missing-mcp.js");
      writeFileSync(p, JSON.stringify({ mcpServers: { agentix: { command: "node", args: [stale] } } }));
      const r = connectConfigFile(p);
      expect(r.success).toBe(true);
      const e = readUniversalEntry(JSON.parse(readFileSync(p, "utf-8")));
      expect(e).not.toBeNull();
      expect(e!.args).not.toEqual([stale]);
    });

    it("respects the schema of an existing `servers`-style file", () => {
      const p = join(dir, "vscode-mcp.json");
      writeFileSync(p, JSON.stringify({ servers: { other: { type: "stdio", command: "x" } } }));
      connectConfigFile(p);
      const written = JSON.parse(readFileSync(p, "utf-8"));
      expect(written.servers.agentix.type).toBe("stdio");
      expect(written.mcpServers).toBeUndefined();
    });

    it("writes a launchable command (absolute node path or global bin), never a broken path", () => {
      const p = join(dir, "mcp.json");
      connectConfigFile(p);
      const e = readUniversalEntry(JSON.parse(readFileSync(p, "utf-8")));
      expect(e).not.toBeNull();
      // Either an absolute file we can run on node/npx, or the global bin fallback.
      const isFileLaunch = (e!.args || []).some((a) => /\.(c?js|ts)$/.test(a));
      const isBinFallback = e!.command === "agentix-mcp";
      expect(isFileLaunch || isBinFallback).toBe(true);
    });

    it("refuses to overwrite a file that is not valid JSON", () => {
      const p = join(dir, "corrupt.json");
      writeFileSync(p, "{ this is : not json ]");
      const r = connectConfigFile(p);
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/unparseable/i);
      // The original bytes must be left untouched.
      expect(readFileSync(p, "utf-8")).toBe("{ this is : not json ]");
    });
  });

  describe("manualSnippet", () => {
    it("emits valid JSON with an agentix mcpServers entry for any client", () => {
      const parsed = JSON.parse(manualSnippet());
      expect(parsed.mcpServers.agentix).toBeDefined();
      expect(parsed.mcpServers.agentix.command).toBeTruthy();
    });
  });
});
