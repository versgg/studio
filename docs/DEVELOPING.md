# Developing Studio

## How it fits together

1. `studio-engine` (Rust, `crates/engine`) owns the project and does all the heavy work. It is the single source of truth.
2. The Electron app (`apps/desktop`) is a client of the engine. The page never owns project state; `store.ts` only mirrors the engine's latest snapshot.
3. They talk through newline-delimited JSON-RPC over a local socket: a named pipe on Windows, a Unix socket elsewhere (`crates/engine-core/src/protocol.rs`, `docs/contract-v2.md`).
4. Preview frames travel through a shared-memory ring (`crates/engine-core/src/ring.rs`): the engine writes, the preload reads.
5. The preload addon (`crates/bridge`, napi-rs) copies the newest frame into a Node buffer; the player draws it with WebGL2 from the preload (`apps/desktop/src/preload/player.ts`), so frames never cross the context bridge.
6. Electron's main process (`apps/desktop/src/main`) starts the engine, restarts it if it dies, opens windows, and runs the jobs that call outside services (dub, stems, Vmake, ElevenLabs, translations).
7. Every edit is a command on the engine (`crates/engine/src/doc.rs`): undoable, saved at once, and logged in the project's `history.jsonl` with who made it (you, or Claude through MCP).
8. Media work runs the FFmpeg command-line tools through `crates/media`: one filter graph for preview, mix and export.
9. MCP (`crates/mcp`, the `studio-mcp` binary) speaks to the same engine commands as the app; see `docs/MCP.md`.
10. Layouts are a CSS grid in `App.tsx`; every shortcut is in `keymap.ts`; design tokens are in `packages/ui/src/tokens.css`.

## Commands

| Command | What it does |
|---|---|
| `npm run native` | Builds the engine, the MCP server and the addon (release) and copies the addon to `apps/desktop/native/` |
| `npm run build` | The native build, plus the main, preload and page bundles |
| `npm run dev` | The native build, then Vite's dev server and Electron with hot reload |
| `npm start` | Runs the built app |
| `npm test` | `cargo test --workspace`, the TypeScript type check and the unit tests |
| `node scripts/smoke.mjs [w] [h] [fps]` | Engine, socket, frame ring and addon, without Electron |
| `npm run e2e` | Engine end-to-end: import, edits, seek, play, split, undo, export 9:16 and 4:5 |
| `npm run ui-check` | Builds, then drives the real app off-screen: library, timeline, keys, Inspector, export, play and every panel. Screenshots and `results.json` go to `out/ui-check/` |
| `npm run drop-check` | Linux with GNOME: real file drags dropped on every part of the window, in a GNOME Shell with no screen |
| `npm run doctor` | Checks the machine (Node, Rust, FFmpeg and its encoders, ALSA on Linux) and says how to fix what's missing |
| `npm run bench -w @studio/desktop` | Frame-transport benchmark (opens a real window) |
| `node apps/desktop/scripts/make-luts.mjs` | Writes the built-in LUTs in `apps/desktop/assets/luts` |
| `npx electron scripts/make-icon.cjs` | Renders `apps/desktop/assets/icon.svg` to `icon.ico` and `icon.png` |

## Tests and their switches

- **Footage:** the e2e and UI checks make their own short test clips. To test on real footage, pass a folder (`node scripts/ui-check.mjs <folder>`) or set `STUDIO_TEST_CLIPS`; its first three videos are used.
- **Stand-ins for outside services:** the UI check never calls a paid or online service unless told to. Steps that need one run on a stand-in when it's switched on, and are skipped otherwise:
  - `STUDIO_VMAKE_FAKE=1` (Vmake), `STUDIO_ELEVEN_FAKE=1` (ElevenLabs), `STUDIO_STEMS_FAKE=1` (stems server), `STUDIO_CLAUDE_FAKE=1` (Claude Code's reading and translating).
  - `STUDIO_UI_CHECK_ONLINE=0` skips the one step that uses the real transcript server.
- **Other switches:** `STUDIO_SILENT=1` keeps tests quiet. `STUDIO_UI_ONLY=<pattern>` runs only matching UI-check steps, without the window-chrome run, which shows a real window. `STUDIO_UI_APP=<dir>` tests a staged copy of the app, so a Studio that's open keeps its files.
- **Every stand-in at once:**

  ```bash
  STUDIO_SILENT=1 STUDIO_UI_CHECK_ONLINE=0 STUDIO_VMAKE_FAKE=1 STUDIO_ELEVEN_FAKE=1 STUDIO_STEMS_FAKE=1 STUDIO_CLAUDE_FAKE=1 STUDIO_UI_ONLY=. node scripts/ui-check.mjs
  ```

## Settings read from the environment

| Variable | Use |
|---|---|
| `STUDIO_FFMPEG_DIR` | Folder holding `ffmpeg` and `ffprobe`, when they aren't on the PATH |
| `STUDIO_ENGINE` | A different engine binary than `target/release/studio-engine` |
| `STUDIO_PROJECTS_DIR`, `STUDIO_USER_DATA` | Where projects and the app's settings live (tests use throwaway folders) |
| `STUDIO_TRANSCRIPT_URL`, `STUDIO_STEMS_URL` | Other servers for captions and stems |

## Rules the code follows

- Never block the engine's playback or preview thread, or the player's draw loop.
- The UI never owns project state: it sends commands and shows what the engine reports.
- Every change ends with a test: a Rust unit test, the smoke script, the e2e or a UI-check step.
- Cross-platform: anything OS-specific goes behind `cfg` (Rust) or `process.platform` (TypeScript), with every side written.
- Keys are stored encrypted by the main process (`src/main/secrets.ts`) and never reach the page or a project file.

Linux specifics, from packages to the desktop launcher, are in [LINUX.md](LINUX.md).
