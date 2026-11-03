# Running Studio on Linux

Studio runs on Linux: it's tested on Ubuntu 26.04 (GNOME on Wayland, an NVIDIA laptop, Node 26, Rust 1.99, FFmpeg 8). This page is the checklist, in order. The CI workflow (`.github/workflows/ci.yml`) runs the same tests on Ubuntu 24.04 and Windows when it's started from the Actions tab.

## 1. Install what it needs

Ubuntu or Debian:

```bash
sudo apt install build-essential pkg-config libasound2-dev ffmpeg git curl
```

Fedora:

```bash
sudo dnf install gcc pkgconf-pkg-config alsa-lib-devel ffmpeg git curl
```

Fedora's own `ffmpeg-free` has no x264 or NVENC. Use the full `ffmpeg` from RPM Fusion.

Then:

- **Rust:** install with `curl https://sh.rustup.rs -sSf | sh`. Edition 2024 needs Rust 1.85 or newer.
- **Node.js 22 or newer:** from nodesource or `nvm`. The distro's Node is often too old.

## 2. Graphics

- **NVIDIA:**
  - Install the proprietary driver, version 570 or newer. `nvidia-smi` should list the card.
  - Ubuntu's and RPM Fusion's FFmpeg can use NVENC once that driver is in place. The doctor script tests one frame to make sure.
- **Hybrid graphics (laptops):**
  - The engine's FFmpeg uses NVENC whichever chip drives the screen.
  - The Electron window can stay on the integrated graphics. No PRIME offload variables are needed.
- **AMD or Intel:**
  - Exports fall back to x264 until VA-API presets land, which is step 9 in the plan.
  - `vainfo` should still work there; the doctor reports it.

## 3. Check the machine

```bash
npm install
node node_modules/electron/install.js
node scripts/doctor.mjs
```

Electron 45 has no install script of its own: `install.js` downloads its Linux binary into `node_modules/electron/dist` (otherwise the first `npm start` does). npm 11 also asks before running other packages' install scripts (esbuild, onnxruntime-node); Studio doesn't need them, as both packages ship their Linux binaries.

Fix every `FAIL` line. A `warn` line is optional.

## 4. Build and test, in this order

| Step | Command | What it proves |
|---|---|---|
| Rust tests | `cargo test --workspace` | Model, protocol, frame ring, filter graphs, undo history |
| Build | `npm run build` | The engine, the addon (`libstudio_bridge.so` is copied to `studio_bridge.node`) and the app bundles |
| Smoke | `node scripts/smoke.mjs` | Unix socket, shared-memory ring and addon, with no Electron |
| Engine end-to-end | `node scripts/e2e.mjs` | Import, proxies, timeline edits, playback with sound, 9:16 and 4:5 export |
| UI check | `node scripts/ui-check.mjs` | The real app, off-screen: library, timeline drags, keys, inspector, export, play. Screenshots go to `out/ui-check/` |
| Drop check (GNOME) | `npm run drop-check` | Real drags of files, as GNOME Files makes them, dropped on the library, its tabs, the player, the Inspector, the timeline and the Audio page. It runs in a GNOME Shell with no screen (`gnome-shell --headless`, its own D-Bus, home and settings), so nothing shows on the desktop. `DROP_SCALE=1.3333` checks a 133 % scale. Results and any failed drop's screenshot go to `out/drop-check/` |
| Run it | `npm start` | The app itself |

## 5. Things that differ from Windows

- **Socket:** a Unix socket at `/tmp/studio-<pid>/engine.sock` instead of a named pipe. Both are in `crates/engine/src/server.rs`.
- **CPU time:** read from `/proc/self/stat` (`crates/engine/src/cpu.rs`).
- **Windows only, skipped on Linux:** the 1 ms timer (`timeBeginPeriod`) and the hidden-console flag for FFmpeg.
- **Sound:** cpal talks to ALSA. On PipeWire desktops it goes through `pipewire-alsa`, which Ubuntu 24.04 and Fedora install by default. Without a sound device, playback still runs on a silent clock.
- **Default folders:** if the desktop has no XDG Documents or Videos folder, projects and exports fall back to the home folder.

## 6. Known first-run snags

- **"The SUID sandbox helper binary was found, but is not configured correctly":** Ubuntu 23.10 and later block Chromium's sandbox for unpackaged Electron. Use one of these:
  - For development, run `ELECTRON_DISABLE_SANDBOX=1 npm start`.
  - Or give the helper its permissions:

    ```bash
    sudo chown root:root node_modules/electron/dist/chrome-sandbox
    sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
    ```

  The AppImage and deb packages (step 9) handle this themselves.
- **Wayland or X11:** Electron picks the session's own platform. Measure both, because frame pacing can differ:

  ```bash
  npm start -- --ozone-platform=wayland
  npm start -- --ozone-platform=x11
  ```

## 7. Frame transport benchmark

Run it in each session type (Wayland and X11) to compare frame pacing; it opens a real window for a few seconds:

```bash
npm run bench -w @studio/desktop
```

## 8. Starting it from the desktop

Replace `/path/to/studio` with the folder you cloned. The launcher is a `.desktop` file, in `~/.local/share/applications/studio.desktop` (the app grid and the dock) and copied to `~/Desktop/Studio.desktop`, marked trusted (`gio set ~/Desktop/Studio.desktop metadata::trusted true`) and executable:

```ini
[Desktop Entry]
Type=Application
Name=Studio
GenericName=Video editor
Exec=/path/to/studio/node_modules/electron/dist/electron /path/to/studio/apps/desktop
Path=/path/to/studio
Icon=/path/to/studio/apps/desktop/assets/icon.png
Terminal=false
Categories=AudioVideo;Video;AudioVideoEditing;
StartupWMClass=studio
StartupNotify=true
```

- `desktopName` in `apps/desktop/package.json` is `studio.desktop`, so the window is matched to the launcher (its icon and name in the dock).
- Apps started from the dock get GNOME's PATH, without nvm or `~/.local/bin`. Studio needs neither: Electron is called by its own path, FFmpeg is in `/usr/bin`, and `claude` is looked for in `~/.local/bin` by name (`findClaude` in `src/main/dub-read.ts`).

## Notes from the first Linux runs

- **Sandbox:** the "SUID sandbox helper" snag in section 6 didn't happen on Ubuntu 26.04, though `apparmor_restrict_unprivileged_userns` is 1. Electron 45 started without `chrome-sandbox` set up or `--no-sandbox`.
- **ALSA:** the build needs `libasound2-dev` (only for `pkg-config alsa`; `alsa-sys` ships its bindings, so the headers themselves aren't read). Without it, `cargo` fails in `alsa-sys`.
- **Wayland can't place windows:** `setPosition(-8000, -8000)` does nothing there, so a window "parked off the desktop" (`STUDIO_PAGE_SCRIPT_PARKED`, `STUDIO_CHROME_CHECK`, `npm run bench`) shows on the screen. The UI check and page scripts render off-screen and never show a window (`STUDIO_UI_ONLY=.` runs every step without the window-chrome run).
- **Drag and drop:** on Wayland a drop is decided by the page's answer to the pointer's last move, and a move into a new element is answered by `dragenter` alone, so the app cancels `dragenter` as well as `dragover` (`App.tsx`). `npm run drop-check` drags real files in a GNOME Shell with no screen.
- **Harmless lines in the log:** `vaInitialize failed` (no VA-API driver for an Intel chip; `sudo apt install intel-media-va-driver` if you want it) and "Authorization required, but no authorization protocol specified" when started without `XAUTHORITY`.
