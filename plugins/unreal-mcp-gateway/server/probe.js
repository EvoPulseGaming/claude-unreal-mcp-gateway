#!/usr/bin/env node
/**
 * Diagnostic probe — connects to ONE live UE editor and dumps the protocol shapes the gateway
 * depends on. Auto-detects a native (5.8) editor (tools/list, list_toolsets, describe_toolset,
 * call_tool dispatch) or a legacy (5.7) REST editor (GET /mcp/status, GET /mcp/tools, POST /mcp/tool).
 * Zero-dependency: uses the gateway's own clients (Node built-ins only).
 *
 *   node probe.js [port]      (defaults to the first live editor on the native + legacy ports)
 */

import { HttpClient, LegacyHttpClient } from "./mcp.js";
import { scanPorts, tcpProbe, URL_PATH, resultText, parseIdentity, isLegacyPort, CONNECT_TIMEOUT_MS } from "./lib.js";

function show(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function probeNative(port) {
  const url = `http://127.0.0.1:${port}${URL_PATH}`;
  console.log(`Probing NATIVE ${url} ...`);
  const c = new HttpClient(url, { name: "ue-gateway-probe", version: "1.0.0" }, 20000);
  const init = await c.connect(CONNECT_TIMEOUT_MS);
  show("initialize result", init);

  const lt = await c.call("tools/list", {});
  show("tools/list — names", (lt.tools || []).map((t) => t.name));

  const ls = await c.call("tools/call", { name: "list_toolsets", arguments: {} });
  show("list_toolsets (text)", resultText(ls));
  show("parsed identity", parseIdentity(resultText(ls)));

  const desc = await c.call("tools/call", { name: "describe_toolset", arguments: { toolset_name: "UELLMToolkit" } });
  show("describe_toolset length", resultText(desc).length);

  const call = await c.call(
    "tools/call",
    { name: "call_tool", arguments: { toolset_name: "UELLMToolkit", tool_name: "run_console_command", arguments: { command: "stat unit" } } },
    15000,
  );
  show("call_tool run_console_command", { isError: call.isError, text: resultText(call).slice(0, 400) });

  await c.close();
}

async function probeLegacy(port) {
  const base = `http://127.0.0.1:${port}`;
  console.log(`Probing LEGACY (5.7 REST) ${base} ...`);
  const c = new LegacyHttpClient(base, 20000);

  const status = await c.status(CONNECT_TIMEOUT_MS);
  show("GET /mcp/status", status);

  const tools = await c.listTools();
  show("GET /mcp/tools — names", tools.map((t) => t.name));

  const call = await c.callTool("run_console_command", { command: "stat unit" }, 15000);
  show("POST /mcp/tool/run_console_command", { success: call.success, message: String(call.message).slice(0, 400) });
}

async function main() {
  let port = parseInt(process.argv[2], 10);
  if (!Number.isInteger(port)) { for (const p of scanPorts()) { if (await tcpProbe(p)) { port = p; break; } } }
  if (!port) { console.error("No live editor found. Open one first."); process.exit(2); }

  // Try native first for a native port, legacy first for a legacy port; fall through on failure.
  const order = isLegacyPort(port) ? [probeLegacy, probeNative] : [probeNative, probeLegacy];
  let lastErr;
  for (const probe of order) {
    try { await probe(port); process.exit(0); }
    catch (e) { lastErr = e; console.error(`(${probe.name} failed: ${e.message})`); }
  }
  console.error("probe failed:", lastErr?.message || "no protocol matched");
  process.exit(1);
}

main().catch((e) => { console.error("probe failed:", e.message); process.exit(1); });
