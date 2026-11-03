// FFmpeg for the main process's own small jobs (sound effects, frames for analysis, mattes,
// sound for transcription). Found the way the engine finds it: STUDIO_FFMPEG_DIR, next to
// the engine binary, or on PATH.

import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

export function findTool(name: 'ffmpeg' | 'ffprobe'): string {
  const dirs = [process.env.STUDIO_FFMPEG_DIR, process.env.STUDIO_ENGINE && path.dirname(process.env.STUDIO_ENGINE), app.isPackaged ? path.join(process.resourcesPath, 'bin') : null]
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, exe(name))
    if (fs.existsSync(p)) return p
  }
  // On PATH (spawn looks it up).
  return name
}

/** Runs FFmpeg at low priority; resolves with stdout, rejects with the last line of stderr. */
export function ffmpeg(args: string[], o: { stdin?: Buffer; tool?: 'ffmpeg' | 'ffprobe'; timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(findTool(o.tool ?? 'ffmpeg'), o.tool === 'ffprobe' ? args : ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true })
    lowPriority(child)
    const out: Buffer[] = []
    let err = ''
    const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : null
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    child.on('error', (e) => reject(new Error(`${o.tool ?? 'ffmpeg'} could not start: ${e.message}`)))
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(err.trim().split(/\r?\n/).pop() || `${o.tool ?? 'ffmpeg'} exited with ${code}`))
    })
    if (o.stdin) child.stdin.end(o.stdin)
    else child.stdin.end()
  })
}

export function lowPriority(child: ChildProcessWithoutNullStreams) {
  try {
    if (child.pid) os.setPriority(child.pid, 10)
  } catch {}
}

/** Width, height (as shown, after rotation), frame rate and length of a file's first video stream. */
export async function probeVideo(file: string): Promise<{ width: number; height: number; fps: number; durationUs: number }> {
  const raw = await ffmpeg(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', file], { tool: 'ffprobe', timeoutMs: 20_000 })
  const j = JSON.parse(raw.toString())
  const s = j.streams?.[0]
  if (!s) throw new Error('This file has no picture.')
  const rot = Math.abs(Number(s.side_data_list?.find((d: { rotation?: number }) => d.rotation != null)?.rotation ?? s.tags?.rotate ?? 0)) % 180
  const rate = (x: string) => {
    const [a, b] = String(x ?? '0/1').split('/').map(Number)
    return b ? a / b : a
  }
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30
  const [w, h] = rot === 90 ? [s.height, s.width] : [s.width, s.height]
  return { width: w, height: h, fps, durationUs: Math.round(Number(j.format?.duration ?? 0) * 1e6) }
}
