import { BaseHarnessAdapter } from "../base";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export class ClaudeCodeAdapter extends BaseHarnessAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly configPath: string;
  readonly mcpConfigPath: string;

  constructor() {
    super();
    this.configPath = this.findConfigPath() || "";
    this.mcpConfigPath = this.findMCPConfigPath() || "";
  }

  // ~/.claude.json lives directly in the home dir, so connect() writes there
  // when the file doesn't exist yet.
  protected getConfigDir(): string {
    return homedir();
  }

  protected findConfigPath(): string | null {
    const paths = [
      join(homedir(), ".claude"),
      join(homedir(), ".config", "claude"),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  // Claude Code reads MCP servers from the top-level `mcpServers` key of
  // ~/.claude.json — NOT ~/.claude/mcp_config.json (which it ignores entirely).
  // We target ~/.claude.json first; connect() creates it if missing.
  protected findMCPConfigPath(): string | null {
    const primary = join(homedir(), ".claude.json");
    if (existsSync(primary)) return primary;
    return null;
  }

  protected getMCPConfigFilename(): string { return ".claude.json"; }

  protected getVersionCommand(): string | null { return "claude --version 2>/dev/null || echo ''"; }
  protected getBinaryName(): string | null { return "claude"; }
  protected getMCPKey(): string { return "agentix"; }
}
