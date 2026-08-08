#!/usr/bin/env bash
# In-container smoke test for the published @corven/agentix tarball.
# Proves: SQLite binding resolves on THIS Node version (vendored or runtime-fetched),
# CLI runs, MCP server boots + answers a JSON-RPC tools/list, connect is non-destructive.
set -uo pipefail

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "=== $1 ==="; }

NODE_ABI="$(node -e 'process.stdout.write(process.versions.modules)')"
echo "############################################################"
echo "# Node $(node --version)  (ABI ${NODE_ABI})  arch=$(node -e 'process.stdout.write(process.arch)')"
echo "############################################################"

export AGENTIX_HOME="/root/.agentix"
export HOME="/root"
BIN="$(npm root -g)/@corven/agentix/bin/agentix"
MCPBIN="$(npm root -g)/@corven/agentix/bin/agentix-mcp"

hdr "1. CLI --version"
V="$(node "$BIN" --version 2>&1)"; echo "    -> $V"
[ "$V" = "1.0.3" ] && ok "version is 1.0.3" || bad "version wrong: $V"

hdr "2. CLI --help lists commands"
H="$(node "$BIN" --help 2>&1)"
echo "$H" | grep -q "connect" && ok "help lists connect" || bad "no connect in help"
echo "$H" | grep -q "doctor"  && ok "help lists doctor"  || bad "no doctor in help"

hdr "3. agentix init  (opens SQLite -> proves native binding resolves)"
INIT="$(node "$BIN" init 2>&1)"; RC=$?
echo "$INIT" | tail -6 | sed 's/^/    /'
if [ $RC -eq 0 ] && [ -f "$AGENTIX_HOME/db/agentix.db" ]; then
  ok "init exit 0 and DB file created"
else
  bad "init failed (rc=$RC) or DB missing"
fi

hdr "4. SQLite binding works (write + read back through config table)"
node "$BIN" config set rpcUrl https://sepolia.base.org >/dev/null 2>&1
GET="$(node "$BIN" config get rpcUrl 2>&1)"
echo "$GET" | tail -3 | sed 's/^/    /'
echo "$GET" | grep -q "sepolia.base.org" && ok "config persisted + read back through SQLite" || bad "config roundtrip failed"

hdr "5. agentix doctor  (diagnostics run end to end)"
DOC="$(node "$BIN" doctor 2>&1)"; RC=$?
echo "$DOC" | grep -iE "sqlite|database|binding" | head -3 | sed 's/^/    /'
echo "$DOC" | grep -iqE "error TS|Cannot find module|is not a function" && bad "doctor emitted a code error" || ok "doctor produced no code-level errors"

hdr "6. agentix connect --print  (non-destructive snippet)"
SNIP="$(node "$BIN" connect --print 2>&1)"
echo "$SNIP" | grep -q '"agentix"' && ok "snippet contains agentix entry" || bad "snippet missing agentix"
echo "$SNIP" | grep -qE '"command"' && ok "snippet has a launch command" || bad "snippet missing command"

hdr "7. agentix connect  (writes ONE portable file, touches nothing else)"
mkdir -p /root/.decoy
echo '{"mcpServers":{"other":{"command":"foo","args":["bar"]}}}' > /root/.decoy/config.json
DECOY_BEFORE="$(cat /root/.decoy/config.json)"
CONN="$(node "$BIN" connect 2>&1)"
echo "$CONN" | grep -qiE "portable MCP config|Created|Updated" && ok "connect wrote portable file" || bad "connect did not report portable file"
[ -f "$AGENTIX_HOME/mcp.json" ] && ok "portable ~/.agentix/mcp.json exists" || bad "portable mcp.json missing"
DECOY_AFTER="$(cat /root/.decoy/config.json)"
[ "$DECOY_BEFORE" = "$DECOY_AFTER" ] && ok "decoy harness config UNTOUCHED (non-destructive default)" || bad "decoy config was mutated!"
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.env.AGENTIX_HOME+"/mcp.json","utf8"));
const e=j.mcpServers&&j.mcpServers.agentix;
if(!e){console.error("    NO_ENTRY");process.exit(1);}
const cmd=e.command,args=e.args||[];
if(cmd==="node"&&args[0]&&fs.existsSync(args[0])){console.log("    LAUNCHABLE_ABS "+args[0]);process.exit(0);}
if(/agentix-mcp/.test(cmd)){console.log("    LAUNCHABLE_BIN "+cmd);process.exit(0);}
console.error("    SUSPECT "+JSON.stringify(e));process.exit(1);
' && ok "portable entry is launchable" || bad "portable entry not launchable"

hdr "8. MCP server boots + answers initialize + tools/list over stdio"
REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
MCPOUT="$(printf '%s\n' "$REQ" | timeout 25 node "$MCPBIN" 2>/tmp/mcp.err)"
echo "$MCPOUT" | head -c 300 | sed 's/^/    /'; echo
echo "$MCPOUT" | grep -q '"serverInfo"' && ok "MCP answered initialize" || bad "no initialize response"
TOOLCOUNT="$(echo "$MCPOUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  let n=0;
  for(const line of s.split(/\r?\n/)){
    const t=line.trim(); if(!t.startsWith("{"))continue;
    try{const o=JSON.parse(t); if(o.id===2&&o.result&&Array.isArray(o.result.tools))n=o.result.tools.length;}catch{}
  }
  process.stdout.write(String(n));
});')"
echo "    tools/list returned ${TOOLCOUNT} tools"
if [ "${TOOLCOUNT:-0}" -gt 0 ] 2>/dev/null; then ok "MCP tools/list returned ${TOOLCOUNT} tools"; else bad "tools/list empty"; echo "    --- mcp.err ---"; tail -8 /tmp/mcp.err | sed 's/^/    /'; fi

echo
echo "############################################################"
echo "# RESULT (Node $(node --version)):  PASS=${PASS}  FAIL=${FAIL}"
echo "############################################################"
[ "$FAIL" -eq 0 ] || exit 1
