// Child worker for tests/31-db-concurrency.test.ts.
// One concurrent writer against the REAL AgentIX db layer (getDatabase applies
// WAL + explicit 5s busy_timeout + the cross-process BEGIN IMMEDIATE init tx).
// Reads tag + count from argv, prints a JSON summary line as its LAST stdout line.
import { getDatabase, runExecute } from "../../src/core/database";

const tag = process.argv[2] || "W";
const n = parseInt(process.argv[3] || "300", 10);

getDatabase(); // triggers schema init + migrations under the cross-process lock
let ok = 0;
let busy = 0;
for (let i = 0; i < n; i++) {
  try {
    runExecute(
      "INSERT OR REPLACE INTO harnesses (harness_id, display_name, version, status, config_path, detected_at) VALUES (?,?,?,?,?,unixepoch())",
      `${tag}-${i}`, tag, "1", "detected", "/tmp/x"
    );
    ok++;
  } catch (e: any) {
    if (String(e.code || e.message).includes("SQLITE_BUSY")) busy++;
    else { console.error("UNEXPECTED", e.message); process.exit(2); }
  }
}
console.log(JSON.stringify({ tag, ok, busy }));
