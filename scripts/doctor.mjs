// Checks that this machine can build and run Studio, and says how to fix what's missing.
// Usage: node scripts/doctor.mjs        (exit code 1 if something required is missing)
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const platform = process.platform
const linux = platform === 'linux'
let failed = 0

const run = (cmd, args = []) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
const line = (tone, what, detail = '') => console.log(`${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[tone]} ${what}${detail ? `  ${detail}` : ''}`)
const need = (ok, what, detail, fix) => {
  line(ok ? 'ok' : 'fail', what, ok ? detail : fix)
  if (!ok) failed++
}
const want = (ok, what, detail, fix) => line(ok ? 'ok' : 'warn', what, ok ? detail : fix)

console.log(`Studio doctor · ${platform} ${os.release()} · ${os.cpus()[0]?.model ?? 'unknown CPU'}\n`)

// Toolchains
const nodeMajor = Number(process.versions.node.split('.')[0])
need(nodeMajor >= 22, 'Node.js', `v${process.versions.node}`, `v${process.versions.node} is too old; install Node 22 or newer`)
const cargo = run('cargo', ['-V'])
need(!!cargo, 'Rust (cargo)', cargo ?? '', 'install Rust from https://rustup.rs')
const rustc = run('rustc', ['-V'])
const rustMinor = Number(/rustc 1\.(\d+)/.exec(rustc ?? '')?.[1] ?? 0)
need(rustMinor >= 85, 'Rust 1.85+ (edition 2024)', rustc ?? '', 'run `rustup update stable`')
if (linux) {
  need(!!run('cc', ['--version']), 'C compiler', 'cc found', 'sudo apt install build-essential')
  need(!!run('pkg-config', ['--version']), 'pkg-config', 'found', 'sudo apt install pkg-config')
  need(run('pkg-config', ['--exists', 'alsa']) !== null, 'ALSA headers (sound output)', 'alsa.pc found', 'sudo apt install libasound2-dev')
}

// FFmpeg
const ffmpegDir = process.env.STUDIO_FFMPEG_DIR
const ffmpeg = ffmpegDir ? join(ffmpegDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg'
const ffprobe = ffmpegDir ? join(ffmpegDir, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe'
const version = run(ffmpeg, ['-hide_banner', '-version'])?.split('\n')[0]
need(!!version, 'FFmpeg', version ?? '', linux ? 'sudo apt install ffmpeg (or set STUDIO_FFMPEG_DIR)' : 'install FFmpeg and put it on PATH (or set STUDIO_FFMPEG_DIR)')
need(!!run(ffprobe, ['-hide_banner', '-version']), 'ffprobe', 'found', 'ffprobe ships with FFmpeg; make sure it sits next to ffmpeg')
if (version) {
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']) ?? ''
  const has = (e) => new RegExp(`\\s${e}\\s`).test(encoders)
  need(has('libx264'), 'x264 encoder (Best quality, and the fallback)', 'libx264', 'this FFmpeg build has no libx264; use a full build')
  need(has('aac'), 'AAC encoder', 'aac', 'this FFmpeg build has no AAC encoder')
  want(has('libmp3lame'), 'MP3 encoder (Export › Sound only)', 'libmp3lame', 'this FFmpeg build has no libmp3lame; MP3 export is off (WAV still works)')
  const gpu = ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'h264_amf'].filter(has)
  want(gpu.length > 0, 'Graphics-card encoders', gpu.join(', '), 'none found; exports fall back to x264 (slower)')
  if (gpu.includes('h264_nvenc')) {
    // Listing an encoder doesn't mean the driver can open it; try one frame.
    const nvencWorks = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']) !== null
    want(nvencWorks, 'NVENC opens on this driver', 'test encode ok', linux ? 'test encode failed; install the proprietary NVIDIA driver (570 or newer)' : 'test encode failed; update the NVIDIA driver')
  }
  if (linux) want(!!run('vainfo'), 'VA-API (AMD/Intel)', 'vainfo works', 'optional: sudo apt install vainfo mesa-va-drivers intel-media-va-driver')
}

// GPU and display
const smi = run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'])
want(!!smi, 'NVIDIA GPU', smi ?? '', 'no nvidia-smi; fine on AMD/Intel, needed for NVENC')
if (linux) {
  const session = process.env.XDG_SESSION_TYPE ?? (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : '')
  want(!!session, 'Display session', session, 'no display found; run the app from a desktop session (CI uses xvfb-run)')
  want(!!run('pactl', ['info']) || !!run('aplay', ['-l']), 'Sound server', 'PipeWire/PulseAudio or ALSA answers', 'no sound device; playback uses a silent clock')
}

// This checkout
need(existsSync(join(root, 'node_modules')), 'npm dependencies', 'installed', 'run `npm install` in the repo root')
const engineExe = join(root, 'target', 'release', platform === 'win32' ? 'studio-engine.exe' : 'studio-engine')
want(existsSync(engineExe), 'Engine built', 'target/release', 'run `npm run native`')
want(existsSync(join(root, 'apps', 'desktop', 'native', 'studio_bridge.node')), 'Frame addon built', 'apps/desktop/native', 'run `npm run native`')
want(existsSync(join(root, 'apps', 'desktop', 'dist', 'main.js')), 'App bundles built', 'apps/desktop/dist', 'run `npm run build`')

console.log(failed ? `\n${failed} required check(s) failed.` : '\nAll required checks passed.')
process.exit(failed ? 1 : 0)
