// The Export dialog, as on the canvas (Export.dc.html): preview and checks, formats and
// quality, files. Settings are remembered; "Save these settings as a preset" makes them
// the starting point every time.

import { useEffect, useMemo, useRef, useState } from 'react'
import { basename, bytes, FORMATS } from './format'
import { exportCaptionsSrt } from './captions'
import { isReels, reelsCovers } from './reels'
import { srtFile, textFile, textOf, type TextWhat } from './textExport'
import { useStrip } from './media-cache'
import './export.css'
import { call, exportTimeLeft, findClip, getState, mediaById, setState, startExport, toast, useStore, type ExportJob, type Snapshot, type Us } from './store'

const PREFS_KEY = 'studio.export.v2'
const OLD_PREFS_KEY = 'studio.export.v1'

interface Prefs {
  formats?: string[]
  quality?: string
  folder?: string
  pattern?: string
  bitrate?: Record<string, number>
  fps?: number
  captions?: string
  after?: string
}
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? localStorage.getItem(OLD_PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const WHERE: Record<string, string> = { '9:16': 'Reels, TikTok, Shorts', '4:5': 'Meta feed', '1:1': 'Square feed', '16:9': 'YouTube' }
const GLYPH: Record<string, [number, number]> = { '9:16': [18, 32], '4:5': [26, 32], '1:1': [30, 30], '16:9': [40, 23] }
const QUALITY = [
  ['fast', 'Fast', 'Graphics card encoder. Quick drafts.'],
  ['balanced', 'Balanced', 'Graphics card, higher bitrate. Ads.'],
  ['best', 'Best', 'Software encoder. Slower, cleanest.'],
] as const
/** The sound alone, each a file of its own: id, name, spec, what it's for, MB per second. */
const SOUNDS = [
  ['mp3', 'MP3', '320 kbps', 'Plays anywhere', 320 / 8 / 1000],
  ['wav', 'WAV', '24-bit, 48 kHz', 'Uncompressed, for editing', (48000 * 3 * 2) / 1e6],
] as const
const ORDER: string[] = [...FORMATS.map(([f]) => f), ...SOUNDS.map(([s]) => s)]
const soundOf = (f: string) => SOUNDS.find(([s]) => s === f)
const MBPS: Record<string, number> = { fast: 10, balanced: 12, best: 16 }
const BITRATES = [8, 10, 12, 16, 20, 25]
const AUDIO_KBPS = 320
const TOKENS = ['{project}', '{format}', '{version}', '{date}', '{language}']
const DEFAULT_PATTERN = '{project}-{format}-v{version}'

/** 0:20.5 */
const len = (us: Us) => {
  const s = us / 1e6
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
const today = () => new Date().toISOString().slice(0, 10)
const language = () => (navigator.language || 'en').split('-')[0]
const clean = (name: string) => name.replace(/[<>:"/\\|?*]/g, '-').trim()
const sep = (folder: string) => (folder.includes('\\') ? '\\' : '/')

function fileStem(pattern: string, project: string, format: string, version: number) {
  const out = pattern
    .split('{project}')
    .join(project)
    .split('{format}')
    .join(format.replace(':', 'x'))
    .split('{version}')
    .join(String(version))
    .split('{date}')
    .join(today())
    .split('{language}')
    .join(language())
  return clean(out) || 'Export'
}

/**
 * Whether every caption line sits clear of the app's buttons, measured from each line's box,
 * scale and position. A 9:16 project is judged against Instagram Reels as the player draws it
 * (reels.ts); other shapes against the plain safe zones: the top 8 %, the bottom 17 %, and the
 * right 15 % between 38 % and 82 % of the height.
 */
function captionsClear(snap: Snapshot | null): { lines: number; outside: number; reels: boolean } {
  const p = snap?.project
  if (!p) return { lines: 0, outside: 0, reels: false }
  const reels = isReels(p.width, p.height)
  const lines = p.tracks.filter((t) => t.role === 'captions' && !t.hidden).flatMap((t) => t.clips)
  let outside = 0
  for (const c of lines) {
    const k = (c.scale ?? 100) / 100
    const w = (c.text?.boxW ?? p.width) * k
    const h = (c.text?.boxH ?? 0) * k
    const cx = p.width / 2 + (c.posX ?? 0)
    const cy = p.height / 2 + (c.posY ?? 0)
    const top = cy - h / 2
    const bottom = cy + h / 2
    const right = cx + w / 2
    if (reels) {
      // Without a measured box, only the line's middle is judged across.
      const known = c.text?.boxW !== undefined
      const [x0, x1] = known ? [(cx - w / 2) / p.width, right / p.width] : [cx / p.width, cx / p.width]
      if (reelsCovers(x0, top / p.height, x1, bottom / p.height, known)) outside++
      continue
    }
    const inSide = right > p.width * 0.85 && bottom > p.height * 0.38 && top < p.height * 0.82
    if (top < p.height * 0.08 || bottom > p.height * 0.83 || inSide) outside++
  }
  return { lines: lines.length, outside, reels }
}

/** The checks on the left: what the export will meet, from the project as it is. */
function checks(snap: Snapshot | null, durationUs: Us, nvenc: boolean, quality: string, video: boolean) {
  const p = snap?.project
  const used = p?.tracks.flatMap((t) => t.clips) ?? []
  const media = used.map((c) => mediaById(snap, c.mediaId))
  const missing = media.filter((m) => !m || m.missing).length
  const pictures = media.filter((m) => m && m.kind !== 'audio').length
  const sounds = media.filter((m) => m?.kind === 'audio').length
  const master = (p as { master?: { normalize?: boolean; targetLufs?: number } } | undefined)?.master
  const lufs = master?.targetLufs ?? -14
  const caps = captionsClear(snap)
  const out: { ok: boolean; text: string; sub: string }[] = [
    ...(caps.lines
      ? [
          caps.outside
            ? { ok: false, text: `${caps.outside} caption ${caps.outside === 1 ? 'line is' : 'lines are'} under ${caps.reels ? 'the Reels card and buttons' : 'the app buttons'}`, sub: 'Move the captions in Library › Captions › Position' }
            : { ok: true, text: 'Captions inside the safe zone', sub: `All ${caps.lines} lines clear of ${caps.reels ? 'the Reels card and buttons' : 'the app buttons'}` },
        ]
      : []),
    missing
      ? { ok: false, text: `${missing} ${missing === 1 ? 'file is' : 'files are'} missing`, sub: 'Relink or remove them; they export as black and silence' }
      : { ok: true, text: 'All media found', sub: `${pictures} ${pictures === 1 ? 'clip' : 'clips'}, ${sounds} audio ${sounds === 1 ? 'file' : 'files'}` },
    master?.normalize === false
      ? { ok: true, text: 'Loudness as mixed', sub: 'Levelling is off on the Audio page' }
      : { ok: true, text: `Loudness levelled to ${lufs.toFixed(0).replace('-', '−')} LUFS`, sub: 'Measured during the export, peaks under −1 dBTP' },
    { ok: durationUs > 0, text: `Length ${len(durationUs)}`, sub: durationUs > 0 ? 'From the first frame to the last clip' : 'The timeline is empty' },
    ...(video ? [quality === 'best' || nvenc ? { ok: true, text: quality === 'best' ? 'Software encoder' : 'Graphics card encoder found', sub: quality === 'best' ? 'x264, slow preset' : 'NVENC H.264' } : { ok: false, text: 'No graphics card encoder', sub: 'Fast and Balanced use the software encoder' }] : []),
  ]
  return out
}

export function ExportDialog() {
  const snap = useStore((s) => s.snap)
  const paths = useStore((s) => s.paths)
  const caps = useStore((s) => s.caps)
  const jobs = useStore((s) => s.exports)
  // Set when exporting just the selected clips (right-click › Export these clips).
  const only = useStore((s) => s.exportClips)
  const prefs = useMemo(loadPrefs, [])
  const project = snap?.project
  const current = FORMATS.find(([, w, h]) => w === project?.width && h === project?.height)?.[0] ?? '9:16'
  const [formats, setFormats] = useState<string[]>(prefs.formats?.length ? prefs.formats : [current])
  const [quality, setQuality] = useState(prefs.quality ?? 'balanced')
  const [bitrates, setBitrates] = useState<Record<string, number>>(prefs.bitrate ?? {})
  const [fps, setFps] = useState<number>(prefs.fps ?? 0)
  const [captions, setCaptions] = useState(prefs.captions ?? 'Burned in')
  const [after, setAfter] = useState(prefs.after ?? 'Open folder')
  const [textWhat, setTextWhat] = useState<TextWhat>('both')
  const [savingText, setSavingText] = useState<'txt' | 'srt' | null>(null)
  const [folder, setFolder] = useState(prefs.folder ?? (paths ? `${paths.videos}${sep(paths.videos)}Studio Exports` : ''))
  const [pattern, setPattern] = useState(prefs.pattern ?? DEFAULT_PATTERN)
  const [pv, setPv] = useState(formats[0] ?? current)
  const [version, setVersion] = useState(1)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  // After Export the window stays up and shows those files being made, then Done.
  const batch = useStore((s) => s.exportBatch)
  const shown = batch ? jobs.filter((j) => batch.includes(j.jobId)) : []
  const working = shown.some((j) => j.state === 'queued' || j.state === 'running')
  // However the window is closed (Escape too), a finished export isn't shown again next time.
  useEffect(
    () => () => {
      const s = getState()
      const b = s.exportBatch
      if (b && !s.exports.some((j) => b.includes(j.jobId) && (j.state === 'queued' || j.state === 'running'))) setState({ exportBatch: null })
    },
    [],
  )

  const span = useMemo(() => {
    if (!only?.length) return { start: 0, dur: snap?.durationUs ?? 0 }
    const cs = only.map((id) => findClip(snap, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c)
    const start = Math.min(...cs.map((c) => c.startUs))
    return { start, dur: Math.max(...cs.map((c) => c.startUs + c.durationUs)) - start }
  }, [only, snap])
  const mbps = bitrates[quality] ?? MBPS[quality]
  const chosen = FORMATS.filter(([f]) => formats.includes(f))
  const canMp3 = caps?.mp3 !== false
  const sounds = SOUNDS.filter(([s]) => formats.includes(s) && (s !== 'mp3' || canMp3))
  // Every file this export makes: the video formats, then the sound alone.
  const outputs = [...chosen.map(([f]) => f), ...sounds.map(([s]) => s)]
  const projectName = `${project?.name ?? 'Export'}${only?.length ? ' selection' : ''}`
  // {format} is "audio" for the sound files: Promo-audio-v1.mp3.
  const stemOf = (f: string, v: number) => fileStem(pattern, projectName, soundOf(f) ? 'audio' : f, v)
  const extOf = (f: string) => (soundOf(f) ? f : 'mp4')
  const stems = outputs.map((f) => [f, stemOf(f, version)] as const)
  const sizeMb = (span.dur / 1e6) * ((mbps + AUDIO_KBPS / 1000) / 8)
  const sizeOf = (f: string) => {
    const s = soundOf(f)
    return s ? (span.dur / 1e6) * s[4] : sizeMb
  }
  const totalMb = outputs.reduce((n, f) => n + sizeOf(f), 0)
  const empty = !span.dur
  const hasCaptions = !!project?.tracks.some((t) => t.role === 'captions' && t.clips.length)

  // {version}: the first number no file in this export already uses.
  useEffect(() => {
    if (!folder || !pattern.includes('{version}')) return setVersion(1)
    let live = true
    ;(async () => {
      for (let v = 1; v < 200; v++) {
        const names = outputs.map((f) => `${folder}${sep(folder)}${stemOf(f, v)}.${extOf(f)}`)
        const exists = await window.studio.app.existing(names)
        if (!exists.some(Boolean)) {
          if (live) setVersion(v)
          return
        }
      }
    })()
    return () => {
      live = false
    }
  }, [folder, pattern, formats.join(), projectName, jobs.length])
  useEffect(() => {
    if (!formats.includes(pv) && chosen.length) setPv(chosen[0][0])
  }, [formats, pv])

  const toggle = (f: string) => setFormats((x) => (x.includes(f) ? x.filter((y) => y !== f) : ORDER.filter((y) => y === f || x.includes(y))))
  // Closed while it's exporting, the files carry on, and Export brings this view back.
  const close = () => setState({ dialog: null, exportClips: null, ...(working ? {} : { exportBatch: null }) })
  const settings = (): Prefs => ({ formats, quality, folder, pattern, bitrate: bitrates, fps, captions, after })
  const remember = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(settings()))
    } catch {}
  }
  const choose = async () => {
    const f = await window.studio.app.chooseFolder(folder || paths?.videos, 'Export to folder')
    if (f) setFolder(f)
  }
  const insert = (token: string) => {
    const el = nameRef.current
    const at = el?.selectionStart ?? pattern.length
    const end = el?.selectionEnd ?? at
    setPattern(pattern.slice(0, at) + token + pattern.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }
  /** The edit's text (on screen, what's said, or both) as .txt or .srt, next to the video and named like it. */
  const saveText = async (kind: 'txt' | 'srt') => {
    const snap = getState().snap
    if (!snap) return
    setSavingText(kind)
    try {
      const text = await textOf(snap)
      const body = kind === 'txt' ? textFile(text, textWhat) : srtFile(text, textWhat)
      if (!body.trim()) return void toast(textWhat === 'said' ? 'Nothing is said that Studio knows the words of: no dubbed voice, voiceover script or captions.' : 'There’s no text in this edit to save.', 'error')
      const tag = textWhat === 'screen' ? ' (on screen)' : textWhat === 'said' ? ' (said)' : ''
      const r = await window.studio.files.writeText(`${folder}${sep(folder)}${stems[0]?.[1] ?? projectName}${tag}.${kind}`, body)
      if ('error' in r) return void toast(r.error, 'error')
      toast(`Saved ${basename(r.out)}${text.fromCaptions && textWhat !== 'screen' ? ' (what she says from the captions)' : ''}`)
    } catch (e) {
      toast(`Couldn’t save the text: ${(e as Error).message}`, 'error')
    } finally {
      setSavingText(null)
    }
  }
  const go = async (closeAfter: boolean) => {
    setBusy(true)
    remember()
    const ids = await startExport(
      outputs,
      quality,
      folder,
      projectName,
      only,
      { names: Object.fromEntries(stems), bitrateMbps: mbps, ...(fps ? { fps } : {}), captions, openFolder: after === 'Open folder' },
    )
    const ok = !!ids
    // Captions as .srt next to the video files, when asked and there are any.
    if (ok && captions !== 'Burned in' && hasCaptions) {
      try {
        const files = await exportCaptionsSrt(folder, stems[0]?.[1] ?? projectName)
        if (files.length) toast(`Captions saved: ${files.map((f) => basename(f)).join(', ')}`)
      } catch (e) {
        toast(`Couldn't save the captions: ${(e as Error).message}`, 'error')
      }
    }
    setBusy(false)
    if (ids && closeAfter) setState({ exportBatch: ids })
    if (ok && !closeAfter) toast(`${outputs.length === 1 ? 'One file' : `${outputs.length} files`} added to the export queue`)
  }

  const checkList = checks(snap, span.dur, !!caps?.nvenc, quality, chosen.length > 0)
  const gpu = !!caps?.nvenc && quality !== 'best'
  const ratio = project ? project.width / project.height : 9 / 16
  const boxW = ratio >= 1 ? 220 : 180
  const boxH = Math.round(boxW / ratio)
  const pf = FORMATS.find(([f]) => f === pv)
  const pr = pf ? pf[1] / pf[2] : ratio
  const crop = pr > ratio ? { w: boxW, h: boxW / pr } : { w: boxH * pr, h: boxH }
  const running = jobs.filter((j) => j.state !== 'cancelled')

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !working && close()}>
      <div className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="exp-h">
        <div className="exp-head">
          <h1 id="exp-h">{shown.length ? (working ? 'Exporting…' : shown.some((j) => j.state === 'failed') ? 'Export finished with errors' : 'Done') : only?.length ? `Export ${only.length === 1 ? 'one clip' : `${only.length} clips`}` : 'Export'}</h1>
          <span className="exp-meta">
            {project?.name} · {len(span.dur)}
          </span>
          <button type="button" className="exp-close" aria-label="Close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3.5 3.5l9 9 M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>

        {shown.length > 0 ? (
          <ExportProgress jobs={shown} snap={snap} atUs={span.start} folder={folder} frame={{ width: boxW, height: boxH }} onClose={close} />
        ) : (
          <>
        <div className="exp-body">
          <section className="exp-col exp-preview" aria-label="Preview and checks">
            <div className="exp-frame" style={{ width: boxW, height: boxH }}>
              <FirstFrame snap={snap} atUs={span.start} />
              {chosen.length > 0 && pv !== current && <span className="exp-crop" aria-hidden="true" style={{ left: (boxW - crop.w) / 2, top: (boxH - crop.h) / 2, width: crop.w, height: crop.h }} />}
              <span className="exp-frame-label">{!chosen.length ? 'Sound only' : pv === current ? pv : `${pv} crop`}</span>
            </div>
            {chosen.length > 1 && (
              <div className="seg-pill" role="group" aria-label="Preview format">
                {chosen.map(([f]) => (
                  <button key={f} type="button" className={f === pv ? 'on' : ''} aria-pressed={f === pv} onClick={() => setPv(f)}>
                    {f}
                  </button>
                ))}
              </div>
            )}
            <div className="exp-checks">
              <h2>Checks</h2>
              {checkList.map((c) => (
                <div key={c.text} className="exp-check">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={c.ok ? '#3FB27F' : '#E5A23A'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={c.ok ? 'M3 8.5l3 3 7-7' : 'M8 3.5v5.5 M8 12v.5'} />
                  </svg>
                  <span>
                    <span>{c.text}</span>
                    <span className="exp-sub">{c.sub}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="exp-col exp-main" aria-label="Formats and quality">
            <div className="exp-group">
              <div className="exp-title-row">
                <h2>Formats</h2>
                <span className="exp-sub-12">One click, every placement</span>
              </div>
              {FORMATS.map(([f, w, h]) => {
                const on = formats.includes(f)
                const [gw, gh] = GLYPH[f]
                return (
                  <button key={f} type="button" role="checkbox" aria-checked={on} className={`exp-format${on ? ' on' : ''}`} onClick={() => toggle(f)}>
                    <span className="exp-box" aria-hidden="true">
                      <Tick />
                    </span>
                    <span className="exp-glyph" aria-hidden="true">
                      <span style={{ width: gw, height: gh }} />
                    </span>
                    <span className="exp-format-text">
                      <span className="exp-format-name">
                        {f} <span>· {WHERE[f]}</span>
                      </span>
                      <span className="exp-sub">{f === current ? 'The edit as you made it' : 'Centred, each clip filled or fitted as you set it'}</span>
                    </span>
                    <span className="exp-res">
                      {w} × {h}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="exp-group">
              <div className="exp-title-row">
                <h2>Sound only</h2>
                <span className="exp-sub-12">The same mix, levelled as the video</span>
              </div>
              <div className="exp-sounds">
                {SOUNDS.map(([s, name, spec, use]) => {
                  const off = s === 'mp3' && !canMp3
                  const on = !off && formats.includes(s)
                  return (
                    <button key={s} type="button" role="checkbox" aria-checked={on} disabled={off} className={`exp-format exp-sound${on ? ' on' : ''}`} onClick={() => toggle(s)} title={off ? 'This FFmpeg has no MP3 encoder (libmp3lame)' : undefined}>
                      <span className="exp-box" aria-hidden="true">
                        <Tick />
                      </span>
                      <span className="exp-format-text">
                        <span className="exp-format-name">
                          {name} <span>· {spec}</span>
                        </span>
                        <span className="exp-sub">{off ? 'No MP3 encoder in this FFmpeg' : use}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className={`exp-group${chosen.length ? '' : ' exp-dim'}`}>
              <div className="exp-title-row">
                <h2>Quality</h2>
                {!chosen.length && <span className="exp-sub-12">For video files</span>}
              </div>
              <div className="exp-qualities" role="group" aria-label="Quality">
                {QUALITY.map(([q, name, sub]) => (
                  <button key={q} type="button" className={q === quality ? 'on' : ''} aria-pressed={q === quality} onClick={() => setQuality(q)}>
                    <span className="exp-q-name">{name}</span>
                    <span className="exp-sub">{q !== 'best' && !caps?.nvenc ? 'No graphics card encoder here: software.' : sub}</span>
                  </button>
                ))}
              </div>
              <div className="exp-setting">
                <span>Codec</span>
                <span className="exp-value">{quality === 'best' || !caps?.nvenc ? 'H.264 · x264' + (quality === 'best' ? ', slow preset' : '') : 'H.264 · works everywhere'}</span>
              </div>
              <div className="exp-setting">
                <span>Encoder</span>
                <span className="exp-value">{gpu ? 'Graphics card · automatic' : 'Software (CPU)'}</span>
              </div>
              <label className="exp-setting">
                <span>Bitrate</span>
                <span className="exp-select">
                  <select value={mbps} onChange={(e) => setBitrates({ ...bitrates, [quality]: Number(e.target.value) })}>
                    {BITRATES.map((b) => (
                      <option key={b} value={b}>
                        About {b} Mbps
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </span>
              </label>
              <label className="exp-setting">
                <span>Frame rate</span>
                <span className="exp-select">
                  <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                    <option value={0}>{project?.fps ?? 30} fps, same as the project</option>
                    {[24, 25, 30, 60]
                      .filter((r) => r !== project?.fps)
                      .map((r) => (
                        <option key={r} value={r}>
                          {r} fps
                        </option>
                      ))}
                  </select>
                  <Chevron />
                </span>
              </label>
              <div className="exp-setting">
                <span>Audio</span>
                <span className="exp-value">AAC {AUDIO_KBPS} kbps · −14 LUFS</span>
              </div>
              <div className="exp-setting">
                <span>Captions</span>
                <div className="seg-pill" role="group" aria-label="Captions" title={hasCaptions ? undefined : 'No captions in this edit yet (Library › Captions)'}>
                  {['Burned in', '.srt file', 'Both'].map((c) => (
                    <button key={c} type="button" className={c === captions ? 'on' : ''} aria-pressed={c === captions} onClick={() => setCaptions(c)} disabled={!hasCaptions}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="exp-col exp-files" aria-label="Files">
            <h2>Files</h2>
            <div className="exp-file-grid">
              <span className="exp-label">Folder</span>
              <button type="button" className="exp-select-button" onClick={choose} title={folder}>
                <span>{folder ? shortPath(folder, paths?.videos) : 'Choose a folder'}</span>
                <Chevron />
              </button>
              <span className="exp-label">Name</span>
              <input ref={nameRef} className="exp-name" value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false} aria-label="File name" />
            </div>
            <div className="exp-tokens">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insert(t)} title={t === '{language}' ? 'Your system language' : t === '{version}' ? 'The first number not already used in the folder' : undefined}>
                  {t}
                </button>
              ))}
            </div>
            <div className="exp-file-list">
              {stems.map(([f, stem]) => (
                <div key={f} className="exp-file">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#A3A3AB" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={soundOf(f) ? 'M2 6.5v3 M5 4v8 M8 2v12 M11 5v6 M14 7v2' : 'M2 4h9v8H2z M11 7l3-2v6l-3-2'} />
                  </svg>
                  <span className="exp-file-name">
                    {stem}.{extOf(f)}
                  </span>
                  <span className="exp-file-size">about {Math.max(1, Math.round(sizeOf(f)))} MB</span>
                </div>
              ))}
            </div>
            <div className="exp-text">
              <span className="exp-label">Text</span>
              <div className="seg-pill" role="group" aria-label="Text to save">
                {(
                  [
                    ['both', 'All'],
                    ['screen', 'On screen'],
                    ['said', 'What she says'],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" className={k === textWhat ? 'on' : ''} aria-pressed={k === textWhat} onClick={() => setTextWhat(k)}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="exp-text-row">
              <button type="button" className="exp-secondary" onClick={() => void saveText('txt')} disabled={!folder || empty || !!savingText} title="Each text on its own line, no times">
                {savingText === 'txt' ? 'Saving…' : 'Save .txt'}
              </button>
              <button type="button" className="exp-secondary" onClick={() => void saveText('srt')} disabled={!folder || empty || !!savingText} title="Each text with when it shows">
                {savingText === 'srt' ? 'Saving…' : 'Save .srt'}
              </button>
              </div>
              <span className="exp-text-note">Saved next to the video, named like it. The .txt has no times.</span>
            </div>
            <div className="exp-setting">
              <span>When done</span>
              <div className="seg-pill" role="group" aria-label="When done">
                {['Open folder', 'Do nothing'].map((a) => (
                  <button key={a} type="button" className={a === after ? 'on' : ''} aria-pressed={a === after} onClick={() => setAfter(a)}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="exp-link"
              onClick={() => {
                remember()
                toast('Saved: every export starts from these settings')
              }}
            >
              Save these settings as a preset
            </button>
            {running.length > 0 && (
              <ul className="jobs">
                {running.map((j) => (
                  <li key={j.jobId} className={`job state-${j.state}`}>
                    <div className="job-line">
                      <span className="job-name" title={j.path}>
                        {basename(j.path)}
                      </span>
                      <span className="job-status">
                        {j.state === 'queued' && 'Waiting'}
                        {j.state === 'running' && `${Math.round(j.fraction * 100)} %`}
                        {j.state === 'done' && `${bytes(j.bytes ?? 0)} in ${(j.seconds ?? 0).toFixed(1)} s`}
                        {j.state === 'failed' && 'Failed'}
                      </span>
                      {(j.state === 'queued' || j.state === 'running') && (
                        <button type="button" className="link-button" onClick={() => call('export.cancel', { jobId: j.jobId })}>
                          Cancel
                        </button>
                      )}
                      {j.state === 'done' && (
                        <button type="button" className="link-button" onClick={() => window.studio.app.showItem(j.path)}>
                          Show
                        </button>
                      )}
                    </div>
                    <div className="job-bar">
                      <span style={{ width: `${Math.round(j.fraction * 100)}%` }} />
                    </div>
                    {j.error && <p className="error">{j.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="exp-foot">
          <span className="exp-summary">
            {empty ? 'The timeline is empty.' : `${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} · about ${Math.max(1, Math.round(totalMb))} MB in total`}
          </span>
          <button type="button" className="exp-secondary" onClick={() => go(false)} disabled={busy || empty || !outputs.length || !folder}>
            Add to queue
          </button>
          <button type="button" className="exp-primary button primary" onClick={() => go(true)} disabled={busy || empty || !outputs.length || !folder}>
            {outputs.length ? `Export ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'}` : 'Pick a format'}
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}

const FORMAT_OF: Record<string, string> = Object.fromEntries(FORMATS.map(([f, w, h]) => [`${w}x${h}`, f]))
const clockOf = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`)

/**
 * The Export window while its files are made: the first frame with how far along it all is,
 * each file with its bar, percentage and time left, then Done with what was made, until closed.
 */
function ExportProgress({ jobs, snap, atUs, folder, frame, onClose }: { jobs: ExportJob[]; snap: Snapshot | null; atUs: Us; folder: string; frame: { width: number; height: number }; onClose: () => void }) {
  const [now, setNow] = useState(Date.now())
  const working = jobs.some((j) => j.state === 'queued' || j.state === 'running')
  useEffect(() => {
    if (!working) return
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [working])
  const live = jobs.filter((j) => j.state !== 'cancelled')
  const overall = live.length ? live.reduce((n, j) => n + (j.state === 'done' ? 1 : j.fraction), 0) / live.length : 1
  // Time left on them all: the one exporting by its own pace; the ones waiting about as long as it takes in all.
  const running = live.find((j) => j.state === 'running')
  const runLeft = running ? exportTimeLeft(running, now) : null
  const perFile = running && runLeft != null && running.rateFrom ? (now - (running.startedAt ?? running.rateFrom.at)) / 1000 + runLeft : (live.find((j) => j.state === 'done')?.seconds ?? null)
  const waiting = live.filter((j) => j.state === 'queued').length
  const left = !working ? 0 : runLeft != null ? runLeft + waiting * (perFile ?? 0) : waiting && !running && perFile != null ? waiting * perFile : null
  const done = live.filter((j) => j.state === 'done')
  const total = done.reduce((n, j) => n + (j.bytes ?? 0), 0)
  const took = done.reduce((n, j) => n + (j.seconds ?? 0), 0)
  const failed = live.filter((j) => j.state === 'failed')
  return (
    <>
      <div className="exp-body exp-progress">
        <section className="exp-col exp-preview" aria-label="Export progress">
          <div className="exp-frame exp-frame-progress" style={frame}>
            <FirstFrame snap={snap} atUs={atUs} />
            <span className={`exp-pct${working ? '' : ' done'}`} aria-live="polite">
              {working ? `${Math.floor(overall * 100)} %` : failed.length ? 'Failed' : 'Done'}
            </span>
          </div>
        </section>
        <section className="exp-col exp-main" aria-label="Files">
          <h2>{working ? 'Exporting…' : failed.length ? `${done.length} of ${live.length} made` : `${done.length === 1 ? 'One file' : `${done.length} files`} made`}</h2>
          <p className="exp-left">
            {working
              ? left != null
                ? `About ${clockOf(left)} left`
                : running && running.fraction === 0
                  ? 'Getting the sound ready…'
                  : 'Working out the time left…'
              : done.length
                ? `${bytes(total)} in ${took.toFixed(1)} s`
                : 'Nothing was made.'}
          </p>
          <ul className="jobs exp-jobs">
            {jobs.map((j) => {
              const jl = exportTimeLeft(j, now)
              return (
                <li key={j.jobId} className={`job state-${j.state}`}>
                  <div className="job-line">
                    <span className="job-name" title={j.path}>
                      {basename(j.path)}
                    </span>
                    <span className="job-format">{j.sound ? `${soundOf(j.sound)?.[1] ?? j.sound.toUpperCase()} · ${soundOf(j.sound)?.[2] ?? ''}` : `${FORMAT_OF[`${j.width}x${j.height}`] ?? ''} · ${j.width}×${j.height}`}</span>
                    <span className="job-status">
                      {j.state === 'queued' && 'Waiting'}
                      {j.state === 'running' && `${Math.floor(j.fraction * 100)} %${jl != null ? ` · about ${clockOf(jl)} left` : ''}`}
                      {j.state === 'done' && `Done · ${bytes(j.bytes ?? 0)} in ${(j.seconds ?? 0).toFixed(1)} s`}
                      {j.state === 'failed' && 'Failed'}
                      {j.state === 'cancelled' && 'Cancelled'}
                    </span>
                    {(j.state === 'queued' || j.state === 'running') && (
                      <button type="button" className="link-button" onClick={() => call('export.cancel', { jobId: j.jobId })}>
                        Cancel
                      </button>
                    )}
                    {j.state === 'done' && (
                      <>
                        <button type="button" className="link-button" onClick={() => window.studio.app.showItem(j.path)}>
                          Show
                        </button>
                        <button type="button" className="link-button" onClick={() => window.studio.app.openVideo(j.path)}>
                          Play
                        </button>
                      </>
                    )}
                  </div>
                  <div className="job-bar">
                    <span style={{ width: `${Math.round((j.state === 'done' ? 1 : j.fraction) * 100)}%` }} />
                  </div>
                  {j.error && <p className="error">{j.error}</p>}
                </li>
              )
            })}
          </ul>
        </section>
      </div>
      <div className="exp-foot">
        <span className="exp-summary">{working ? 'You can close this window: the export carries on, and Export shows it again.' : `Saved in ${folder}`}</span>
        {working ? (
          <button type="button" className="exp-secondary" onClick={() => jobs.forEach((j) => (j.state === 'queued' || j.state === 'running') && call('export.cancel', { jobId: j.jobId }))}>
            Cancel export
          </button>
        ) : (
          <>
            {done[0] && (
              <button type="button" className="exp-secondary" onClick={() => window.studio.app.showItem(done[0].path)}>
                Show in folder
              </button>
            )}
            <button type="button" className="exp-primary button primary" onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </>
  )
}

const Tick = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5l3 3 7-7" />
  </svg>
)

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#8A8A93" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
)

/** ~/Videos/Studio Exports style, when the folder is under Videos' parent (home). */
function shortPath(folder: string, videos?: string) {
  if (!videos) return folder
  const home = videos.replace(/[\\/][^\\/]+$/, '')
  return folder.startsWith(home) ? `~${folder.slice(home.length).replace(/\\/g, '/')}` : folder
}

/** The export's first frame, from the filmstrip of the clip that starts it. */
function FirstFrame({ snap, atUs }: { snap: Snapshot | null; atUs: Us }) {
  const main = snap?.project.tracks.find((t) => t.main)
  const clip = main?.clips.find((c) => atUs >= c.startUs && atUs < c.startUs + c.durationUs) ?? main?.clips[0]
  const media = clip ? mediaById(snap, clip.mediaId) : undefined
  const urls = useStrip(media?.kind === 'audio' ? undefined : media)
  if (!urls?.length || !clip || !media) return null
  const src = clip.inUs + Math.max(0, atUs - clip.startUs)
  const url = urls[urls.length === 1 ? 0 : Math.min(urls.length - 1, Math.floor((src / Math.max(1, media.durationUs)) * urls.length))]
  return <img src={url} alt="First frame of the export" className={clip.flip ? 'flipped' : ''} />
}
