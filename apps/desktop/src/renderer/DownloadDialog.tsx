// Media › Download: links pasted one per line (TikTok, Instagram, YouTube, the Facebook ad
// library), each looked up first (title, length, the qualities it offers; nothing fetched), then
// downloaded into the open project and put in its library, as the download server's own page
// works. With "Remove the on-screen text with Vmake" ticked, each video then goes through Remove
// text with Vmake on the user's own account (downloads.ts). Below, this project's downloads with
// their progress; they carry on with the dialog closed, and after a restart.

import './download.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadJob, DownloadProbe, VmakeAccount } from '../shared/api'
import { linksIn } from '../shared/download-links'
import { Pills, Select } from './controls'
import { cancelDownload, startDownloads, useDownloads } from './downloads'
import { Icon } from './icons'
import { useStore } from './store'
import { vmakeCheck, vmakeHasToken, vmakeKnown, vmakeTokenSet } from './vmakeAccount'

type Looked = { state: 'looking' } | { state: 'ok'; probe: DownloadProbe } | { state: 'failed'; error: string }
type Pick = { kind: 'mp4' | 'mp3'; quality: string }

const length = (s: number) => {
  const t = Math.max(0, Math.round(s))
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const RUNNING: DownloadJob['state'][] = ['queued', 'working', 'saving']

function jobLine(j: DownloadJob): string {
  if (j.state === 'failed') return `Stopped: ${j.error ?? 'unknown error'}`
  if (j.state === 'cancelled') return 'Cancelled'
  if (j.state === 'saved') return j.imported ? (j.vmake ? 'In the library · Vmake is taking its text out' : 'In the library') : 'Saved · goes into the library'
  if (j.state === 'queued') return 'Waiting for the server'
  return `${j.stage || (j.state === 'saving' ? 'Saving' : 'Downloading')} · ${Math.round(j.fraction * 100)} %`
}

export function DownloadDialogBody({ close }: { close: () => void }) {
  const dir = useStore((s) => s.snap?.dir ?? '')
  const [text, setText] = useState('')
  const [looked, setLooked] = useState<Record<string, Looked>>({})
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [vmakeOn, setVmakeOn] = useState(false)
  const [model, setModel] = useState('full')
  const [hasKey, setHasKey] = useState<boolean | null>(vmakeHasToken)
  const [account, setAccount] = useState<VmakeAccount | null>(vmakeKnown)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const jobs = useDownloads()
  const links = useMemo(() => linksIn(text), [text])
  const asked = useRef(new Set<string>())

  // Each new link is looked up once, three at a time, after typing rests.
  useEffect(() => {
    const fresh = links.filter((l) => !asked.current.has(l))
    if (!fresh.length) return
    const t = window.setTimeout(() => {
      const queue = [...fresh]
      for (const l of queue) asked.current.add(l)
      setLooked((now) => ({ ...now, ...Object.fromEntries(queue.map((l) => [l, { state: 'looking' } as Looked])) }))
      const next = async (): Promise<void> => {
        const l = queue.shift()
        if (!l) return
        const r = await window.studio.services.downloadProbe(l).catch((e: Error) => ({ error: e.message }))
        if ('error' in r) setLooked((now) => ({ ...now, [l]: { state: 'failed', error: r.error } }))
        else {
          setLooked((now) => ({ ...now, [l]: { state: 'ok', probe: r } }))
          setPicks((now) => (now[l] ? now : { ...now, [l]: { kind: 'mp4', quality: r.ladder[0]?.id ?? '' } }))
        }
        return next()
      }
      void Promise.all([next(), next(), next()])
    }, 500)
    return () => window.clearTimeout(t)
  }, [links])

  // Vmake: the account as last seen at once, checked again when the box is ticked.
  useEffect(() => {
    if (!vmakeOn) return
    if (!account) void window.studio.services.vmakeKnown().then((a) => setAccount((now) => now ?? a))
    void window.studio.services.keys().then(async (k) => {
      setHasKey(k.vmake)
      vmakeTokenSet(k.vmake)
      if (!k.vmake) return
      const r = await vmakeCheck()
      if ('error' in r) {
        if (r.auth) setHasKey(false)
      } else setAccount(r)
    })
  }, [vmakeOn])

  const saveToken = async () => {
    const r = await window.studio.services.setKey('vmake', token)
    if (r.error) return setError(r.error)
    setToken('')
    setHasKey(true)
    vmakeTokenSet(true)
    const a = await vmakeCheck()
    if (!('error' in a)) setAccount(a)
  }

  const remove = (link: string) => setText((t) => t.split('\n').filter((line) => !line.includes(link)).join('\n'))
  const ready = links.filter((l) => looked[l]?.state === 'ok')
  const looking = links.some((l) => !looked[l] || looked[l].state === 'looking')
  const videos = ready.filter((l) => picks[l]?.kind !== 'mp3')
  const price = account?.prices[model]
  const vmakeUsed = vmakeOn && videos.length > 0
  const tooLong = vmakeUsed && price?.durationLimit ? videos.filter((l) => (looked[l] as { probe: DownloadProbe }).probe.duration > price.durationLimit) : []
  const vmakeBlocked = vmakeUsed && (!hasKey || !price || tooLong.length > 0)

  const start = async () => {
    setError('')
    setStarting(true)
    try {
      await startDownloads(
        ready.map((l) => {
          const p = (looked[l] as { probe: DownloadProbe }).probe
          const pick = picks[l] ?? { kind: 'mp4', quality: p.ladder[0]?.id ?? '' }
          return { probe: p.probe, url: p.url, title: p.title, platform: p.platform, kind: pick.kind, quality: pick.kind === 'mp3' ? '' : pick.quality, vmake: vmakeOn && pick.kind === 'mp4' ? model : '' }
        }),
      )
      setText('')
      setPicks({})
    } finally {
      setStarting(false)
    }
  }

  const recent = jobs.filter((j) => RUNNING.includes(j.state) || Date.now() - j.startedAt < 24 * 3600_000)

  return (
    <>
      <div className="modal-body">
        <label className="field-block">
          <span className="field-label">Links, one per line</span>
          <textarea className="lib-textarea text-input dl-links" value={text} onChange={(e) => setText(e.target.value)} placeholder="TikTok, Instagram, YouTube or Facebook ad library links" spellCheck={false} data-autofocus />
        </label>
        {links.length > 0 && (
          <div className="dl-rows" aria-label="Links">
            {links.map((l) => {
              const r = looked[l]
              const pick = picks[l]
              const probe = r?.state === 'ok' ? r.probe : null
              return (
                <div key={l} className={`dl-row${r?.state === 'failed' ? ' failed' : ''}`}>
                  {probe?.thumb ? <img className="dl-thumb" src={probe.thumb} alt="" /> : <span className="dl-thumb" aria-hidden="true" />}
                  <span className="dl-text">
                    <span className="dl-title">{probe ? probe.title : l}</span>
                    <span className="dl-meta">{!r || r.state === 'looking' ? 'Looking it up…' : r.state === 'failed' ? r.error : [probe!.platformLabel, length(probe!.duration), probe!.uploader].filter(Boolean).join(' · ')}</span>
                  </span>
                  {probe && pick && (
                    <>
                      <Pills
                        label="File"
                        variant="seg"
                        items={[
                          ['mp4', 'MP4'],
                          ['mp3', 'MP3'],
                        ]}
                        value={pick.kind}
                        onPick={(k) => setPicks((now) => ({ ...now, [l]: { ...pick, kind: k as Pick['kind'] } }))}
                      />
                      <Select small label="Quality" value={pick.kind === 'mp3' ? 'mp3' : pick.quality} options={pick.kind === 'mp3' ? [['mp3', 'Sound only']] : probe.ladder.map((q) => [q.id, q.label] as [string, string])} disabled={pick.kind === 'mp3' || probe.ladder.length < 2} onChange={(q) => setPicks((now) => ({ ...now, [l]: { ...pick, quality: q } }))} />
                    </>
                  )}
                  <button type="button" className="icon-button dl-remove" aria-label="Remove this link" title="Remove this link" onClick={() => remove(l)}>
                    <Icon name="close" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <div className="field-block">
          <label className="check">
            <input type="checkbox" checked={vmakeOn} onChange={(e) => setVmakeOn(e.target.checked)} />
            Remove the on-screen text with Vmake once it’s in (videos only; your own Vmake account and credits)
          </label>
          {vmakeOn && hasKey === false && (
            <div className="dl-vmake">
              <div className="folder-row">
                <input className="text-input" style={{ flex: 1 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the access-token header from vmake.ai" spellCheck={false} autoComplete="off" />
                <button type="button" className="button" onClick={() => void saveToken()} disabled={!token.trim()}>
                  Save
                </button>
              </div>
              <p className="hint">
                <a href="https://vmake.ai" target="_blank" rel="noreferrer">
                  vmake.ai
                </a>{' '}
                while signed in → F12 → Network → any request to wapi.vmake.ai → Request Headers → copy access-token. Studio keeps it encrypted on this computer.
              </p>
            </div>
          )}
          {vmakeOn && hasKey && (
            <div className="dl-vmake">
              <Select
                label="Removal model"
                value={model}
                options={Object.entries(account?.models ?? {}).map(([key, m]) => {
                  const p = account?.prices[key]
                  return [key, `${m.name}${!p ? ' · not offered now' : p.credits != null ? ` · ${p.credits} credits` : ''}${p?.durationLimit ? ` · up to ${Math.round(p.durationLimit / 60)} min` : ''}`] as [string, string]
                })}
                onChange={setModel}
              />
              {account?.balance != null && <span className="dl-meta">Balance: {account.balance} credits</span>}
              {!price && <p className="error">That model isn’t offered now; pick another.</p>}
              {tooLong.length > 0 && (
                <p className="error">
                  {account?.models[model]?.name} takes videos up to {Math.round((price?.durationLimit ?? 0) / 60)} min; {tooLong.length === 1 ? 'one link is' : `${tooLong.length} links are`} longer. Untick it, make those MP3, or pick another model.
                </p>
              )}
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {recent.length > 0 && (
          <div className="field-block">
            <span className="field-label">This project’s downloads</span>
            <div className="dl-jobs" aria-label="Downloads">
              {recent.map((j) => (
                <div key={j.id} className={`dl-job${j.state === 'failed' ? ' failed' : ''}`}>
                  <span className="dl-title" title={j.url}>
                    {j.title}
                    <span className="dl-kind">{j.kind.toUpperCase()}</span>
                  </span>
                  <span className="dl-meta" title={jobLine(j)}>
                    {jobLine(j)}
                  </span>
                  {RUNNING.includes(j.state) ? (
                    <button type="button" className="lib-link" onClick={() => void cancelDownload(j.id)}>
                      Cancel
                    </button>
                  ) : (
                    <span />
                  )}
                  {RUNNING.includes(j.state) && (
                    <span className="dl-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(j.fraction * 100)}%` }} />
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer>
        <span className="footer-note" title="Saved in the project’s downloads folder and added to its library. Downloads carry on with this closed, and after a restart.">Saved into this project’s library; carries on if closed.</span>
        <button type="button" className="button" onClick={close}>
          Close
        </button>
        <button type="button" className="button primary" disabled={!dir || !ready.length || looking || starting || vmakeBlocked} onClick={() => void start()}>
          {ready.length > 1 ? `Download ${ready.length}` : 'Download'}
        </button>
      </footer>
    </>
  )
}
