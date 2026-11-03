// The Inspector's Dub tab: a clip re-made in another language. Set up what to dub (the
// on-screen text, the voice — her own voice cloned, another voice, or kept — and captions),
// then Studio finds and translates everything (nothing that costs credits yet), and the tab
// lists every text and sentence with its translation to pick and change before the paid steps
// run. The dub itself runs in the main process (src/main/dub.ts), so it carries on while other
// things are selected; this tab only shows it.

import './dub.css'
import { useEffect, useMemo, useState } from 'react'
import type { VmakeAccount } from '../shared/api'
import { vmakeCheck, vmakeKnown } from './vmakeAccount'
import { dubRunning, unchanged, type DubJob, type DubScan, type DubText, type DubVoice } from '../shared/dub'
import { Buttons, Note, Sec, SegRow, SelectRow } from './InspectorBlocks'
import { BusyBar } from './LibraryBlocks'
import { LANG_NAMES, cancelDub, cleanFor, dubText, goDub, removeAgain, retryDub, sayAgain } from './dub'
import { fileUrl, taskElapsed, toast, useStore, type Clip, type Media, type Task } from './store'
import { useUi } from './ui-state'

const LANGS = ['sv', 'no', 'da', 'fi', 'de', 'en', 'nl', 'fr', 'es', 'it', 'pt', 'pl']
const time = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

export function DubTab({ clip, media }: { clip: Clip; media?: Media }) {
  const jobs = useStore((s) => s.dubJobs)
  const job = Object.values(jobs)
    .filter((j) => j.clipId === clip.id)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  const [fresh, setFresh] = useState(false)
  if (job?.state === 'review') return <Review key={job.id} job={job} />
  if (job && dubRunning(job)) return <Running job={job} />
  return <Setup clip={clip} media={media} last={fresh ? undefined : job} onAgain={() => setFresh(true)} />
}

/** A key field: shown only while the key is missing (or refused). */
function KeyField({ name, label, help }: { name: 'vmake' | 'elevenlabs'; label: string; help: string }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  return (
    <div className="dub-key">
      <span className="dub-label">{label}</span>
      <div className="dub-key-row">
        <input className="text-input" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste it here" spellCheck={false} autoComplete="off" />
        <button
          type="button"
          className="button"
          disabled={!value.trim()}
          onClick={async () => {
            const r = await window.studio.services.setKey(name, value)
            if (r.error) return setError(r.error)
            setValue('')
            setError('')
            window.dispatchEvent(new Event('studio-keys'))
          }}
        >
          Save
        </button>
      </div>
      <p className="dub-hint">{help}</p>
      {error && <p className="dub-error">{error}</p>}
    </div>
  )
}

function useKeys() {
  const [keys, setKeys] = useState<{ vmake: boolean; elevenlabs: boolean } | null>(null)
  useEffect(() => {
    const load = () => window.studio.services.keys().then((k) => setKeys({ vmake: k.vmake, elevenlabs: k.elevenlabs }))
    load()
    window.addEventListener('studio-keys', load)
    return () => window.removeEventListener('studio-keys', load)
  }, [])
  return keys
}

function Setup({ clip, media, last, onAgain }: { clip: Clip; media?: Media; last?: DubJob; onAgain: () => void }) {
  const voiceChosen = useStore((s) => s.voice)
  const [lang, setLang] = useUi('dub.lang', 'sv')
  // On-screen text: translated and drawn again, left as filmed, or only taken out (Remove).
  const [onScreen, setOnScreen] = useUi<'translate' | 'leave' | 'remove'>('dub.onScreen', 'translate')
  const text = onScreen !== 'leave'
  const removeText = onScreen === 'remove'
  const [voice, setVoice] = useUi<DubVoice>('dub.voice', 'clone')
  const [captions, setCaptions] = useUi('dub.captions', false)
  const [chosenModel, setModel] = useUi('dub.model', 'pro')
  // Remove needs Vmake: None isn't offered then.
  const model = removeText && chosenModel === 'skip' ? 'pro' : chosenModel
  const keys = useKeys()
  const [account, setAccount] = useState<VmakeAccount | null>(vmakeKnown)
  const sound = !!media?.hasAudio && !clip.detached
  const speaks = sound && voice !== 'keep'
  const hears = sound && (speaks || captions)
  useEffect(() => {
    if (text && keys?.vmake) vmakeCheck().then((r) => 'error' in r || setAccount(r))
  }, [text, keys?.vmake])
  const price = account?.prices[model]?.credits
  // A clean copy of this clip from an earlier dub is used again, whatever's picked, at no cost.
  useStore((s) => s.dubJobs)
  const cleaned = media ? cleanFor(clip, media) : undefined
  const needVmake = text && model !== 'skip' && !cleaned && keys && !keys.vmake
  const needEleven = hears && keys && !keys.elevenlabs
  const anything = text || speaks || (sound && captions)
  const start = () => {
    if (!media) return
    if (voice === 'voice' && speaks && !voiceChosen) return void toast('Choose the voice in the Audio tab first, or use her own voice.', 'error')
    onAgain()
    void dubText({ mediaId: media.id, clipId: clip.id }, { lang, model: text ? model : 'skip', text, removeText, voice: sound ? voice : 'keep', ...(voice === 'voice' && voiceChosen ? { voiceId: voiceChosen.id, voiceName: voiceChosen.name } : {}), captions: sound && captions, review: true })
  }
  return (
    <>
      {last && (last.state === 'failed' || last.state === 'cancelled') && (
        <div className="dub-error-box">
          <span>
            The last dub into {LANG_NAMES[last.lang] ?? last.lang} stopped: {last.reason ?? 'cancelled'}
          </span>
          <Buttons items={[{ label: 'Try again', onClick: () => void retryDub(last.id), title: 'Carries on from where it stopped, keeping what it found and translated' }]} />
        </div>
      )}
      {last && last.state !== 'applied' && last.text && <Removal job={last} />}
      {last?.state === 'applied' && <Note>Dubbed into {LANG_NAMES[last.lang] ?? last.lang}: the new text and sound are on the timeline as their own clips.</Note>}
      {last?.state === 'applied' && last.voice !== 'keep' && last.voiceId && <SayAgain key={last.id} job={last} />}
      <Sec title="Dub" first />
      <SelectRow label="Into" value={lang} options={LANGS.map((l) => [l, LANG_NAMES[l]] as [string, string])} onChange={setLang} />
      <SegRow label="On-screen text" value={onScreen} items={[['translate', 'Translate'], ['remove', 'Remove'], ['leave', 'Leave']]} onPick={(v) => setOnScreen(v as typeof onScreen)} />
      {sound ? (
        <>
          <SegRow label="Voice" value={voice} items={[['clone', 'Her voice'], ['voice', 'Another'], ['keep', 'Keep']]} onPick={(v) => setVoice(v as DubVoice)} />
          {voice === 'voice' && <Note>{voiceChosen ? `Speaks with ${voiceChosen.name} (chosen in Audio).` : 'Choose the voice in the Audio tab first.'}</Note>}
          <SegRow label="Captions" value={captions ? 'on' : 'off'} items={[['on', LANG_NAMES[lang]], ['off', 'None']]} onPick={(v) => setCaptions(v === 'on')} />
        </>
      ) : (
        <Note>{media?.hasAudio ? 'The clip’s sound is off, so only its text can be dubbed.' : 'The clip has no sound, so only its text can be dubbed.'}</Note>
      )}
      {text && (
        <>
          <Sec title="Text removal" />
          <SegRow label="Vmake" value={model} items={[['pro', 'Smart Remove Pro'], ['full', 'Smart Remove'], ...(removeText ? [] : [['skip', 'None'] as [string, string]])]} onPick={setModel} />
          <Note>
            {cleaned
              ? `Vmake already took this clip’s text out for the ${LANG_NAMES[cleaned.lang] ?? cleaned.lang} dub: that copy is used again, at no cost, whichever you pick.`
              : model === 'skip'
              ? 'The new text goes over the old one; nothing is removed.'
              : `${price != null ? `${price} credits` : 'Paid'} from your Vmake account${account?.balance != null ? ` (${account.balance} left)` : ''}. Vmake starts the moment the dub does and runs on its own, as it takes longest, so it’s paid then, before you pick what to dub.`}
          </Note>
          {needVmake && <KeyField name="vmake" label="Vmake access token" help="vmake.ai while signed in → F12 → Network → any request to wapi.vmake.ai → Request Headers → access-token. Kept encrypted on this computer." />}
        </>
      )}
      {needEleven && <KeyField name="elevenlabs" label="ElevenLabs API key" help="elevenlabs.io → Developers → API keys. It needs Speech to Text, Text to Speech and Voices (write). Kept encrypted on this computer." />}
      <Note>
        {removeText
          ? `Vmake takes the on-screen text out, and nothing is drawn back${sound && captions ? `: ${LANG_NAMES[lang]} captions go on from what’s said` : ''}.${speaks ? ` Studio listens to what’s said, Claude translates it, and you pick and change any sentence before ElevenLabs is paid for. Then ${voice === 'clone' ? 'her voice is cloned and' : 'the voice'} speaks the ${LANG_NAMES[lang]} as one take, each sentence at its moment over the music without her voice.` : sound && captions ? ' Studio listens to what’s said and Claude translates it; you can change any line before it goes on.' : ''}`
          : speaks
          ? `Studio finds the text and listens to what’s said, Claude translates it all, and you pick what to dub and change any translation before ${text && model !== 'skip' ? 'ElevenLabs is' : 'anything is'} paid for. Then ${voice === 'clone' ? 'her voice is cloned' : 'the voice'} speaks the ${LANG_NAMES[lang]} as one take, each sentence at its moment over the music without her voice.`
          : `Studio finds the text, Claude reads and translates it, and you pick what to dub and change any translation${text && model !== 'skip' ? '' : ' before anything is paid for'}.`}
      </Note>
      <Buttons items={[{ label: 'Find what to dub', onClick: start, disabled: !media || !anything || !!needVmake || !!needEleven || !keys }]} />
    </>
  )
}

/** After a voice dub: what's said, sentence by sentence, to change and have said again in the same voice. */
function SayAgain({ job }: { job: DubJob }) {
  const [lines, setLines] = useState<{ id: string; at: number; text: string }[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    window.studio.services.dubResult(job.id).then((r) => !('error' in r) && setLines((r.voice?.lines ?? []).filter((l) => !l.own).map((l) => ({ id: l.id, at: l.at, text: l.text }))))
  }, [job.id])
  if (!lines?.length) return null
  const changed = lines.filter((l) => edits[l.id] != null && edits[l.id].trim() && edits[l.id].trim() !== l.text.trim())
  const chars = changed.reduce((a, l) => a + edits[l.id].length, 0)
  const go = async () => {
    setBusy(true)
    await sayAgain(job, Object.fromEntries(changed.map((l) => [l.id, edits[l.id]])))
    const r = await window.studio.services.dubResult(job.id)
    if (!('error' in r)) setLines((r.voice?.lines ?? []).filter((l) => !l.own).map((l) => ({ id: l.id, at: l.at, text: l.text })))
    setEdits({})
    setBusy(false)
  }
  return (
    <>
      <Sec title="What she says" />
      <div className="dub-list">
        {lines.map((l) => (
          <div key={l.id} className={`dub-item line${edits[l.id] != null && edits[l.id] !== l.text ? ' on' : ''}`}>
            <span className="dub-when">{time(l.at)}</span>
            <textarea className="dub-edit" rows={2} value={edits[l.id] ?? l.text} disabled={busy} onChange={(e) => setEdits({ ...edits, [l.id]: e.target.value })} />
          </div>
        ))}
      </div>
      <Note>Change a sentence and it’s said again in the same voice, spoken on from the sentence before so it sounds like one take, then swapped in where its clip is.{changed.length ? ` About ${chars} ElevenLabs characters, plus the sentence before.` : ''}</Note>
      <Buttons items={[{ label: busy ? 'Saying it again…' : changed.length > 1 ? `Say ${changed.length} sentences again` : 'Say it again', onClick: () => void go(), disabled: busy || !changed.length }]} />
    </>
  )
}

type Result = { scan: DubScan | null; texts: DubText[]; speech: { lines: { id: string; start: number; end: number; text: string }[] } | null; said: { id: string; text: string; translation: string }[] }

/** The review: every text and sentence with its translation; pick, change, then dub. */
function Review({ job }: { job: DubJob }) {
  const [r, setR] = useState<Result | null>(null)
  const [texts, setTexts] = useState<Set<string>>(new Set())
  const [lines, setLines] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [account, setAccount] = useState<VmakeAccount | null>(vmakeKnown)
  useEffect(() => {
    window.studio.services.dubResult(job.id).then((x) => {
      if ('error' in x) return toast(x.error, 'error')
      setR(x)
      setTexts(new Set(x.texts.filter((t) => t.kind === 'edit' && !unchanged(t)).map((t) => t.id)))
      setLines(new Set(x.said.map((l) => l.id)))
    })
    if (job.text && job.model !== 'skip') vmakeCheck().then((a) => 'error' in a || setAccount(a))
  }, [job.id])
  const sep = job.dir.includes('\\') ? '\\' : '/'
  const shown = useMemo(() => r?.texts.filter((t) => t.kind !== 'part') ?? [], [r])
  if (!r) return <Note>Loading what was found…</Note>
  const toggle = (set: Set<string>, id: string, put: (s: Set<string>) => void) => {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    put(n)
  }
  const chars = r.said.filter((l) => lines.has(l.id)).reduce((a, l) => a + (edits[l.id] ?? l.translation).length, 0)
  // Vmake started (and was paid) with the dub; only a dub whose removal never started still pays for it here.
  const removing = !!(job.vmakeJob || job.clean)
  const credits = texts.size && job.model !== 'skip' && !removing ? account?.prices[job.model]?.credits : 0
  const speaks = job.voice !== 'keep'
  const cost = [credits ? `${credits} Vmake credits` : texts.size && job.model !== 'skip' && !removing ? 'Vmake credits' : '', speaks && lines.size ? `about ${chars} ElevenLabs characters${job.voice === 'clone' && !job.voiceId ? ' and one voice clone' : ''}` : ''].filter(Boolean).join(' and ')
  const go = () => goDub(job.id, { texts: [...texts], lines: speaks || job.captions ? [...lines] : [], edits })
  return (
    <>
      <Sec title={`Into ${LANG_NAMES[job.lang] ?? job.lang}: pick what to dub`} first />
      <Removal job={job} />
      {shown.length > 0 && (
        <>
          <h4 className="dub-head">On-screen text · {texts.size} of {shown.filter((t) => t.kind === 'edit').length}</h4>
          <div className="dub-list">
            {shown.map((t) => {
              const b = r.scan?.blocks.find((x) => x.id === t.id)
              const on = texts.has(t.id)
              const scene = t.kind === 'scene'
              const same = !scene && unchanged(t)
              return (
                <div key={t.id} className={`dub-item${on ? ' on' : ''}${scene ? ' scene' : ''}`}>
                  <button type="button" className="dub-pick" role="checkbox" aria-checked={on} disabled={scene} onClick={() => toggle(texts, t.id, setTexts)} title={scene ? 'Filmed, not edited in: stays as it is' : on ? 'Dubbed' : 'Left as it is'}>
                    <span className="dub-box" />
                  </button>
                  {b && <img className="dub-crop" src={fileUrl(`${job.dir}${sep}${b.crop}`)} alt="" />}
                  <span className="dub-when">{b ? time(b.startUs / 1e6) : ''}</span>
                  <span className="dub-orig">{t.text.replace(/\n/g, ' / ')}</span>
                  {scene ? <span className="dub-note">Filmed on the product: stays</span> : same && !on ? <span className="dub-note">Same in {LANG_NAMES[job.lang] ?? job.lang}: stays as it is</span> : <textarea className="dub-edit" rows={Math.max(1, t.translation.split('\n').length)} value={edits[t.id] ?? t.translation} disabled={!on} onChange={(e) => setEdits({ ...edits, [t.id]: e.target.value })} />}
                </div>
              )
            })}
          </div>
        </>
      )}
      {r.said.length > 0 && (
        <>
          <h4 className="dub-head">
            {speaks ? 'Voice' : 'Captions'} · {lines.size} of {r.said.length} sentences
          </h4>
          <div className="dub-list">
            {r.said.map((l) => {
              const s = r.speech?.lines.find((x) => x.id === l.id)
              const on = lines.has(l.id)
              return (
                <div key={l.id} className={`dub-item line${on ? ' on' : ''}`}>
                  <button type="button" className="dub-pick" role="checkbox" aria-checked={on} onClick={() => toggle(lines, l.id, setLines)} title={on ? (speaks ? 'Spoken in the new language' : 'Captioned') : speaks ? 'Her own voice stays here' : 'No caption here'}>
                    <span className="dub-box" />
                  </button>
                  <span className="dub-when">{s ? time(s.start) : ''}</span>
                  <span className="dub-orig">{l.text}</span>
                  <textarea className="dub-edit" rows={2} value={edits[l.id] ?? l.translation} disabled={!on} onChange={(e) => setEdits({ ...edits, [l.id]: e.target.value })} />
                </div>
              )
            })}
          </div>
        </>
      )}
      <Note>{cost ? `Dubbing these costs ${cost}.` : 'Nothing here costs credits.'} Every translation can still be changed on the timeline afterwards.</Note>
      <Buttons
        items={[
          { label: `Dub ${[texts.size ? `${texts.size} text${texts.size === 1 ? '' : 's'}` : '', lines.size && (speaks || job.captions) ? `${lines.size} sentence${lines.size === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'nothing'}`, onClick: go, disabled: !texts.size && !(lines.size && (speaks || job.captions)) },
          { label: 'Cancel', onClick: () => void cancelDub(job.id) },
        ]}
      />
    </>
  )
}

/**
 * The text removal, which Vmake runs on its own from the moment the dub starts (it takes
 * longest): how far it is, that it's done, or that it stopped, with Start it again.
 */
function Removal({ job }: { job: DubJob }) {
  const r = job.removal
  if (!r) return null
  if (r.state === 'failed' || r.state === 'cancelled')
    return !dubRunning(job) ? null : (
      <div className="dub-error-box dub-removal">
        <span>Vmake stopped removing the text: {r.reason ?? 'cancelled'}</span>
        <Buttons items={[{ label: 'Start it again', onClick: () => void removeAgain(job.id), title: 'Sends the clip to Vmake again (paid again); the dub goes on meanwhile' }]} />
      </div>
    )
  if (r.state === 'done') return <Note>{/^Already/.test(r.stage) ? `${r.stage}: Vmake took the text out once, for both.` : `Vmake has taken the text out of the clip${dubRunning(job) ? '' : '; a new dub of it uses that instead of paying again'}.`}</Note>
  const bar = { fraction: r.fraction, waiting: false, startedAt: r.startedAt } as Task
  return (
    <div className="insp-busy dub-removal" role="status">
      <span className="busy-spin" aria-hidden="true" />
      <span>
        Text removal, on its own: {r.stage} · {taskElapsed(bar)} · {Math.round(r.fraction * 100)} %
        {!dubRunning(job) ? '. A new dub of this clip uses it.' : ''}
      </span>
      <BusyBar task={bar} />
    </div>
  )
}

function Running({ job }: { job: DubJob }) {
  const bar = { fraction: job.fraction, waiting: false, startedAt: job.startedAt } as Task
  return (
    <>
      <Sec title={`Dubbing into ${LANG_NAMES[job.lang] ?? job.lang}`} first />
      <div className="insp-busy" role="status">
        <span className="busy-spin" aria-hidden="true" />
        <span>
          {job.stage} · {taskElapsed(bar)} · {Math.round(job.fraction * 100)} %
        </span>
        <BusyBar task={bar} />
      </div>
      {job.state !== 'removing' && <Removal job={job} />}
      {job.needsClaude ? (
        <Note>Claude reads and translates through Claude Code on this computer, which is signed out. Run claude auth login in a terminal, then Try again.</Note>
      ) : (
        <Note>The clip can’t be changed until the dub is on the timeline. It carries on if you close the project, and picks up again when Studio starts.</Note>
      )}
      <Buttons items={[...(job.needsClaude ? [{ label: 'Try again', onClick: () => void retryDub(job.id) }] : []), { label: 'Cancel dub', onClick: () => void cancelDub(job.id) }]} />
    </>
  )
}
