---
name: unreal-editors
description: Use this skill whenever the user wants to author or inspect an Unreal Engine project through a running editor — Animation Blueprints, montages, blend spaces, retargeting, anim curves, MetaSound, audio, Enhanced Input, lighting, FBX/Interchange import, PIE gameplay debugging, OR standard editor work (actors, Blueprints, assets, materials, Niagara, UMG, viewport capture, output log, level editing). Triggers include "Unreal", "UE5", "UE 5.8", "the editor", "Animation Blueprint", "AnimBP", "montage", "blend space", "retarget", "MetaSound", "Enhanced Input", "PIE", "play in editor", "spawn actor", "blueprint", or any request to drive or inspect a live UE editor. Tools target whichever editor(s) run on 127.0.0.1:8000-8031.
---

# Unreal Engine editor tools (via the always-on gateway)

This plugin runs a local **gateway** that fronts every running Unreal editor's native MCP server and
**forwards the engine's tool discovery** to you. It's **always alive** and auto-discovers editors on
ports **8000-8031**, so editors can open/close at any time **without restarting Claude**.

You get **4 tools**, and you use them to discover and call everything an editor exposes — both the
engine's native AI packs AND the project's `UELLMToolkit`:

- **`list_editors`** — which editors are live (project, port, pid, UE version).
- **`list_toolsets {editor?}`** — the toolsets available on an editor (engine packs + UELLMToolkit). **Start here.**
- **`describe_toolset {toolset_name, editor?}`** — the tools (names + input schemas) in one toolset.
- **`call_tool {toolset_name, tool_name, arguments, editor?}`** — invoke a tool.

## The workflow

1. (If unsure which editors are live) call **`list_editors`**.
2. Call **`list_toolsets`** to see what's available on the target editor. You'll see:
   - **Engine packs** — e.g. `EditorAppToolset` (actors, viewport capture, output log, camera, PIE
     start/stop), the `EditorToolset` Python tools (Blueprint editing, asset CRUD, materials, scene/level),
     `NiagaraToolset`, `UUMGToolSet`, `GASToolsets`, `PCGToolset`, `PhysicsAssetToolset`, … — the engine's
     own editor tools.
   - **`UELLMToolkit`** — the gaps the engine lacks: animation authoring (`anim_blueprint_modify`,
     `anim_edit`, `montage_modify`, `blend_space`, `retarget`), `audio`, `metasound`, `enhanced_input`,
     `lighting`, `gameplay_debug` (PIE input-injection harness), `run_console_command`, `asset_import`,
     `get_ue_context`.
3. Call **`describe_toolset {toolset_name}`** to get a toolset's tools + parameter schemas.
4. Call **`call_tool {toolset_name, tool_name, arguments}`** to run one.

## Targeting an editor (multi-editor)

Every tool except `list_editors` takes an optional **`editor`** argument — a port (`"8001"`), project
name, or pid:
- **One editor open** → used automatically; omit `editor`.
- **Several open** → pass `editor`. Call `list_editors` first to see them.
- **None open** → you get a clear message; ask the user to open a UE editor, then retry.

## Which toolset for what

- Standard editor work (spawn/move actors, edit Blueprints, manage assets, materials, Niagara, UMG,
  capture the viewport, read the output log, open levels) → the **engine packs** (discover exact tool
  names via `list_toolsets` → `describe_toolset`).
- Animation-asset authoring, audio/MetaSound, Enhanced Input, lighting, PIE input-injection gameplay
  testing, console commands, FBX/Interchange import → **`UELLMToolkit`**.

## Rules

1. Discover, don't guess: `list_toolsets` → `describe_toolset` before calling a tool you haven't used —
   names and schemas come from the editor, not memory.
2. With more than one editor open, pass an explicit `editor` so you act on the intended project.
3. It's fine if an editor opened **after** Claude started — the gateway routes to whatever's live; no
   restart needed. If a call says the editor went away, re-check `list_editors` and retry a live one.
4. PIE-dependent work needs the editor in Play-In-Editor; start it first (`UELLMToolkit` `gameplay_debug`,
   or the engine's `EditorAppToolset` `StartPIE`).

## How it works (to reason about failures)

Each UE editor hosts its own MCP server on an auto-selected loopback port (8000-8031), exposing the
engine's tool-search meta-tools (`list_toolsets`/`describe_toolset`/`call_tool`). The gateway is a single
always-on process that scans those ports, parses each editor's identity, and **forwards** your
discovery/call to the chosen editor — adding multi-editor routing (`editor`) and no-restart. It flattens
nothing; whatever the editor registers, you see.
