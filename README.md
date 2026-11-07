# Studio

A desktop video editor for short vertical videos and ads: CapCut's simple layout with a proper editing engine underneath. The interface is Electron (React, TypeScript); the engine is a separate Rust program that drives FFmpeg, plays sound and renders exports.

<img src="apps/desktop/assets/icon.png" width="64" alt="">

## Install

### The easy way: let an AI agent do it

Install [Claude Code](https://claude.com/claude-code) (or another coding agent that can run commands), open a terminal, start it, and paste:

> Clone https://github.com/versgg/studio and install it by following its INSTALL.md.

The agent checks your machine, installs what's missing (asking before it does), builds Studio, tests it and puts a Studio shortcut on your desktop. Expect 15–30 minutes, mostly the first build, and about 6 GB of disk.

### By hand

[INSTALL.md](INSTALL.md) is written for an agent but reads fine as a checklist. In short:

1. Install Git, Node.js 22 or newer, Rust (from [rustup.rs](https://rustup.rs)) and FFmpeg with `ffprobe`, and on Linux `build-essential pkg-config libasound2-dev`. On Windows you also need the Visual Studio C++ Build Tools.
2. In the cloned folder:

   ```bash
   npm ci
   node scripts/doctor.mjs
   npm run build
   npm start
   ```

`node scripts/doctor.mjs` says what's missing and how to get it.

## Platforms

| | |
|---|---|
| **Linux** | Tested on Ubuntu 26.04 (GNOME on Wayland). Other distributions with Node 22+, Rust and FFmpeg should work. NVIDIA cards export with NVENC. |
| **Windows 10/11** | Where Studio was first built and tested; not re-tested since development moved to Linux (November 2026). |
| **macOS** | Not tested yet. It should build (Apple Silicon or Intel); exports use x264 there. |

## What it does

- **Editing:** a library with linked folders, a magnetic main track, any number of video, text and sound tracks, split, ripple trim, delete left/right, snapping, box select, compound clips, freeze frames, speed and reverse, keyframes, crop, masks, colour and LUTs, and full undo history.
- **Text and captions:** text clips with presets, outlines, shadows and backgrounds; captions from speech, editable line by line and exported as `.srt`.
- **Export:** several formats in one go (9:16, 4:5, 1:1, 16:9), on the graphics card where there is one, and the sound alone as MP3 or WAV.
- **Audio page:** an Audacity-style view for cutting sound down to the sample, removing silence and mixing.
- **Safe zones:** a Reels-style overlay that shows what the app's buttons and captions cover.
- **Import from CapCut:** opens CapCut projects with their cuts, texts, captions and animations.
- **Optional online features**, each with your own account where one is needed:
  - Voiceovers and voice changing with ElevenLabs (your API key).
  - Captions and stems (vocals, music, drums…) through an online server (no key).
  - Dub: a clip's on-screen text and voice in another language. It uses Claude Code on your computer to read and translate, Vmake to take the old text out (your Vmake login), and ElevenLabs for the voice. Any sentence can be rerolled as a new take (with new words if you like), and every take is kept to go back to.
  - Translations: a whole project made again in other languages.
- **MCP:** Claude (Claude Code or Claude Desktop) can build and edit projects through Studio's MCP server; see [docs/MCP.md](docs/MCP.md).

Keys are typed into the app (File › Preferences › Keys) and kept encrypted on your computer; they never go in the project folder or this repository.

## Using it

- Start it from the desktop shortcut the installer made, or with `npm start` in this folder.
- Projects are saved in `Documents/Studio Projects`, one `.studio` folder each.
- To update: `git pull`, then `npm ci` and `npm run build`.

## For developers

See [docs/DEVELOPING.md](docs/DEVELOPING.md): how the pieces fit, every command, and the test suites (Rust tests, an engine end-to-end test and a UI check that drives the real app off-screen).

## Third-party parts

- FFmpeg is used as a separate program and isn't included.
- Fonts come from [Fontsource](https://fontsource.org) (SIL Open Font License).
- Text detection uses PaddleOCR's PP-OCRv4 models (Apache 2.0), in `apps/desktop/assets/ocr`.
- Face and object tracking use MediaPipe models (Apache 2.0), in `apps/desktop/assets/mediapipe`.
