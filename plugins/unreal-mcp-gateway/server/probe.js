#!/usr/bin/env node
/**
 * Diagnostic probe — connects to ONE live UE editor and dumps the protocol shapes the
 * gateway depends on (tools/list, list_toolsets, describe_toolset, a call_tool dispatch).
 * Zero-dependency: uses the gateway's own HttpClient (Node built-ins only).
 *
 *   node probe.js [port]      (defaults to the first live editor on 8000-8031)
 */

import { HttpClient } from "./mcp.js";
import { ports, tcpProbe, URL_PATH, resultText, parseIdentity, CONNECT_TIMEOUT_MS } from "./lib.js";

function show(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function main() {
  let port = parseInt(process.argv[2], 10);
  if (!Number.isInteger(port)) { for (const p of ports()) { if (await tcpProbe(p)) { port = p; break; } } }
  if (!port) { console.error("No live editor on 8000-8031. Open one first."); process.exit(2); }

  const url = `http://127.0.0.1:${port}${URL_PATH}`;
  console.log(`Probing ${url} ...`);
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
  process.exit(0);
}

main().catch((e) => { console.error("probe failed:", e.message); process.exit(1); });
