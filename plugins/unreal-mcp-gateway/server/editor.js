/**
 * EditorClient — a downstream MCP connection to ONE live Unreal editor.
 *
 * Speaks MCP JSON-RPC over Streamable HTTP (via the zero-dependency HttpClient) to the
 * editor's native MCP server. The gateway forwards the engine's discovery meta-tools
 * verbatim, so this client only (a) connects, (b) confirms the editor answers
 * `list_toolsets` and grabs its identity (project/pid/port — read from the UELLMToolkit
 * toolset prefix when present), and (c) forwards meta-tool calls. A fault marks the client
 * not-alive and the scanner re-discovers on its next sweep.
 */

import { HttpClient } from "./mcp.js";
import { log, parseIdentity, resultText, URL_PATH, CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS } from "./lib.js";

export class EditorClient {
  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.url = `http://${host}:${port}${URL_PATH}`;
    this.client = null;
    this.identity = null; // { project, uproject, ue, pid, port }
    this.alive = false;
  }

  /** Connect, confirm it's an engine MCP editor (answers list_toolsets), grab identity. */
  async connect() {
    this.client = new HttpClient(this.url, { name: "ue-mcp-gateway", version: "2.0.0" }, CALL_TIMEOUT_MS);
    await this.client.connect(CONNECT_TIMEOUT_MS);

    const listing = await this.forward("list_toolsets", {}, CONNECT_TIMEOUT_MS);
    const text = resultText(listing);
    if (!text) {
      throw new Error(`port ${this.port} did not answer list_toolsets — not a UE MCP editor`);
    }
    // Identity is embedded in the UELLMToolkit toolset description prefix when present;
    // otherwise fall back to port-only so the gateway still routes to any MCP editor.
    this.identity = parseIdentity(text) || { project: "Unknown", uproject: "", ue: "", pid: 0, port: this.port };
    this.alive = true;
    log.info("editor connected", { port: this.port, project: this.identity.project, pid: this.identity.pid });
    return this;
  }

  /**
   * Forward an engine discovery meta-tool (list_toolsets / describe_toolset / call_tool)
   * verbatim. In tool-search mode these ARE the editor's top-level tools/call names.
   */
  async forward(metaTool, args, timeoutMs) {
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
   * Re-confirm this port still hosts the SAME editor process. An editor can close and a different
   * one bind the same loopback port between scans; the gateway's TCP probe can't see that, so the
   * scanner calls this periodically. Updates identity on drift; returns true if the pid changed.
   * Throws (via forward) if the editor is unreachable — the caller then marks it for reconnect.
   */
  async reverifyIdentity() {
    const listing = await this.forward("list_toolsets", {}, CONNECT_TIMEOUT_MS);
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
    return { port: this.port, project: id.project, uproject: id.uproject, ue: id.ue, pid: id.pid, alive: this.alive };
  }

  async close() {
    try { await this.client?.close(); } catch { /* ignore */ }
    this.alive = false;
  }
}
