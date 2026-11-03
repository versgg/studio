# Installing Studio: instructions for an AI agent

You are an AI coding agent (Claude Code or similar) installing **Studio**, a desktop video editor, on the user's computer. Studio is built from source: an Electron app (`apps/desktop`) plus a Rust engine and a native addon (`crates/`). Follow the steps in order. Each step says how to check it worked; don't move on until it has.

## Ground rules

- **Ask before installing system software** (apt/dnf/pacman, winget, Homebrew, Xcode tools) or using `sudo`/an admin prompt. Show the exact commands and say why they're needed. If the user prefers to run a command themselves, give it to them and wait.
- **Never ask for, type or store passwords, API keys or tokens.** When `sudo` or an installer needs a password, the user types it. Studio's own keys are entered by the user inside the app later.
- Only change what the install needs: the Studio folder, the toolchains listed here, and a Studio shortcut.
- When a command fails, read the error, fix the cause and run it again. Don't skip a check.
- Keep the user posted in one line per step. The first build takes a while; say so.
- At the end, report to the user (see step 9).

## 1. Find out where you are

- The operating system and CPU: Linux (which distribution), Windows 10/11, or macOS (Apple Silicon or Intel).
- Whether you're already inside a clone of this repository: there's a `package.json` whose `"name"` is `"studio"`, next to `Cargo.toml` and `INSTALL.md`.
  - If not, clone it. Use the address the user gave you, into a folder called `studio` in their home folder (`~/studio`, or `%USERPROFILE%\studio` on Windows), unless they name another place.
  - `git` itself may be missing; install it first (step 2).
- Support so far: **Linux** (tested on Ubuntu 26.04), **Windows** (where Studio was first built), **macOS** (never built yet; go ahead, and if a build error can't be fixed, report it exactly).

## 2. Install the tools

Studio needs:
- **Git**.
- **Node.js 22 or newer** (24 LTS is good).
- **Rust stable 1.85 or newer**, installed with rustup.
- **FFmpeg** with `ffprobe` on the PATH, built with `libx264` and `aac`. A "full" build, not a minimal one.
- A C/C++ toolchain.

Check what's already there first (`git --version`, `node -v`, `cargo -V`, `rustc -V`, `ffmpeg -version`, `ffprobe -version`) and install only what's missing or too old.

### Linux

Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libasound2-dev ffmpeg git curl
```

Fedora: `sudo dnf install gcc gcc-c++ pkgconf-pkg-config alsa-lib-devel git curl`. Then FFmpeg from RPM Fusion: Fedora's own `ffmpeg-free` has no x264. Enable RPM Fusion and `sudo dnf install ffmpeg --allowerasing`.

Arch: `sudo pacman -S --needed base-devel alsa-lib ffmpeg git curl`.

- **Node.js:** if `node -v` is missing or older than 22, install it without sudo through nvm, then open a new shell or source `~/.nvm/nvm.sh`:

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  nvm install 24
  ```

- **Rust:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then `. "$HOME/.cargo/env"`.

### Windows

In PowerShell. winget asks the user to approve each install:

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Rustlang.Rustup
winget install -e --id Gyan.FFmpeg
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

- The last one is the C++ build tools Rust needs on Windows (`link.exe`). It's large and takes a while.
- Afterwards, open a **new** terminal so the PATH includes everything. In the same terminal, `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')` does the same.
- Then `rustup default stable`.

### macOS

- **Xcode Command Line Tools:** `xcode-select --install`. A system dialog opens: the user clicks Install, and you wait until `xcode-select -p` prints a path.
- **Homebrew**, if `brew` is missing:

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```

  The user types their password. Afterwards, follow its "Next steps" lines so `brew` is on the PATH.
- `brew install git node ffmpeg`.
- **Rust:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then `. "$HOME/.cargo/env"`.

**Check:** `node -v` (22+), `rustc -V` (1.85+), `ffmpeg -version` and `ffprobe -version` all answer.

## 3. Install the JavaScript packages

In the Studio folder:

```bash
npm ci
```

- If npm (version 11 or newer) asks whether to run packages' install scripts, Studio doesn't need them: esbuild and onnxruntime-node ship their binaries. Answering no is fine.
- Then make sure Electron's own binary is there. Run this; it does nothing if Electron is already downloaded:

  ```bash
  node node_modules/electron/install.js
  ```

**Check:** `node_modules/electron/dist` exists and holds `electron` (Linux), `electron.exe` (Windows) or `Electron.app` (macOS).

## 4. Check the machine

```bash
node scripts/doctor.mjs
```

- Fix every line that says `FAIL`, then run it again until there are none.
- `warn` lines are optional. "Engine built" and "App bundles built" are expected to warn before step 5.
- **FFmpeg somewhere unusual:** set `STUDIO_FFMPEG_DIR` to the folder holding `ffmpeg` and `ffprobe`.

## 5. Build

```bash
npm run build
```

This compiles the Rust engine, the MCP server and the native addon in release mode, then bundles the app. The first time takes 5–20 minutes; later builds are quick.

**Check:**
- `target/release/studio-engine` (`studio-engine.exe` on Windows) exists.
- `apps/desktop/native/studio_bridge.node` exists.
- `apps/desktop/dist/main.js` exists.

## 6. Test

```bash
node scripts/smoke.mjs
node scripts/e2e.mjs
```

- `smoke` checks the engine, the frame transport and the addon without opening a window.
- `e2e` imports test clips it makes itself, edits, plays and exports them (a minute or two).
- **Both must end without failures.** If one fails, read its output and fix the cause; `node scripts/doctor.mjs` often says what's wrong.

For a thorough check, `npm test` runs the Rust tests, the type check and the unit tests. It's optional and takes a few minutes more.

## 7. Make a shortcut

Use the absolute path of the Studio folder wherever `STUDIO` appears below.

### Linux

Write `~/.local/share/applications/studio.desktop`, so Studio is in the app list and can be pinned:

```ini
[Desktop Entry]
Type=Application
Name=Studio
GenericName=Video editor
Exec=STUDIO/node_modules/electron/dist/electron STUDIO/apps/desktop
Path=STUDIO
Icon=STUDIO/apps/desktop/assets/icon.png
Terminal=false
Categories=AudioVideo;Video;AudioVideoEditing;
StartupWMClass=studio
StartupNotify=true
```

- Make it executable with `chmod +x`.
- If there's a `~/Desktop` folder, copy it there too. On GNOME, also run `gio set ~/Desktop/studio.desktop metadata::trusted true`.

### Windows

PowerShell. This makes a desktop shortcut and a Start menu shortcut:

```powershell
$studio = (Resolve-Path .).Path
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $s = $shell.CreateShortcut((Join-Path $dir 'Studio.lnk'))
  $s.TargetPath = Join-Path $studio 'node_modules\electron\dist\electron.exe'
  $s.Arguments = '"' + (Join-Path $studio 'apps\desktop') + '"'
  $s.WorkingDirectory = $studio
  $s.IconLocation = Join-Path $studio 'apps\desktop\assets\icon.ico'
  $s.Save()
}
```

### macOS

A small app in `~/Applications` that starts Studio:

```bash
mkdir -p ~/Applications
osacompile -o ~/Applications/Studio.app -e 'do shell script "cd STUDIO && STUDIO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron STUDIO/apps/desktop > /dev/null 2>&1 &"'
```

## 8. Start it once

Start Studio from the new shortcut, or with `npm start` in the Studio folder. Ask the user to confirm that the window opens on the Home screen, then they can close it or keep going.

If it doesn't open:

- **Linux, "The SUID sandbox helper binary was found, but is not configured correctly":** with the user's OK, run

  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  ```

  Or start it with `ELECTRON_DISABLE_SANDBOX=1`; in the `.desktop` file that's `Exec=env ELECTRON_DISABLE_SANDBOX=1 STUDIO/node_modules/...`.
- **"The engine is not connected":** the engine wasn't built. Run step 5 again and check `target/release`.
- **Anything else:** run `npm start` in a terminal and read what it prints.

## 9. Tell the user

Report briefly:
- where Studio is installed;
- how to start it (the shortcut);
- what you installed;
- the test results;
- that projects are saved in `Documents/Studio Projects`.

Then explain the optional online features. Each is set up inside the app, and the user enters their own details. Keys go in **File › Preferences (Ctrl+,) › Keys**, or where a feature first asks for one:

- **Voiceovers and voices (ElevenLabs):** an ElevenLabs API key.
- **Dub and Translations:** use **Claude Code** on this computer (the `claude` command, signed in) to read and translate text.
- **Taking text out of a video (Vmake):** a Vmake access token.
- **Captions and stems:** go through an online server and need nothing to set up.

To update Studio later, in its folder: `git pull`, then `npm ci` and `npm run build`.
