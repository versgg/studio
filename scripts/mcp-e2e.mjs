// MCP end-to-end (no Electron). Speaks MCP over stdio to studio-mcp like Claude Code does
// (initialize, tools/list, then tool calls), in two phases:
//
// 1. Headless: studio-mcp gets a temp user data and projects folder, so it starts its own
//    engine. Checks a project, an import, the timeline, a split, the summary, a preview
//    frame, text, the permission levels, an export and the history's actor.
// 2. "App open": the test starts an engine the way the app does (--user-data, so it writes
//    engine.json) and connects to it as the window would. studio-mcp must use that engine,
//    not start its own, and an export waits for the window's approval.
//
// Usage: node scripts/mcp-e2e.mjs
//   STUDIO_MCP     studio-mcp binary (default target/agent-mcp/release, then target/release)
//   STUDIO_ENGINE  studio-engine binary (default target/agent-v2/release, then target/release)
//   VERBOSE=1      print studio-mcp's and the engine's log as it runs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const exe = (name) => (isWin ? `${name}.exe` : name)
const firstExisting = (...paths) => paths.find((p) => p && existsSync(p))
const mcpExe = process.env.STUDIO_MCP ?? firstExisting(join(root, 'target', 'agent-mcp', 'release', exe('studio-mcp')), join(root, 'target', 'release', exe('studio-mcp')))
const engineExe = process.env.STUDIO_ENGINE ?? firstExisting(join(root, 'target', 'agent-v2', 'release', exe('studio-engine')), join(root, 'target', 'release', exe('studio-engine')))
if (!mcpExe || !existsSync(mcpExe)) throw new Error('studio-mcp not built: cargo build --release -p studio-mcp')
if (!engineExe || !existsSync(engineExe)) throw new Error('studio-engine not found: set STUDIO_ENGINE')
const built = (p) => {
  const d = new Date(statSync(p).mtimeMs)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
console.log(`studio-mcp    ${mcpExe} (built ${built(mcpExe)})`)
console.log(`studio-engine ${engineExe} (built ${built(engineExe)})`)

const work = join(os.tmpdir(), `studio-mcp-e2e-${process.pid}`)
const projects = join(work, 'projects')
const exportsDir = join(work, 'exports')
for (const d of [projects, exportsDir]) mkdirSync(d, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A 4 s test clip with sound, made with lavfi.
const clip = join(work, 'clip.mp4')
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip])

const results = []
const check = (ok, msg, detail) => {
  results.push({ ok: !!ok, msg })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${!ok && detail ? `\n       ${String(detail).split('\n').join('\n       ')}` : ''}`)
}
const logs = []

// --- an MCP client on studio-mcp's stdio -------------------------------------------------
function startMcp(env) {
  const child = spawn(mcpExe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, STUDIO_SILENT: '1', ...env } })
  const c = { exited: null, log: [] }
  logs.push(c.log)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    c.log.push(d)
    if (process.env.VERBOSE) process.stderr.write(d)
  })
  child.on('exit', (code) => (c.exited = code ?? 0))
  let buf = ''
  let nextId = 0
  const waiting = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg)
        waiting.delete(msg.id)
      }
    }
  })
  c.send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  c.request = (method, params = {}, ms = 120_000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const t = setTimeout(() => reject(new Error(`${method}: no answer in ${ms / 1000} s`)), ms)
      waiting.set(id, (m) => {
        clearTimeout(t)
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)
      })
      c.send({ id, method, params })
    })
  // A tool call: { text, images, isError }.
  c.tool = async (name, args = {}, ms) => {
    const r = await c.request('tools/call', { name, arguments: args }, ms)
    const text = (r.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
    return { text, images: (r.content ?? []).filter((x) => x.type === 'image'), isError: !!r.isError }
  }
  c.init = async () => {
    const init = await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '1' } })
    c.send({ method: 'notifications/initialized' })
    return init
  }
  // Closing stdin is how Claude ends a session.
  c.close = async () => {
    child.stdin.end()
    const t0 = Date.now()
    while (c.exited === null && Date.now() - t0 < 15_000) await sleep(100)
    if (c.exited === null) child.kill()
    return c.exited
  }
  return c
}

const parseDone = (text) => {
  const m = text.match(/Done: (.*)$/m)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return m[1]
  }
}
const statusOf = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// --- a connection to an engine's socket, as Studio's window has ---------------------------
async function windowConnection(socket, onEvent = () => {}) {
  const s = await new Promise((res, rej) => {
    const c = net.connect(socket)
    c.once('connect', () => res(c))
    c.once('error', rej)
  })
  s.setEncoding('utf8')
  let b = ''
  let n = 0
  const pending = new Map()
  s.on('data', (d) => {
    b += d
    let nl
    while ((nl = b.indexOf('\n')) >= 0) {
      const m = JSON.parse(b.slice(0, nl))
      b = b.slice(nl + 1)
      if (m.id != null) pending.get(m.id)?.(m)
      else onEvent(m)
    }
  })
  s.on('error', () => {})
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++n
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      s.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { call, close: () => s.destroy() }
}

// ===== Phase 1: headless ====================================================================
console.log('\nPhase 1: Studio closed (studio-mcp runs the engine headless)')
const userData = join(work, 'userdata')
mkdirSync(userData, { recursive: true })
const mcp = startMcp({ STUDIO_ENGINE: engineExe, STUDIO_USER_DATA: userData, STUDIO_PROJECTS_DIR: projects })
let enginePid = null
let user = null
let projectDir = null
let engineJson = false
try {
  const init = await mcp.init()
  check(init.serverInfo?.name === 'studio' && init.capabilities?.tools, `initialize: ${init.serverInfo?.name} ${init.serverInfo?.version}, protocol ${init.protocolVersion}`)

  const listed = (await mcp.request('tools/list')).tools
  const names = listed.map((t) => t.name)
  const want = ['project_new', 'project_summary', 'media_import', 'media_describe', 'timeline_add_clip', 'timeline_split', 'clip_set', 'text_add', 'captions_set', 'transition_set', 'adjust_add', 'export_start', 'preview_frame', 'history_list']
  check(want.every((n) => names.includes(n)) && listed.every((t) => t.inputSchema?.type === 'object' && t.description), `tools/list: ${listed.length} tools with schemas`, want.filter((n) => !names.includes(n)).join(', '))

  const created = await mcp.tool('project_new', { name: 'MCP E2E', aspect: '9:16' })
  projectDir = created.text.match(/ at (.+\.studio)/)?.[1]
  check(!created.isError && created.text.includes('MCP E2E'), 'project_new makes and opens a project', created.text)

  const status = await mcp.tool('studio_status')
  const st = statusOf(status.text)
  enginePid = st.engine?.pid
  check(st.engine?.startedByStudioMcp === true && /headless/.test(st.window ?? ''), `studio_status: headless engine pid ${enginePid}, window "${st.window}"`, status.text)

  const file = join(userData, 'engine.json')
  engineJson = existsSync(file)
  check(engineJson, 'the headless engine wrote engine.json in the user data folder (--user-data)')
  // The test plays the user: it changes the History tab's settings on the engine's own
  // socket. The engine counts a connection without mcp.hello as a Studio window, so this one
  // is only open for each call.
  const engineSock = engineJson ? JSON.parse(readFileSync(file, 'utf8')).socket : st.engine?.socket
  user = {
    call: async (method, params) => {
      const w = await windowConnection(engineSock)
      try {
        return await w.call(method, params)
      } finally {
        w.close()
        await sleep(300)
      }
    },
  }
  const mcpStatus = await user.call('mcp.status').catch((e) => ({ error: e.message }))
  check(mcpStatus.clients >= 1, `mcp.hello reached the engine (mcp.status clients ${mcpStatus.clients})`, JSON.stringify(mcpStatus))

  const imported = await mcp.tool('media_import', { paths: [clip] })
  const mediaId = parseDone(imported.text)?.imported?.[0]
  check(!imported.isError && mediaId, `media_import: ${mediaId}`, imported.text)

  const described = await mcp.tool('media_describe', { mediaId })
  check(!described.isError && /4\.00 s/.test(described.text) && /720×1280/.test(described.text) && described.images.length >= 1, `media_describe: length, size and ${described.images.length} thumbnail image(s)`, described.text)

  const added = await mcp.tool('timeline_add_clip', { mediaId })
  const clipId = parseDone(added.text)
  check(!added.isError && typeof clipId === 'string', `timeline_add_clip: ${clipId}`, added.text)

  const split = await mcp.tool('timeline_split', { atUs: 2_000_000 })
  const right = parseDone(split.text)
  check(!split.isError && Array.isArray(right) && right.length === 1, `timeline_split at 2 s: right-hand clip ${right}`, split.text)

  const summary = await mcp.tool('project_summary')
  check(!summary.isError && summary.text.includes(clipId) && summary.text.includes(String(right?.[0])), 'project_summary lists both halves by id', summary.text)

  const look = await mcp.tool('clip_set', { clipId, scale: 120, saturation: 20 })
  check(!look.isError, 'clip_set: scale and colour', look.text)

  const frame = await mcp.tool('preview_frame', { atUs: 1_000_000 })
  const img = frame.images[0]
  const png = img ? Buffer.from(img.data, 'base64') : Buffer.alloc(0)
  const isPng = img?.mimeType === 'image/png' && png.subarray(1, 4).toString() === 'PNG'
  check(isPng, `preview_frame returns a PNG image${isPng ? ` ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}, ${(png.length / 1024).toFixed(0)} KB` : ''}`, frame.text)

  // Headless, nothing draws text, and the result says so.
  const text = await mcp.tool('text_add', { content: 'Hej!', atUs: 0, durationUs: 1_000_000 })
  check(!text.isError && /No Studio window is open/.test(text.text), 'text_add says honestly that no window draws the text', text.text)

  // Permissions, set the way the user would in the History tab.
  const setMcp = (m) => user.call('project.setOptions', { mcp: m })
  await setMcp({ allowed: 'look' }).catch(() => {})
  const lookEdit = await mcp.tool('clip_set', { clipId, opacity: 50 })
  check(lookEdit.isError && /only lets Claude look/.test(lookEdit.text), 'allowed "look": editing is refused', lookEdit.text)
  const lookLook = await mcp.tool('project_summary')
  check(!lookLook.isError, 'allowed "look": looking still works', lookLook.text)

  await setMcp({ allowed: 'edit' }).catch(() => {})
  const editImport = await mcp.tool('media_import', { paths: [clip] })
  const editExport = await mcp.tool('export_start', { folder: exportsDir })
  const editEdit = await mcp.tool('clip_set', { clipId, opacity: 90 })
  check(editImport.isError && editExport.isError && !editEdit.isError, 'allowed "edit": import and export refused, edits allowed', [editImport.text, editExport.text, editEdit.text].join('\n'))

  await mcp.tool('project_set_options', { magnet: true, mcp: { allowed: 'all', askBeforeExport: false } })
  const afterSneaky = await user.call('project.current')
  const mcpNow = afterSneaky.project?.mcp ?? afterSneaky.mcp
  check(mcpNow?.allowed === 'edit', "project_set_options can't change Claude's own permissions", JSON.stringify(mcpNow))

  await setMcp({ allowed: 'all', askBeforeExport: true }).catch(() => {})
  const asked = await mcp.tool('export_start', { folder: exportsDir, quality: 'fast' })
  check(asked.isError && /no Studio window is open/.test(asked.text), 'ask before export: refused headless, because no window can ask', asked.text)

  await setMcp({ allowed: 'all', askBeforeExport: false }).catch(() => {})
  const exported = await mcp.tool('export_start', { folder: exportsDir, quality: 'fast', formats: ['9:16'], timeoutS: 90 }, 150_000)
  const outPath = exported.text.match(/ — (.+\.mp4) \(/)?.[1]
  let probe = exported.text
  let probeOk = false
  if (outPath && existsSync(outPath)) {
    const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outPath]).toString())
    const v = p.streams.find((s) => s.codec_type === 'video')
    const dur = Number(p.format.duration)
    probeOk = v?.width === 1080 && v?.height === 1920 && Math.abs(dur - 4) < 0.3
    probe = `${v?.width}×${v?.height} ${v?.codec_name}, ${dur.toFixed(2)} s`
  }
  check(!exported.isError && probeOk, `export_start headless with "ask before export" off: ${outPath ? `${outPath.split(/[\\/]/).pop()}, ${probe}` : 'no file'}`, probe)
  const exportStatus = await mcp.tool('export_status')
  check(/: done/.test(exportStatus.text), 'export_status shows the job done', exportStatus.text)
  // A stuck job would keep studio-mcp waiting for it at exit: cancel it.
  for (const [, job] of exportStatus.text.matchAll(/- (e\d+) [^\n]*: (?:running|queued)/g)) await mcp.tool('export_cancel', { jobId: job })

  const history = await mcp.tool('history_list')
  check(/Split — claude/.test(history.text) && /Claude · MCP/.test(history.text), 'history_list shows actor "claude" for Claude\'s edits', history.text)

  const undo = await mcp.tool('edit_undo')
  const redo = await mcp.tool('edit_redo')
  check(!undo.isError && !redo.isError, 'edit_undo and edit_redo', `${undo.text} / ${redo.text}`)
} catch (e) {
  check(false, `phase 1 stopped: ${e.message}`)
}
check((await mcp.close()) === 0, 'studio-mcp exits when its stdin closes')
if (enginePid) {
  const t1 = Date.now()
  while (alive(enginePid) && Date.now() - t1 < 10_000) await sleep(100)
  check(!alive(enginePid), 'its headless engine exits with it')
}

// ===== Phase 2: Studio open =================================================================
console.log('\nPhase 2: Studio open (studio-mcp uses the app\'s engine)')
if (!engineJson) {
  console.log('skip: this engine build has no --user-data / engine.json, so studio-mcp has no app engine to find')
} else {
  const appData = join(work, 'appdata')
  mkdirSync(appData, { recursive: true })
  const socket = isWin ? `\\\\.\\pipe\\studio-mcp-e2e-app-${process.pid}` : join(work, 'app.sock')
  const app = spawn(engineExe, ['--socket', socket, '--ring', join(work, 'app.ring'), '--projects-dir', projects, '--user-data', appData, '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, STUDIO_SILENT: '1' } })
  app.stdout.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
  app.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
  let win = null
  let mcp2 = null
  const approvals = []
  try {
    const t0 = Date.now()
    while (!existsSync(join(appData, 'engine.json')) && Date.now() - t0 < 15_000) await sleep(100)
    check(existsSync(join(appData, 'engine.json')), 'the app engine wrote engine.json')
    // The window: answers approvals with yes, as a user clicking "Allow" would.
    win = await windowConnection(socket, (m) => {
      if (m.method === 'approval.requested') {
        approvals.push(m.params)
        win.call('approval.answer', { id: m.params.id, ok: true }).catch(() => {})
      }
    })
    await win.call('project.open', { path: projectDir })
    await win.call('project.setOptions', { mcp: { allowed: 'all', askBeforeExport: true } }).catch(() => {})

    // STUDIO_ENGINE points nowhere: studio-mcp must use the app's engine, not start one.
    mcp2 = startMcp({ STUDIO_ENGINE: join(work, 'no-engine-here.exe'), STUDIO_USER_DATA: appData, STUDIO_PROJECTS_DIR: projects })
    await mcp2.init()
    const st = statusOf((await mcp2.tool('studio_status')).text)
    check(st.engine?.startedByStudioMcp === false && st.engine?.socket === socket, `studio_status: connected to the app's engine (window "${st.window}")`, JSON.stringify(st))
    const summary = await mcp2.tool('project_summary')
    check(!summary.isError && summary.text.includes('MCP E2E'), 'project_summary sees the project the window has open', summary.text)

    let changed = 0
    const seen = await windowConnection(socket, (m) => m.method === 'project.changed' && changed++)
    const edit = await mcp2.tool('clip_set', { clipIds: [summary.text.match(/\b(c\d+)\b/)?.[1]].filter(Boolean), brightness: 10 })
    await sleep(300)
    check(!edit.isError && changed > 0, `an edit reaches the window live (${changed} project.changed)`, edit.text)
    seen.close()

    const exported = await mcp2.tool('export_start', { folder: exportsDir, quality: 'fast', baseName: 'approved', timeoutS: 90 }, 150_000)
    const out = exported.text.match(/ — (.+\.mp4) \(/)?.[1]
    check(approvals.length === 1 && /export/i.test(approvals[0].what ?? '') && !exported.isError && out && existsSync(out), `export waits for the window's approval, then exports (${approvals[0]?.detail ?? 'no approval asked'})`, exported.text)

    check((await mcp2.close()) === 0, 'studio-mcp exits when its stdin closes')
    await sleep(300)
    check(alive(app.pid) && existsSync(join(appData, 'engine.json')), "the app's engine and its engine.json are left alone")
  } catch (e) {
    check(false, `phase 2 stopped: ${e.message}`)
  }
  win?.close()
  if (mcp2 && mcp2.exited === null) await mcp2.close()
  app.stdin.end()
  const t2 = Date.now()
  while (alive(app.pid) && Date.now() - t2 < 10_000) await sleep(100)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${engineExe} (built ${built(engineExe)})`)
if (failed.length && !process.env.VERBOSE) console.log(`\nstudio-mcp log (last 30 lines):\n${logs.map((l) => l.join('')).join('').split('\n').slice(-30).join('\n')}`)
try {
  rmSync(work, { recursive: true, force: true })
} catch {}
process.exit(failed.length ? 1 : 0)
