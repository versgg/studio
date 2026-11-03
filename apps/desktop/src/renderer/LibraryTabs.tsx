// The Library's Text, Stickers, Effects, Transitions, Captions and History tabs, as drawn
// on the Library board. Every tile and button does what it shows (libraryActions.ts and the
// modules it uses); the choices here that only shape the next action (a transition's length,
// how to split caption lines) are kept in ui-state.

import './library-tabs.css'
import './devhooks'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { openMenu } from './ContextMenu'
import { Chips, Pills, Select, SelectButton, Stepper, Toggle } from './controls'
import { DIcon, LIB_ICONS } from './design-icons'
import * as act from './libraryActions'
import { Actions, AddButton, Head, Note, Row, Rows, SearchBox, Setting, Settings, Tile, Tiles } from './LibraryBlocks'
import { captionSources, captionTracks, langName, LANGS, POSITIONS, proofreadOf, scriptOfTrack, subscribeProofreads } from './captions'
import { roleOf } from './audioState'
import { useSavedLooks } from './looks'
import { EMOJI_FONT, STICKER_KINDS, STICKERS, yourStickers, type Art } from './stickers'
import { FONTS } from './textFonts'
import { call, fileUrl, findClip, getState, mediaById, seek, setState, useRunningTask, useStore, type Clip, type Snapshot } from './store'
import { setUi, useUi } from './ui-state'


/** Real frames for the effect and transition previews: the selected clip first, then the project's footage. */
function useFrames(): string[] {
  const media = useStore((s) => s.snap?.project.media)
  const selected = useStore((s) => {
    const f = findClip(s.snap, s.selection[0] ?? '')
    return f ? mediaById(s.snap, f.clip.mediaId)?.poster : null
  })
  const posters = [selected, ...(media ?? []).filter((m) => m.kind !== 'audio' && !m.missing).map((m) => m.poster)].filter((p): p is string => !!p)
  return [...new Set(posters)].slice(0, 2).map(fileUrl)
}

function Frame({ src, style, b, className = 'frame' }: { src?: string; style?: CSSProperties; b?: boolean; className?: string }) {
  return src ? <img className={className} src={src} alt="" draggable={false} style={style} /> : <span className={`${className} blank${b ? ' b' : ''}`} style={style} />
}

/** A list the engine offers (effects, transitions); null while asking, [] if it has none. */
function useEngineList(method: 'engine.effects' | 'engine.transitions') {
  const link = useStore((s) => s.link)
  const [list, setList] = useState<string[] | null>(null)
  useEffect(() => {
    if (link !== 'connected') return
    let live = true
    act
      .engineList(method)
      .then((l) => live && setList(l))
      .catch(() => live && setList([]))
    return () => {
      live = false
    }
  }, [method, link])
  return list
}

// Text

/** "Add text" dragged onto the timeline, which shows where it lands and adds it there (Timeline.tsx). */
export const TEXT_MIME = 'application/x-studio-text'

export function TextTab() {
  const project = useStore((s) => s.snap?.project)
  const brand = act.brandOf(project)
  const [editing, setEditing] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      {/* A click adds it at the playhead; a drag puts it where it's dropped on the timeline. */}
      <div
        className="lib-add-drag"
        draggable={!!project}
        onDragStart={(e) => {
          e.dataTransfer.setData(TEXT_MIME, '1')
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <AddButton title="Add text" sub="Click for its own track at the playhead (T), or drag it onto the timeline. Its look, preset styles and animation are in the Inspector." icon={LIB_ICONS.text} color="#E8C050" onClick={() => act.addText()} />
      </div>
      <Head
        text="Brand kit"
        right={
          <button type="button" className="lib-link" onClick={() => setEditing(!editing)} disabled={!project}>
            {editing ? 'Done' : 'Edit'}
          </button>
        }
      />
      <div className={`lib-swatches${editing ? ' editing' : ''}`}>
        {brand.colors.map((hex) =>
          editing ? (
            <button key={hex} type="button" className="swatch" title={`Remove ${hex}`} aria-label={`Remove ${hex} from the brand kit`} style={{ background: hex }} onClick={() => act.removeBrandColour(hex)}>
              <DIcon d="M5 5l6 6 M11 5l-6 6" size={10} width={1.8} />
            </button>
          ) : (
            <span key={hex} title={hex} style={{ background: hex }} />
          ),
        )}
        <button type="button" aria-label="Add a brand colour" title="Add a brand colour" onClick={() => picker.current?.click()} disabled={!project}>
          <DIcon d={LIB_ICONS.plus} size={12} />
        </button>
        {/* The native change event: once, when the picker closes (not on every drag step). */}
        <input
          ref={(el) => {
            picker.current = el
            if (el) el.onchange = () => act.addBrandColour(el.value)
          }}
          type="color"
          className="lib-colour-input"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
      <Rows>
        {(['Titles', 'Captions'] as const).map((use, i) =>
          editing ? (
            <Settings key={use}>
              <Setting label={`${use} font`}>
                <Select label={`${use} font`} value={brand.fonts[i] ?? FONTS[0].family} options={FONTS.map((f) => [f.family, `${f.label ?? f.family} · ${f.use}`] as [string, string])} onChange={(f) => act.setBrandFont(i, f)} />
              </Setting>
            </Settings>
          ) : (
            <Row key={use} icon={LIB_ICONS.font} name={brand.fonts[i] ?? FONTS[0].family} sub={use} nameClass="brand-font" style={{ ['--brand-font' as string]: `"${brand.fonts[i] ?? FONTS[0].family}"` }} />
          ),
        )}
      </Rows>
      <Note>The brand colours and fonts are offered first in a text clip’s Inspector. They’re saved in this project.</Note>
    </>
  )
}

// Stickers

const artPath = ([d, fill, stroke = 'none', width = 0, transform]: Art, i: number) => <path key={i} d={d} fill={fill} stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" transform={transform} />

export function StickersTab() {
  const [query, setQuery] = useUi('lib.stk.query', '')
  const [kind, setKind] = useUi('lib.stk', 'All')
  const media = useStore((s) => s.snap?.project.media)
  const hasProject = useStore((s) => !!s.snap)
  const q = query.trim().toLowerCase()
  const match = (name: string) => !q || name.toLowerCase().includes(q)
  const shown = kind === 'Yours' ? [] : STICKERS.filter((s) => (kind === 'All' || s.kinds.includes(kind)) && (match(s.name) || s.kinds.some((k) => match(k))))
  const yours = kind === 'All' || kind === 'Yours' ? yourStickers(media).filter((m) => match(m.name)) : []
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Search stickers" />
      <Chips items={STICKER_KINDS} value={kind} onPick={setKind} />
      <Tiles cols={4}>
        {shown.map((s) => (
          <Tile key={s.name} name={s.name} h={72} onClick={() => act.addSticker(s)} disabled={!hasProject} title={`Add the ${s.name} sticker at the playhead`}>
            {s.emoji ? (
              <span className="sample emoji" style={{ fontFamily: EMOJI_FONT }}>
                {s.emoji}
              </span>
            ) : (
              <svg className="art" width="100%" height="100%" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                {s.art?.map(artPath)}
              </svg>
            )}
          </Tile>
        ))}
        {yours.map((m) => (
          <Tile key={m.id} name={m.name.replace(/\.[^.]+$/, '')} h={72} onClick={() => act.addYourSticker(m)} title={`Add ${m.name} at the playhead`}>
            {m.poster ? <img className="frame contain" src={fileUrl(m.poster)} alt="" draggable={false} /> : <span className="sample">{m.name.split('.').pop()?.toUpperCase()}</span>}
          </Tile>
        ))}
        {(kind === 'All' || kind === 'Yours') && (
          <Tile name="Upload yours" h={72} onClick={act.uploadSticker} disabled={!hasProject}>
            <span className="upload">
              <DIcon d={LIB_ICONS.plus} size={16} />
            </span>
          </Tile>
        )}
      </Tiles>
      {!shown.length && !yours.length && kind !== 'Yours' && <Note>No sticker by that name.</Note>}
      <Note>Your own PNG, GIF, WebP or WebM with transparency works too. It’s copied into the project.</Note>
    </>
  )
}

// Effects

/** Tile pictures for the engine's effects (a CSS likeness; the engine draws the real thing). */
const FX_LOOK: Record<string, { filter?: string; tf?: string; overlay?: string }> = {
  Blur: { filter: 'blur(2px)' },
  Glow: { filter: 'brightness(1.15) saturate(1.2)', overlay: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,0.35), rgba(255,255,255,0) 60%)' },
  'Film grain': { filter: 'contrast(1.1)', overlay: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.06) 0 1px, rgba(0,0,0,0.06) 1px 2px)' },
  VHS: { filter: 'saturate(1.3) contrast(1.1)', overlay: 'repeating-linear-gradient(0deg, rgba(0,0,0,0) 0 3px, rgba(0,0,0,0.25) 3px 4px)' },
  Glitch: { filter: 'saturate(1.3)', overlay: 'repeating-linear-gradient(0deg, rgba(102,163,255,0.0) 0 9px, rgba(102,163,255,0.35) 9px 12px, rgba(240,128,128,0.0) 12px 20px)' },
  Shake: { tf: 'rotate(-3deg) scale(1.12)' },
  'Zoom pulse': { tf: 'scale(1.18)' },
  Sharpen: { filter: 'contrast(1.25) saturate(1.05)' },
  'Black & white': { filter: 'grayscale(1)' },
  Sepia: { filter: 'sepia(0.9)' },
  Vintage: { filter: 'sepia(0.35) contrast(0.9) brightness(1.05) saturate(0.8)' },
  Chromatic: { filter: 'drop-shadow(2px 0 0 rgba(240,80,80,0.6)) drop-shadow(-2px 0 0 rgba(80,160,255,0.6))' },
  Pixelate: { filter: 'contrast(1.05)', overlay: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 8px), repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 8px)' },
  Mirror: { tf: 'scaleX(-1)' },
  Edge: { filter: 'grayscale(1) contrast(3) invert(1)' },
  Invert: { filter: 'invert(1)' },
  'Light leak': { overlay: 'radial-gradient(circle at 90% 10%, rgba(255,158,101,0.75), rgba(255,158,101,0) 60%)' },
  'Lens distort': { tf: 'scale(1.15)', overlay: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.6) 100%)' },
}

export function EffectsTab() {
  const [sub, setSub] = useUi('lib.fxSub', 'Looks')
  const [frame] = useFrames()
  const saved = useSavedLooks()
  const effects = useEngineList('engine.effects')
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const picked = selection.map((id) => findClip(snap, id)?.clip).filter((c): c is Clip => !!c)
  const hasAll = (name: string) => picked.length > 0 && picked.every((c) => c.effects?.some((e) => e.name === name))
  const lookMenu = (name: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, [{ label: `Delete the look “${name}”`, run: () => act.deleteLook(name) }])
  }
  return (
    <>
      <Pills variant="sub" label="Effect type" items={['Looks', 'Video effects']} value={sub} onPick={setSub} />
      {sub === 'Looks' ? (
        <>
          <Note>One tap gives the selected clips (or an adjustment layer) a whole look. Fine-tune it in the Inspector’s Adjust tab.</Note>
          <Tiles cols={4}>
            {[...act.BUILT_IN_LOOKS, ...saved].map((look) => (
              <Tile key={`${look.saved ? 's' : 'b'}:${look.name}`} name={look.name} h={104} onClick={() => act.applyLook(look)} onContextMenu={look.saved ? lookMenu(look.name) : undefined} title={look.saved ? `${look.name} (saved). Right-click to delete.` : look.name}>
                <Frame src={frame} style={{ filter: look.css }} />
              </Tile>
            ))}
          </Tiles>
          {!saved.length && <Note>Save your own from the Inspector: Adjust › Save as a look.</Note>}
        </>
      ) : (
        <>
          <AddButton title="Add an adjustment layer" sub="Effects and looks on it apply to every clip below" icon={LIB_ICONS.layers} color="#74BE59" onClick={act.addAdjustmentLayer} disabled={!snap} />
          {effects === null ? (
            <Note>Asking the engine for its effects…</Note>
          ) : effects.length === 0 ? (
            <Note>This engine has no video effects.</Note>
          ) : (
            <>
              <Note>Click to add an effect to the selected clips; click again to take it off. Set its amount in the Inspector’s Adjust tab.</Note>
              <Tiles cols={4}>
                {effects.map((name) => {
                  const fx = FX_LOOK[name] ?? {}
                  return (
                    <Tile key={name} name={name} h={104} ring={hasAll(name)} onClick={() => act.toggleEffect(name)}>
                      <Frame src={frame} style={{ filter: fx.filter, transform: fx.tf }} />
                      {fx.overlay && <span className="layer" aria-hidden="true" style={{ background: fx.overlay }} />}
                    </Tile>
                  )
                })}
              </Tiles>
            </>
          )}
        </>
      )}
    </>
  )
}

// Transitions

type AB = { clip?: string; op?: number; tf?: string; overlay?: string; filter?: string; mask?: string }
const TR_LOOK: Record<string, AB> = {
  Dissolve: { op: 0.5 },
  'Fade through black': { op: 0, overlay: 'rgba(0,0,0,0.55)' },
  'Fade through white': { op: 0, overlay: 'rgba(255,255,255,0.55)' },
  Blur: { op: 0.5, filter: 'blur(3px)' },
  'Wipe left': { clip: 'inset(0 0 0 50%)' },
  'Wipe right': { clip: 'inset(0 50% 0 0)' },
  'Slide up': { tf: 'translateY(45%)' },
  'Slide down': { tf: 'translateY(-45%)' },
  'Slide left': { tf: 'translateX(45%)' },
  'Slide right': { tf: 'translateX(-45%)' },
  'Zoom in': { tf: 'scale(0.55)' },
  Squeeze: { tf: 'scaleX(0.4)' },
  Circle: { clip: 'circle(32% at 50% 50%)' },
  Radial: { clip: 'polygon(50% 50%, 50% 0, 100% 0, 100% 100%, 50% 100%)' },
  Smooth: { mask: 'linear-gradient(90deg, transparent 25%, #000 75%)' },
  Pixelize: { op: 0.6, overlay: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.25) 0 1px, transparent 1px 7px), repeating-linear-gradient(90deg, rgba(0,0,0,0.25) 0 1px, transparent 1px 7px)' },
}
const TR_GROUPS: [string, string[]][] = [
  ['Basic', ['Dissolve', 'Fade through black', 'Fade through white', 'Blur']],
  ['Movement', ['Slide up', 'Slide down', 'Slide left', 'Slide right', 'Zoom in', 'Squeeze']],
  ['Wipes and shapes', ['Wipe left', 'Wipe right', 'Circle', 'Radial', 'Smooth', 'Pixelize']],
]
const clockOf = (us: number) => {
  const cs = Math.round(Math.max(0, us) / 10_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(cs / 6000))}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`
}

export function TransitionsTab() {
  const [length, setLength] = useUi('lib.trLen', 0.4)
  const [apply, setApply] = useUi<'This cut' | 'All cuts'>('lib.trApply', 'This cut')
  const [a, b] = useFrames()
  const names = useEngineList('engine.transitions')
  // Re-read on every edit, playhead move and selection change.
  useStore((s) => s.snap?.revision)
  useStore((s) => s.positionUs)
  useStore((s) => s.selection)
  const target = act.cutTarget()
  const current = target?.transition?.name ?? null
  const grouped = names ? TR_GROUPS.map(([g, list]) => [g, list.filter((n) => names.includes(n))] as [string, string[]]) : []
  const rest = names?.filter((n) => !TR_GROUPS.some(([, l]) => l.includes(n))) ?? []
  if (rest.length) grouped.push(['More', rest])
  const tile = (name: string | null) => {
    const t = name ? (TR_LOOK[name] ?? {}) : {}
    const label = name ?? 'None'
    return (
      <Tile key={label} name={label} h={64} ring={apply === 'This cut' && current === name && !!target} onClick={() => act.addTransition(name, length, apply)} title={name ? `${name}, ${length.toFixed(1)} s, on ${apply === 'All cuts' ? 'every cut' : 'this cut'}` : `No transition on ${apply === 'All cuts' ? 'any cut' : 'this cut'}`}>
        <Frame className="layer" src={a} />
        {name && <Frame className="layer" src={b ?? a} b style={{ clipPath: t.clip, opacity: t.op ?? 1, transform: t.tf, filter: t.filter, WebkitMaskImage: t.mask, maskImage: t.mask }} />}
        {!name && <span className="layer cut-line" aria-hidden="true" />}
        {t.overlay && <span className="layer" aria-hidden="true" style={{ background: t.overlay }} />}
      </Tile>
    )
  }
  return (
    <>
      <Settings>
        <Setting label="Default length">
          <Stepper label="Default length" value={length} onChange={setLength} min={0.1} max={3} step={0.1} format={(x) => `${x.toFixed(1)} s`} />
        </Setting>
        <Setting label="Apply to">
          <Pills variant="seg" label="Apply to" items={['This cut', 'All cuts']} value={apply} onPick={(v) => setApply(v as 'This cut' | 'All cuts')} />
        </Setting>
      </Settings>
      {apply === 'This cut' && (
        <Note>
          {target ? (
            <>
              This cut is at <strong>{clockOf(target.startUs)}</strong>
              {current ? `: ${current}, ${((target.transition?.durationUs ?? 0) / 1e6).toFixed(1)} s` : ': a plain cut'}. Select the clip after a cut, or move the playhead, to pick another.
            </>
          ) : (
            'The main track needs two clips for a cut.'
          )}
        </Note>
      )}
      {names === null ? (
        <Note>Asking the engine for its transitions…</Note>
      ) : !names.length ? (
        <Note>This engine has no transitions.</Note>
      ) : (
        grouped.map(([group, list], gi) => (
          <Fragment key={group}>
            <Head text={group} />
            <Tiles cols={4}>
              {gi === 0 && tile(null)}
              {list.map((n) => tile(n))}
            </Tiles>
          </Fragment>
        ))
      )}
    </>
  )
}

// Captions

const LANG_OPTIONS: [string, string][] = [['', 'Detect'], ...LANGS.map((l) => [l.code, l.name] as [string, string])]

/**
 * The script a captions source was read from: its voiceovers' own ElevenLabs scripts until
 * you type or paste one (kept per source), "" when there's none.
 */
function useScript(source: string) {
  const snap = useStore((s) => s.snap)
  const [typed, setTyped] = useUi<string | null>(`lib.capScript.${source}`, null)
  const [own, setOwn] = useState('')
  // Asked again when the source's clips change (a new voiceover on that track).
  const clips = snap?.project.tracks.find((t) => t.id === source)?.clips.map((c) => c.mediaId).join() ?? ''
  useEffect(() => {
    let live = true
    setOwn('')
    if (source) scriptOfTrack(source).then((s) => live && setOwn(s))
    return () => {
      live = false
    }
  }, [source, clips])
  return { text: typed ?? own, own, typed: typed !== null, set: setTyped, reset: () => setTyped(null) }
}

export function CaptionsTab() {
  const snap = useStore((s) => s.snap)
  const sources = captionSources(snap)
  const tracks = captionTracks(snap)
  const [from, setFrom] = useUi('lib.capFrom', '')
  const [language, setLanguage] = useUi('lib.capLang', 'sv')
  const [perCaption] = useUi('lib.capWords', 0)
  const [scriptOpen, setScriptOpen] = useUi('lib.capScriptOpen', false)
  const source = sources.some(([id]) => id === from) ? from : (sources[0]?.[0] ?? '')
  const script = useScript(source)
  const making = useRunningTask('captions')
  // The track with the server's corrections (the one just made), else the first one showing.
  const current = tracks.find((t) => proofreadOf(t.track.id)) ?? tracks.find((t) => !t.track.hidden) ?? tracks[0]
  useSyncExternalStore(subscribeProofreads, () => (current ? proofreadOf(current.track.id) : undefined))
  const proof = current ? proofreadOf(current.track.id) : undefined
  // Voiceovers on tracks of their own: with two or more, each language can come from its own.
  const voiceovers = (snap?.project.tracks ?? []).filter((t) => t.kind === 'audio' && roleOf(t, snap) === 'voice' && t.clips.length).length
  const words = script.text.trim() ? script.text.trim().split(/\s+/).length : 0
  const make = async () => {
    const id = await act.generateCaptions({ sourceTrackId: source, language, perCaption, style: 'Clean', centerY: POSITIONS.Bottom, script: script.text })
    if (id) openCaptions(id)
  }
  const makeEvery = async () => {
    const ids = await act.captionsForEveryVoiceover({ perCaption, style: 'Clean', centerY: POSITIONS.Bottom })
    if (ids.length) openCaptions(ids[0])
  }
  // The captions already here, one row per language (its rows together), to open in the Inspector.
  const languages = [...new Set(tracks.map((t) => t.lang))].map((lang) => {
    const rows = tracks.filter((t) => t.lang === lang)
    return { lang, rows, lines: rows.reduce((n, t) => n + t.lines.length, 0), hidden: rows.every((t) => t.track.hidden) }
  })
  const again = languages.find((l) => l.lang === language && l.lines)
  return (
    <>
      {languages.length > 0 && (
        <>
          <Head text="In this project" />
          <div className="lib-rows">
            {languages.map((l) => (
              <Row
                key={l.lang || 'none'}
                className="cap-lang-row"
                icon={LIB_ICONS.captions}
                name={l.lang ? `${langName(l.lang)} captions` : 'Captions'}
                sub={`${l.lines} line${l.lines === 1 ? '' : 's'}${l.hidden ? ' · left out of the video' : ''}`}
                action="Edit"
                onAction={() => openCaptions(l.rows[0].track.id)}
                onClick={() => openCaptions(l.rows[0].track.id)}
                title="Open its lines, look and timing in the Inspector"
              />
            ))}
          </div>
          <Head text="Make captions" />
        </>
      )}
      <Settings>
        <Setting label="Made from">
          <Select label="Made from" value={source} options={sources.length ? sources : [['', '']]} shown={sources.length ? undefined : 'No sound in the project yet'} disabled={!sources.length} onChange={setFrom} />
        </Setting>
        <Setting label="Language">
          <Select label="Language" value={language} options={LANG_OPTIONS} onChange={setLanguage} />
        </Setting>
        <Setting label="Script">
          {scriptOpen || !words ? (
            <textarea
              className="lib-textarea"
              aria-label="Script"
              rows={3}
              value={script.text}
              placeholder="What’s said, if you have it: misheard words are corrected to it."
              onChange={(e) => script.set(e.target.value)}
              onBlur={() => setScriptOpen(false)}
              spellCheck={false}
            />
          ) : (
            <SelectButton label="Script" value={`${script.typed ? 'Pasted' : 'The voiceover’s'} · ${words} words`} title={script.text.slice(0, 400)} onClick={() => setScriptOpen(true)} />
          )}
        </Setting>
      </Settings>
      {script.typed && script.own && (
        <button type="button" className="lib-link" onClick={script.reset}>
          Use the voiceover’s own script
        </button>
      )}
      <AddButton
        title={again ? `Make the ${langName(again.lang)} captions again` : 'Make captions'}
        sub={again ? `Replaces its ${again.lines} lines${words ? '; every word checked against the script' : ''}` : words ? 'Every word is checked against the script' : 'The lines land on their own track'}
        icon={LIB_ICONS.captions}
        color="#9996FC"
        onClick={make}
        disabled={!source}
        busy={making ? { text: 'Making captions', task: making } : undefined}
      />
      {voiceovers > 1 && <Actions items={[{ label: 'Captions for every voiceover, each in its language', icon: LIB_ICONS.captions, onClick: makeEvery, disabled: !!making }]} />}
      {proof && (
        <>
          <Note>{proof.summary}</Note>
          {proof.changes.length > 0 && (
            <ol className="lib-lines lib-proof">
              {proof.changes.map((c, i) => (
                <li key={i} onClick={() => seek(c.atUs + 1)} title="Go to it">
                  <time>{clockOf(c.atUs)}</time>
                  <span>
                    <s>{c.heard}</s> {c.script}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  )
}

/**
 * Opens a captions track in the Inspector, as CapCut does: its first line selected, on the
 * Captions tab. Asks the engine, since lines set a moment ago may not be in the store's copy yet.
 */
async function openCaptions(trackId: string) {
  const now = ((await window.studio.engine.call('project.current').catch(() => null)) as Snapshot | null) ?? getState().snap
  const info = captionTracks(now).find((t) => t.track.id === trackId)
  if (!info?.lines.length) return
  setUi('insp.capTab', 'captions')
  setState({ selection: [info.lines[0].id], focus: 'timeline' })
}

// History

interface Step {
  index: number
  label: string
  actor: string
  time: string
  revision?: number
}

/** An icon for a step, from words in its label. */
function stepIcon(label: string) {
  const l = label.toLowerCase()
  if (/import|link folder|add media/.test(l)) return LIB_ICONS.import
  if (/record|voice/.test(l)) return LIB_ICONS.mic
  if (/split|trim|delete|cut|remove/.test(l)) return LIB_ICONS.cut
  if (/caption/.test(l)) return LIB_ICONS.captions
  if (/text|title/.test(l)) return LIB_ICONS.text
  if (/transition/.test(l)) return LIB_ICONS.transitions
  if (/scale|transform|rotate|crop|mirror|opacity|keyframe/.test(l)) return LIB_ICONS.scale
  if (/sound|audio|volume|fade|pitch|track|mute|loud|normal|label/.test(l)) return LIB_ICONS.audio
  return LIB_ICONS.plus
}
const byClaude = (actor: string) => /claude|mcp|agent/i.test(actor)
const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
}

/** The project's undo history from the engine (this session's steps), newest last. */
function useHistory() {
  const revision = useStore((s) => s.snap?.revision)
  const dir = useStore((s) => s.snap?.dir)
  const [h, setH] = useState<{ steps: Step[]; current: number }>({ steps: [], current: -1 })
  useEffect(() => {
    let live = true
    window.studio.engine
      .call('history.list')
      .then((r: { steps?: Step[]; current?: number }) => live && setH({ steps: r?.steps ?? [], current: r?.current ?? -1 }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [revision, dir])
  return h
}

/** The engine's MCP status, asked every few seconds; null when the engine has no MCP. */
function useMcpStatus() {
  const link = useStore((s) => s.link)
  const [st, setSt] = useState<{ clients: number; lastSeen?: string | number | null } | null | undefined>(undefined)
  useEffect(() => {
    if (link !== 'connected') return
    let live = true
    const ask = () =>
      window.studio.engine
        .call('mcp.status')
        .then((r: { clients?: number; lastSeen?: string | number | null }) => live && setSt({ clients: Number(r?.clients ?? 0), lastSeen: r?.lastSeen ?? null }))
        .catch(() => live && setSt(null))
    ask()
    const t = window.setInterval(ask, 4000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [link])
  return st
}

const ALLOWED: [string, string][] = [
  ['all', 'Edit, import, add audio'],
  ['edit', 'Edit only'],
  ['look', 'Only look'],
]

export function HistoryTab() {
  const [who, setWho] = useUi('lib.who', 'All')
  const mcp = useStore((s) => s.snap?.project.mcp) ?? { allowed: 'all' as const, askBeforeExport: true }
  const hasProject = useStore((s) => !!s.snap)
  const status = useMcpStatus()
  const { steps, current } = useHistory()
  const goto = (index: number) => {
    const to = Math.max(-1, Math.min(steps.length - 1, index))
    if (to !== current) call('history.goto', { index: to })
  }
  const now = steps[current]
  const anyClaude = steps.some((x) => byClaude(x.actor))
  const seen = status?.lastSeen ? new Date(typeof status.lastSeen === 'number' && status.lastSeen < 1e12 ? status.lastSeen * 1000 : status.lastSeen) : null
  const statusText = status === undefined ? 'Asking the engine…' : status === null ? 'Not connected' : status.clients > 0 ? `${status.clients} agent${status.clients === 1 ? '' : 's'} connected` : seen && !Number.isNaN(seen.getTime()) ? `Waiting · last seen ${seen.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for an agent'
  return (
    <>
      <Pills variant="sub" label="Show" items={['All', 'Claude', 'You']} value={who} onPick={setWho} />
      <div className="lib-stepper">
        <button type="button" className="nav" aria-label="Previous step" onClick={() => goto(current - 1)} disabled={current < 0}>
          <DIcon d={LIB_ICONS.prev} size={12} width={1.6} />
        </button>
        <span className="lib-stepper-text">
          <span>{steps.length ? `Step ${current + 1} of ${steps.length}` : 'No steps yet'}</span>
          <span>{now?.label ?? (steps.length ? 'Before the first step' : 'Edits show up here as you make them')}</span>
        </span>
        <button type="button" className="nav" aria-label="Next step" onClick={() => goto(current + 1)} disabled={current >= steps.length - 1}>
          <DIcon d={LIB_ICONS.next} size={12} width={1.6} />
        </button>
        <button type="button" className="keep" onClick={() => goto(steps.length - 1)} disabled={current >= steps.length - 1} title="Go to the latest step and keep every step">
          Keep all
        </button>
      </div>
      <Head text="This session" right={anyClaude ? 'Claude via MCP, and you' : 'You'} />
      {steps.length === 0 && <Note>Every edit lands here with who made it, and you can step back to any of them.</Note>}
      <ol className="lib-steps">
        {steps.map((st) => {
          const claude = byClaude(st.actor)
          if (!(who === 'All' || (who === 'Claude') === claude)) return null
          const done = st.index <= current
          const color = claude ? '#A9B6FF' : '#E8C050'
          return (
            <li key={st.index} className={`${st.index === current ? 'now' : ''}${done ? '' : ' undone'}`}>
              <DIcon d={stepIcon(st.label)} size={14} stroke={color} />
              <time>{clock(st.time)}</time>
              <span className="lib-steps-text">
                <span>{st.label}</span>
                <span style={{ color }}>{claude ? 'Claude · MCP' : 'You'}</span>
              </span>
              <button
                type="button"
                aria-label={`${done ? 'Undo to before' : 'Redo up to'}: ${st.label}`}
                title={done ? (st.index === current ? 'Undo this step' : 'Undo this step and the ones after it') : 'Redo up to this step'}
                onClick={() => goto(done ? st.index - 1 : st.index)}
              >
                {done ? 'Undo' : 'Redo'}
              </button>
            </li>
          )
        })}
      </ol>
      <Head
        text="Connection"
        right={
          <button type="button" className="lib-link" onClick={() => setState({ dialog: 'mcp' })}>
            Connect…
          </button>
        }
      />
      <Settings>
        <Setting label="MCP server">
          <SelectButton label="MCP server" value={statusText} title="How to connect an agent" onClick={() => setState({ dialog: 'mcp' })} />
        </Setting>
        <Setting label="Allowed to">
          <Select label="Allowed to" value={mcp.allowed} options={ALLOWED} disabled={!hasProject} onChange={(v) => act.setMcp({ allowed: v as 'all' | 'edit' | 'look' })} />
        </Setting>
        <Setting label="Ask before export">
          <Toggle label="Ask before export" on={mcp.askBeforeExport} disabled={!hasProject} onChange={(on) => act.setMcp({ askBeforeExport: on })} />
        </Setting>
      </Settings>
    </>
  )
}
