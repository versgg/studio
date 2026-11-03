// The Inspector's Stems tab: a clip's sound split into its parts by the stems server (AudioShake
// underneath), one row per stem as on the server's own page: its waveform (true to its level, so a
// quiet bed draws small), ▶ to hear it on its own, + to put it under the clip in sync. Ticked
// stems can replace the clip's sound ("Use only these"). Stems AudioShake left empty are
// folded away. The separation runs in the main process (src/main/stems.ts), so it carries on
// while other things are selected; this tab only shows it.

import './stems.css'
import { useEffect, useState } from 'react'
import { Icon } from './icons'
import { Buttons, Note, Sec } from './InspectorBlocks'
import { BusyBar } from './LibraryBlocks'
import { addStems, call, cancelStems, fileUrl, mediaById, previewStem, separateStems, useStore, type Clip, type Media, type Task } from './store'
import { MAX_SECONDS, MIN_SECONDS, covers, doubled, overlap, pickStems, running, separatingFraction, separatingLeft, sourceSpan, usually, type Song, type Stem, type StemsJob } from '../shared/stems'

/** "12.4 s", "1:05" */
const seconds = (us: number) => {
  const s = Math.max(0, us / 1e6)
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}
const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}
const minus = (db: number) => `${db < 0 ? '−' : ''}${Math.abs(Math.round(db))} dB`

/** Re-renders every `ms` while `on`. */
function useTick(on: boolean, ms = 1000) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), ms)
    return () => window.clearInterval(t)
  }, [on, ms])
}

export function StemsTab({ clip, media }: { clip: Clip; media?: Media }) {
  const jobs = useStore((s) => s.stemsJobs)
  const { job, failed } = pickStems(clip, Object.values(jobs))
  if (job && running(job)) return <Running job={job} />
  if (job?.state === 'done' && job.stems) return <Done key={job.dir} clip={clip} job={job} failed={failed} />
  return <Start clip={clip} media={media} failed={failed} />
}

/** Before: what it does, how long it takes, and the one action. */
function Start({ clip, media, failed }: { clip: Clip; media?: Media; failed?: StemsJob }) {
  const span = sourceSpan(clip)
  const secs = (span.to - span.from) / 1e6
  const why = !media
    ? 'The clip’s file is missing.'
    : !(media.kind === 'audio' || media.hasAudio)
      ? 'This clip has no sound.'
      : media.missing
        ? `${media.name} is missing, so its sound can’t be sent.`
        : clip.speedCurve
          ? 'A clip with a speed curve plays silent, so it has no sound to split. Take the curve off first.'
          : secs > MAX_SECONDS
            ? `The server separates up to ${MAX_SECONDS / 60} minutes of sound, and the clip plays ${seconds(span.to - span.from)}. Trim it first.`
            : secs < MIN_SECONDS
              ? 'The clip is too short to separate.'
              : null
  return (
    <>
      <Sec first title="Stems" />
      <Note>
        Splits the clip’s sound into its parts (vocals, instrumental, drums, bass and more) with AudioShake, on the stems server. Only the {seconds(span.to - span.from)} it plays is sent, and it usually takes {usually(secs)}.
      </Note>
      {failed && (
        <div className="stems-error" role="alert">
          {failed.reason}
        </div>
      )}
      {why && <Note>{why}</Note>}
      <div className="actions insp-buttons">
        <button type="button" className="button primary stems-go" disabled={!!why} onClick={() => separateStems(clip.id)}>
          {failed ? 'Try again' : 'Separate into stems'}
        </button>
      </div>
    </>
  )
}

/** While it runs: what the server is doing, how far, how long so far and what's left. */
function Running({ job }: { job: StemsJob }) {
  useTick(true)
  const separating = job.state === 'separating' && !!job.sentAt && !!job.expectedMs
  const fraction = separating ? separatingFraction(Date.now() - job.sentAt!, job.expectedMs!, job.fraction) : job.fraction
  const left = separating ? ` · ${separatingLeft(Date.now() - job.sentAt!, job.expectedMs!)}` : ''
  return (
    <>
      <Sec first title="Stems" />
      <div className="insp-busy stems-busy" role="status">
        <span className="busy-spin" aria-hidden="true" />
        <span className="stems-stage">
          {job.stage}… {Math.round(fraction * 100)} %
        </span>
        <BusyBar task={{ fraction, waiting: job.state === 'waiting' } as Task} />
      </div>
      <Note>
        {seconds((Date.now() - job.startedAt) * 1000)} so far{left}. It carries on while you work, and picks up again if Studio closes; the stems land here and in the project’s stems folder.
      </Note>
      <Buttons items={[{ label: 'Stop', onClick: () => cancelStems(job.dir) }]} />
    </>
  )
}

const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * The song (or songs) in the sound, as the server's read named them: Shazam's match with its cover,
 * where in the clip it was heard and where that is in the recording, and the server's warning when
 * only an instrumental stretch plays. None found says so.
 */
function Songs({ songs, clip }: { songs: Song[]; clip: Clip }) {
  return (
    <>
      <Sec first title={songs.length > 1 ? 'Songs' : 'Song'} />
      {!songs.length && <Note>Shazam didn’t recognise a song in this sound.</Note>}
      {songs.map((s, i) => (
        <div key={i} className="stems-song">
          {s.cover ? <img src={fileUrl(s.cover)} alt="" className="stems-cover" /> : <span className="stems-cover blank" aria-hidden="true" />}
          <div className="stems-song-text">
            <strong title={s.title}>{s.title}</strong>
            {s.artist && <span title={s.artist}>{s.artist}</span>}
            <small>
              {[s.album, s.released, s.genre].filter(Boolean).join(' · ')}
              {s.fromLyrics ? 'Named from its lyrics; Shazam found no match' : ''}
            </small>
            {s.heardAt != null && (
              <small>
                Heard {clockOf(s.heardAt / (clip.speed ?? 1))} into the clip{s.trackAt ? `, ${clockOf(s.trackAt)} into the song` : ''}
              </small>
            )}
            {s.note && <small className="stems-song-note">{s.note}</small>}
          </div>
          {s.url && (
            <button type="button" className="stems-link" onClick={() => window.studio.app.openExternal(s.url!)}>
              Open in Shazam
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/** Done: a row per stem with sound, the silent ones folded away, and what to do with the ticked ones. */
function Done({ clip, job, failed }: { clip: Clip; job: StemsJob; failed?: StemsJob }) {
  const [picked, setPicked] = useState<string[]>([])
  const [showSilent, setShowSilent] = useState(false)
  const source = useStore((s) => s.source)
  const sourcePath = useStore((s) => (s.source ? mediaById(s.snap, s.source.mediaId)?.path : undefined))
  const stems = job.stems ?? []
  const heard = stems.filter((s) => !s.silent)
  const silent = stems.filter((s) => s.silent)
  const same = (p: string) => !!sourcePath && sourcePath.replace(/\\/g, '/').toLowerCase() === p.replace(/\\/g, '/').toLowerCase()
  const pick = (name: string, on: boolean) => setPicked((x) => (on ? [...x.filter((n) => n !== name), name] : x.filter((n) => n !== name)))
  // In the service's order, whatever order they were ticked in.
  const chosen = stems.filter((s) => picked.includes(s.name)).map((s) => s.name)
  const twice = doubled(chosen)
  const span = sourceSpan(clip)
  const row = (s: Stem) => {
    const playing = same(s.path) && !!source
    return (
      <StemRow
        key={s.name}
        stem={s}
        picked={picked.includes(s.name)}
        onPick={(on) => pick(s.name, on)}
        playing={playing && !!source?.playing}
        at={playing && s.durationUs ? source!.positionUs / s.durationUs : null}
        onPlay={() => previewStem(s.path)}
        onAdd={() => addStems(clip.id, job, [s.name], false)}
      />
    )
  }
  return (
    <>
      {job.songs && <Songs songs={job.songs} clip={clip} />}
      <div className="stems-head">
        <Sec first={!job.songs} title="Stems" />
        <span className="stems-meta">
          {heard.length} with sound · AudioShake
        </span>
      </div>
      {clip.detached && (
        <div className="stems-off" role="status">
          <span>The clip’s own sound is off: its stems play instead.</span>
          <button type="button" className="stems-link" onClick={() => call('clip.set', { clipId: clip.id, detached: false, label: 'Restore sound' })}>
            Restore its sound
          </button>
        </div>
      )}
      {!covers(clip, job) && (
        <Note>
          These stems cover {seconds(overlap(clip, job))} of the {seconds(span.to - span.from)} the clip plays now (it was made longer since). Separate it again to cover all of it.
        </Note>
      )}
      {failed && (
        <div className="stems-error" role="alert">
          The last try failed: {failed.reason}
        </div>
      )}
      {/* What to do with the ticked ones, above the rows as on the server's page (no scrolling to it). */}
      <div className="stems-bar">
        <span className="stems-picked">{chosen.length ? `${chosen.length} ticked: ${stems.filter((s) => chosen.includes(s.name)).map((s) => s.label).join(', ')}` : 'Tick the parts to keep.'}</span>
        <div className="actions insp-buttons">
          <button type="button" className="button primary stems-only" disabled={!chosen.length} onClick={() => addStems(clip.id, job, chosen, true)} title="Turns the clip’s own sound off and puts the ticked stems under it, in sync">
            Use only these{chosen.length ? ` (${chosen.length})` : ''}
          </button>
          <button type="button" className="button stems-add" disabled={!chosen.length} onClick={() => addStems(clip.id, job, chosen, false)} title="Puts the ticked stems under the clip, in sync, and keeps its own sound">
            Add to timeline
          </button>
        </div>
      </div>
      {twice.length > 0 && <Note>{twice.join('. ')}: that part would play twice.</Note>}
      <div className="stems-list" role="list" aria-label="Stems">
        {heard.map(row)}
        {!heard.length && <Note>AudioShake found no separate parts with sound in this clip.</Note>}
        {silent.length > 0 && (
          <button type="button" className="stems-silent" aria-expanded={showSilent} onClick={() => setShowSilent(!showSilent)}>
            {showSilent ? 'Hide' : 'Show'} {silent.length} silent: {silent.map((s) => s.label).join(', ')}
          </button>
        )}
        {showSilent && silent.map(row)}
      </div>
      <Note>“Use only these” turns the clip’s own sound off and puts the ticked stems under it, in sync, each on its own track; + adds one and keeps the clip’s sound. Ctrl+Z goes back.</Note>
      <div className="stems-foot">
        <span>Separated {ago(job.finishedAt ?? job.startedAt)}</span>
        <button type="button" className="stems-link" onClick={() => window.studio.app.showItem(stems[0]?.path ?? job.dir)}>
          Show the files
        </button>
        <button type="button" className="stems-link stems-again" onClick={() => separateStems(clip.id)}>
          Separate again
        </button>
      </div>
    </>
  )
}

function StemRow({ stem, picked, onPick, playing, at, onPlay, onAdd }: { stem: Stem; picked: boolean; onPick: (on: boolean) => void; playing: boolean; at: number | null; onPlay: () => void; onAdd: () => void }) {
  return (
    <div role="listitem" className={`stem-row${picked ? ' picked' : ''}${stem.silent ? ' silent' : ''}${playing ? ' playing' : ''}`} data-stem={stem.name}>
      {/* A button, not an input: shortcuts (Ctrl+Z…) still work after ticking one. */}
      <button type="button" role="checkbox" aria-checked={picked} className="stem-pick" onClick={() => onPick(!picked)}>
        <span className="stem-box" aria-hidden="true" />
        <span className="stem-name">{stem.label}</span>
      </button>
      <span className="stem-level" title="Its loudest moment">
        {stem.silent ? 'silent' : minus(stem.levelDb)}
      </span>
      <button type="button" className={`stem-btn stem-play${playing ? ' on' : ''}`} aria-label={`${playing ? 'Pause' : 'Play'} ${stem.label}`} title={playing ? 'Pause' : 'Play it on its own'} onClick={onPlay}>
        <Icon name={playing ? 'pause' : 'play'} size={12} filled={!playing} />
      </button>
      <button type="button" className="stem-btn stem-add" aria-label={`Add ${stem.label} to the timeline`} title="Add to the timeline under the clip, in sync" onClick={onAdd}>
        <Icon name="plus" size={12} />
      </button>
      <Wave peaks={stem.peaks} at={at} />
    </div>
  )
}

/** A stem's waveform on a level scale (−54 dB to full), mirrored, with the preview's place. */
function Wave({ peaks, at }: { peaks: number[]; at: number | null }) {
  const n = Math.max(1, peaks.length)
  const h = (p: number) => (p > 0 ? Math.max(0, (20 * Math.log10(p) + 54) / 54) * 13 : 0)
  let d = 'M0 14'
  peaks.forEach((p, i) => (d += `L${(i + 0.5).toFixed(1)} ${(14 - h(p)).toFixed(2)}`))
  d += `L${n} 14`
  for (let i = peaks.length - 1; i >= 0; i--) d += `L${(i + 0.5).toFixed(1)} ${(14 + h(peaks[i])).toFixed(2)}`
  d += 'Z'
  return (
    <svg className="stem-wave" viewBox={`0 0 ${n} 28`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
      {at != null && <line x1={at * n} x2={at * n} y1={0} y2={28} />}
    </svg>
  )
}
