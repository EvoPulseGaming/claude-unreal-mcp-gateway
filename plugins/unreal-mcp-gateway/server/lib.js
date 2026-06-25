/**
 * ue-mcp-gateway — shared helpers.
 *
 * Discovery range, logging (stderr only — stdout is the MCP stdio channel),
 * a cheap TCP liveness probe, a promise timeout, and the toolset-identity parser.
 */

import net from "node:net";

// Auto-port range the UE native server probes (UnrealClaudeModule.cpp: BasePort .. BasePort+32).
export const BASE_PORT = parseInt(process.env.UE_GATEWAY_BASE_PORT, 10) || 8000;
export const PORT_RANGE = parseInt(process.env.UE_GATEWAY_PORT_RANGE, 10) || 32;
export const URL_PATH = process.env.UE_GATEWAY_URL_PATH || "/mcp";
export const SCAN_INTERVAL_MS = parseInt(process.env.UE_GATEWAY_SCAN_MS, 10) || 2500;
export const TCP_PROBE_MS = parseInt(process.env.UE_GATEWAY_TCP_PROBE_MS, 10) || 250;
export const CONNECT_TIMEOUT_MS = parseInt(process.env.UE_GATEWAY_CONNECT_MS, 10) || 4000;
export const CALL_TIMEOUT_MS = parseInt(process.env.UE_GATEWAY_CALL_MS, 10) || 300000;

// Logs go to stderr so they never corrupt the JSON-RPC stdout stream.
export const log = {
  info: (msg, data) => console.error(`[gateway] ${msg}`, data ? JSON.stringify(data) : ""),
  warn: (msg, data) => console.error(`[gateway][warn] ${msg}`, data ? JSON.stringify(data) : ""),
  error: (msg, data) => console.error(`[gateway][error] ${msg}`, data ? JSON.stringify(data) : ""),
  debug: (msg, data) => process.env.DEBUG && console.error(`[gateway][debug] ${msg}`, data ? JSON.stringify(data) : ""),
};

export function ports() {
  return Array.from({ length: PORT_RANGE }, (_, i) => BASE_PORT + i);
}

/** Resolve/reject `p` but never wait longer than `ms`. */
export function withTimeout(p, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Cheap "is something listening on this loopback port?" check — no protocol, just a TCP connect. */
export function tcpProbe(port, host = "127.0.0.1", timeoutMs = TCP_PROBE_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

/**
 * Parse the UE toolset identity prefix that FUELLMToolset::GetToolsetDescription() prepends:
 *   "[Project | X:/path/Proj.uproject | UE 5.8 | pid=61072 | port=8000] UELLMToolkit: ..."
 * Returns { project, uproject, ue, pid, port } or null.
 */
export function parseIdentity(text) {
  if (!text) return null;
  const m = text.match(
    /\[([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*UE\s*([\d.]+)\s*\|\s*pid=(\d+)\s*\|\s*port=(\d+)\]/,
  );
  if (!m) return null;
  return {
    project: m[1].trim(),
    uproject: m[2].trim(),
    ue: m[3].trim(),
    pid: parseInt(m[4], 10),
    port: parseInt(m[5], 10),
  };
}

/** Pull the plain text out of an MCP tool result's content array. */
export function resultText(res) {
  if (!res || !Array.isArray(res.content)) return "";
  return res.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
