// Headless end-to-end check, no Electron: start the engine, ping it over the local
// socket, run the preview, read frames through the real bridge addon, then stop.
// Usage: node scripts/smoke.mjs [width] [height] [fps]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [width, height, fps] = [Number(process.argv[2] ?? 1080), Number(process.argv[3] ?? 1920), Number(process.argv[4] ?? 30)]
const isWin = process.platform === 'win32'
const runDir = join(os.tmpdir(), `studio-smoke-${process.pid}`)
mkdirSync(runDir, { recursive: true })
const socket = isWin ? `\\\\.\\pipe\\studio-smoke-${process.pid}` : join(runDir, 'engine.sock')
const ring = join(runDir, 'preview.ring')
const exe = join(root, 'target', 'release', isWin ? 'studio-engine.exe' : 'studio-engine')
const { PreviewRing } = createRequire(import.meta.url)(join(root, 'apps', 'desktop', 'native', 'studio_bridge.node'))

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`)
  process.exit(1)
}
// The socket and the ring file go when the script ends, however it ends.
process.on('exit', () => {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {}
})
const engine = spawn(exe, ['--socket', socket, '--ring', ring, '--exit-on-stdin-eof'], { stdio: ['pipe', 'inherit', 'inherit'] })
engine.on('exit', (code) => code && fail(`engine exited with ${code}`))

const connect = async () => {
  for (let i = 0; i < 50; i++) {
    const s = await new Promise((resolve) => {
      const c = net.connect(socket)
      c.once('connect', () => resolve(c))
      c.once('error', () => resolve(null))
    })
    if (s) return s
    await new Promise((r) => setTimeout(r, 100))
  }
  fail('could not connect to the engine socket')
}
const sock = await connect()
sock.setEncoding('utf8')
let buf = ''
const waiting = new Map()
sock.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    waiting.get(msg.id)?.(msg)
  }
})
let id = 0
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })

const t0 = performance.now()
const pong = await call('ping')
console.log(`ping: ${(performance.now() - t0).toFixed(2)} ms, engine ${pong.version} on ${pong.platform}`)
if (!pong.pong) fail('ping did not pong')

await call('preview.start', { width, height, fps })
const reader = new PreviewRing(ring)
const target = Buffer.alloc(reader.slotBytes())
let last = 0, got = 0, dropped = 0
const copies = []
const end = performance.now() + 3000
while (performance.now() < end) {
  const info = reader.readLatest(target, last)
  if (info) {
    if (last && info.seq > last + 1) dropped += info.seq - last - 1
    last = info.seq
    got++
    copies.push(info.copyUs)
    if (info.width !== width || info.height !== height) fail(`frame is ${info.width}x${info.height}`)
  }
  await new Promise((r) => setTimeout(r, 2))
}
const status = await call('preview.stop')
const avg = copies.reduce((a, b) => a + b, 0) / Math.max(1, copies.length)
console.log(`frames: ${got} read in 3 s (${(got / 3).toFixed(1)} fps), ${dropped} missed, copy ${avg.toFixed(0)} µs avg, engine wrote ${status.framesWritten} (${status.lateFrames} late, ${status.avgWriteUs} µs avg)`)
if (got < fps * 3 * 0.9) fail(`only ${got} frames arrived`)
const px = target.subarray(0, 4)
if (px[3] !== 255) fail('pixel alpha is not opaque; pattern not written')
engine.stdin.end()
sock.destroy()
console.log('SMOKE OK')
