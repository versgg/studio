// The library's Audio tab, as on the Library board: Music (the project's own audio and the
// user's own music folder), Sound effects (a built-in set made with FFmpeg), Voice (recording
// your voice and ElevenLabs voiceovers) and From video (pulling a clip's sound onto its own
// track). Plus the voice picker and the voice-clone dialogs.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { DesignRound, Voice } from '../shared/api'
import { chooseVoice, cloneVoice, designVoices, forgetElevenKey, generateVoiceover, keepDesignedVoice, loadEleven, saveElevenKey, startRecording, useKeyCheck, VOICE_GROUPS, type Recorder } from './audio'
import { Chips, Pills, Select, SelectButton, Stepper, Toggle } from './controls'
import { DIcon, LIB_ICONS } from './design-icons'
import { Icon } from './icons'
import { libraryMenu, openMenu } from './ContextMenu'
import { Actions, AddButton, Head, KeyField, Note, Row, Rows, SearchBox, Setting, Settings, mss, startMediaDrag } from './LibraryBlocks'
import { ElevenKeyHelp } from './ElevenKeyHelp'
import { addSound, loadEffects, loadMusic, pickMusicFolder, previewSound, useSounds } from './soundLibrary'
import { call, getState, importPaths, mediaById, previewMedia, setState, toast, useRunningTask, useStore, type Media } from './store'
import { getUi, setUi, useUi } from './ui-state'
import './audio-panel.css'

const LANGUAGES: [string, string][] = [
  ['', 'Detect from the text'],
  ['en', 'English'],
  ['sv', 'Swedish'],
  ['no', 'Norwegian'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['de', 'German'],
]
const SETTINGS_KEY = 'studio.voiceover.v1'
/** ElevenLabs' voice_settings.speed range (checked 2026-10-27). */
const SPEED_MIN = 0.7
const SPEED_MAX = 1.2

interface Saved {
  modelId?: string
  stability?: number
  similarity?: number
  language?: string
  atPlayhead?: boolean
  alongTimeline?: boolean
  mic?: string
  countIn?: string
  monitor?: boolean
  speed?: number
}
function loadSettings(): Saved {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function saveSettings(patch: Saved) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }))
  } catch {}
}

/** One shared player for voice previews: a second click stops it. Tests (STUDIO_SILENT) stay silent. */
const preview = { audio: null as HTMLAudioElement | null, url: '' }
export function playPreview(url: string | null) {
  preview.audio?.pause()
  if (!url || preview.url === url) {
    preview.url = ''
    return
  }
  preview.audio = new Audio(url)
  preview.audio.muted = window.studio.silent
  preview.url = url
  preview.audio.onended = () => (preview.url = '')
  preview.audio.play().catch(() => toast('Couldn’t play that preview.', 'error'))
}

const SUBS = ['Music', 'Sound effects', 'Voice', 'From video']

export function AudioPanel() {
  const eleven = useStore((s) => s.eleven)
  const [sub, setSub] = useUi('lib.audioSub', 'Music')
  const [dropping, setDropping] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (eleven.hasKey === null) loadEleven()
  }, [])
  // Sound files dropped here are imported, as on the Media tab.
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    setDropping(false)
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    importPaths([...e.dataTransfer.files].map((f) => window.studio.app.pathForFile(f)).filter(Boolean))
  }
  return (
    <div ref={ref} className={`bin audio-panel${dropping ? ' dropping' : ''}`} onDragOver={onDragOver} onDragLeave={(e) => !ref.current?.contains(e.relatedTarget as Node | null) && setDropping(false)} onDrop={onDrop}>
      <div className="lib-scroll">
        <Pills variant="sub" label="Audio source" items={SUBS} value={sub} onPick={setSub} />
        {sub === 'Music' ? <MusicTab /> : sub === 'Sound effects' ? <EffectsTab /> : sub === 'Voice' ? <VoiceTab /> : <FromVideoTab />}
      </div>
    </div>
  )
}

// Music

const VOICE_PATH = /[\\/](recordings|voiceovers)[\\/]/
/** Rows shown at once (search narrows a big folder). */
const MAX_ROWS = 150

function MusicTab() {
  const [query, setQuery] = useUi('lib.music.query', '')
  const [folder, setFolder] = useUi('lib.musicSub', 'All')
  const music = useSounds((x) => x.music)
  const scanning = useSounds((x) => x.scanning)
  const error = useSounds((x) => x.musicError)
  const where = useSounds((x) => x.musicFolder)
  const playing = useSounds((x) => x.playing)
  const realBars = useSounds((x) => x.bars)
  const hasProject = useStore((s) => !!s.snap)
  useEffect(() => {
    loadMusic()
  }, [])
  const q = query.trim().toLowerCase()
  // Chips are the music folder's own subfolders (only when there are some).
  const folders = [...new Set((music ?? []).map((m) => m.kind).filter(Boolean))]
  const chip = folders.includes(folder) ? folder : 'All'
  const found = (music ?? []).filter((m) => (chip === 'All' || m.kind === chip) && (!q || m.name.toLowerCase().includes(q) || m.kind.toLowerCase().includes(q)))
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Search music" />
      <Head text="In this project" />
      <ProjectAudio query={q} />
      <Head
        text="Your music"
        right={
          <button type="button" className="lib-link" onClick={pickMusicFolder} title={where ?? undefined}>
            Change folder
          </button>
        }
      />
      {where && (
        <p className="lib-note mono" title={where}>
          {where}
        </p>
      )}
      {folders.length > 0 && <Chips items={['All', ...folders]} value={chip} onPick={setFolder} />}
      {error ? (
        <p className="lib-note error">{error}</p>
      ) : music === null || (scanning && !music.length) ? (
        <Note>Looking through your music folder…</Note>
      ) : !music.length ? (
        <Note>No music files in this folder. Pick the folder you keep music in (MP3, WAV, M4A, FLAC, OGG).</Note>
      ) : !found.length ? (
        <Note>Nothing matches that.</Note>
      ) : (
        <Rows>
          {found.slice(0, MAX_ROWS).map((m) => (
            <Row
              key={m.path}
              name={m.name}
              sub={m.kind || 'Music folder'}
              dur={m.durationUs ? mss(m.durationUs) : ''}
              title={m.path}
              onPlay={() => previewSound(m)}
              playing={playing === m.path}
              wave={realBars[m.path]}
              onAdd={hasProject ? () => addSound(m, 'music') : undefined}
            />
          ))}
        </Rows>
      )}
      {found.length > MAX_ROWS && (
        <Note>
          Showing {MAX_ROWS} of {found.length}. Search to narrow it down.
        </Note>
      )}
    </>
  )
}

/** The project's own voice and music files, with everything the media tiles can do. */
function ProjectAudio({ query }: { query: string }) {
  const media = useStore((s) => s.snap?.project.media)
  const tracks = useStore((s) => s.snap?.project.tracks)
  const picked = useStore((s) => s.libraryPicked)
  const used = useMemo(() => new Set((tracks ?? []).flatMap((t) => t.clips.map((c) => c.mediaId))), [tracks])
  const items = (media ?? []).filter((m) => m.kind === 'audio' && (!query || m.name.toLowerCase().includes(query)))
  if (!items.length) return <Note>{query ? 'No sound here by that name.' : 'No voice or music in the project yet. Record one under Voice, or drop sound files here.'}</Note>
  const pick = (m: Media, e: React.MouseEvent) => {
    setState({ focus: 'library', libraryPicked: e.ctrlKey || e.metaKey ? (picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id]) : [m.id] })
    if (!(e.ctrlKey || e.metaKey) && !m.missing) previewMedia(m.id, 0)
  }
  return (
    <Rows>
      {items.map((m) => {
        const voice = VOICE_PATH.test(m.path)
        const drag = picked.includes(m.id) ? items.filter((x) => picked.includes(x.id) && !x.missing) : [m]
        return (
          <Row
            key={m.id}
            className="audio-row"
            dot={voice ? '#66A3FF' : '#34B494'}
            name={m.name.replace(/\.[^.]+$/, '')}
            sub={m.missing ? 'Missing on disk' : `${voice ? 'Voice' : 'Music'} track${used.has(m.id) ? '' : ' · not on the timeline yet'}`}
            dur={mss(m.durationUs)}
            active={picked.includes(m.id)}
            title={`${m.name}\nClick to hear it in the player. Double-click or drag to add it to the timeline.`}
            onClick={(e) => pick(m, e)}
            onDoubleClick={() => !m.missing && call('timeline.insert', { mediaId: m.id, atUs: getState().positionUs })}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!picked.includes(m.id)) setState({ libraryPicked: [m.id] })
              openMenu(e.clientX, e.clientY, libraryMenu())
            }}
            draggable={!m.missing}
            onDragStart={(e) => startMediaDrag(e, drag)}
          />
        )
      })}
    </Rows>
  )
}

// Sound effects

function EffectsTab() {
  const [query, setQuery] = useUi('lib.sfx.query', '')
  const [kind, setKind] = useUi('lib.sfx', 'All')
  const effects = useSounds((x) => x.effects)
  const error = useSounds((x) => x.effectsError)
  const playing = useSounds((x) => x.playing)
  const hasProject = useStore((s) => !!s.snap)
  useEffect(() => {
    loadEffects()
  }, [])
  const q = query.trim().toLowerCase()
  const kinds = [...new Set((effects ?? []).map((f) => f.kind))]
  const shown = (effects ?? []).filter((f) => (kind === 'All' || f.kind === kind) && (!q || f.name.toLowerCase().includes(q) || f.kind.toLowerCase().includes(q)))
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Search sound effects" />
      <Chips items={['All', ...kinds]} value={kinds.includes(kind) ? kind : 'All'} onPick={setKind} />
      {error ? (
        <p className="lib-note error">The sound effects couldn’t be made: {error}</p>
      ) : effects === null ? (
        <Note>Making the sound effects (the first time only)…</Note>
      ) : (
        <Rows>
          {shown.map((f) => (
            <Row key={f.id} name={f.name} sub={f.kind} dur={`${(f.durationUs / 1e6).toFixed(1)} s`} onPlay={() => previewSound(f)} playing={playing === f.path} wave={f.bars} onAdd={hasProject ? () => addSound(f, 'effect') : undefined} />
          ))}
        </Rows>
      )}
      <Note>Made by Studio, free to use anywhere. Added sounds are copied into the project.</Note>
    </>
  )
}

// Voice: recording

// The recorder lives here rather than in the component, so switching tabs mid-take
// doesn't lose it.
let countTimer = 0
let stopMonitor: (() => void) | null = null

async function startMonitor(deviceId: string | undefined) {
  stopMonitor?.()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    ctx.createMediaStreamSource(stream).connect(ctx.destination)
    stopMonitor = () => {
      stream.getTracks().forEach((t) => t.stop())
      ctx.close()
      stopMonitor = null
    }
  } catch (e) {
    toast(`Couldn’t play the microphone back: ${(e as Error).message}`, 'error')
  }
}

function RecordSection() {
  const saved = useMemo(loadSettings, [])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [mic, setMic] = useState(saved.mic ?? '')
  const [along, setAlong] = useState(saved.alongTimeline ?? true)
  const [countIn, setCountIn] = useState(saved.countIn ?? '3 s')
  const [monitor, setMonitor] = useState(saved.monitor ?? false)
  const [rec, setRec] = useUi<Recorder | null>('lib.rec', null)
  const [saving, setSaving] = useUi('lib.recSaving', false)
  const [counting, setCounting] = useUi<number | null>('lib.recCount', null)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const raf = useRef(0)
  const hasProject = useStore((s) => !!s.snap)

  useEffect(() => {
    const list = () => navigator.mediaDevices?.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput')))
    list()
    navigator.mediaDevices?.addEventListener('devicechange', list)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', list)
  }, [])
  useEffect(() => saveSettings({ mic, alongTimeline: along, countIn, monitor }), [mic, along, countIn, monitor])
  useEffect(() => {
    if (!rec) return
    const tick = () => {
      setLevel(rec.level())
      setElapsed(performance.now() - rec.startedAt)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [rec])

  const begin = async () => {
    try {
      const r = await startRecording(mic || undefined, along, () => setUi('lib.recSaving', false))
      setUi('lib.rec', r)
      if (getUi('lib.monitor', monitor)) startMonitor(mic || undefined)
      // Device names only show once the microphone has been allowed.
      navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput')))
    } catch (e) {
      toast(`Couldn’t open the microphone: ${(e as Error).message}. On Windows, check Settings › Privacy › Microphone.`, 'error')
    }
  }
  const stop = () => {
    rec?.stop()
    stopMonitor?.()
    setRec(null)
    setSaving(true)
    setLevel(0)
  }
  const click = () => {
    if (rec) return stop()
    // A second click during the count-in calls it off.
    if (counting != null) {
      clearInterval(countTimer)
      return setCounting(null)
    }
    let left = parseInt(countIn) || 0
    if (!left) return void begin()
    setCounting(left)
    countTimer = window.setInterval(() => {
      left--
      if (left > 0) return setUi('lib.recCount', left)
      clearInterval(countTimer)
      setUi('lib.recCount', null)
      begin()
    }, 1000)
  }
  const toggleMonitor = (on: boolean) => {
    setMonitor(on)
    setUi('lib.monitor', on)
    if (!rec) return
    if (on) startMonitor(mic || undefined)
    else stopMonitor?.()
  }

  const secs = Math.floor(elapsed / 1000)
  const options: [string, string][] = [['', 'The system default'], ...mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m) => [m.deviceId, m.label || 'Microphone'] as [string, string])]
  return (
    <section className="audio-card">
      <AddButton
        className={`record-button${rec ? ' on' : ''}`}
        disabled={!hasProject || saving}
        onClick={click}
        icon={rec ? LIB_ICONS.stop : LIB_ICONS.mic}
        color={rec ? '#FF6B4A' : '#66A3FF'}
        title={rec ? `Recording · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : counting != null ? `Starting in ${counting}…` : saving ? 'Saving the recording…' : 'Record a voiceover'}
        sub={rec ? 'Click to stop. It lands on its own track.' : counting != null ? 'Click to call it off' : 'Starts at the playhead, on its own track'}
        side={
          rec && (
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${Math.round(Math.sqrt(level) * 100)}%` }} className={level > 0.95 ? 'clip' : ''} />
            </span>
          )
        }
      />
      <Settings>
        <Setting label="Microphone">
          <Select label="Microphone" value={mic} options={options} onChange={setMic} disabled={!!rec} />
        </Setting>
        <Setting label="Count-in">
          <Pills variant="seg" label="Count-in" items={['Off', '3 s', '5 s']} value={countIn} onPick={setCountIn} />
        </Setting>
        <Setting label="Hear yourself">
          <Toggle label="Hear yourself (use headphones)" on={monitor} onChange={toggleMonitor} />
        </Setting>
        <Setting label="Play the edit">
          <Toggle label="Play the timeline while I record (use headphones)" on={along} onChange={setAlong} disabled={!!rec} />
        </Setting>
      </Settings>
    </section>
  )
}

// Voice: ElevenLabs

/** Under a working key: what it couldn't do (a permission it lacks) and the save-time check. */
export function KeyLines({ error }: { error?: string }) {
  const check = useKeyCheck('elevenlabs')
  return (
    <>
      {check && !check.ok && <p className="lib-note error">{check.text}</p>}
      {error && error !== check?.text && <p className="lib-note error">{error}</p>}
      {(error || (check && !check.ok)) && <ElevenKeyHelp />}
    </>
  )
}

function ElevenKey() {
  const error = useStore((s) => s.eleven.error)
  const check = useKeyCheck('elevenlabs')
  return <KeyField label="ElevenLabs key" note="Studio keeps it encrypted on this computer; voiceovers use your ElevenLabs credits." error={error} check={check} onSave={saveElevenKey} help={<ElevenKeyHelp open />} />
}

function VoiceoverSection() {
  const eleven = useStore((s) => s.eleven)
  const voice = useStore((s) => s.voice)
  const saved = useMemo(loadSettings, [])
  const [text, setText] = useUi('lib.script', '')
  const [modelId, setModelId] = useState(saved.modelId ?? 'eleven_v4')
  const [stability, setStability] = useState(saved.stability ?? 0.5)
  const [similarity, setSimilarity] = useState(saved.similarity ?? 0.75)
  const [language, setLanguage] = useState(saved.language ?? '')
  const [atPlayhead, setAtPlayhead] = useState(saved.atPlayhead ?? true)
  // A voiceover being made: the button shows it, and a second click can't start another.
  const making = useRunningTask('voiceover')
  const [speed, setSpeed] = useState(Math.min(SPEED_MAX, Math.max(SPEED_MIN, saved.speed ?? 1)))
  useEffect(() => saveSettings({ modelId, stability, similarity, language, atPlayhead, speed }), [modelId, stability, similarity, language, atPlayhead, speed])

  if (eleven.hasKey === false)
    return (
      <section className="audio-card">
        <ElevenKey />
      </section>
    )
  if (eleven.hasKey === null || !eleven.voices)
    return (
      <section className="audio-card">
        <Note>{eleven.error ?? 'Loading your voices…'}</Note>
      </section>
    )

  const models = eleven.models ?? []
  const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id === 'eleven_v4') ?? models[0]
  const max = model?.maxChars || 10_000
  const left = eleven.account ? eleven.account.limit - eleven.account.used : null
  const go = () => {
    if (!voice || !model || !text.trim()) return
    generateVoiceover({ voice, text: text.trim(), modelId: model.id, stability, similarity, speed, languageCode: language || undefined, atPlayhead })
  }
  const kind = voice ? (VOICE_GROUPS.find(([g]) => g === voice.category)?.[1] ?? voice.category) : ''
  return (
    <section className="audio-card">
      <Settings>
        <Setting label="Script">
          <textarea
            className="lib-textarea"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, max))}
            placeholder="What should the voice say? Tags like [whispers], [laughs] or [short pause] shape the delivery."
            spellCheck
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go()
            }}
          />
        </Setting>
        <Setting label="Voice">
          <span className="voice-row">
            <SelectButton label="Voice" value={voice ? `${voice.name}${kind ? ` · ${kind}` : ''}` : 'Choose a voice'} title="Choose a voice" onClick={() => setState({ dialog: 'voices' })} />
            <button type="button" className="lib-row-play" title="Hear this voice" aria-label="Hear this voice" disabled={!voice?.previewUrl} onClick={() => playPreview(voice?.previewUrl ?? null)}>
              <DIcon d={LIB_ICONS.play} size={9} filled />
            </button>
          </span>
        </Setting>
        <Setting label="Model">
          <Select label="Model" value={model?.id ?? ''} options={models.map((m) => [m.id, m.name] as [string, string])} onChange={setModelId} />
        </Setting>
        <Setting label="Language">
          <Select label="Language" value={language} options={LANGUAGES} onChange={setLanguage} />
        </Setting>
        <Setting label="Stability">
          <Stepper label="Stability" value={stability} onChange={setStability} min={0} max={1} step={0.05} format={(x) => `${Math.round(x * 100)} %`} />
        </Setting>
        <Setting label="Similarity">
          <Stepper label="Similarity" value={similarity} onChange={setSimilarity} min={0} max={1} step={0.05} format={(x) => `${Math.round(x * 100)} %`} />
        </Setting>
        <Setting label="Speed">
          <Stepper label="Speed" value={speed} onChange={setSpeed} min={SPEED_MIN} max={SPEED_MAX} step={0.05} format={(x) => `${x.toFixed(2)}×`} />
        </Setting>
        <Setting label="At the playhead">
          <Toggle label="Put it on the timeline at the playhead" on={atPlayhead} onChange={setAtPlayhead} />
        </Setting>
      </Settings>
      <Actions items={[{ label: 'Make voiceover', icon: LIB_ICONS.plus, primary: true, onClick: go, disabled: !voice || !text.trim(), title: 'Ctrl+Enter', busy: making ? { text: 'Making the voiceover', task: making } : undefined }]} />
      {making && <p className="lib-note">{making.stage}. It lands on its own track{atPlayhead ? ' at the playhead' : ''} when it's ready; you can keep editing.</p>}
      <p className="lib-note mono">
        {text.length.toLocaleString()} / {max.toLocaleString()} characters{left != null ? ` · ${left.toLocaleString()} credits left` : ''}
      </p>
      <KeyLines error={eleven.error} />
      <div className="lib-links">
        {eleven.account?.canClone && (
          <button type="button" className="lib-link" onClick={() => setState({ dialog: 'clone' })}>
            Clone a voice from recordings…
          </button>
        )}
        {eleven.account && (
          <button type="button" className="lib-link" onClick={() => setState({ dialog: 'design' })}>
            Design a voice…
          </button>
        )}
        <button type="button" className="lib-link" onClick={forgetElevenKey}>
          Use another API key
        </button>
      </div>
    </section>
  )
}

function VoiceTab() {
  return (
    <>
      <RecordSection />
      <Head text="Voice from a script" className="audio-heading" />
      <Note>Paste a script and pick a voice. It lands on its own track, ready to trim.</Note>
      <VoiceoverSection />
    </>
  )
}

// From video

function FromVideoTab() {
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const main = snap?.project.tracks.find((t) => t.main)
  const clips = (main?.clips ?? []).map((c) => ({ c, m: mediaById(snap, c.mediaId) })).filter((x): x is { c: typeof x.c; m: Media } => x.m?.kind === 'video')
  return (
    <>
      <Note>Pull the sound out of a clip onto its own track, so you can edit it on the Audio page.</Note>
      {clips.length ? (
        <Rows>
          {clips.map(({ c, m }) => (
            <Row
              key={c.id}
              icon={LIB_ICONS.video}
              name={m.name.replace(/\.[^.]+$/, '')}
              sub={!m.hasAudio ? 'No audio' : c.detached ? 'Sound on its own track · muted here' : c.volume === 0 ? 'Has sound · muted' : 'Has sound'}
              dur={mss(c.durationUs)}
              active={selection.includes(c.id)}
              onClick={() => setState({ selection: [c.id], focus: 'timeline' })}
              action={m.hasAudio ? (c.detached ? 'Restore' : 'Extract') : undefined}
              onAction={() => (c.detached ? call('clip.set', { clipId: c.id, detached: false }) : call('clip.extractAudio', { clipIds: [c.id] }))}
            />
          ))}
        </Rows>
      ) : (
        <Note>No video clips on the timeline yet.</Note>
      )}
    </>
  )
}

/** All the account's voices, by kind (clones first), searchable; search also looks in the public Voice Library. */
export function VoicePickerDialog({ close }: { close: () => void }) {
  const eleven = useStore((s) => s.eleven)
  const chosen = useStore((s) => s.voice)
  const [query, setQuery] = useState('')
  const [library, setLibrary] = useState<Voice[]>([])
  const [searching, setSearching] = useState(false)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (q.length < 2) return setLibrary([])
    const t = setTimeout(async () => {
      setSearching(true)
      const r = await window.studio.services.elevenLibrary(q)
      setSearching(false)
      setLibrary(Array.isArray(r) ? r : [])
    }, 400)
    return () => clearTimeout(t)
  }, [q])

  const matches = (v: Voice) => !q || [v.name, v.description, ...Object.values(v.labels)].join(' ').toLowerCase().includes(q)
  const mine = (eleven.voices ?? []).filter(matches)
  const groups = VOICE_GROUPS.map(([key, title]) => [title, key === 'library' ? library : mine.filter((v) => v.category === key)] as const)
  const known = new Set(VOICE_GROUPS.map(([k]) => k))
  const other = mine.filter((v) => !known.has(v.category))
  const all = [...groups, ...(other.length ? ([['Other', other]] as const) : [])].filter(([, list]) => list.length)

  const pick = (v: Voice) => {
    chooseVoice(v)
    close()
  }
  return (
    <div className="modal-body voice-picker">
      <label className="lib-search">
        <DIcon d={LIB_ICONS.search} size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices: name, accent, ‘Swedish’, ‘deep’, ‘narration’…" spellCheck={false} autoFocus />
      </label>
      <div className="voice-groups">
        {all.map(([title, list]) => (
          <div key={title} className="voice-group">
            <h4>
              {title} <span className="dim">{list.length}</span>
            </h4>
            {list.map((v) => (
              <div key={`${v.category}:${v.id}`} className={`voice-item${chosen?.id === v.id ? ' on' : ''}`}>
                <button type="button" className="icon-toggle" title="Hear it" disabled={!v.previewUrl} onClick={() => playPreview(v.previewUrl)}>
                  <Icon name="play" size={12} filled />
                </button>
                <button type="button" className="voice-pick" onClick={() => pick(v)}>
                  <span className="voice-name">{v.name}</span>
                  <span className="voice-meta">{[v.labels.accent, v.labels.gender, v.labels.age, v.labels.use_case ?? v.labels.descriptive, v.labels.language].filter(Boolean).join(' · ')}</span>
                </button>
              </div>
            ))}
          </div>
        ))}
        {!all.length && <p className="hint">{searching ? 'Searching the Voice Library…' : q ? 'No voice matches that.' : 'No voices yet.'}</p>}
        {searching && all.length > 0 && <p className="hint">Searching the Voice Library…</p>}
      </div>
    </div>
  )
}

/** An instant voice clone from recordings in the library, with the owner's consent. */
export function CloneDialogBody({ close }: { close: () => void }) {
  const media = useStore((s) => s.snap?.project.media)
  const audio = (media ?? []).filter((m) => (m.kind === 'audio' || m.hasAudio) && !m.missing)
  const recordings = audio.filter((m) => /[\\/]recordings[\\/]/.test(m.path))
  const [name, setName] = useState('My voice')
  const [picked, setPicked] = useState<string[]>(recordings.map((m) => m.id))
  const [noise, setNoise] = useState(true)
  const [consent, setConsent] = useState(false)
  const seconds = picked.reduce((s, id) => s + (audio.find((m) => m.id === id)?.durationUs ?? 0), 0) / 1e6
  const go = () => {
    cloneVoice(name.trim() || 'My voice', picked, noise)
    close()
  }
  return (
    <>
      <div className="modal-body">
        <label className="field-block">
          <span className="field-label">Name</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <div className="field-block">
          <span className="field-label">Recordings ({seconds.toFixed(0)} s; 1–2 minutes of clean speech works best)</span>
          <div className="choice-list scroll">
            {audio.map((m) => (
              <label key={m.id} className="check">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                {m.name} <span className="dim">{(m.durationUs / 1e6).toFixed(0)} s</span>
              </label>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={noise} onChange={(e) => setNoise(e.target.checked)} />
          Remove background noise first
        </label>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          This is my own voice, or its owner has agreed to it being cloned.
        </label>
      </div>
      <footer>
        <span className="footer-note">{seconds < 10 ? 'Pick at least 10 seconds of speech.' : ''}</span>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={!consent || !picked.length || seconds < 10} onClick={go}>
          Clone the voice
        </button>
      </footer>
    </>
  )
}

const DESIGN_MODELS: [string, string][] = [
  ['eleven_ttv_v3', 'Eleven v3'],
  ['eleven_multilingual_ttv_v2', 'Multilingual v2'],
]

/**
 * Voice Design: describe a voice, hear three takes on it, keep the one you like (it joins
 * Designed voices and becomes the voice for voiceovers). Generating costs credits for the
 * preview text's length; keeping one is free.
 */
export function DesignDialogBody({ close }: { close: () => void }) {
  const [description, setDescription] = useUi('audio.design.description', '')
  const [model, setModel] = useUi('audio.design.model', 'eleven_ttv_v3')
  const [text, setText] = useState('')
  const [round, setRound] = useState<DesignRound | null>(null)
  const [picked, setPicked] = useState('')
  const [heard, setHeard] = useState<string[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'' | 'designing' | 'keeping'>('')
  const [error, setError] = useState('')
  useEffect(() => () => playPreview(null), [])
  const desc = description.trim()
  const own = text.trim()
  const descNote = desc.length < 20 ? 'Describe the voice in at least 20 characters.' : desc.length > 1000 ? 'Keep the description under 1000 characters.' : ''
  const textNote = own && own.length < 100 ? `Your own line needs at least 100 characters (${own.length} now).` : own.length > 1000 ? 'Keep the line under 1000 characters.' : ''
  const generate = async () => {
    playPreview(null)
    setBusy('designing')
    setError('')
    const r = await designVoices(desc, own, model)
    setBusy('')
    if ('error' in r) return setError(r.error)
    setRound(r)
    setPicked(r.previews[0]?.id ?? '')
    setHeard([])
  }
  const hear = (p: DesignRound['previews'][number]) => {
    playPreview(p.audio)
    setPicked(p.id)
    setHeard((h) => (h.includes(p.id) ? h : [...h, p.id]))
  }
  const keep = async () => {
    playPreview(null)
    setBusy('keeping')
    setError('')
    const failed = await keepDesignedVoice(name.trim(), desc, picked, heard.filter((h) => h !== picked))
    setBusy('')
    if (failed) return setError(failed)
    close()
  }
  return (
    <>
      <div className="modal-body design-voice">
        <label className="field-block">
          <span className="field-label">Describe the voice</span>
          <textarea
            className="lib-textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A warm Swedish woman in her thirties, calm and close to the mic, friendly and unhurried, like telling a friend about something she loves."
            spellCheck={false}
            aria-label="Describe the voice"
          />
          <span className="hint">
            Age, gender, accent, tone, pace and how it’s recorded. {desc.length} / 1000
          </span>
        </label>
        <label className="field-block">
          <span className="field-label">What the previews say</span>
          <textarea
            className="lib-textarea"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Leave empty and ElevenLabs writes a line that fits the description, or paste 100–1000 characters of your script."
            spellCheck={false}
            aria-label="What the previews say"
          />
        </label>
        <div className="field-block">
          <span className="field-label">Model</span>
          <Pills items={DESIGN_MODELS} value={model} onPick={setModel} label="Model" variant="seg" />
        </div>
        {round && (
          <div className="field-block">
            <span className="field-label">Pick one</span>
            <div className="design-previews">
              {round.previews.map((p, i) => (
                <div key={p.id} className={`voice-item${picked === p.id ? ' on' : ''}`}>
                  <button type="button" className="icon-toggle" title="Hear it" aria-label={`Hear voice ${i + 1}`} onClick={() => hear(p)}>
                    <Icon name="play" size={12} filled />
                  </button>
                  <button type="button" className="voice-pick" aria-pressed={picked === p.id} onClick={() => setPicked(p.id)}>
                    <span className="voice-name">Voice {i + 1}</span>
                    <span className="voice-meta">
                      {Math.round(p.seconds)} s{heard.includes(p.id) ? ' · heard' : ''}
                    </span>
                  </button>
                </div>
              ))}
            </div>
            {round.text && <p className="hint">They say: “{round.text}”</p>}
          </div>
        )}
        {round && (
          <label className="field-block">
            <span className="field-label">Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What to call it in your voices" spellCheck={false} aria-label="Voice name" />
          </label>
        )}
        {error && <p className="lib-note error">{error}</p>}
      </div>
      <footer>
        <span className="footer-note">{busy === 'designing' ? 'Designing three voices…' : busy === 'keeping' ? 'Keeping it in your voices…' : descNote || textNote || (round ? 'Keeping a voice is free.' : 'Each Generate uses credits for the preview text’s length.')}</span>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className={`button${round ? '' : ' primary'}`} disabled={!!busy || !!descNote || !!textNote} onClick={generate}>
          {round ? 'Generate again' : 'Generate'}
        </button>
        {round && (
          <button type="button" className="button primary" disabled={!!busy || !picked || !name.trim()} onClick={keep}>
            Keep this voice
          </button>
        )}
      </footer>
    </>
  )
}

export const voicesLoaded = () => !!getState().eleven.voices
