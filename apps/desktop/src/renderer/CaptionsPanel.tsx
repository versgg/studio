// The Inspector's Captions tab, shown for a caption line: every line of its language (on all
// its rows) under a header that stays put: the language and its count, shown on the video or
// not, .srt, find (and replace all), and words per caption. Each line shows when it starts and
// ends; the one being said is highlighted word by word as it plays (and kept in view). One
// click in a line puts the cursor there; Enter splits the line at the cursor (at its end it
// adds a new line after it) and Backspace at its start joins it to the line before, each part
// keeping the voice's own timing from the words' times the lines keep (nothing is heard
// again). Hovering a line offers a new line after it and deleting it.
//
// With hundreds of lines this has to stay light while playing: the tab only re-renders when the
// line or word being said changes (not on every position tick), and each row is memoised, so a
// tick redraws the one or two rows it touches.

import './captions-panel.css'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from 'react'
import { Stepper } from './controls'
import { DIcon, LIB_ICONS } from './design-icons'
import { Note } from './InspectorBlocks'
import { addCaptionLineAfter, burnCaptions, canResplit, captionTracks, editCaptionLine, estimatedTimes, exportSrt, findPattern, groupLines, joinCaptionLine, joinNextCaptionLine, langName, replaceInCaptions, resplitCaptions, splitCaptionLine, wordAt, wordsLabel } from './captions'
import { previewTextLook } from './liveText'
import { getState, seek, setState, toast, useStore, type Clip, type Track } from './store'
import { useUi } from './ui-state'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (us: number) => {
  const cs = Math.round(Math.max(0, us) / 10_000)
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`
}

const ICON = {
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M2.5 2.5l11 11',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 8.5h5.6l.7-8.5',
}

/** Where in a line's text a click landed, as a character offset. */
function caretAt(e: MouseEvent, el: HTMLElement): number {
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY)
  const all = el.textContent?.length ?? 0
  if (!r || !el.contains(r.startContainer)) return all
  let n = 0
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (t === r.startContainer) return n + r.startOffset
    n += t.textContent?.length ?? 0
  }
  return all
}

/** The line being said at `pos` (by binary search over the lines in time order) and its word: "id:word", or "". */
function sayingAt(lines: { clip: Clip }[], pos: number) {
  let lo = 0, hi = lines.length - 1, at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].clip.startUs <= pos) (at = mid), (lo = mid + 1)
    else hi = mid - 1
  }
  const c = at >= 0 ? lines[at].clip : undefined
  return c && pos < c.startUs + c.durationUs ? `${c.id}:${wordAt(c, pos)}` : ''
}

/** What a row can do; one object for every row, so rows only re-render when their own line changes. */
type Act = {
  open: (id: string, caret: number, at?: number) => void
  close: (id: string) => void
  commit: (trackId: string, id: string, text: string) => void
  split: (trackId: string, c: Clip, before: string, after: string) => void
  join: (trackId: string, id: string, text: string) => void
  joinNext: (trackId: string, id: string, text: string) => void
  move: (index: number, step: number, caret: number) => void
  insertAfter: (trackId: string, c: Clip) => void
  remove: (trackId: string, id: string) => void
}

export function CaptionLinesTab({ track }: { track: Track }) {
  const snap = useStore((s) => s.snap)
  const lines = useMemo(() => groupLines(snap, track.id), [snap, track.id])
  const info = useMemo(() => captionTracks(snap).find((t) => t.track.id === track.id), [snap, track.id])
  const linesRef = useRef(lines)
  linesRef.current = lines
  // Re-renders when the line or word being said changes, not on every tick of the playhead.
  const saying = useStore((s) => sayingAt(linesRef.current, s.positionUs))
  const [nowId, nowWord] = saying ? [saying.slice(0, saying.lastIndexOf(':')), Number(saying.slice(saying.lastIndexOf(':') + 1))] : ['', -1]
  const [perCaption, setPerCaption] = useUi('lib.capWords', 0)
  const [editing, setEditing] = useState<{ id: string; caret: number } | null>(null)
  const [query, setQuery] = useState('')
  const [replacing, setReplacing] = useState<string | null>(null)
  const [hit, setHit] = useState(0)
  const list = useRef<HTMLOListElement>(null)
  const matches = useMemo(() => (query.trim() ? lines.filter((l) => findPattern(query).test(l.clip.text?.content ?? '')).map((l) => l.clip) : []), [lines, query])
  // The line being said stays in view as it plays (not while typing or finding).
  useEffect(() => {
    if (editing || query || !nowId) return
    list.current?.querySelector(`[data-line="${nowId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [nowId])

  const act = useRef<Act>(null!)
  act.current = {
    open: (id, caret, at) => {
      setState({ selection: [id] })
      if (at != null) seek(at)
      setEditing({ id, caret })
    },
    close: (id) => setEditing((e) => (e?.id === id ? null : e)),
    commit: (trackId, id, text) => void editCaptionLine(trackId, id, text),
    split: async (trackId, c, before, after) => {
      // At the end of the line: a new line after it. Else typing carries on at the start of the second part.
      if (!after.trim()) {
        const id = await addCaptionLineAfter(trackId, c.id, before)
        if (id) act.current.open(id, 0, c.startUs + c.durationUs)
        return
      }
      const r = await splitCaptionLine(trackId, c.id, before, after)
      if (r?.ids[r.index + 1]) act.current.open(r.ids[r.index + 1], 0)
    },
    join: async (trackId, id, text) => {
      const r = await joinCaptionLine(trackId, id, text)
      if (r?.ids[r.index]) act.current.open(r.ids[r.index], r.caret)
    },
    joinNext: async (trackId, id, text) => {
      const r = await joinNextCaptionLine(trackId, id, text)
      if (r?.ids[r.index]) act.current.open(r.ids[r.index], r.caret)
    },
    move: (index, step, caret) => {
      const next = linesRef.current[index + step]?.clip
      if (next) act.current.open(next.id, Math.min(caret, next.text?.content.length ?? 0), next.startUs)
    },
    insertAfter: async (trackId, c) => {
      const id = await addCaptionLineAfter(trackId, c.id)
      if (id) act.current.open(id, 0, c.startUs + c.durationUs)
    },
    remove: (trackId, id) => void editCaptionLine(trackId, id, ''),
  }

  if (!lines.length) return null
  const resplit = canResplit(track.id)
  /** Find: the next (or previous) line with it, selected, under the playhead and in view. */
  const go = (step: number) => {
    if (!matches.length) return
    const k = (hit + step + matches.length) % matches.length
    setHit(k)
    const c = matches[k]
    setState({ selection: [c.id] })
    seek(c.startUs)
    requestAnimationFrame(() => list.current?.querySelector(`[data-line="${c.id}"]`)?.scrollIntoView({ block: 'center' }))
  }
  const replaceAll = async () => {
    const n = await replaceInCaptions(track.id, query, replacing ?? '')
    toast(n ? `Replaced in ${n} line${n === 1 ? '' : 's'}.` : `No line has “${query.trim()}”.`)
    if (n) setQuery((replacing ?? '').trim())
    setHit(0)
  }
  const shown = !track.hidden
  return (
    <>
      <div className="cap-head">
        <div className="cap-top">
          <span className="cap-title">
            {info?.lang ? `${langName(info.lang)} captions` : 'Captions'}
            <span className="cap-count">{lines.length} lines</span>
          </span>
          <button type="button" className={`cap-tool${shown ? ' on' : ''}`} aria-pressed={shown} title={shown ? 'On the video (and in every export). Click to leave them out.' : 'Left out of the video. Click to show them.'} onClick={() => void burnCaptions(track.id, !shown)}>
            <DIcon d={shown ? ICON.eye : ICON.eyeOff} size={14} />
            <span>{shown ? 'On video' : 'Hidden'}</span>
          </button>
          <button type="button" className="cap-tool" title="Save the lines as an .srt file" onClick={() => void exportSrt(track.id)}>
            <span>.srt</span>
          </button>
        </div>
        <div className="cap-find">
          <DIcon d={LIB_ICONS.search} size={13} />
          <input
            aria-label="Find in captions"
            placeholder="Find in captions"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setHit(0)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query.trim() && (
            <>
              <span className="cap-hits">{matches.length ? `${Math.min(hit + 1, matches.length)} of ${matches.length}` : 'None'}</span>
              <button type="button" className="cap-icon" aria-label="Previous" title="Previous (Shift+Enter)" disabled={!matches.length} onClick={() => go(-1)}>
                <DIcon d={ICON.up} size={13} />
              </button>
              <button type="button" className="cap-icon" aria-label="Next" title="Next (Enter)" disabled={!matches.length} onClick={() => go(1)}>
                <DIcon d={ICON.down} size={13} />
              </button>
            </>
          )}
          <button type="button" className={`cap-tool${replacing != null ? ' on' : ''}`} aria-pressed={replacing != null} title="Replace a word in every line" onClick={() => setReplacing((r) => (r == null ? '' : null))}>
            <span>Replace</span>
          </button>
        </div>
        {replacing != null && (
          <div className="cap-find cap-replace">
            <input aria-label="Replace with" placeholder="Replace with" value={replacing} spellCheck={false} onChange={(e) => setReplacing(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && query.trim() && void replaceAll())} />
            <button type="button" className="button" disabled={!query.trim() || !matches.length} onClick={() => void replaceAll()}>
              {matches.length ? `Replace in ${matches.length}` : 'Replace all'}
            </button>
          </div>
        )}
        <div className="cap-split">
          <span>Words per caption</span>
          <Stepper
            label="Words per caption"
            value={perCaption}
            onChange={(v) => {
              setPerCaption(v)
              if (resplit) void resplitCaptions(track.id, v)
            }}
            min={0}
            max={40}
            step={1}
            format={(n) => (n <= 0 ? wordsLabel(n) : `${n} per caption`)}
            // Type a number of words; 0, nothing or "sentence" is a sentence each.
            parse={(t) => (/^\s*(s|by|sentence)/i.test(t) || !t.trim() ? 0 : Number.parseInt(t, 10) >= 0 ? Number.parseInt(t, 10) : null)}
          />
        </div>
      </div>
      {resplit && estimatedTimes(track.id) && <Note>These lines were made before Studio kept each word’s time, so the times are shared out over each line by its length. Make the captions again for the voice’s exact times.</Note>}
      <ol className="cap-lines" ref={list} aria-label="Caption lines">
        {lines.map(({ clip: c, trackId }, i) => (
          <CaptionRow key={c.id} clip={c} trackId={trackId} index={i} now={c.id === nowId} word={c.id === nowId ? nowWord : -1} caret={editing?.id === c.id ? editing.caret : null} query={query.trim()} act={act} />
        ))}
      </ol>
      <p className="cap-hint">Click a line to type in it. Enter splits it, Backspace at its start joins it to the line before, ↑ ↓ go to the next line; the timing stays with the voice.</p>
    </>
  )
}

const CaptionRow = memo(function CaptionRow({ clip, trackId, index, now, word, caret, query, act }: { clip: Clip; trackId: string; index: number; now: boolean; word: number; caret: number | null; query: string; act: MutableRefObject<Act> }) {
  const text = clip.text?.content ?? ''
  const input = useRef<HTMLInputElement>(null)
  const span = useRef<HTMLSpanElement>(null)
  // A split or join sets the lines again; the field it leaves mustn't also save its text.
  const done = useRef(false)
  useLayoutEffect(() => {
    if (caret == null || !input.current) return
    done.current = false
    input.current.focus()
    input.current.setSelectionRange(caret, caret)
  }, [caret != null, clip.id])
  const words = clip.text?.words
  const tokens = text.split(/(\s+)/)
  const highlight = now && word >= 0 && Array.isArray(words) && tokens.filter((t) => t.trim()).length === words.length
  const found = query && findPattern(query).test(text)
  let w = -1
  const shown = found
    ? text.split(new RegExp(`(${findPattern(query).source})`, 'gi')).map((part, k) => (k % 2 ? <mark key={k} className="cap-found">{part}</mark> : part))
    : highlight
      ? tokens.map((t, k) => {
          if (!t.trim()) return t
          w++
          return w === word ? (
            <mark key={k} className="cap-word">
              {t}
            </mark>
          ) : (
            t
          )
        })
      : text
  const editing = caret != null
  return (
    <li data-line={clip.id} className={`${now ? 'now' : ''}${editing ? ' editing' : ''}${found ? ' found' : ''}`}>
      <button type="button" className="cap-when" title="Go to this line" onClick={() => act.current.open(clip.id, text.length, clip.startUs)}>
        <time>{clock(clip.startUs)}</time>
        <span>{clock(clip.startUs + clip.durationUs).slice(3)}</span>
      </button>
      {editing ? (
        <input
          ref={input}
          className="cap-edit"
          aria-label="Caption line"
          defaultValue={text}
          spellCheck
          // Each key shows in the player at once; the line is drawn when it's saved.
          onChange={(e) => previewTextLook([clip.id], { content: e.currentTarget.value })}
          onBlur={(e) => {
            // Left empty, the line goes (a new line nobody typed in too).
            const v = e.currentTarget.value.trim()
            if (!done.current && (!v || v !== text.trim())) act.current.commit(trackId, clip.id, v)
            act.current.close(clip.id)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            const el = e.currentTarget
            const at = el.selectionStart ?? 0
            if (e.key === 'Enter') {
              e.preventDefault()
              done.current = true
              act.current.split(trackId, clip, el.value.slice(0, at), el.value.slice(at))
            } else if (e.key === 'Backspace' && at === 0 && el.selectionEnd === 0) {
              e.preventDefault()
              done.current = true
              act.current.join(trackId, clip.id, el.value)
            } else if (e.key === 'Delete' && at === el.value.length && el.selectionEnd === at) {
              // The reverse of Backspace: the line below comes up into this one.
              e.preventDefault()
              done.current = true
              act.current.joinNext(trackId, clip.id, el.value)
            } else if (e.key === 'Escape') {
              // A new line left as it came (empty) goes; any other keeps its words.
              done.current = !!text.trim()
              el.value = text
              previewTextLook([clip.id], { content: text })
              el.blur()
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              el.blur()
              act.current.move(index, e.key === 'ArrowUp' ? -1 : 1, at)
            }
          }}
        />
      ) : (
        <span ref={span} className="cap-text" onClick={(e) => act.current.open(clip.id, span.current ? caretAt(e, span.current) : text.length, getState().positionUs >= clip.startUs && getState().positionUs < clip.startUs + clip.durationUs ? undefined : clip.startUs)}>
          {shown || ' '}
        </span>
      )}
      <span className="cap-acts">
        <button type="button" className="cap-icon" aria-label="Add a line after it" title="Add a line after it" onClick={() => act.current.insertAfter(trackId, clip)}>
          <DIcon d={LIB_ICONS.plus} size={12} />
        </button>
        <button type="button" className="cap-icon" aria-label="Delete the line" title="Delete the line" onClick={() => act.current.remove(trackId, clip.id)}>
          <DIcon d={ICON.trash} size={12} />
        </button>
      </span>
    </li>
  )
})
