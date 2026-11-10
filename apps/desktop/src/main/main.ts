// First: on a Mac, the PATH Terminal has, before the engine or any tool starts (shell-path.ts).
import './shell-path'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EngineSupervisor } from './engine'
import { registerProjects } from './projects'
import { registerServices } from './services'
import { capcutRoot } from './capcut'
import { runChromeCheck, runUiCheck } from './ui-check'
import { MIN_WINDOW } from '../shared/window'

// Cached thumbnails and waveforms are served to the renderer through studio-file://,
// limited to the projects folder (the dev renderer runs on http:// and can't read file://).
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

const isWin = process.platform === 'win32'
// Its own taskbar identity on Windows, so the taskbar shows Studio's icon, not Electron's.
if (isWin) app.setAppUserModelId('studio.editor')
const runDir = path.join(os.tmpdir(), `studio-${process.pid}`)
const socketPath = isWin ? `\\\\.\\pipe\\studio-engine-${process.pid}` : path.join(runDir, 'engine.sock')
const ringPath = path.join(runDir, 'preview.ring')
const bench = process.argv.find((a) => a.startsWith('--bench='))?.slice('--bench='.length)
const repoRoot = path.resolve(app.getAppPath(), '../..')

function enginePath(): string {
  const exe = isWin ? 'studio-engine.exe' : 'studio-engine'
  if (process.env.STUDIO_ENGINE) return process.env.STUDIO_ENGINE
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', exe)
  return path.join(repoRoot, 'target', 'release', exe)
}

// The UI check (scripts/ui-check.mjs) runs hidden, with its own projects and settings folders.
const uiCheck = process.env.STUDIO_UI_CHECK
// Development: a script run in the hidden page once it has loaded (scripts/page-run.mjs), with
// this computer's own settings and keys; it prints what it returns, and the app quits after.
const pageScript = app.isPackaged ? undefined : process.env.STUDIO_PAGE_SCRIPT
const testRun = !!(uiCheck || process.env.STUDIO_CHROME_CHECK)
// Tests record from Chromium's fake microphone (a tone), never the real one.
if (testRun) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
if (process.env.STUDIO_USER_DATA) app.setPath('userData', process.env.STUDIO_USER_DATA)
// Linux desktops without XDG user folders have no Documents or Videos path; use home then.
const userPath = (name: 'documents' | 'videos') => {
  try {
    return app.getPath(name)
  } catch {
    return app.getPath('home')
  }
}
const projectsDir = process.env.STUDIO_PROJECTS_DIR ?? path.join(userPath('documents'), 'Studio Projects')
// Test runs give the engine their own data folder, so its engine.json (how studio-mcp finds a
// running engine) never lands in the real one; normally both use %APPDATA%/Studio.
const engineData = process.env.STUDIO_USER_DATA ? ['--user-data', process.env.STUDIO_USER_DATA] : []
const engine = new EngineSupervisor(enginePath(), ['--socket', socketPath, '--ring', ringPath, '--max-width', '1080', '--max-height', '1920', '--projects-dir', projectsDir, ...engineData])
engine.on('status', (status) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engine:process', status)
})
ipcMain.handle('engine:process', () => engine.status)

const timings: Record<string, number> = {}
const mark = (name: string) => {
  timings[name] = Math.round(process.uptime() * 1000)
  console.log(`[app] ${name} at ${timings[name]} ms`)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    backgroundColor: '#0E0E10',
    title: 'Studio',
    // The app icon from the canvas (scripts/make-icon.cjs renders it from assets/icon.svg).
    icon: path.join(__dirname, '..', 'assets', isWin ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    skipTaskbar: testRun,
    // No system title bar: the app's own top bar is the title bar, with its own minimise,
    // maximise and close buttons on Windows and Linux. macOS keeps its traffic lights.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload loads the native frame-bridge addon, which a sandboxed preload can't.
      // The window only ever loads our own bundled renderer.
      sandbox: false,
      backgroundThrottling: false,
      // The UI check renders off-screen: no window appears, and every frame still paints.
      // STUDIO_PAGE_SCRIPT_PARKED=1: a real window parked off the desktop instead (for timings
      // that include the GPU's painting).
      offscreen: !!(uiCheck || (pageScript && !process.env.STUDIO_PAGE_SCRIPT_PARKED)),
      additionalArguments: [`--studio-socket=${socketPath}`, `--studio-ring=${ringPath}`, ...(bench ? [`--studio-bench=${bench}`] : [])],
    },
  })
  // Why a page dies, in the terminal: the reason and exit code, and a preload that threw.
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[app] the page stopped: ${d.reason} (exit code ${d.exitCode})`))
  win.webContents.on('preload-error', (_e, file, err) => console.error(`[app] preload ${path.basename(file)} failed: ${err.stack ?? err.message}`))
  // STUDIO_DEBUG=1: the page's loading milestones, to see where a window that never shows got stuck.
  if (process.env.STUDIO_DEBUG) {
    for (const ev of ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading'] as const) win.webContents.on(ev as 'dom-ready', () => mark(ev))
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error(`[app] page failed to load: ${code} ${desc}`))
    win.webContents.on('console-message', (e) => console.log(`[page] ${e.message}`))
  }
  const chromeCheck = process.env.STUDIO_CHROME_CHECK
  win.once('ready-to-show', () => {
    mark('readyToShow')
    if (chromeCheck || (pageScript && process.env.STUDIO_PAGE_SCRIPT_PARKED)) {
      // Shown (the window buttons only exist on a shown window), but parked off the desktop.
      win.setPosition(-8000, -8000)
      win.showInactive()
    } else if (!uiCheck && !pageScript) win.show()
  })
  if (pageScript) {
    win.webContents.once('did-finish-load', async () => {
      let ok = true
      try {
        const out = await win.webContents.executeJavaScript(`(async () => { try { ${fs.readFileSync(pageScript, 'utf8')}
 } catch (e) { return { error: String((e && e.stack) || e) } } })()`, true)
        if (out?.error) throw new Error(out.error)
        console.log(`[page-script] ${JSON.stringify(out)}`)
      } catch (e) {
        ok = false
        console.error(`[page-script] failed: ${(e as Error).message}`)
      }
      engine.stop()
      setTimeout(() => app.exit(ok ? 0 : 1), 300)
    })
  }
  if (chromeCheck) {
    win.webContents.once('did-finish-load', async () => {
      const ok = await runChromeCheck(win, chromeCheck).catch((e) => {
        console.error('[chrome-check] crashed:', e)
        return false
      })
      engine.stop()
      setTimeout(() => app.exit(ok ? 0 : 1), 300)
    })
  }
  if (uiCheck) {
    win.webContents.once('did-finish-load', async () => {
      const clips = JSON.parse(process.env.STUDIO_UI_CHECK_CLIPS ?? '[]') as string[]
      const ok = await runUiCheck(win, uiCheck, clips, process.env.STUDIO_UI_CHECK_EXPORTS ?? path.join(uiCheck, 'exports')).catch((e) => {
        console.error('[ui-check] crashed:', e)
        return false
      })
      engine.stop()
      setTimeout(() => app.exit(ok ? 0 : 1), 300)
    })
  }
  // No native menu (its accelerators would take Ctrl+Z, Ctrl+B and friends from the page).
  // Developer keys stay available outside packaged builds.
  win.webContents.on('before-input-event', (e, input) => {
    if (app.isPackaged || input.type !== 'keyDown') return
    if (input.key === 'F12') {
      win.webContents.toggleDevTools()
      e.preventDefault()
    } else if (input.control && input.key.toLowerCase() === 'r') {
      win.webContents.reload()
      e.preventDefault()
    }
  })
  // The microphone, for recording a voiceover. Nothing else (no camera, no screen).
  win.webContents.session.setPermissionRequestHandler((wc, permission, done, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    done(wc === win.webContents && permission === 'media' && types.length > 0 && types.every((t) => t === 'audio'))
  })
  win.webContents.session.setPermissionCheckHandler((wc, permission) => wc === win.webContents && permission === 'media')
  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'))
}

ipcMain.on('player:first-frame', () => mark('firstFrame'))

const MEDIA_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp']
ipcMain.handle('app:paths', () => ({ documents: userPath('documents'), videos: userPath('videos'), projects: projectsDir }))
ipcMain.handle('dialog:openMedia', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)!
  const r = await dialog.showOpenDialog(win, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video, audio and images', extensions: MEDIA_EXTENSIONS }, { name: 'All files', extensions: ['*'] }] })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('dialog:chooseFolder', async (e, defaultPath?: string, title?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)!
  const r = await dialog.showOpenDialog(win, { title: title ?? 'Choose a folder', defaultPath, properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('dialog:openProject', async (e, defaultPath?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)!
  const r = await dialog.showOpenDialog(win, { title: 'Open project', defaultPath: defaultPath ?? projectsDir, properties: ['openFile'], filters: [{ name: 'Studio project', extensions: ['json'] }] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.on('shell:showItem', (_e, p: string) => shell.showItemInFolder(p))
// Links to the services' key pages open in the normal browser; nothing else leaves the app.
const EXTERNAL = ['elevenlabs.io', 'vmake.ai', 'modelcontextprotocol.io', 'shazam.com']
ipcMain.on('shell:openExternal', (_e, url: string) => {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && EXTERNAL.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) shell.openExternal(u.toString())
  } catch {}
})
// Only whether each path exists, never what's in it.
ipcMain.handle('fs:existing', (_e, paths: unknown) => (Array.isArray(paths) ? paths.slice(0, 64).map((p) => typeof p === 'string' && fs.existsSync(p)) : []))

registerServices()
registerProjects(projectsDir)

// The command that connects Claude Code to this computer's studio-mcp (next to the engine).
ipcMain.handle('mcp:command', () => {
  const exe = path.join(path.dirname(enginePath()), isWin ? 'studio-mcp.exe' : 'studio-mcp')
  return fs.existsSync(exe) ? `claude mcp add studio -- "${exe}"` : null
})

// The app's own window buttons.
const senderWindow = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
ipcMain.on('window:minimize', (e) => senderWindow(e)?.minimize())
ipcMain.on('window:toggleMaximize', (e) => {
  const w = senderWindow(e)
  if (w?.isMaximized()) w.unmaximize()
  else w?.maximize()
})
ipcMain.on('window:close', (e) => senderWindow(e)?.close())
ipcMain.handle('window:isMaximized', (e) => !!senderWindow(e)?.isMaximized())
ipcMain.on('shell:openFolder', (_e, p: string) => {
  if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) shell.openPath(p)
})
// An exported file, in the computer's own player (video and sound files only).
ipcMain.on('shell:openVideo', (_e, p: string) => {
  if (typeof p === 'string' && /\.(mp4|mov|m4v|webm|mp3|wav)$/i.test(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile()) shell.openPath(p)
})

// Electron reports each process's CPU use since the previous call, so take a baseline
// when the measured window starts and read it again at the end.
ipcMain.on('bench:measure-start', () => app.getAppMetrics())

ipcMain.on('bench:done', (_e, result: Record<string, unknown>) => {
  const dir = path.join(repoRoot, 'perf')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `step0-${process.platform}-${bench?.replace(/[^0-9x@]/g, '')}.json`)
  const appCpu = app.getAppMetrics().map((m) => ({ type: m.type, cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10 }))
  const report = { date: new Date().toISOString(), platform: process.platform, electron: process.versions.electron, cpus: os.cpus()[0]?.model, cores: os.cpus().length, bench, timings, appCpu, ...result }
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  console.log(`[bench] wrote ${file}`)
  app.quit()
})

app.whenReady().then(() => {
  mark('appReady')
  Menu.setApplicationMenu(null)
  sweepRunDirs()
  fs.mkdirSync(runDir, { recursive: true })
  // studio-file://cache/<encoded absolute path>. Only files in the projects folder, or the
  // derived files in any project's cache (projects can be opened from anywhere).
  // The renderer reads them with fetch and draws them on canvases, so they carry CORS headers.
  protocol.handle('studio-file', async (req) => {
    const file = path.normalize(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    const rel = path.relative(projectsDir, file)
    const inProjects = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    const inCache = /\.studio[\\/]cache[\\/][^\\/]+[\\/][^\\/]+\.(jpg|png|json)$/i.test(file)
    // A song's cover saved beside its stems (a project saved outside the projects folder too).
    const cover = /\.studio[\\/]stems[\\/][^\\/]+[\\/]cover-\d+\.jpg$/i.test(file)
    // A visual dub's letter masks and crops (the page fits fonts against them).
    const dubbed = /\.studio[\\/]dubs[\\/][^\\/]+[\\/]t\d+-(mask|crop)\.png$/i.test(file)
    // A project's own fonts (brought from CapCut), drawn with on the page.
    const font = /\.studio[\\/]fonts[\\/][^\\/]+\.(ttf|otf|woff2?)$/i.test(file)
    // CapCut projects' covers, for Import from CapCut.
    const ccRoot = path.basename(file) === 'draft_cover.jpg' ? capcutRoot() : ''
    const capcutCover = !!ccRoot && path.relative(ccRoot, path.dirname(path.dirname(file))) === ''
    if (!inProjects && !inCache && !cover && !dubbed && !font && !capcutCover) return new Response('Not allowed', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
  engine.start()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => engine.stop())
// The socket and the 24 MB frame ring go with the app (app.exit skips will-quit). On Windows the
// engine may still hold the ring for a moment; the next start sweeps it up then.
process.on('exit', () => {
  try {
    fs.rmSync(runDir, { recursive: true, force: true })
  } catch {}
})

/** Run folders (`studio-<pid>`) left by earlier runs whose app is gone: a crash, or a ring Windows still held. */
function sweepRunDirs() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const pid = Number(/^studio-(\d+)$/.exec(name)?.[1])
      if (!pid || pid === process.pid) continue
      try {
        process.kill(pid, 0)
        continue
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') continue
      }
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true })
    }
  } catch {}
}
