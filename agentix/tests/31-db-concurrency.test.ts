import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";

// Regression test for the cross-process SQLite init/write race.
//
// Every AI harness (Claude Code, Cursor, Copilot, ...) launches its OWN
// `node mcp.js` process, and the API server + CLI open the same ~/.agentix db.
// On a FRESH db they all race to run CREATE TABLE + ALTER TABLE ADD COLUMN
// migrations. Before the fix, concurrent initializers threw "duplicate column
// name" / "database is locked"; concurrent writers could throw SQLITE_BUSY.
//
// The fix (src/core/database.ts): explicit 5s busy_timeout + wrapping schema
// creation and migrations in a BEGIN IMMEDIATE transaction so exactly one
// process migrates while the rest wait, then run against the finished schema.
//
// This test spawns K real child processes against a shared fresh db and asserts
// every one completes all its writes with zero BUSY and a clean exit.

const WRITER = join(__dirname, "fixtures", "db-concurrent-writer.ts");
const K = 4;
const N = 300;

function runWriter(home: string, tag: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("bun", ["x", "tsx", WRITER, tag, String(N)], {
      env: { ...process.env, AGENTIX_HOME: home },
      cwd: join(__dirname, ".."),
    });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

describe("31. Cross-process DB concurrency", () => {
  it(
    "handles concurrent first-run init + writes from many processes with no BUSY or DDL races",
    async () => {
      // Isolated fresh home so we exercise the first-run migration path.
      const home = join(tmpdir(), `agentix-conc-test-${process.pid}-${Date.now()}`);
      rmSync(home, { recursive: true, force: true });
      mkdirSync(join(home, "db"), { recursive: true });

      try {
        const results = await Promise.all(
          Array.from({ length: K }, (_, i) => runWriter(home, `W${i}`))
        );

        let totalOk = 0;
        let totalBusy = 0;
        for (const r of results) {
          expect(r.code, `writer exited nonzero: ${r.out}`).toBe(0);
          const lastLine = r.out.split("\n").filter(Boolean).pop() || "";
          let parsed: { tag: string; ok: number; busy: number };
          try {
            parsed = JSON.parse(lastLine);
          } catch {
            throw new Error(`writer produced no JSON summary. Full output:\n${r.out}`);
          }
          totalOk += parsed.ok;
          totalBusy += parsed.busy;
        }

        // Every write across every process must succeed, with zero SQLITE_BUSY.
        expect(totalBusy).toBe(0);
        expect(totalOk).toBe(K * N);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000
  );
});
