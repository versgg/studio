// The player's draw loop. It runs here in the preload so frames never cross the
// context bridge: the addon copies the newest engine frame into a Node buffer
// (the one planned copy), and WebGL2 uploads it straight from that buffer.

import path from 'node:path'
import type { PlayerStats } from '../shared/api'

interface FrameInfo {
  seq: number
  width: number
  height: number
  stride: number
  ptsUs: number
  writtenAtUs: number
  copyUs: number
}
interface PreviewRing {
  slotBytes(): number
  readLatest(target: Buffer, lastSeq: number): FrameInfo | null
}

const native = require(path.join(__dirname, '..', 'native', 'studio_bridge.node')) as { PreviewRing: new (path: string) => PreviewRing }

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2((pos.x + 1.0) * 0.5, 1.0 - (pos.y + 1.0) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`
const FRAG = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
out vec4 color;
void main() { color = texture(tex, uv); }`

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const p95 = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d

export class Player {
  private ring?: PreviewRing
  private nextRingTry = 0
  private buf?: Buffer
  private canvas?: HTMLCanvasElement
  private gl?: WebGL2RenderingContext
  private tex?: WebGLTexture
  private texSize = { w: 0, h: 0 }
  private raf = 0
  private lastSeq = 0
  private firstFrameSent = false
  private listeners = new Set<(s: PlayerStats) => void>()
  private sample = this.emptySample()
  private lastReport = performance.now()
  private totals = { received: 0, dropped: 0 }

  constructor(private ringPath: string, private onFirstFrame: () => void) {}

  attach(canvasId: string) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null
    if (!canvas || canvas === this.canvas) return
    this.canvas = canvas
    this.initGl(canvas)
    if (!this.raf) this.raf = requestAnimationFrame(this.loop)
  }

  detach() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.canvas = undefined
    this.gl = undefined
  }

  onStats(cb: (s: PlayerStats) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  resetStats() {
    this.sample = this.emptySample()
    this.totals = { received: 0, dropped: 0 }
    this.lastReport = performance.now()
  }

  /** Stats over everything since the last reset (used by the bench). */
  snapshot(): PlayerStats {
    return this.summarise(this.sample, (performance.now() - this.sample.start) / 1000)
  }

  private emptySample() {
    return { start: performance.now(), frames: 0, draws: 0, copyUs: [] as number[], uploadMs: [] as number[], latencyMs: [] as number[], arrivals: [] as number[], w: 0, h: 0 }
  }

  private summarise(s: ReturnType<Player['emptySample']>, seconds: number): PlayerStats {
    const intervals = s.arrivals.slice(1).map((t, i) => t - s.arrivals[i])
    const mean = avg(intervals)
    const jitter = Math.sqrt(avg(intervals.map((d) => (d - mean) ** 2)))
    return {
      fpsIn: round(s.frames / Math.max(seconds, 0.001), 1),
      fpsDraw: round(s.draws / Math.max(seconds, 0.001), 1),
      framesReceived: this.totals.received,
      dropped: this.totals.dropped,
      frameWidth: s.w,
      frameHeight: s.h,
      copyUsAvg: round(avg(s.copyUs), 0),
      copyUsMax: round(Math.max(0, ...s.copyUs), 0),
      uploadMsAvg: round(avg(s.uploadMs)),
      uploadMsP95: round(p95(s.uploadMs)),
      latencyMsAvg: round(avg(s.latencyMs), 1),
      latencyMsP95: round(p95(s.latencyMs), 1),
      intervalJitterMs: round(jitter),
    }
  }

  private initGl(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false })
    if (!gl) throw new Error('WebGL2 is not available')
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error')
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    this.tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.texSize = { w: 0, h: 0 }
    this.gl = gl
  }

  private openRing(): PreviewRing | undefined {
    if (this.ring) return this.ring
    const now = performance.now()
    if (now < this.nextRingTry) return undefined
    try {
      this.ring = new native.PreviewRing(this.ringPath)
      this.buf = Buffer.alloc(this.ring.slotBytes())
    } catch {
      this.nextRingTry = now + 250 // the engine hasn't created it yet
    }
    return this.ring
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const gl = this.gl
    const canvas = this.canvas
    if (!gl || !canvas) return
    this.sample.draws++

    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }

    const ring = this.openRing()
    const info = ring && this.buf ? ring.readLatest(this.buf, this.lastSeq) : null
    if (info) {
      const t0 = performance.now()
      if (this.lastSeq && info.seq > this.lastSeq + 1) this.totals.dropped += info.seq - this.lastSeq - 1
      this.lastSeq = info.seq
      this.totals.received++
      const bytes = new Uint8Array(this.buf!.buffer, this.buf!.byteOffset, info.stride * info.height)
      gl.bindTexture(gl.TEXTURE_2D, this.tex!)
      if (this.texSize.w !== info.width || this.texSize.h !== info.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, info.width, info.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
        this.texSize = { w: info.width, h: info.height }
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, info.width, info.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
      }
      this.sample.uploadMs.push(performance.now() - t0)
      this.sample.copyUs.push(info.copyUs)
      this.sample.latencyMs.push(Date.now() - info.writtenAtUs / 1000)
      this.sample.arrivals.push(t0)
      this.sample.frames++
      this.sample.w = info.width
      this.sample.h = info.height
    }

    // Letterbox the frame into the canvas.
    gl.viewport(0, 0, cw, ch)
    gl.clearColor(0.055, 0.055, 0.063, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.texSize.w) {
      const scale = Math.min(cw / this.texSize.w, ch / this.texSize.h)
      const vw = Math.round(this.texSize.w * scale)
      const vh = Math.round(this.texSize.h * scale)
      gl.viewport(Math.round((cw - vw) / 2), Math.round((ch - vh) / 2), vw, vh)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (info && !this.firstFrameSent) {
        this.firstFrameSent = true
        this.onFirstFrame()
      }
    }

    const now = performance.now()
    if (now - this.lastReport >= 500) {
      const recent = this.summarise(this.sample, (now - this.sample.start) / 1000)
      this.lastReport = now
      for (const cb of this.listeners) cb(recent)
      // Keep the live window short so the panel shows current numbers.
      if (now - this.sample.start > 5000 && !this.benchHold) this.sample = this.emptySample()
    }
  }

  /** While true, stats accumulate without the rolling reset (bench mode). */
  benchHold = false
}
