# unreal-mcp-gateway

An **always-alive local MCP gateway** for Unreal Engine. Each open UE editor hosts its own engine-native
MCP server on the first free loopback port in **8000-8031**. MCP clients (Claude Desktop, Claude Code)
bind their servers **only at launch** and don't reconnect when a server is absent at start or appears
later — so without a gateway you must **restart Claude every time you open an editor**.

This plugin fixes that. It launches one always-on gateway as the `unreal` MCP server. The gateway:

- **Never exits** on backend faults — the client's connection never fails, so it never needs a restart.
- **Forwards the engine's own discovery** — it flattens nothing and keeps no static snapshot. Each call
  is routed live to the chosen editor's native MCP server, which returns whatever toolsets that editor
  exposes right now (the engine's ~21 "tool pack" plugins plus UELLMToolkit's curated moat).
- **Auto-discovers** editors by scanning `8000-8031`, parses each editor's identity, and **routes**
  each call to the chosen editor (the optional `editor` argument; defaults to the only one open).

Open/close editors in any order, any time → **zero Claude restarts.**

## Tools

The gateway exposes **4 tools** — one gateway-local, three that forward the engine's tool-search
discovery to a live editor:

- `list_editors` — gateway-local; enumerates the editors found on `8000-8031` (port / project / pid).
- `list_toolsets` — list the toolsets a chosen editor exposes.
- `describe_toolset` — list the tools inside a toolset.
- `call_tool` — invoke a tool: `{ toolset_name, tool_name, arguments }`.

`list_toolsets` / `describe_toolset` / `call_tool` each take an optional `editor` arg to route to a
specific editor (defaults to the only one open). Toolset names follow the engine convention: engine
packs are `Plugin.ToolsetClass` (e.g. `EditorToolset.LogsToolset`); the UELLMToolkit moat is
`UELLMToolkit`. The agent discovers and invokes everything — engine packs and the moat alike — through
these meta-tools; nothing is pre-flattened into `unreal_<tool>` names.

## Dependencies

**None.** The gateway is pure Node.js (>=18) — it speaks MCP (JSON-RPC over stdio + Streamable HTTP)
using only built-ins (`fetch`, `net`, stdin/stdout), so there is **nothing to install** (no `npm
install`). Just `node`.

## Diagnostics

```sh
node server/probe.js [port]      # dump a live editor's protocol shapes
DEBUG=1 node server/gateway.js   # verbose scanner logging (stderr)
```

## Notes

- Each editor's native MCP server comes from UE 5.8's bundled AI stack (the `ModelContextProtocol`
  server + `ToolsetRegistry`). With the **UELLMToolkit** UE plugin installed, that editor also exposes
  the curated `UELLMToolkit` moat alongside the engine's tool packs — the gateway simply forwards
  whatever each editor advertises.
- Loopback only — no firewall prompts. Tunables via env vars (see `server/lib.js`).
