/**
 * Native binding resolver for better-sqlite3.
 *
 * We ship prebuilt `.node` addons under vendor/better-sqlite3/<abi>/<platform>-<arch>/
 * and load them explicitly via better-sqlite3's `nativeBinding` option. This means
 * better-sqlite3 never needs its install-time lifecycle script to compile or
 * fetch a binary — which keeps the package working under npm v12, where
 * dependency install scripts no longer run by default.
 *
 * Resolution order (see resolveSqliteBinding):
 *   1. AGENTIX_SQLITE_BINDING env override (absolute path to a .node)
 *   2. Vendored prebuilt matching current ABI + platform + arch
 *   3. Runtime-fetched prebuilt cached under ~/.agentix/sqlite/<abi>/<plat>-<arch>/
 *   4. better-sqlite3's own build/Release/better_sqlite3.node (dev / source build)
 *   5. null -> let better-sqlite3 fall back to `bindings` (best effort)
 *
 * "Any Node version" support: we only vendor a couple of ABIs to keep the npm
 * tarball small. For every other Node release (ABI 115, 131, 141, 147, …) the
 * runtime downloads the matching official WiseLibs/better-sqlite3 prebuilt for
 * the current ABI/platform/arch on first DB open and caches it. This is done
 * synchronously (via a spawned Node child using only built-ins — no curl/tar
 * dependency) so the sync getDatabase() path keeps working unchanged.
 *
 * Integrity: before writing the cached addon to disk, the fetch script also
 * downloads the release's official SHASUMS256.txt and verifies the tarball's
 * sha256 against the published checksum for that exact asset name. This
 * prevents loading a tampered/MITM'd binary as a native addon.
 */
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

/** better-sqlite3 version we ship / fetch prebuilts for. Keep in sync with package.json. */
const BSQLITE_VERSION = "12.11.1";

/** Root of the AgentIX data dir, where runtime-fetched bindings are cached. */
function agentixHome(): string {
  return process.env.AGENTIX_HOME || join(homedir(), ".agentix");
}

/** Relative path of the addon for the current runtime: <abi>/<platform>-<arch>/better_sqlite3.node */
function bindingRelPath(): string {
  const abi = process.versions.modules; // e.g. "137"
  const platform = process.platform; // "win32" | "linux" | "darwin"
  const arch = process.arch; // "x64" | "arm64"
  return join(abi, `${platform}-${arch}`, "better_sqlite3.node");
}

/** Cache location for a runtime-fetched binding for the current runtime. */
function fetchedBindingPath(): string {
  return join(agentixHome(), "sqlite", bindingRelPath());
}

/** Candidate roots where the vendor/ dir may live (dev tree and bundled package). */
function vendorRoots(): string[] {
  const roots: string[] = [];
  // When compiled/bundled, __dirname points into the package; walk a few levels up.
  // In dev (ts-node / bun), this file is at agentix/src/core/.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    roots.push(join(dir, "vendor", "better-sqlite3"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Env-provided package root.
  if (process.env.AGENTIX_HOME) {
    roots.push(join(process.env.AGENTIX_HOME, "vendor", "better-sqlite3"));
  }
  return roots;
}

/**
 * Returns an absolute path to the native better-sqlite3 addon to load, or null.
 * Pure filesystem lookups only — never touches the network. Use ensureSqliteBinding()
 * when you also want to fetch a missing prebuilt.
 */
export function resolveSqliteBinding(): string | null {
  // 1. Explicit override.
  const override = process.env.AGENTIX_SQLITE_BINDING;
  if (override && existsSync(override)) return override;

  const rel = bindingRelPath();

  // 2. Vendored prebuilt for this exact ABI/platform/arch.
  for (const root of vendorRoots()) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }

  // 3. Previously runtime-fetched prebuilt (cached under ~/.agentix/sqlite/).
  const fetched = fetchedBindingPath();
  if (existsSync(fetched)) return fetched;

  // 4. Locally compiled binary (developer machine that built from source).
  try {
    const pkgDir = dirname(require.resolve("better-sqlite3/package.json"));
    const built = join(pkgDir, "build", "Release", "better_sqlite3.node");
    if (existsSync(built)) return built;
  } catch {
    /* better-sqlite3 not resolvable here; fall through */
  }

  // 5. Give up and let better-sqlite3 use its own `bindings` lookup.
  return null;
}

/**
 * Resolve the native binding, downloading the matching official prebuilt if none
 * is present locally. This is what getDatabase() uses so AgentIX works on ANY
 * Node version, not just the ABIs we vendor.
 *
 * The download runs synchronously in a spawned Node child (built-ins only: https,
 * zlib, fs, crypto — no curl, no tar, no extra deps) so the existing sync DB-open
 * path is unchanged. The child also verifies the downloaded tarball's sha256
 * against the release's published SHASUMS256.txt before extracting anything. On
 * any failure (network, checksum mismatch, missing entry) it returns whatever
 * resolveSqliteBinding() finds (may be null), letting the caller degrade to
 * better-sqlite3's own resolution.
 */
export function ensureSqliteBinding(): string | null {
  const existing = resolveSqliteBinding();
  if (existing) return existing;

  const dest = fetchedBindingPath();
  try {
    if (fetchPrebuiltSync(dest) && existsSync(dest)) return dest;
  } catch {
    /* fall through to whatever resolveSqliteBinding finds (likely null) */
  }
  return resolveSqliteBinding();
}

/**
 * Download + verify + extract the official better-sqlite3 prebuilt for the
 * current ABI/platform/arch into `dest`. Runs in a spawned Node child using
 * only built-in modules (https, zlib, fs, crypto), so it needs no external
 * tools and blocks (spawnSync) until finished. The downloaded tarball's
 * sha256 is checked against the release's official SHASUMS256.txt before the
 * addon is written to disk. Returns true on success.
 */
function fetchPrebuiltSync(dest: string): boolean {
  const abi = process.versions.modules;
  const platform = process.platform;
  const arch = process.arch;
  // Official release asset naming: better-sqlite3-v<ver>-node-v<abi>-<plat>-<arch>.tar.gz
  const asset = `better-sqlite3-v${BSQLITE_VERSION}-node-v${abi}-${platform}-${arch}.tar.gz`;
  const releaseBase = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQLITE_VERSION}`;
  const url = `${releaseBase}/${asset}`;
  const shasumsUrl = `${releaseBase}/SHASUMS256.txt`;

  const dir = dirname(dest);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Child script: fetch SHASUMS256.txt, download the asset (following
  // redirects), verify its sha256 against the published checksum, gunzip,
  // walk the tar for the single build/Release/better_sqlite3.node entry, and
  // write it to dest. Aborts without writing anything on checksum mismatch.
  const child = String.raw`
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const crypto = require("crypto");
const url = process.argv[1];
const shasumsUrl = process.argv[2];
const assetName = process.argv[3];
const dest = process.argv[4];

function get(u, redirs) {
  return new Promise((resolve, reject) => {
    if ((redirs || 0) > 5) return reject(new Error("too many redirects"));
    https.get(u, { headers: { "User-Agent": "agentix-sqlite-fetch" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, (redirs || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function expectedSha256(shasumsText, name) {
  for (const line of shasumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<hex sha256>  <filename>" (two spaces, may vary)
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === name) return match[1].toLowerCase();
  }
  return null;
}

// Extract the single .node file from an uncompressed tar buffer (ustar format).
function extractNode(tar) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.slice(off, off + 512);
    // A block of all zeros marks the end of the archive.
    if (header.every((b) => b === 0)) break;
    let name = header.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.slice(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    off += 512;
    if (/better_sqlite3\.node$/.test(name)) {
      return tar.slice(off, off + size);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

(async () => {
  try {
    const shasumsBuf = await get(shasumsUrl, 0);
    const expected = expectedSha256(shasumsBuf.toString("utf8"), assetName);
    if (!expected) {
      console.error("no checksum entry found for " + assetName + " in SHASUMS256.txt");
      process.exit(4);
    }

    const tgz = await get(url, 0);
    const actual = crypto.createHash("sha256").update(tgz).digest("hex");
    if (actual !== expected) {
      console.error("checksum mismatch for " + assetName + ": expected " + expected + ", got " + actual);
      process.exit(3);
    }

    const tar = zlib.gunzipSync(tgz);
    const node = extractNode(tar);
    if (!node || node.length === 0) { console.error("addon not found in archive"); process.exit(2); }
    fs.writeFileSync(dest, node);
    process.exit(0);
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
})();
`;

  const res = spawnSync(process.execPath, ["-e", child, url, shasumsUrl, asset, dest], {
    timeout: 60000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return res.status === 0;
}

/**
 * Human-readable description of what binding would be used, for diagnostics.
 * Does NOT trigger a network fetch — reports only what is already on disk.
 */
export function describeSqliteBinding(): string {
  const abi = process.versions.modules;
  const target = `${process.platform}-${process.arch} (ABI ${abi}, Node ${process.version})`;
  const resolved = resolveSqliteBinding();
  if (!resolved) {
    return `No local better-sqlite3 binary for ${target}; will fetch the official prebuilt on first DB open (cached under ${fetchedBindingPath()}).`;
  }
  return `better-sqlite3 binding for ${target}: ${resolved}`;
}
