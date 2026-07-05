/**
 * EditorClient — a downstream connection to ONE live Unreal editor, in either of two modes:
 *
 *   native (UE 5.8+): the engine's ModelContextProtocol server — JSON-RPC over Streamable HTTP at
 *     /mcp, exposing the tool-search meta-tools (list_toolsets/describe_toolset/call_tool). The gateway
 *     forwards those verbatim.
 *
 *   legacy (UE 5.7):  the old UELLMToolkit bespoke REST server on a fixed port — GET /mcp/tools,
 *     POST /mcp/tool/{name}, GET /mcp/status. It has no toolsets and no meta-tools, so this client
 *     ADAPTS the 4-tool meta surface onto REST: the flat tool list is presented as a single synthetic
 *     `UELLMToolkit` toolset, and call_tool becomes a POST. From the gateway's (and the agent's) point
 *     of view a 5.7 editor is indistinguishable from a 5.8 one — same discovery workflow, no restart.
 *
 * Detection is by port membership (native range vs the configured legacy port); a fault marks the
 * client not-alive and the scanner re-discovers on its next sweep.
 */

import { HttpClient, LegacyHttpClient } from "./mcp.js";
import {
  log, parseIdentity, resultText, URL_PATH,
  CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS,
  isNativePort, isLegacyPort,
  isLegacyStatus, legacyStatusToIdentity, legacyParamsToInputSchema,
} from "./lib.js";

// The synthetic toolset a legacy (5.7) editor's flat tools are presented under, so the agent's
// list_toolsets → describe_toolset → call_tool workflow is IDENTICAL to a 5.8 editor's.
const LEGACY_TOOLSET = "UELLMToolkit";

export class EditorClient {
  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.url = `http://${host}:${port}${URL_PATH}`;
    this.base = `http://${host}:${port}`;
    this.mode = null;      // 'native' | 'legacy'
    this.client = null;    // native transport (HttpClient)
    this.legacy = null;    // legacy transport (LegacyHttpClient)
    this.identity = null;  // { project, uproject, ue, pid, port }
    this.alive = false;
  }

  /**
   * Connect and identify. Detect the protocol by PORT: the native JSON-RPC MCP on the engine's
   * auto-port range, or the legacy 5.7 REST server on its fixed port. A port in both sets tries native
   * first; a port in neither defaults to native. First detector that connects wins.
   */
  async connect() {
    const detectors = [];
    if (isNativePort(this.port)) detectors.push(() => this._connectNative());
    if (isLegacyPort(this.port)) detectors.push(() => this._connectLegacy());
    if (detectors.length === 0) detectors.push(() => this._connectNative());

    let lastErr;
    for (const detect of detectors) {
      try { await detect(); return this; }
      catch (e) { lastErr = e; await this._teardown(); }
    }
    throw lastErr || new Error(`port ${this.port}: no UE MCP editor detected`);
  }

  async _connectNative() {
    this.client = new HttpClient(this.url, { name: "ue-mcp-gateway", version: "2.1.0" }, CALL_TIMEOUT_MS);
    await this.client.connect(CONNECT_TIMEOUT_MS);

    const listing = await this.client.call("tools/call", { name: "list_toolsets", arguments: {} }, CONNECT_TIMEOUT_MS);
    const text = resultText(listing);
    if (!text) throw new Error(`port ${this.port} did not answer list_toolsets — not a native UE MCP editor`);
    // Identity is embedded in the UELLMToolkit toolset description prefix when present; otherwise fall
    // back to port-only so the gateway still routes to any native MCP editor.
    this.mode = "native";
    this.identity = parseIdentity(text) || { project: "Unknown", uproject: "", ue: "", pid: 0, port: this.port };
    this.alive = true;
    log.info("editor connected", { port: this.port, mode: this.mode, project: this.identity.project, pid: this.identity.pid });
    return this;
  }

  async _connectLegacy() {
    this.legacy = new LegacyHttpClient(this.base, CALL_TIMEOUT_MS);
    const status = await this.legacy.status(CONNECT_TIMEOUT_MS);
    if (!isLegacyStatus(status)) throw new Error(`port ${this.port} /mcp/status is not a UE 5.7 UELLMToolkit server`);
    this.mode = "legacy";
    this.identity = legacyStatusToIdentity(status, this.port);
    this.alive = true;
    log.info("editor connected", { port: this.port, mode: this.mode, project: this.identity.project, ue: this.identity.ue });
    return this;
  }

  /** Forward an engine discovery meta-tool to the editor — verbatim (native) or adapted (legacy). */
  async forward(metaTool, args, timeoutMs) {
    return this.mode === "legacy"
      ? this._forwardLegacy(metaTool, args, timeoutMs)
      : this._forwardNative(metaTool, args, timeoutMs);
  }

  async _forwardNative(metaTool, args, timeoutMs) {
    try {
      return await this.client.call("tools/call", { name: metaTool, arguments: args || {} }, timeoutMs || CALL_TIMEOUT_MS);
    } catch (e) {
      // A per-call timeout (AbortError) doesn't prove the editor is gone — surface it but KEEP the
      // session; the TCP scan + next call catch a genuinely dead one. Hard faults → mark dead.
      if (e?.name !== "AbortError") this.alive = false;
      throw e;
    }
  }

  /**
   * Adapt the 4 meta-tools onto the 5.7 REST API:
   *   list_toolsets    → one synthetic UELLMToolkit toolset wrapping the flat tool list
   *   describe_toolset → GET /mcp/tools, each tool's `parameters` → JSON-Schema inputSchema
   *   call_tool        → POST /mcp/tool/{tool_name}, {success,message,data} → MCP content
   */
  async _forwardLegacy(metaTool, args, timeoutMs) {
    const timeout = timeoutMs || CALL_TIMEOUT_MS;
    try {
      if (metaTool === "list_toolsets") {
        const tools = await this.legacy.listTools(timeout);
        const text =
          `Toolsets on this editor (legacy UE 5.7 REST server — project "${this.identity?.project || "Unknown"}"):\n` +
          `- ${LEGACY_TOOLSET} — ${tools.length} tools. ` +
          `Call describe_toolset { toolset_name: "${LEGACY_TOOLSET}" } for schemas, then call_tool.`;
        return { content: [{ type: "text", text }] };
      }

      if (metaTool === "describe_toolset") {
        const requested = args?.toolset_name;
        if (requested && String(requested).toLowerCase() !== LEGACY_TOOLSET.toLowerCase()) {
          return { content: [{ type: "text",
            text: `This legacy UE 5.7 editor exposes only the '${LEGACY_TOOLSET}' toolset (a flat tool set); '${requested}' is not available here.` }] };
        }
        const tools = await this.legacy.listTools(timeout);
        const shaped = {
          toolset: LEGACY_TOOLSET,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: legacyParamsToInputSchema(t.parameters),
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      }

      if (metaTool === "call_tool") {
        const toolName = args?.tool_name;
        if (!toolName) return { content: [{ type: "text", text: "call_tool requires 'tool_name'." }], isError: true };
        const res = await this.legacy.callTool(toolName, args?.arguments || {}, timeout);
        const ok = !!res?.success;
        // Mirror the 5.7 Node bridge exactly: success → message + optional data; failure → "Error: message".
        const text = ok
          ? (res.message || "") + (res.data !== undefined ? `\n\n${JSON.stringify(res.data)}` : "")
          : `Error: ${res?.message || res?.error || "unknown error"}`;
        return { content: [{ type: "text", text }], isError: !ok };
      }

      return { content: [{ type: "text", text: `Unknown meta-tool for legacy editor: ${metaTool}` }], isError: true };
    } catch (e) {
      // Same rule as native: a timeout may be transient; any other fault marks the editor for reconnect.
      if (e?.name !== "AbortError") this.alive = false;
      throw e;
    }
  }

  /**
   * Re-confirm this port still hosts the SAME editor. A port can be closed and re-bound by a different
   * editor between scans; the TCP probe can't see that, so the scanner calls this periodically. Updates
   * identity on drift; returns true if it changed. Throws if unreachable → caller marks for reconnect.
   */
  async reverifyIdentity() {
    if (this.mode === "legacy") {
      const status = await this.legacy.status(CONNECT_TIMEOUT_MS);
      if (!isLegacyStatus(status)) {
        // Answered but not the 5.7 shape → the port was taken over by something else; force reconnect.
        this.alive = false;
        throw new Error(`port ${this.port} no longer a UE 5.7 server`);
      }
      const prev = this.identity?.project;
      this.identity = legacyStatusToIdentity(status, this.port);
      return prev != null && this.identity.project !== prev;
    }

    const listing = await this._forwardNative("list_toolsets", {}, CONNECT_TIMEOUT_MS);
    const id = parseIdentity(resultText(listing));
    const prevPid = this.identity?.pid;
    if (!id) {
      // Answered, but no UELLMToolkit identity prefix. If we previously had a REAL identity the port
      // was reused by a different (identity-less) editor → drift: drop to a port-only placeholder.
      if (prevPid) { this.identity = { project: "Unknown", uproject: "", ue: "", pid: 0, port: this.port }; return true; }
      return false;
    }
    this.identity = id;
    return prevPid != null && id.pid !== prevPid;
  }

  summary() {
    const id = this.identity || {};
    return { port: this.port, mode: this.mode, project: id.project, uproject: id.uproject, ue: id.ue, pid: id.pid, alive: this.alive };
  }

  async _teardown() {
    try { await this.client?.close(); } catch { /* ignore */ }
    try { await this.legacy?.close(); } catch { /* ignore */ }
    this.client = null;
    this.legacy = null;
  }

  async close() {
    await this._teardown();
    this.alive = false;
  }
}
