// The Library's Translations tab: the project as it is on the timeline made again in other
// languages, one project per language ("Spring promo · Norsk"). Pick the languages and whether the
// same voice speaks them; Claude translates everything (nothing paid yet); the review shows every
// language on its own tab, each line with a back-translation into the project's language; then
// the voices speak and each language lands in its own project. The work runs in the main process
// (src/main/translate.ts), so it carries on in any project.

import './dub.css'
import './translations.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TR_LANGS, trLangName, trProjectName, trRunning, type TrItem, type TrJob, type TrText, type TrVoice } from '../shared/translate'
import { Pills, Select } from './controls'
import { Head, Note, Setting, Settings } from './LibraryBlocks'
import { collect, cancelTranslation, goTranslation, openTranslation, pickVoiceover, readVoiceover, retryTranslation, startTranslation, useTrJobs, type Voiceover } from './translate'
import { toast, useStore } from './store'
import { getUi, useUi } from './ui-state'

const clock = (us: number) => `${Math.floor(us / 60e6)}:${((us / 1e6) % 60).toFixed(1).padStart(4, '0')}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

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
        <Setup done={mine.filter((j) => j.state === 'applied' || j.state === 'ready')} own={own?.state} />
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
    if (snap) collect(snap).then((f) => live && setFound(f), () => live && setFound(null))
    return () => {
      live = false
    }
  }, [rev, own, heard])
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
  // The account's voices, to change the one a voiceover was matched to.
  const [accountVoices, setAccountVoices] = useState<{ id: string; name: string }[] | null>(null)
  useEffect(() => {
    if (accountVoices || !found?.voiceovers.length) return
    void window.studio.services.translateVoices().then((v) => setAccountVoices('error' in v ? [] : v))
  }, [found])
  if (!snap) return null
  const pick = async (vo: Voiceover, id: string) => {
    const v = accountVoices?.find((x) => x.id === id)
    await pickVoiceover(snap.dir, vo.path, id ? { voiceId: id, name: v?.name ?? id } : null)
    setHeard((n) => n + 1)
  }
  const from = found?.from || fromPicked
  const into = langs.filter((l) => l !== from)
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
        {voice === 'same' &&
          found?.voiceovers.map((vo) => {
            const options: [string, string][] = (accountVoices?.length ? accountVoices : vo.voice ? [{ id: vo.voice.voiceId, name: vo.voice.name }] : []).map((v) => [v.id, v.name])
            return (
              <Setting key={vo.path} label={vo.name.replace(/\.[^.]+$/, '')}>
                <Select label={`The voice of ${vo.name}`} value={vo.voice?.voiceId ?? ''} options={[...options, ['', 'Keep its own sound']]} onChange={(id) => void pick(vo, id)} />
              </Setting>
            )
          })}
      </Settings>
      {voice === 'same' && found?.voiceovers.map((vo) => <Note key={vo.path}>{voiceoverNote(vo)}</Note>)}
      {voice === 'same' && hearing && <Note>Listening to {hearing.split(/[\\/]/).pop()} for what it says and whose voice it is…</Note>}
      {voice === 'same' && Object.entries(unheard).map(([p, why]) => <Note key={p}>{p.split(/[\\/]/).pop()} couldn’t be heard: {why}</Note>)}
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
            {voice === 'same' && unknown ? ` ${plural(unknown, 'spoken part')} ha${unknown === 1 ? 's' : 've'} no voice Studio knows, so ${unknown === 1 ? 'it keeps' : 'they keep'} the old sound.` : ''}
            {lines.length && voice === 'same' ? ' Captions are made again from the new voice.' : ''}
          </Note>
        )
      ) : (
        <Note>Reading the timeline…</Note>
      )}
      <Note>Each language becomes its own project next to this one ({into.length ? trProjectName(snap.project.name, into[0]) : 'Name · Language'}). Claude translates it all first; you review every language before anything is paid for.</Note>
      <div className="tr-buttons">
        <button type="button" className="button primary" disabled={!into.length || !found?.items.length || starting} onClick={() => void start()}>
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

/** The review: one tab per language, every line with its translation and back-translation. */
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
      })
  }, [jobs.map((j) => j.id).join()])
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
      await goTranslation(j.id, { picks: d.texts.map((t) => t.id).filter((id) => !s.has(id)), edits: edits[j.id] })
    }
    setSending(false)
  }
  const flip = (id: string) => {
    const n = new Set(skip)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setOff({ ...off, [job.id]: n })
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
                <textarea className="dub-edit" rows={Math.max(1, Math.min(4, Math.ceil((mine[i.id] ?? t.translation).length / 38)))} value={mine[i.id] ?? t.translation} disabled={!on} onChange={(e) => setEdits({ ...edits, [job.id]: { ...mine, [i.id]: e.target.value } })} />
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

/** What the tab found for a voiceover it heard: how many sentences, and whose voice (or why none). */
function voiceoverNote(vo: Voiceover) {
  const n = `${vo.sentences} sentence${vo.sentences === 1 ? '' : 's'}`
  if (!vo.voice && vo.note === 'kept') return `${vo.name}: ${n}, kept in its own sound.`
  if (!vo.voice) return `${vo.name}: ${n}, no voice found${vo.note ? ` (${vo.note.replace(/\.$/, '')})` : ''}. Pick its voice above, or it keeps its own sound. Studio never clones a voice for this.`
  const how = vo.how === 'history' ? 'found in your ElevenLabs history' : vo.how === 'name' ? 'named in the file’s name' : vo.how === 'studio' ? 'made in Studio' : 'picked by you'
  return `${vo.name}: ${n}, spoken again by ${vo.voice.name} (${how}). No new voice is cloned.`
}
