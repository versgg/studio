# Connecting Claude to Studio (MCP)

`studio-mcp` lets Claude Code or Claude Desktop build and edit Studio projects. It speaks MCP over stdio and passes every tool call to Studio's engine, the same commands the app uses.

- **Studio open:** edits appear live in the window. History marks them "Claude · MCP".
- **Studio closed:** `studio-mcp` starts the engine itself, headless and silent. The engine stops when the Claude session ends.

## Connect

Build it (it goes next to `studio-engine`):

```sh
cargo build --release -p studio-mcp
```

Then print the exact commands for this machine:

```sh
target/release/studio-mcp --print-config
```

That prints two things:

- **Claude Code:** `claude mcp add studio -- "<path>\studio-mcp.exe"`. Add `--scope user` to have it in every project.
- **Claude Desktop:** a JSON block to add to `%APPDATA%\Claude\claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS). Restart Claude Desktop afterwards.

Check it in Claude Code with `/mcp`. Then ask, for example: "Open my latest Studio project and tell me what's on the timeline."

## How it finds Studio

1. It reads `engine.json` in Studio's user data folder and connects to that engine's socket. The folder is `%APPDATA%\Studio` on Windows and `~/.config/Studio` elsewhere. It also looks in `@studio/desktop`, the folder Electron uses today.
2. If no engine is running, it starts `studio-engine` from next to itself, with its own socket and `STUDIO_SILENT=1`. It keeps the engine's stdin open, so the engine exits when the session ends. Exports that Claude started get up to 15 minutes to finish first.
3. If Studio opens while Claude is working headless, the next tool call moves to Studio's engine and stops the headless one. If Studio closes, the next call starts a headless engine and reopens the same project.

Environment variables:

| Variable | What it does |
|---|---|
| `STUDIO_USER_DATA` | Studio's user data folder (where `engine.json` is) |
| `STUDIO_ENGINE` | The `studio-engine` to run headless |
| `STUDIO_PROJECTS_DIR` | Projects folder for a headless engine (default `Documents/Studio Projects`) |

## What Claude can do

Times are in microseconds. Ids come from `project_summary`: media `m…`, clips `c…`, tracks `t…`.

| Area | Tools |
|---|---|
| Status and projects | `studio_status`, `project_list`, `project_open`, `project_open_latest`, `project_new`, `project_summary`, `project_state`, `project_set_format`, `project_set_options` |
| Media | `media_import` (files or folders), `media_list`, `media_describe` (with poster and filmstrip images), `media_remove` |
| Timeline | `timeline_add_clip`, `timeline_move`, `timeline_trim`, `timeline_split`, `timeline_delete`, `timeline_delete_left`, `timeline_delete_right`, `timeline_extract_audio`, `timeline_compound`, `timeline_break_compound`, `timeline_freeze_frame`, `clip_replace_media`, `edit_undo`, `edit_redo`, `history_list`, `history_goto` |
| Look | `clip_set` (transform, crop, flip, colour, HSL, curves, wheels, LUT, speed, reverse, keyframes, effects, blend, masks, animations, fades, pitch, envelope), `effects_list` |
| Text and overlays | `text_add`, `text_set`, `captions_set`, `overlay_add` (videos, pictures, stickers), `adjust_add`, `transition_set`, `transition_set_all` |
| Audio | `track_set`, `audio_master`, `audio_loudness`, `audio_normalize_mix`, `audio_normalize`, `audio_remove_silences`, `audio_split_at_silences`, `audio_label_sounds`, `audio_crossfade`, `audio_spectral_delete`, `labels_add`, `labels_set`, `labels_delete` |
| Export | `export_start`, `export_status`, `export_cancel` |
| Seeing | `preview_frame` returns the composited frame as an image |

**Text and captions are drawn by the Studio window.** The engine only composites the picture the window makes. With no window open, a text clip is saved but shows nothing in frames or exports until the project is opened in Studio. The tool result says which case applies.

## Permissions

The user sets these per project in the History tab. Claude can't change them.

| Allowed to | Claude may |
|---|---|
| look | Read only: summaries, frames, lists, history |
| edit | Also edit the timeline and the look. No imports, removals or exports. |
| all (default) | Everything |

- **Ask before export** (on by default): Studio asks the user before Claude exports. With no window open, nobody can answer, so the export is refused.
- **Removing media** always asks the user.

## Troubleshooting

- `studio_status` says which engine Claude is on, whether a window is open, and what Claude may do.
- studio-mcp logs to stderr, which Claude Code and Claude Desktop keep in their MCP logs.
- A headless engine logs to `%TEMP%\studio-mcp-<pid>\engine-<n>.log`.

## Testing

```sh
cargo test -p studio-mcp
node scripts/mcp-e2e.mjs
```

`mcp-e2e.mjs` starts `studio-mcp` with a temporary user data and projects folder, so it runs its own headless engine. It speaks MCP over stdio and checks the following:

- a new project, an import, a clip on the timeline, a split and the summary
- a preview frame
- the permission levels
- a headless export
- that the history shows actor "claude"

Point it at builds with `STUDIO_MCP` and `STUDIO_ENGINE`.
