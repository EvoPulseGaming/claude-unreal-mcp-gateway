#!/usr/bin/env node
/**
 * ue-mcp-gateway — an always-alive local MCP server that fronts the ephemeral, per-editor
 * Unreal Engine MCP servers (each editor binds its own loopback port in 8000..8031) and
 * FORWARDS the engine's native discovery to the client. Each Claude client launches ONE copy
 * as its single stdio MCP entry. Because this process never exits and advertises a STATIC
 * 4-tool surface, editors can open/close in any order with ZERO client restarts.
 *
 * Front tools (always exactly these 4):
 *   list_editors                                              — which editors are live (gateway-local)
 *   list_toolsets    { editor? }                              — forward: a editor's toolsets (engine packs + UELLMToolkit)
 *   describe_toolset { toolset_name, editor? }                — forward: a toolset's tools + schemas
 *   call_tool        { toolset_name?, tool_name, arguments?, editor? } — forward: invoke a tool
 *
 * The agent discovers everything dynamically via list_toolsets/describe_toolset — the engine's
 * native tool-search flow — while the gateway adds multi-editor routing (the `editor` arg) and
 * no-restart. Nothing is flattened or snapshotted; whatever the editor exposes, the agent sees.
 */

import { StdioServer } from "./mcp.js";
import { EditorClient } from "./editor.js";
import { log, scanPorts, tcpProbe, BASE_PORT, SCAN_INTERVAL_MS, CALL_TIMEOUT_MS } from "./lib.js";

const META_TIMEOUT_MS = 30000; // list_toolsets / describe_toolset (call_tool uses CALL_TIMEOUT_MS)
const IDENTITY_REVERIFY_EVERY = 8; // every Nth scan, re-confirm an alive editor's identity (catches silent port-reuse)

// ── Hardening: a backend fault must NEVER take the gateway down ───────────────
process.on("uncaughtException", (e) => log.error("uncaughtException (continuing)", { error: e?.message, stack: e?.stack }));
process.on("unhandledRejection", (e) => log.error("unhandledRejection (continuing)", { error: e?.message || String(e) }));

const registry = new Map(); // port -> EditorClient
let scanCount = 0;

// ── Discovery scanner ─────────────────────────────────────────────────────────
async function scanOnce(server) {
  const all = scanPorts(); // native auto-port range + any legacy (5.7) ports
  const open = await Promise.all(all.map((p) => tcpProbe(p)));
  const reverify = (++scanCount % IDENTITY_REVERIFY_EVERY) === 0;
  let changed = false;
  for (let i = 0; i < all.length; i++) {
    const port = all[i];
    const isOpen = open[i];
    const existing = registry.get(port);
    if (isOpen && !existing) {
      const ed = new EditorClient(port);
      try { await ed.connect(); registry.set(port, ed); changed = true; }
      catch (e) { await ed.close(); log.debug("port open but not a UE MCP editor", { port, error: e.message }); }
    } else if (!isOpen && existing) {
      registry.delete(port); await existing.close(); changed = true; log.info("editor gone", { port });
    } else if (isOpen && existing && !existing.alive) {
      // A forward() marked it dead. Re-discover in THIS pass instead of waiting another full
      // scan interval — halves recovery latency after a transient editor hiccup.
      registry.delete(port); await existing.close();
      const ed = new EditorClient(port);
      try { await ed.connect(); registry.set(port, ed); log.info("editor reconnected", { port }); }
      catch (e) { log.debug("reconnect failed; will retry next scan", { port, error: e.message }); }
      changed = true;
    } else if (isOpen && existing && existing.alive && reverify) {
      // Port still open and we believe the same editor is there — but an editor can close and a
      // DIFFERENT one bind the same port between scans, which the TCP probe alone can't see.
      // Periodically re-confirm identity: on a pid change rebind; on failure, let it reconnect.
      try {
        if (await existing.reverifyIdentity()) { changed = true; log.info("editor changed on reused port", { port, pid: existing.identity?.pid }); }
      } catch (e) {
        // A per-call timeout (AbortError) doesn't prove the editor is gone — a busy editor mid-long-op can
        // miss the 4s reverify deadline. Mirror forward()'s rule: keep the session on AbortError, only mark
        // dead (→ reconnect next scan) on a hard fault, so we don't churn a healthy-but-busy editor.
        if (e?.name !== "AbortError") { existing.alive = false; log.debug("identity reverify failed; will reconnect", { port, error: e.message }); }
        else log.debug("identity reverify timed out; keeping session", { port });
      }
    }
  }
  if (changed) {
    try { server.notify("notifications/tools/list_changed"); }
    catch (e) { log.debug("list_changed notify failed", { error: e.message }); }
  }
}

// ── Routing helpers ─────────────────────────────────────────────────────────────
function liveEditors() { return [...registry.values()].filter((e) => e.alive); }

function editorListText(list) {
  return list
    .map((e) => `- port ${e.port} — ${e.identity?.project || "Unknown"} (pid ${e.identity?.pid ?? "?"}, UE ${e.identity?.ue || "?"})`)
    .join("\n");
}

function resolveEditor(sel) {
  const live = liveEditors();
  if (live.length === 0) return { error: "No UE editor is running on ports 8000-8031. Open one and retry." };
  if (sel != null && String(sel).trim() !== "") {
    const s = String(sel).trim().toLowerCase();
    // 1. Exact match on an unambiguous identifier (port / pid / full project name). The placeholder
    //    sentinels of an identity-less editor (pid 0, project "unknown") are NOT selectable by
    //    "0"/"unknown" — only by their real port — mirroring the substring guard below.
    const exact = live.filter((e) => {
      const proj = (e.identity?.project || "").toLowerCase();
      return String(e.port) === s ||
        (e.identity?.pid && String(e.identity.pid) === s) ||
        (proj && proj !== "unknown" && proj === s);
    });
    if (exact.length === 1) return { target: exact[0] };
    if (exact.length > 1) {
      return { error: `'${sel}' matches multiple editors:\n${editorListText(exact)}\nUse a unique port or pid.` };
    }
    // 2. Fall back to a UNIQUE project-name substring — never matches identity-less placeholders,
    //    and refuses to GUESS when more than one project contains the substring.
    const subs = live.filter((e) => {
      const proj = (e.identity?.project || "").toLowerCase();
      return proj && proj !== "unknown" && proj.includes(s);
    });
    if (subs.length === 1) return { target: subs[0] };
    if (subs.length > 1) {
      return { error: `'${sel}' is ambiguous — it matches:\n${editorListText(subs)}\nPass a port, pid, or exact project name.` };
    }
    return { error: `No live editor matches '${sel}'. Live editors:\n${editorListText(live)}\nPass editor: <port|project|pid>.` };
  }
  if (live.length === 1) return { target: live[0] };
  return { error: `Multiple UE editors are open — set the 'editor' arg (port / project / pid):\n${editorListText(live)}` };
}

function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }

// ── Static front tool surface (4 meta-tools) ──────────────────────────────────────
const EDITOR_ARG = {
  type: "string",
  description: "Optional. Target editor by port ('8001'), project name, or pid. Defaults to the only running editor; if several are open and omitted, the call returns the editor list to choose from.",
};

const FRONT_TOOLS = [
  {
    name: "list_editors",
    description: "List the Unreal editors the gateway currently sees on 127.0.0.1:8000-8031 (project, port, pid, engine version). Use this to pick a target for the 'editor' argument.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_toolsets",
    description: "List the AI toolsets available on a running Unreal editor — the engine's native packs (EditorToolset, NiagaraToolsets, UMGToolSet, GASToolsets, PCGToolset, …) AND UELLMToolkit (animation / audio / MetaSound / Enhanced Input / lighting / PIE gameplay-debug / console / import — the gaps the engine lacks). Start here, then describe_toolset and call_tool.",
    inputSchema: { type: "object", properties: { editor: EDITOR_ARG } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "describe_toolset",
    description: "Get the tools (names + input schemas) for one toolset on an editor. A large toolset (e.g. a native NiagaraToolset, or a legacy UE 5.7 editor's ~40-tool UELLMToolkit) is automatically condensed to fit the response — descriptions shortened to their first line and output schemas dropped, then names-only if still too big. Pass 'tool_name' to get one tool's full, untruncated description + schema.",
    inputSchema: {
      type: "object",
      properties: {
        toolset_name: { type: "string", description: "Toolset name from list_toolsets (e.g. 'EditorAppToolset', 'UELLMToolkit')." },
        tool_name: { type: "string", description: "Optional. Narrow to a single tool and return its full (untruncated) description + input schema." },
        editor: EDITOR_ARG,
      },
      required: ["toolset_name"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "call_tool",
    description: "Invoke a tool on an editor. Provide toolset_name + tool_name + arguments (use describe_toolset for the schema).",
    inputSchema: {
      type: "object",
      properties: {
        toolset_name: { type: "string", description: "Owning toolset (e.g. 'EditorAppToolset', 'UELLMToolkit'). Omit only for a top-level MCP tool." },
        tool_name: { type: "string", description: "Tool to call (bare name, no toolset prefix)." },
        arguments: { type: "object", description: "Tool arguments. Defaults to {}." },
        editor: EDITOR_ARG,
      },
      required: ["tool_name"],
    },
  },
];
const FORWARDED = new Set(["list_toolsets", "describe_toolset", "call_tool"]);

// ── MCP front server ────────────────────────────────────────────────────────────
function buildServer() {
  const server = new StdioServer({ name: "ue-mcp-gateway", version: "2.2.0" });

  server.on("initialize", (params) => ({
    protocolVersion: params?.protocolVersion || "2025-03-26",
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "ue-mcp-gateway", version: "2.2.0" },
  }));
  server.on("notifications/initialized", () => {});
  server.on("ping", () => ({}));
  server.on("tools/list", () => ({ tools: FRONT_TOOLS }));

  server.on("tools/call", async (params) => {
    const { name, arguments: args } = params || {};

    if (name === "list_editors") {
      const live = liveEditors();
      return textResult(live.length
        ? JSON.stringify(live.map((e) => e.summary()), null, 2)
        : "No UE editors currently running on ports 8000-8031.");
    }

    if (FORWARDED.has(name)) {
      const { target, error } = resolveEditor(args?.editor);
      if (error) return textResult(error); // guidance, not a hard error
      const fwd = { ...(args || {}) };
      delete fwd.editor;
      const timeout = name === "call_tool" ? CALL_TIMEOUT_MS : META_TIMEOUT_MS;
      try {
        const res = await target.forward(name, fwd, timeout);
        return { content: res.content || [], isError: !!res.isError };
      } catch (e) {
        return textResult(`${name} on editor ${target.port} (${target.identity?.project || "?"}) failed: ${e.message}`, true);
      }
    }

    return textResult(`Unknown gateway tool: ${name}. Available: list_editors, list_toolsets, describe_toolset, call_tool.`, true);
  });

  return server;
}

async function main() {
  const server = buildServer();
  server.start();
  log.info("gateway up (forwarding engine discovery)", { base: BASE_PORT });
  // Self-rescheduling loop (NOT setInterval): the next scan is only queued AFTER the current one
  // settles, so passes can't overlap and double-connect / leak an editor session if a sweep runs long.
  const tick = async () => {
    try { await scanOnce(server); }
    catch (e) { log.error("scan error (continuing)", { error: e.message }); }
    finally { setTimeout(tick, SCAN_INTERVAL_MS); }
  };
  await tick();
}

main().catch((e) => {
  // Only a fatal FRONT transport failure reaches here; backend faults are contained above.
  log.error("fatal gateway error", { error: e?.message, stack: e?.stack });
  process.exit(1);
});
