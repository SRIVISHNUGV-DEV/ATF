"use client";

// API base. Default is EMPTY (same-origin) so browser calls hit the dashboard's
// local /api proxy route. That route reads AGENTIX_HOME/runtime.json server-side
// and injects the local API bearer token before forwarding to the runtime API.
// The browser never sees the token and never needs to know the backend port.
export const API = process.env.NEXT_PUBLIC_API_URL || "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    if (typeof data === "string") {
      throw new Error(`HTTP ${res.status} — backend returned a non-JSON response (is the runtime API running?)`);
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export async function fetchJSON<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function postJSON<T>(path: string, body: any): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export async function putJSON<T>(path: string, body: any): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteJSON<T>(path: string, body?: any): Promise<T> {
  return request<T>(path, { method: "DELETE", body: body ? JSON.stringify(body) : undefined });
}

export const EXPLORER = "https://sepolia.basescan.org";

export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(addr: string) {
  return `${EXPLORER}/address/${addr}`;
}

export function explorerBlock(block: number | string) {
  return `${EXPLORER}/block/${block}`;
}

export function truncate(addr: string, chars = 6): string {
  if (!addr) return "—";
  return addr.length > chars + 4 ? `${addr.slice(0, chars)}...${addr.slice(-4)}` : addr;
}
