import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface RuntimeManifest {
  apiPort?: number;
  host?: string;
  apiToken?: string;
}

function readManifest(): RuntimeManifest {
  const home = process.env.AGENTIX_HOME || join(homedir(), ".agentix");
  const manifestPath = join(home, "runtime.json");
  try {
    if (!existsSync(manifestPath)) return {};
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return {};
  }
}

function apiTarget(path: string[]): { url: string; token?: string } {
  const manifest = readManifest();
  const explicit = process.env.AGENTIX_API_URL;
  const base = explicit || `http://${manifest.host || "127.0.0.1"}:${manifest.apiPort || process.env.AGENTIX_API_PORT || "3001"}`;
  const cleanBase = base.replace(/\/$/, "");
  const suffix = path.map(encodeURIComponent).join("/");
  return { url: `${cleanBase}/api/${suffix}`, token: process.env.AGENTIX_API_TOKEN || manifest.apiToken };
}

async function proxy(req: NextRequest, ctx: { params: { path?: string[] } }) {
  const path = ctx.params.path || [];
  const target = apiTarget(path);
  const url = new URL(target.url);
  url.search = req.nextUrl.search;

  const headers = new Headers(req.headers);
  headers.set("host", url.host);
  headers.set("origin", req.nextUrl.origin);
  if (target.token) headers.set("authorization", `Bearer ${target.token}`);
  headers.delete("content-length");

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    return NextResponse.json(
      {
        error: "AgentIX runtime API is not reachable",
        hint: "Start the runtime with: bun x tsx scripts/serve.ts (from the agentix/ directory)",
      },
      { status: 502 },
    );
  }
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("transfer-encoding");
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
export const OPTIONS = proxy;
