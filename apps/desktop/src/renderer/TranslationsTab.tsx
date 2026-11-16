// The Library's Translations tab: the project as it is on the timeline made again in other
// languages, one project per language ("Spring promo · Norsk"). Pick the languages and whether the
// same voice speaks them; Claude translates everything (nothing paid yet); the review shows every
// language on its own tab, each line with a back-translation into the project's language; then
// the voices speak and each language lands in its own project. The work runs in the main process
// (src/main/translate.ts), so it carries on in any project.
// With Same voice, every sound that could speak is heard first (voiceovers, and the video clips'
// own sound), and the check above Translate says what would still be spoken in the old language
// and why, so nothing stays in it unnoticed. Each voice found has its own settings: what speaks
// it (an ElevenLabs voice, a clone, or its old sound), what a clone is made from (its own sound
// or the dub's sample, the speech on another track, or a file), and whether the clone is deleted
// after or kept in ElevenLabs.

import './dub.css'
import './translations.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TR_LANGS, trLangName, trProjectName, trRunning, type TrItem, type TrJob, type TrText, type TrVoice, type TrVoiceChoice } from '../shared/translate'
import { Pills, Select } from './controls'
import { Head, Note, Setting, Settings } from './LibraryBlocks'
import { chooseVoice, collect, cancelTranslation, goTranslation, openTranslation, readVoiceover, retryTranslation, startTranslation, useTrJobs, type TrVoiceRow } from './translate'
import { sameFolder, toast, useStore } from './store'
import { getUi, useUi } from './ui-state'
import { writeSoon } from './drafts'

const clock = (us: number) => `${Math.floor(us / 60e6)}:${((us / 1e6) % 60).toFixed(1).padStart(4, '0')}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const sameDir = sameFolder

export function TranslationsTab() {
  const snap = useStore((s) => s.snap)
  const all = Object.values(useTrJobs())
  if (!snap) return <Note>Open a project to translate it.</Note>
  const own = all.find((j) => sameDir(j.project, snap.dir))
  const mine = all.filter((j) => sameDir(j.source, snap.dir)).sort((a, b) => b.startedAt - a.startedAt)
  const batch = mine[0]?.batch
  const order = (j: TrJob) => TR_LANGS.findIndex((l) => l.code === j.lang)
  const latest = mine.filter((j) => j.batch === batch).sort((a, b) => order(a) - order(b))
  const reviewing = latest.filter((j) => j.state === 'review')
  return (
    <>
      {own && <OwnJob job={own} />}
      {reviewing.length > 0 && !latest.some((j) => j.state === 'reading' || j.state === 'copying') ? (
        <Review key={batch} jobs={reviewing} />
      ) : latest.some((j) => trRunning(j) || j.state === 'failed' || j.state === 'ready') ? (
        <Progress jobs={latest} />
      ) : (
        <Setup key={snap.dir} done={mine.filter((j) => j.state === 'applied' || j.state === 'ready')} own={own?.state} />
      )}
    </>
  )
}

/** In a copy: which translation it is, and how far it's got. */
function OwnJob({ job }: { job: TrJob }) {
  return (
    <div className="tr-own">
      <span>
        The {trLangName(job.lang)} translation of {job.source.split(/[\\/]/).pop()?.replace(/\.studio$/, '')}.{' '}
        {job.state === 'applied' ? 'It’s on the timeline.' : job.state === 'ready' ? 'Putting it on the timeline…' : job.state === 'failed' ? `It stopped: ${job.reason ?? 'unknown error'}` : job.state === 'review' ? 'It waits for the review in the original project.' : trRunning(job) ? `${job.stage} · ${Math.round(job.fraction * 100)} %` : 'Cancelled.'}
      </span>
      {job.state === 'failed' && (
        <button type="button" className="lib-link" onClick={() => void retryTranslation(job.id)}>
          Try again
        </button>
      )}
    </div>
  )
}

type Found = Awaited<ReturnType<typeof collect>>

function Setup({ done, own }: { done: TrJob[]; own?: string }) {
  const snap = useStore((s) => s.snap)
  const [found, setFound] = useState<Found | null>(null)
  const [langs, setLangs] = useUi<string[]>('tr.langs', ['no', 'da'])
  const [voice, setVoice] = useUi<TrVoice>('tr.voice', 'same')
  const [fromPicked, setFrom] = useUi('tr.from', 'sv')
  const [starting, setStarting] = useState(false)
  // What the project says, collected again when the timeline changes (or its own translation
  // lands, or a voiceover has been heard or given a voice).
  const rev = snap?.revision
  const [heard, setHeard] = useState(0)
  useEffect(() => {
    let live = true
    if (snap) collect(snap, fromPicked).then((f) => live && setFound(f), () => live && setFound(null))
    return () => {
      live = false
    }
  }, [rev, own, heard, fromPicked])
  // Voiceovers Studio didn't make are heard once each, one at a time, while Same voice is on.
  const [hearing, setHearing] = useState('')
  const [unheard, setUnheard] = useState<Record<string, string>>({})
  const busy = useRef(false)
  useEffect(() => {
    const next = found?.unread.find((p) => !(p in unheard))
    if (!snap || voice !== 'same' || !next || busy.current) return
    busy.current = true
    setHearing(next)
    void readVoiceover(snap.dir, next).then((r) => {
      busy.current = false
      setHearing('')
      if ('error' in r) setUnheard((u) => ({ ...u, [next]: r.error }))
      setHeard((n) => n + 1)
    })
  }, [found, voice, unheard])
  // The account's voices, to change the one a voiceover was matched to (and whether a key works at all).
  const [accountVoices, setAccountVoices] = useState<{ id: string; name: string }[] | null>(null)
  const [noKey, setNoKey] = useState('')
  const speaks = !!found?.items.some((i) => i.kind === 'line')
  useEffect(() => {
    if (accountVoices || voice !== 'same' || (!found?.voices.length && !speaks)) return
    void window.studio.services.translateVoices().then((v) => {
      setAccountVoices('error' in v ? [] : v)
      setNoKey('error' in v ? v.error : '')
    })
  }, [found, voice])
  if (!snap) return null
  const from = found?.from || fromPicked
  const into = langs.filter((l) => l !== from)
  // Sounds still to be heard (each once); Translate waits for them, so nothing spoken is missed.
  const listening = voice === 'same' ? (found?.unread.filter((p) => !(p in unheard)).length ?? 0) : 0
  const count = (k: TrItem['kind']) => found?.items.filter((i) => i.kind === k).length ?? 0
  const lines = found?.items.filter((i) => i.kind === 'line') ?? []
  const voices = [...new Set(lines.filter((l) => l.voice).map((l) => l.voice!.name.replace(/^(Her|The) /, (w) => w.toLowerCase())))]
  const unknown = lines.filter((l) => !l.voice).length
  // From the saved list as it is now, so quick clicks in a row each count.
  const toggle = (code: string) => {
    const now = getUi<string[]>('tr.langs', langs)
    setLangs(now.includes(code) ? now.filter((l) => l !== code) : [...now, code])
  }
  const start = async () => {
    setStarting(true)
    await startTranslation({ langs: into, voice, from })
    setStarting(false)
  }
  const nothing = found && !found.items.length
  return (
    <>
      <Settings>
        <Setting label="From">
          <Select label="From" value={from} options={TR_LANGS.map((l) => [l.code, l.name] as [string, string])} onChange={setFrom} disabled={!!found?.from} />
        </Setting>
        <Setting label="Voice">
          <Pills label="Voice" variant="seg" value={voice} items={[['same', 'Same voice'], ['text', 'Text only']]} onPick={(v) => setVoice(v as TrVoice)} />
        </Setting>
      </Settings>
      {voice === 'same' && found?.voices.map((vo) => <VoicePick key={vo.key} vo={vo} sources={found.sources} accountVoices={accountVoices} lang={trLangName(found.from || fromPicked)} project={snap.dir} onChange={() => setHeard((n) => n + 1)} />)}
      {voice === 'same' && hearing && <Note>Listening to {hearing.split(/[\\/]/).pop()} for what it says and whose voice it is…</Note>}
      <Head text={`Into · ${into.length ? into.map(trLangName).join(', ') : 'pick one or more'}`} />
      <div className="chips tr-langs" role="group" aria-label="Languages">
        {TR_LANGS.filter((l) => l.code !== from).map((l) => (
          <button key={l.code} type="button" aria-pressed={langs.includes(l.code)} className={langs.includes(l.code) ? 'on' : ''} onClick={() => toggle(l.code)}>
            {l.name}
          </button>
        ))}
      </div>
      {found ? (
        nothing ? (
          <Note>Nothing on this timeline says anything yet: no text clips, captions or voice Studio knows the words of.</Note>
        ) : (
          <Note>
            {[count('text') && plural(count('text'), 'text clip'), count('caption') && plural(count('caption'), 'caption line'), lines.length && plural(lines.length, 'spoken sentence')].filter(Boolean).join(', ')}.{' '}
            {voice === 'same'
              ? voices.length
                ? `Spoken again by ${voices.join(' and ')}, each sentence at its moment.`
                : lines.length || hearing || found.unread.some((p) => !(p in unheard))
                  ? ''
                  : 'No voice here, so only the text changes.'
              : 'The sound stays as it is; only text and captions change.'}
            {voice === 'same' && unknown ? ` ${plural(unknown, 'spoken part')} ${unknown === 1 ? 'is' : 'are'} set to keep ${unknown === 1 ? 'its' : 'their'} own sound.` : ''}
            {lines.length && voice === 'same' ? ' Captions are made again from the new voice.' : ''}
          </Note>
        )
      ) : (
        <Note>Reading the timeline…</Note>
      )}
      <Note>Each language becomes its own project next to this one ({into.length ? trProjectName(snap.project.name, into[0]) : 'Name · Language'}). Claude translates it all first; you review every language before anything is paid for.</Note>
      {found && <SpeechCheck found={found} voice={voice} from={from} listening={listening} unheard={unheard} noKey={noKey} />}
      <div className="tr-buttons">
        <button type="button" className="button primary" disabled={!into.length || !found?.items.length || starting || (voice === 'same' && listening > 0)} onClick={() => void start()}>
          {starting ? 'Starting…' : into.length > 1 ? `Translate into ${into.length} languages` : into.length ? `Translate into ${trLangName(into[0])}` : 'Translate'}
        </button>
      </div>
      {done.length > 0 && (
        <>
          <Head text="Translations" />
          <div className="tr-rows">
            {done.map((j) => (
              <div key={j.id} className="tr-row">
                <span className="tr-row-name">{j.name}</span>
                <span className="tr-row-stage">{j.state === 'applied' ? 'Done' : 'Ready'}</span>
                <button type="button" className="lib-link" onClick={() => void openTranslation(j)}>
                  Open
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** Every language started together, each with its stage, until all are done. */
function Progress({ jobs }: { jobs: TrJob[] }) {
  const waiting = jobs.some((j) => j.needsClaude)
  return (
    <>
      <Head text={`Translating into ${jobs.map((j) => trLangName(j.lang)).join(', ')}`} />
      <div className="tr-rows">
        {jobs.map((j) => (
          <div key={j.id} className={`tr-row${j.state === 'failed' ? ' failed' : ''}`}>
            <span className="tr-row-name">{trLangName(j.lang)}</span>
            <span className="tr-row-stage" title={j.reason ?? j.stage}>
              {j.state === 'failed' ? `Stopped: ${j.reason ?? 'unknown error'}` : j.state === 'applied' ? 'Done' : j.state === 'ready' ? 'Ready' : j.state === 'cancelled' ? 'Cancelled' : `${j.stage} · ${Math.round(j.fraction * 100)} %`}
            </span>
            {j.state === 'failed' ? (
              <button type="button" className="lib-link" onClick={() => void retryTranslation(j.id)}>
                Try again
              </button>
            ) : j.state === 'ready' || j.state === 'applied' ? (
              <button type="button" className="lib-link" onClick={() => void openTranslation(j)}>
                Open
              </button>
            ) : trRunning(j) ? (
              <button type="button" className="lib-link" onClick={() => void cancelTranslation(j.id)}>
                Cancel
              </button>
            ) : null}
            {trRunning(j) && (
              <span className="tr-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(j.fraction * 100)}%` }} />
              </span>
            )}
          </div>
        ))}
      </div>
      <Note>{waiting ? 'Claude translates through Claude Code on this computer, which is signed out. Run claude auth login in a terminal, then Try again.' : 'Each language is its own project on Home. It carries on if you open another project or close Studio.'}</Note>
    </>
  )
}

type Loaded = { job: TrJob; items: TrItem[]; texts: TrText[] }

/**
 * The review: one tab per language, every line with its translation and back-translation. What's
 * unticked and changed is saved in each language's job as it's typed (`translateDraft`), so it's
 * there after another tab, another project or closing Studio, until Translate uses it.
 */
function Review({ jobs }: { jobs: TrJob[] }) {
  const [data, setData] = useState<Record<string, Loaded>>({})
  const [tab, setTab] = useState(jobs[0].id)
  const [off, setOff] = useState<Record<string, Set<string>>>({})
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})
  const [sending, setSending] = useState(false)
  useEffect(() => {
    for (const j of jobs)
      window.studio.services.translateResult(j.id).then((r) => {
        if ('error' in r) return void toast(r.error, 'error')
        setData((d) => ({ ...d, [j.id]: r }))
        // Picks and words left from before, once per language (what's typed since wins).
        if (r.draft) {
          setOff((o) => (o[j.id] ? o : { ...o, [j.id]: new Set(r.draft!.off) }))
          setEdits((e) => (e[j.id] ? e : { ...e, [j.id]: r.draft!.edits }))
        }
      })
  }, [jobs.map((j) => j.id).join()])
  /** A language's picks and words saved in its job, as they change. */
  const keep = (id: string, o: Set<string>, e: Record<string, string>) => writeSoon(`tr|${id}`, () => window.studio.services.translateDraft(id, { off: [...o], edits: e }))
  const job = jobs.find((j) => j.id === tab) ?? jobs[0]
  const r = data[job.id]
  const skip = off[job.id] ?? new Set<string>()
  const mine = edits[job.id] ?? {}
  const rows = useMemo(() => (r ? r.items.filter((i) => r.texts.some((t) => t.id === i.id)) : []), [r])
  const chars = (j: TrJob) => {
    const d = data[j.id]
    if (!d || j.voice !== 'same') return 0
    const s = off[j.id] ?? new Set()
    return d.items.filter((i) => i.kind === 'line' && i.voice && !s.has(i.id)).reduce((a, i) => a + (edits[j.id]?.[i.id] ?? d.texts.find((t) => t.id === i.id)?.translation ?? '').length, 0)
  }
  const total = jobs.reduce((a, j) => a + chars(j), 0)
  const go = async () => {
    setSending(true)
    for (const j of jobs) {
      const d = data[j.id]
      if (!d) continue
      const s = off[j.id] ?? new Set()
      const e = edits[j.id] ?? {}
      // A line whose words were all taken out stays as it is.
      await goTranslation(j.id, { picks: d.texts.map((t) => t.id).filter((id) => !s.has(id) && !(e[id] != null && !e[id].trim())), edits: e })
    }
    setSending(false)
  }
  const flip = (id: string) => {
    const n = new Set(skip)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setOff({ ...off, [job.id]: n })
    keep(job.id, n, mine)
  }
  const type = (id: string, text: string | null) => {
    const next = { ...mine }
    if (text === null) delete next[id]
    else next[id] = text
    setEdits({ ...edits, [job.id]: next })
    keep(job.id, skip, next)
  }
  const from = trLangName(job.from)
  const group = (kind: TrItem['kind'], title: string) => {
    const list = rows.filter((i) => i.kind === kind)
    if (!list.length) return null
    return (
      <>
        <h4 className="dub-head">
          {title} · {list.filter((i) => !skip.has(i.id)).length} of {list.length}
        </h4>
        <div className="dub-list">
          {list.map((i) => {
            const t = r!.texts.find((x) => x.id === i.id)!
            const on = !skip.has(i.id)
            return (
              <div key={i.id} className={`dub-item line tr-item${on ? ' on' : ''}`}>
                <button type="button" className="dub-pick" role="checkbox" aria-checked={on} onClick={() => flip(i.id)} title={on ? `Translated into ${trLangName(job.lang)}` : 'Stays as it is'}>
                  <span className="dub-box" />
                </button>
                <span className="dub-when">{clock(i.startUs)}</span>
                <span className="dub-orig" title={i.text}>
                  {i.text.replace(/\n/g, ' / ')}
                </span>
                <textarea className="dub-edit" rows={Math.max(1, Math.min(4, Math.ceil((mine[i.id] ?? t.translation).length / 38)))} value={mine[i.id] ?? t.translation} disabled={!on} onChange={(e) => type(i.id, e.target.value)} />
                {on && mine[i.id] != null && mine[i.id] !== t.translation && (
                  <button type="button" className="lib-link tr-claude" title={`Claude's: ${t.translation}`} onClick={() => type(i.id, null)}>
                    {mine[i.id].trim() ? 'Back to Claude’s' : 'Empty: stays as it is · Back to Claude’s'}
                  </button>
                )}
                {on && t.back && (
                  <span className="tr-back" title={`What it says, put back into ${from}`}>
                    {from}: {t.back.replace(/\n/g, ' / ')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </>
    )
  }
  return (
    <>
      <Head text="Review the translations" />
      {jobs.length > 1 && <Pills label="Language" variant="sub" className="tr-tabs" value={job.id} items={jobs.map((j) => [j.id, trLangName(j.lang)] as [string, string])} onPick={setTab} />}
      {!r ? (
        <Note>Loading {trLangName(job.lang)}…</Note>
      ) : (
        <>
          {group('text', 'On-screen text')}
          {group('caption', 'Captions')}
          {group('line', job.voice === 'same' ? 'Spoken' : 'Spoken (captions only)')}
          {!rows.length && <Note>Nothing to translate here.</Note>}
        </>
      )}
      <Note>
        Untick a line to leave it as it is. Under each line is what the translation says, put back into {from}, so you can check languages you don’t read. {total ? `Speaking it costs about ${total.toLocaleString()} ElevenLabs characters${jobs.length > 1 ? ` (${jobs.map((j) => `${trLangName(j.lang)} ${chars(j).toLocaleString()}`).join(', ')})` : ''}.` : 'Nothing here costs credits.'}
      </Note>
      <div className="tr-buttons">
        <button type="button" className="button primary" disabled={sending || jobs.some((j) => !data[j.id])} onClick={() => void go()}>
          {sending ? 'Starting…' : jobs.length > 1 ? `Translate ${jobs.length} languages` : `Translate into ${trLangName(job.lang)}`}
        </button>
        <button type="button" className="button" disabled={sending} onClick={() => jobs.forEach((j) => void cancelTranslation(j.id))}>
          Cancel
        </button>
      </div>
    </>
  )
}

const CLONE = '__clone__'
const KEEP = '__keep__'
const FILE = '__file__'
const CLONE_CHOICES: [string, string][] = [['delete', 'Delete after use'], ['keep', 'Keep in ElevenLabs']]
const SOUND_FILES = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv']
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p

/**
 * One voice in the project: what speaks it in the translation (an ElevenLabs voice, a clone, or
 * its old sound), what the clone is made from (its own sound or the dub's sample, the speech on
 * another track, a file on this computer), and whether the clone is deleted after or kept.
 */
function VoicePick({ vo, sources, accountVoices, lang, project, onChange }: { vo: TrVoiceRow; sources: Collected['sources']; accountVoices: { id: string; name: string }[] | null; lang: string; project: string; onChange: () => void }) {
  const [listening, setListening] = useState('')
  const set = async (choice: TrVoiceChoice) => {
    await chooseVoice(project, vo.key, choice)
    onChange()
  }
  const c = vo.choice
  const voices: [string, string][] = (accountVoices?.length ? accountVoices : vo.known ? [{ id: vo.known.voiceId, name: vo.known.name }] : []).map((v) => [v.id, v.name])
  // A voice picked before that's no longer in the account still shows by its name.
  if (c.use === 'voice' && !voices.some((v) => v[0] === c.voiceId)) voices.push([c.voiceId, c.name])
  const own: [string, string] = ['auto', vo.dub ? 'The dub’s sample of the original voice' : vo.before ? 'The sample it was cloned from before' : `Its own sound (${vo.where})`]
  // Another track that speaks; one that's just this voice's own sound is already "its own sound".
  const same = (s: { paths: string[] }) => s.paths.length === vo.paths.length && s.paths.every((x) => vo.paths.includes(x))
  const tracks = sources.filter((s) => vo.dub || vo.before || !same(s)).map((s) => [s.id, s.label] as [string, string])
  const from: [string, string][] = [own, ...tracks, ...(vo.file ? [[`file:${vo.file}`, fileName(vo.file)] as [string, string]] : []), [FILE, 'A file on this computer…']]
  const fromLabel = from.find((f) => c.use === 'clone' && f[0] === c.from)?.[1] ?? own[1]
  const speaker = (id: string) => {
    if (id === KEEP) return set({ use: 'keep' })
    if (id === CLONE) return set({ use: 'clone', from: 'auto', keep: false })
    return set({ use: 'voice', voiceId: id, name: voices.find((v) => v[0] === id)?.[1] ?? id })
  }
  const source = async (id: string) => {
    if (c.use !== 'clone') return
    if (id !== FILE) return set({ ...c, from: id })
    const f = await window.studio.app.chooseFile({ title: 'A sound or video with this voice', filters: [{ name: 'Sound or video', extensions: SOUND_FILES }] })
    if (!f) return
    setListening(fileName(f))
    const r = await readVoiceover(project, f)
    setListening('')
    if ('error' in r) return void toast(`${fileName(f)} couldn’t be heard: ${r.error}`, 'error')
    if (!r.sentences) return void toast(`${fileName(f)} has no speech to clone the voice from.`, 'error')
    await set({ ...c, from: `file:${f}` })
  }
  return (
    <>
      <Head text={`${vo.where}${vo.clip ? ' (the clip’s own sound)' : ''} · ${plural(vo.sentences, 'sentence')}`} />
      <Settings>
        <Setting label="Spoken by">
          <Select label={`What speaks ${vo.where}`} value={c.use === 'voice' ? c.voiceId : c.use === 'clone' ? CLONE : KEEP} options={[...voices, [CLONE, 'A clone of this voice'], [KEEP, `Keep the ${lang} sound`]]} onChange={(id) => void speaker(id)} />
        </Setting>
        {c.use === 'clone' && (
          <>
            <Setting label="Clone from">
              <Select label={`What ${vo.where} is cloned from`} value={c.from} options={from} onChange={(id) => void source(id)} />
            </Setting>
            <Setting label="The clone">
              <Pills label={`The clone of ${vo.where}`} variant="seg" value={c.keep ? 'keep' : 'delete'} items={CLONE_CHOICES} onPick={(k) => void set({ ...c, keep: k === 'keep' })} />
            </Setting>
          </>
        )}
      </Settings>
      <Note>{listening ? `Listening to ${listening} for the voice…` : voiceNote(vo, fromLabel, lang)}</Note>
    </>
  )
}

/** What a voice's settings come to: who speaks it and how it was found, or what it's cloned from and what happens to the clone. */
function voiceNote(vo: TrVoiceRow, from: string, lang: string) {
  const c = vo.choice
  const music = vo.mixed && c.use !== 'keep' ? ' Its voice is over music, so it’s taken out of the music first and the music stays under the new voice.' : ''
  if (c.use === 'keep') return `Its ${lang} sound stays as it is.`
  if (c.use === 'voice') {
    const how = vo.chosen ? '' : vo.how === 'history' ? ' (found in your ElevenLabs history)' : vo.how === 'name' ? ' (named in the file’s name)' : vo.how === 'studio' ? ' (made in Studio)' : ''
    return `${c.name} speaks it again${how}. No clone is made.${music}`
  }
  // Why it's cloned when nobody picked that: the dub's clone isn't in the account, or no voice there said it.
  const other = vo.note && !/^No voice in your ElevenLabs account/.test(vo.note) && vo.note !== 'kept' && vo.note !== 'clone' ? ` (${vo.note.replace(/\.$/, '')})` : ''
  const why = vo.chosen ? 'Cloned' : vo.dub ? 'The dub’s clone isn’t in your ElevenLabs voices, so it’s cloned again' : vo.before ? 'Its clone isn’t in your ElevenLabs voices, so it’s cloned again' : `No voice in your ElevenLabs account said it${other}, so it’s cloned`
  const after = c.keep ? ', and the clone stays in your ElevenLabs voices to speak it from then on' : ' for this translation, then deleted from ElevenLabs'
  return `${why} from ${from.replace(/^The /, 'the ').replace(/^Its /, 'its ')}${after}.${music}`
}

type Collected = Awaited<ReturnType<typeof collect>>

/**
 * The check above Translate: everything that would still be spoken in the project's language,
 * and why (Text only, a sound kept as it is, one that couldn't be heard, no ElevenLabs key), or
 * that everything spoken is said again. Speech in other languages is listed apart, left as it is.
 */
function SpeechCheck({ found, voice, from, listening, unheard, noKey }: { found: Collected; voice: TrVoice; from: string; listening: number; unheard: Record<string, string>; noKey: string }) {
  const lang = trLangName(from)
  const lines = found.items.filter((i) => i.kind === 'line')
  const stays: string[] = []
  if (voice === 'text') {
    if (lines.length || found.voices.length) stays.push(`Text only: everything spoken (${plural(lines.length, 'sentence')}) keeps its ${lang} sound. Pick Same voice to say it again.`)
  } else {
    if (noKey && lines.length) stays.push(`No ElevenLabs key works (${noKey.replace(/\.$/, '')}), so nothing can be spoken. Add the key in Audio › Voice.`)
    for (const vo of found.voices) if (vo.choice.use === 'keep') stays.push(`${vo.where}: set to keep its own sound (${plural(vo.sentences, 'sentence')}).`)
    for (const [p, why] of Object.entries(unheard)) stays.push(`${p.split(/[\\/]/).pop()} couldn’t be heard (${why.replace(/\.$/, '')}), so whatever it says stays ${lang}.`)
  }
  const cloned = found.voices.filter((v) => v.choice.use === 'clone').length
  const mixed = found.voices.filter((v) => v.mixed && v.voice).length
  return (
    <div className={`tr-check${stays.length ? ' stays' : ''}`} role="status">
      {voice === 'same' && listening > 0 ? (
        <p className="tr-check-head">Listening to {plural(listening, 'more sound')} for speech before you can translate…</p>
      ) : stays.length ? (
        <>
          <p className="tr-check-head">Still spoken in {lang}</p>
          {stays.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </>
      ) : voice === 'same' && lines.length ? (
        <p>
          Everything spoken in {lang} is said again: {plural(lines.length, 'sentence')}
          {cloned ? `, ${plural(cloned, 'voice')} cloned for it` : ''}
          {mixed ? `, ${plural(mixed, 'voice')} taken out of the music first` : ''}.
        </p>
      ) : (
        <p>Nothing here is spoken in {lang}.</p>
      )}
      {found.other.map((o) => (
        <p key={o.name}>
          {o.name}: speech in {trLangName(o.language)}, left as it is.
        </p>
      ))}
    </div>
  )
}
