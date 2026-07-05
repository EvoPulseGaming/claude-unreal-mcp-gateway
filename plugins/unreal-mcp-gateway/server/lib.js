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

// ── Legacy (UE 5.7) support ─────────────────────────────────────────────────────
// The 5.7 UELLMToolkit predates the engine-native MCP server: it runs a bespoke REST API
// (GET /mcp/tools, POST /mcp/tool/{name}, GET /mcp/status) on a SINGLE fixed loopback port
// (default 3000), NOT the JSON-RPC-over-Streamable-HTTP the 5.8 plugin uses. The gateway fronts it
// too so 5.7 users also get no-restart. One 5.7 editor at a time — the plugin binds ONE fixed port,
// so a second editor can't bind it; that's a 5.7 limitation the gateway can't lift, it just routes to
// whichever 5.7 editor holds the port. Set UE_GATEWAY_LEGACY_PORTS="" to disable legacy discovery.
export const LEGACY_PORTS = parseLegacyPorts(process.env.UE_GATEWAY_LEGACY_PORTS, [3000]);

function parseLegacyPorts(env, dflt) {
  if (env == null) return dflt;              // unset → default
  return String(env)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536); // ""/all-invalid → [] disables legacy
}

export function isNativePort(port) { return port >= BASE_PORT && port < BASE_PORT + PORT_RANGE; }
export function isLegacyPort(port) { return LEGACY_PORTS.includes(port); }

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

/** Every port the scanner probes: the native auto-port range PLUS any legacy (5.7) ports, deduped. */
export function scanPorts() {
  const seen = new Set();
  const out = [];
  for (const p of [...ports(), ...LEGACY_PORTS]) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
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

// ── Legacy (UE 5.7) shape converters ────────────────────────────────────────────

/**
 * A GET /mcp/status body is only a legit 5.7 UELLMToolkit server if it carries a field ONLY that server
 * emits — guards against a foreign dev server that merely happens to answer :3000 with 200 JSON. A bare
 * `status` string (the common health-check shape `{status:"ok"}`) is deliberately NOT enough; the real
 * 5.7 HandleStatus always emits projectName + projectDirectory + engineVersion + toolCount together.
 */
export function isLegacyStatus(s) {
  if (!s || typeof s !== "object") return false;
  return typeof s.projectName === "string" ||
    typeof s.engineVersion === "string" ||
    typeof s.projectDirectory === "string" ||
    Number.isFinite(s.toolCount);
}

/** Build the gateway's identity shape from a 5.7 GET /mcp/status body (which reports no pid). */
export function legacyStatusToIdentity(status, port) {
  const s = status && typeof status === "object" ? status : {};
  return {
    project: s.projectName ? String(s.projectName) : "Unknown",
    uproject: s.projectDirectory ? String(s.projectDirectory) : "",
    ue: s.engineVersion ? String(s.engineVersion) : "",
    pid: 0,                 // the 5.7 REST /mcp/status doesn't expose a pid
    port,
  };
}

/** Convert a 5.7 tool's `parameters` array (from GET /mcp/tools) into a JSON-Schema inputSchema. */
export function legacyParamsToInputSchema(parameters) {
  const properties = {};
  const required = [];
  for (const p of Array.isArray(parameters) ? parameters : []) {
    if (!p || !p.name) continue;
    const t = p.type;
    const allowed = t === "number" || t === "integer" || t === "boolean" || t === "array" || t === "object";
    const prop = { type: allowed ? t : "string" };
    if (p.description) prop.description = p.description;
    if (p.default !== undefined && p.default !== "") {
      // The 5.7 server always emits `default` as a STRING; coerce it to the mapped type so we don't
      // advertise a mismatch like {type:"integer", default:"50"}.
      if (prop.type === "number" || prop.type === "integer") {
        const n = Number(p.default);
        prop.default = Number.isFinite(n) ? n : p.default;
      } else if (prop.type === "boolean") {
        prop.default = typeof p.default === "boolean" ? p.default : /^true$/i.test(String(p.default));
      } else {
        prop.default = p.default;
      }
    }
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}
