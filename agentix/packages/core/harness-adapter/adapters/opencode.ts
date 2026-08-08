import { BaseHarnessAdapter } from "../base";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export class OpenCodeAdapter extends BaseHarnessAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly configPath: string;
  readonly mcpConfigPath: string;

  constructor() {
    super();
    this.configPath = this.findConfigPath() || "";
    this.mcpConfigPath = this.findMCPConfigPath() || "";
  }

  protected getConfigDir(): string {
    return join(homedir(), ".config", "opencode");
  }

  protected findConfigPath(): string | null {
    const paths = [
      join(homedir(), ".opencode"),
      join(homedir(), ".config", "opencode"),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  protected findMCPConfigPath(): string | null {
    const paths = [
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(process.cwd(), "opencode.json"),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  protected getMCPConfigFilename(): string { return "opencode.json"; }

  protected getVersionCommand(): string | null { return "opencode --version 2>/dev/null || echo ''"; }
  protected getBinaryName(): string | null { return "opencode"; }
  protected getMCPKey(): string { return "agentix"; }

  // OpenCode uses an `mcp` block whose local entries are
  // `{ type: "local", command: [bin, ...args], enabled: true }` — the command
  // is a single array, not the {command, args} pair Claude/Cursor use.
  protected readEntry(config: any): any {
    const e = config?.mcp?.[this.getMCPKey()];
    if (!e) return null;
    // Normalize back to {command, args} so mcpEntryIsValid can inspect the path.
    if (Array.isArray(e.command)) return { command: e.command[0], args: e.command.slice(1) };
    return e;
  }

  protected applyEntry(config: any, entry: any): void {
    if (!config.mcp) config.mcp = {};
    config.mcp[this.getMCPKey()] = {
      type: "local",
      command: [entry.command, ...(entry.args || [])],
      enabled: true,
    };
  }

  protected removeEntry(config: any): void {
    if (config?.mcp?.[this.getMCPKey()]) delete config.mcp[this.getMCPKey()];
  }
}
