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

// Byte budget for a single describe_toolset result. The MCP client caps a tool result on TOKENS
// (Claude Code MAX_MCP_OUTPUT_TOKENS default 25000) and also files-away very large outputs. UE schema
// JSON is dense (~3 bytes/token), and empirically a ~34KB describe returns inline while ~62KB is
// filed away — so 40KB keeps results inline AND well under the token cap. Oversized toolsets fall back
// to the catalog tier here (use describe_toolset { tool_name } for a specific tool's full schema).
// Raise it (or the client's MAX_MCP_OUTPUT_TOKENS) for richer describes; lower it for CJK/localized text.
export const DESCRIBE_MAX_BYTES = parseInt(process.env.UE_GATEWAY_DESCRIBE_MAX_BYTES, 10) || 40000;

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

/** First line (≤200 chars) of a description — used to summarize large toolsets so 40+ verbose tools fit. */
export function firstLine(s) {
  const l = String(s || "").split("\n")[0].trim();
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
}

const byteLen = (s) => Buffer.byteLength(String(s), "utf8");

/** First candidate (built lazily, richest→leanest) whose serialized size fits `max`; else the leanest. */
function pickFitting(builders, max) {
  let last = "";
  for (const build of builders) {
    last = build();
    if (byteLen(last) <= max) return last;
  }
  return last; // none fit → the leanest builder, which the callers construct to be self-bounding
}

// A catalog row is bounded on its own: name + first-line description + at most MAX_REQ required-param
// names (so one tool with a pathologically long `required[]` can't blow the row up).
const MAX_CATALOG_REQUIRED = 24;
function catalogRow(t) {
  const req = (t?.inputSchema && Array.isArray(t.inputSchema.required)) ? t.inputSchema.required : [];
  const shown = req.slice(0, MAX_CATALOG_REQUIRED);
  return {
    name: String(t?.name ?? ""),
    description: firstLine(t?.description),
    required: shown,
    ...(req.length > shown.length ? { requiredMore: req.length - shown.length } : {}),
  };
}

/**
 * Cap a describe_toolset result so a single tool result NEVER exceeds the MCP client's per-result budget
 * (approximated by DESCRIBE_MAX_BYTES; the client cap is token-based, so keep the byte budget below
 * ~3.2× the token cap — lower it further for CJK/localized toolsets where bytes-per-token is smaller).
 * Uniform for native and legacy — both expose the same shape:
 *   { name|toolset, version?, description?, tools: [{ name, description, inputSchema, outputSchema?, annotations? }] }
 * Every tier below is bounded; the LAST builder in each chain is self-limiting, so the result always fits.
 * Returns { text } from the richest tier that fits:
 *   opts.toolName → one tool: full → drop outputSchema → schema-only (desc/output trimmed) → required-only
 *   whole toolset → full (native verbatim / legacy pretty) → summary (1st-line desc + inputSchema, no
 *                   outputSchema) → catalog (names + 1st-line desc + required) → truncated catalog (first K tools)
 */
export function capDescribe(obj, opts = {}) {
  const max = opts.maxBytes || DESCRIBE_MAX_BYTES;
  const tools = Array.isArray(obj?.tools) ? obj.tools : [];
  const head = {};
  for (const key of ["toolset", "name", "version", "description"]) {
    if (obj?.[key] !== undefined) head[key] = obj[key];
  }

  // Narrow to ONE tool. Match the bare name (case-insensitively) or a toolset-qualified engine name by
  // its suffix (e.g. "SetVerbosity" → "EditorToolset.LogsToolset.SetVerbosity"). If a bare suffix is
  // ambiguous across sub-namespaces, disambiguate rather than silently returning the first hit.
  if (opts.toolName != null && String(opts.toolName).trim() !== "") {
    const want = String(opts.toolName).trim().toLowerCase();
    let t = tools.find((x) => String(x.name).toLowerCase() === want);
    if (!t) {
      const suffixed = tools.filter((x) => String(x.name).toLowerCase().endsWith(`.${want}`));
      if (suffixed.length > 1) {
        return { text: `Tool name '${opts.toolName}' is ambiguous in this toolset — matches: ${suffixed.map((x) => x.name).join(", ")}. Pass one of those fully-qualified names.` };
      }
      t = suffixed[0];
    }
    if (!t) return { text: `Tool '${opts.toolName}' not found in this toolset. Call describe_toolset without tool_name to list its tools.` };
    return { text: pickFitting([
      () => JSON.stringify({ ...head, tools: [t] }, null, 2),                                              // full
      () => JSON.stringify({ ...head, tools: [{ ...t, outputSchema: undefined }] }, null, 2),              // drop outputSchema
      () => JSON.stringify({ ...head, note: "Trimmed to fit: description shortened, output schema omitted.",
        tools: [{ name: t.name, description: firstLine(t.description), inputSchema: t.inputSchema }] }),    // schema-only
      () => JSON.stringify({ ...head, note: `Tool '${t.name}' has a schema too large to return in one result; showing required params only.`,
        tools: [catalogRow(t)] }),                                                                         // required-only (bounded)
    ], max) };
  }

  return { text: pickFitting([
    // Tier 1: full — native verbatim (rawText), legacy pretty.
    () => opts.rawText != null ? String(opts.rawText) : JSON.stringify({ ...head, tools }, null, 2),
    // Tier 2: summary — full inputSchema (needed to call), first-line descriptions, drop outputSchema.
    () => JSON.stringify({
      ...head,
      note: `Summarized to fit: descriptions shortened to their first line and output schemas omitted. Call describe_toolset { toolset_name, tool_name: "<name>" } for one tool's full detail.`,
      tools: tools.map((t) => ({
        name: t.name,
        description: firstLine(t.description),
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }),
    // Tier 3: catalog — names + first-line descriptions + (bounded) required params.
    () => JSON.stringify({
      ...head,
      note: `Catalog only — this toolset (${tools.length} tools) is too large for full schemas in one result. Call describe_toolset { toolset_name, tool_name: "<name>" } for a specific tool's schema.`,
      tools: tools.map(catalogRow),
    }),
    // Tier 4: truncated catalog — the first K rows that fit. Self-bounding, so the chain always fits.
    () => truncatedCatalog(head, tools, max),
  ], max) };
}

/** Largest prefix of catalog rows that fits `max`, with a note saying how many were omitted. Always ≤ max. */
function truncatedCatalog(head, tools, max) {
  const rows = tools.map(catalogRow);
  const envelope = (k) => ({
    ...head,
    note: k < rows.length
      ? `Showing ${k} of ${rows.length} tools (rest omitted to fit). Call describe_toolset { toolset_name, tool_name: "<name>" } for any specific tool.`
      : `${rows.length} tools.`,
    tools: rows.slice(0, k),
  });
  let k = rows.length;
  while (k > 0 && byteLen(JSON.stringify(envelope(k))) > max) k--;
  return JSON.stringify(envelope(k));
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
