/**
 * Minimal, ZERO-DEPENDENCY MCP primitives (Node built-ins only — no npm install).
 *
 *  - StdioServer: the front. Speaks MCP (JSON-RPC 2.0) over stdio as newline-delimited
 *    JSON, the same wire format the official clients use.
 *  - HttpClient: the downstream. Speaks MCP over Streamable HTTP to an editor's
 *    127.0.0.1:<port>/mcp endpoint (handles the Mcp-Session-Id handshake and both
 *    application/json and text/event-stream responses).
 *
 * Node 18+ provides global fetch, AbortController, and process streams — nothing else needed.
 */

import { createInterface } from "node:readline";

// ── Front: stdio JSON-RPC server ───────────────────────────────────────────────
export class StdioServer {
  constructor(serverInfo) {
    this.serverInfo = serverInfo;
    this.handlers = new Map(); // method -> async (params, msg) => result
  }

  on(method, fn) { this.handlers.set(method, fn); return this; }

  start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => { this._handle(line).catch(() => {}); });
    rl.on("close", () => process.exit(0));
  }

  async _handle(line) {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); }
    catch { return this._send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      // No JSON-RPC batch support — reject non-object frames instead of silently dropping them.
      return this._send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }

    const isRequest = msg.id !== undefined && msg.id !== null;
    const handler = msg.method ? this.handlers.get(msg.method) : undefined;

    if (!isRequest) { // notification
      if (handler) { try { await handler(msg.params, msg); } catch { /* ignore */ } }
      return;
    }
    if (!handler) {
      return this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
    try {
      const result = await handler(msg.params, msg);
      this._send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (e) {
      this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message || "internal error" } });
    }
  }

  notify(method, params) { this._send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }

  _send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); } // stdout is the protocol channel
}

// ── Downstream: Streamable-HTTP JSON-RPC client ────────────────────────────────
export class HttpClient {
  constructor(url, clientInfo, defaultTimeoutMs = 30000) {
    this.url = url;
    this.clientInfo = clientInfo;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.sessionId = null;
    this._id = 0;
  }

  async connect(timeoutMs) {
    const res = await this._post(
      { jsonrpc: "2.0", id: ++this._id, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: this.clientInfo } },
      timeoutMs,
    );
    if (res.error) throw new Error(res.error.message || "initialize failed");
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs); // notification
    return res.result;
  }

  /** Call a JSON-RPC method (e.g. "tools/list", "tools/call"); returns result or throws on error. */
  async call(method, params, timeoutMs) {
    const res = await this._post({ jsonrpc: "2.0", id: ++this._id, method, params: params || {} }, timeoutMs);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return res.result;
  }

  async close() {
    if (!this.sessionId) return;
    const controller = new AbortController();      // bound the DELETE like every other request, so a
    const timer = setTimeout(() => controller.abort(), 3000); // wedged-but-open editor can't hang the scan loop
    try {
      await fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId }, signal: controller.signal });
    } catch { /* best effort */ }
    finally { clearTimeout(timer); }
    this.sessionId = null;
  }

  async _post(body, timeoutMs = this.defaultTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (body.id === undefined) {                // notification → no response of interest
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return {};
      }
      if (!res.ok) {                              // HTTP-level error (not a normal JSON-RPC body)
        const bodyText = await res.text().catch(() => "");
        // 400 (missing) / 404 (expired/unknown) session → drop it so the NEXT call re-handshakes,
        // instead of replaying a dead session id forever and silently stranding the editor.
        if (res.status === 400 || res.status === 404) this.sessionId = null;
        // If the server still returned a structured JSON-RPC error body, surface it faithfully
        // (preserves error.code/message) rather than flattening to a generic HTTP string.
        let parsed; try { parsed = parseJsonRpc(bodyText); } catch { /* not a JSON-RPC body */ }
        if (parsed && parsed.error) return parsed;
        throw new Error(`HTTP ${res.status} from editor${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/event-stream") && res.body) {
        // The server may keep the SSE stream OPEN after the reply (for progress); resolve as
        // soon as our reply arrives instead of waiting for the stream to close.
        return await readSseMessage(res.body, body.id);
      }
      return parseJsonRpc(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }
}

const MAX_SSE_BYTES = 16 * 1024 * 1024; // hard cap so a never-framed SSE stream can't grow the buffer unboundedly

/** Read an SSE response stream and resolve on the first JSON-RPC reply for `id` (then cancel). */
async function readSseMessage(stream, id) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      if (buf.length > MAX_SSE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`editor SSE response exceeded ${MAX_SSE_BYTES} bytes without a JSON-RPC reply`);
      }
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const evt = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = evt.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("");
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        // Match OUR request id; only fall back to result/error for an id-LESS frame (some servers
        // don't echo the id) — never accept a present-but-DIFFERENT id as our reply.
        if (msg && (msg.id === id || (msg.id === undefined && (msg.result !== undefined || msg.error !== undefined)))) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return msg;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  // Stream ended without a framed reply for our id — surface a clear diagnostic, not a raw JSON throw.
  try { return parseJsonRpc(buf); }
  catch { throw new Error("editor SSE stream ended without a JSON-RPC reply"); }
}

/** Parse a response body that is either raw JSON or SSE-framed ("event: message\ndata: {...}"). */
export function parseJsonRpc(text) {
  const s = (text || "").trim();
  if (!s) return {};
  if (s[0] === "{" || s[0] === "[") return JSON.parse(s);
  const datas = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m) datas.push(m[1]);
  }
  return JSON.parse(datas.join("") || "{}");
}
