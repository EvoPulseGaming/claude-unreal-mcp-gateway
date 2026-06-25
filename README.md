# claude-unreal-mcp-gateway

A Claude Code / Claude Desktop plugin marketplace providing **`unreal-mcp-gateway`** — an always-alive,
zero-dependency local MCP server that fronts the ephemeral, per-editor Unreal Engine MCP servers so
editors can open and close without ever restarting Claude. It doesn't flatten or snapshot anything: it
**forwards each editor's native MCP discovery** (the engine's AI tool packs **plus** the UELLMToolkit
moat) through one stdio connection.

## Why

Each open UE editor runs its own native MCP server (UE 5.8's `ModelContextProtocol` stack) on an
auto-selected loopback port (8000-8031). MCP clients bind their servers only at launch and don't
reconnect to one that was down at startup or shows up later — so opening an editor after Claude is
running forces a Claude restart **every time**. The gateway is a single always-on process the client
connects to once; it auto-discovers editors as they come and go and routes to them, with a stable
tool list that even Claude Desktop can use.

## What it exposes

The gateway is a thin forwarder — it exposes exactly **4 tools** and routes everything else through the
editor's own tool-search discovery (no flattened `unreal_<tool>` names, no static snapshot):

- **`list_editors`** — gateway-local: the editors currently live on 8000-8031.
- **`list_toolsets`** — forwards the editor's toolset list (engine packs named `Plugin.ToolsetClass`,
  e.g. `EditorToolset.LogsToolset`, plus our `UELLMToolkit`).
- **`describe_toolset`** — forwards a toolset's tool schemas.
- **`call_tool`** — invokes a tool: `{ toolset_name, tool_name, arguments }`.

`list_toolsets`, `describe_toolset`, and `call_tool` each take an optional **`editor`** argument to
route to a specific editor; omit it when only one is open. The full combined toolset (engine AI tool
packs + the UELLMToolkit moat) flows through this one connection.

## Install

Zero-step — the gateway is pure Node.js (built-ins only), so there is **nothing to `npm install`**.

```sh
# add this marketplace (local path or the GitHub repo)
claude plugin marketplace add EvoPulseGaming/claude-unreal-mcp-gateway
# install the plugin
claude plugin install unreal-mcp-gateway@claude-unreal-mcp-gateway
```

Restart Claude once after installing. After that, open/close editors freely — no more restarts.
Only requirement: **Node.js (>=18)** on your PATH.

## Layout

```
.claude-plugin/marketplace.json
plugins/unreal-mcp-gateway/
├── .claude-plugin/plugin.json
├── .mcp.json                  # the "unreal" connector → node server/gateway.js
├── server/                    # the gateway (Node.js, zero dependencies — built-ins only)
└── skills/unreal-editors/     # usage guidance skill
```

Requires the **UELLMToolkit** UE plugin in your project. UE 5.8 ships the native MCP server and ~21
engine AI tool packs; UELLMToolkit registers its curated 13-tool moat alongside them via the engine's
`ToolsetRegistry` (and pulls in the engine's `AllToolsets` bundle), so each editor exposes the full
combined toolset that the gateway forwards.

## License

[Unlicense](LICENSE).
