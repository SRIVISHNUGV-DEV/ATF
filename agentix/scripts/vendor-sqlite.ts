/**
 * Vendor better-sqlite3 prebuilt native binaries.
 *
 * Downloads the official prebuilt `.node` addons from the WiseLibs GitHub
 * release and lays them out at:
 *   vendor/better-sqlite3/<abi>/<platform>-<arch>/better_sqlite3.node
 *
 * These are loaded at runtime via the `nativeBinding` option (see
 * src/core/native-sqlite.ts), so better-sqlite3 never needs an install-time
 * lifecycle script — making the package immune to npm v12's default of not
 * running dependency install scripts.
 *
 * Run: bun run scripts/vendor-sqlite.ts
 */
import { mkdirSync, existsSync, rmSync, writeFileSync, createReadStream, createWriteStream, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");
const VENDOR = join(ROOT, "vendor", "better-sqlite3");

// Must match the installed better-sqlite3 version.
const BS3_VERSION = "12.11.1";

// ABI (process.versions.modules) -> human label. Only ABIs that 12.11.1 ships.
const ABIS = [
  { abi: "127", node: "22" }, // Node 22 LTS
  { abi: "137", node: "24" }, // Node 24 current
];

// Platform/arch matrix. release naming: node-v<abi>-<platform>-<arch>
const TARGETS = [
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
];

const BASE = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BS3_VERSION}`;

function sh(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// GNU tar under MSYS treats a leading "D:" as a remote host. Extract by
// running tar with cwd set to the target dir and passing "." so no drive-letter
// path reaches tar's -C/-f argument parser.
function extractTar(tgz: string, destDir: string) {
  // Copy tarball into destDir as a plain relative name, extract there, remove it.
  const localName = "archive.tgz";
  const data = require("fs").readFileSync(tgz);
  writeFileSync(join(destDir, localName), data);
  sh("tar", ["-xzf", localName], destDir);
  rmSync(join(destDir, localName));
}

async function main() {
  console.log(`Vendoring better-sqlite3@${BS3_VERSION} prebuilts...`);
  if (existsSync(VENDOR)) rmSync(VENDOR, { recursive: true });
  mkdirSync(VENDOR, { recursive: true });

  const tmp = join(ROOT, ".vendor-tmp");
  if (existsSync(tmp)) rmSync(tmp, { recursive: true });
  mkdirSync(tmp, { recursive: true });

  const manifest: Record<string, string> = {};
  let count = 0;

  for (const { abi, node } of ABIS) {
    for (const { platform, arch } of TARGETS) {
      const asset = `better-sqlite3-v${BS3_VERSION}-node-v${abi}-${platform}-${arch}.tar.gz`;
      const url = `${BASE}/${asset}`;
      const tgz = join(tmp, asset);
      process.stdout.write(`  ↓ node${node} (abi ${abi}) ${platform}-${arch} ... `);

      // Download with curl (follows redirects, fails on 404).
      sh("curl", ["-sSfL", "-o", tgz, url]);

      // Extract: the .node lives at build/Release/better_sqlite3.node inside the tarball.
      const outDir = join(VENDOR, abi, `${platform}-${arch}`);
      mkdirSync(outDir, { recursive: true });
      const exDir = join(tmp, `${abi}-${platform}-${arch}`);
      mkdirSync(exDir, { recursive: true });
      extractTar(tgz, exDir);

      // Locate the extracted .node
      const nodeFile = findNode(exDir);
      if (!nodeFile) throw new Error(`no .node found in ${asset}`);
      const dest = join(outDir, "better_sqlite3.node");
      copyFileSyncBinary(nodeFile, dest);
      const size = statSync(dest).size;
      manifest[`${abi}/${platform}-${arch}`] = `${(size / 1024).toFixed(0)}KB`;
      count++;
      console.log(`ok (${(size / 1024).toFixed(0)}KB)`);
    }
  }

  rmSync(tmp, { recursive: true });

  writeFileSync(
    join(VENDOR, "manifest.json"),
    JSON.stringify({ version: BS3_VERSION, generated: new Date().toISOString(), binaries: manifest }, null, 2)
  );

  console.log(`\nVendored ${count} binaries -> ${VENDOR}`);
}

function findNode(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      const found = findNode(p);
      if (found) return found;
    } else if (entry.endsWith(".node")) {
      return p;
    }
  }
  return null;
}

function copyFileSyncBinary(src: string, dest: string) {
  const data = require("fs").readFileSync(src);
  writeFileSync(dest, data);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
