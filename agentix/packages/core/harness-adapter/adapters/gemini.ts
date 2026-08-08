import { BaseHarnessAdapter } from "../base";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export class GeminiAdapter extends BaseHarnessAdapter {
  readonly id = "gemini";
  readonly name = "Gemini";
  readonly configPath: string;
  readonly mcpConfigPath: string;

  constructor() {
    super();
    this.configPath = this.findConfigPath() || "";
    this.mcpConfigPath = this.findMCPConfigPath() || "";
  }

  protected getConfigDir(): string {
    return join(homedir(), ".gemini");
  }

  protected findConfigPath(): string | null {
    const paths = [
      join(homedir(), ".gemini"),
      join(homedir(), ".config", "gemini"),
      join(homedir(), ".google", "gemini"),
      join(homedir(), ".config", "google-gemini"),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  // Gemini CLI stores MCP servers under the `mcpServers` key of
  // ~/.gemini/settings.json (same schema as Claude), not a standalone mcp.json.
  protected findMCPConfigPath(): string | null {
    const paths = [
      join(homedir(), ".gemini", "settings.json"),
      join(homedir(), ".config", "gemini", "settings.json"),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  protected getMCPConfigFilename(): string { return "settings.json"; }

  protected getVersionCommand(): string | null {
    return "gemini --version 2>/dev/null || echo ''";
  }

  protected getBinaryName(): string | null { return "gemini"; }
  protected getMCPKey(): string { return "agentix"; }
}
