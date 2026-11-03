# Contract v2: everything the library tabs and inspector do

One spec shared by the engine work, the renderer work and the MCP work, so they can be
built at the same time. JSON names are camelCase; every new model field has a serde
default, so old projects load. All picture work runs in the one graph (crates/media/src/graph.rs),
so preview, the paused frame (`frame_at`) and export always match.

## Tracks

`Track.kind` stays `video` | `audio`. A video track that isn't `main` is an **overlay
track**, drawn over the main track. Later tracks in `project.tracks` are drawn on top.
`Track.role` says what it holds; the timeline colours tracks by it:

| role | holds | timeline colour |
|---|---|---|
| `text` | text clips | `#E8C050` |
| `captions` | caption lines (text clips) | `#9996FC` |
| `sticker` | images, GIF, WebM, emoji stickers | `#DA8CCC` |
| `overlay` | video or picture on top of the main track | `#C4C4CA` |
| `adjust` | adjustment layers | `#74BE59` |
| `voice`, `music`, `""` | sound (as now) | as now |

Every new visual item goes on **its own new track** on top ("Each gets its own track"),
unless the call names a `trackId`. An empty non-main track is removed, as audio tracks are now.

## Clips: new fields (all optional, defaults in brackets)

Look fields that already exist apply to overlay clips too: `scale`, `posX`, `posY`,
`rotation`, `opacity`, colour, `speed`, `reverse`, `keyframes`, `crop`, `flip`, `rotate`, `fit`.
For overlay clips, `fit` means "fill" or "fit" against the frame. Scale 100 = that size.

- `flipV` [false]: vertical flip.
- `transformOn` [true]: false bypasses scale, pos, rotation and opacity (the values are kept).
- `blend` ["normal"]: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `add`, `softlight`, `difference`. Overlay clips only.
- `effects` [[]]: `[{ name, amount }]`, `amount` 0–100. Names are the Effects tab's tiles; the engine maps each to filters:
  - `Blur`
  - `Glow`
  - `Film grain`
  - `VHS`
  - `Glitch`
  - `Shake`
  - `Zoom pulse`
  - `Sharpen`
  - `Black & white`
  - `Sepia`
  - `Vintage`
  - `Chromatic`
  - `Pixelate`
  - `Mirror`
  - `Edge`
  - `Invert`
  - `Light leak`
  - `Lens distort`

  A name the engine doesn't know is refused with an error naming it. **The renderer must use the exact list the engine exposes** through `engine.effects` (below).
- `transition` [null]: on a **main-track** clip, the transition *into* this clip from the clip before it: `{ name, durationUs }`.
  - Names (xfade):
    - `Dissolve` = fade
    - `Fade through black` = fadeblack
    - `Fade through white` = fadewhite
    - `Wipe left` = wipeleft
    - `Wipe right` = wiperight
    - `Slide up` = slideup
    - `Slide down` = slidedown
    - `Slide left` = slideleft
    - `Slide right` = slideright
    - `Zoom in` = zoomin
    - `Circle` = circleopen
    - `Pixelize` = pixelize
    - `Blur` = hblur
    - `Radial` = radial
    - `Squeeze` = squeezeh
    - `Smooth` = smoothleft
  - **The total length doesn't change.** The clip before runs on for d/2 past the cut and the clip after starts d/2 early, using source handles where they exist and held frames (tpad) where not.
  - `engine.transitions` lists the names.
- `hsl` [{}]: `{ Red|Orange|Yellow|Green|Cyan|Blue|Purple|Magenta: { h, s, l } }`, each −100…100. The ranges are approximated with `huesaturation` colour selections; say in code which ranges share a selection.
- `curves` [{}]: `{ master?, red?, green?, blue? }`, each a list of `[x, y]` points in 0…1 → `curves`.
- `wheels` [{}]: `{ lift?, gamma?, gain? }`, each `{ x, y, lum }`, with x and y in −1…1 (the colour push) and lum in −100…100.
- `lut` [null]: `{ path, strength }`. A `.cube` file; strength 0–100 blends with the original.
- `stabilize` [null]: `{ strength }`, 0–100. A two-pass vidstab that caches its transforms per clip under `cache/<mediaId>/stab-*.trf`. While the analysis isn't ready, playback shows the clip unstabilised and export waits for it.
- `smooth` [null]: `{ quality: "Fast" | "Best" }` for slow clips (speed < 1). Fast = `framerate`; Best = `minterpolate` (slow). **Export only**; preview shows plain slow motion.
- `keepPitch` [true]: with speed ≠ 1. False lets the pitch follow the speed.
- `speedCurve` [null]: `{ name, points: [[t, speed]…] }`, t 0…1 over the clip and speed 0.1…10. Time is remapped with setpts. Sound is silenced on a curved clip, as CapCut does.
- `mask` [null]: `{ shape: "line"|"mirror"|"circle"|"rect"|"heart"|"star", x, y, w, h, rotation, feather, invert }`, in fractions of the frame (feather 0–100). The renderer also writes the mask as a PNG (`maskPng`); the engine uses the PNG (alphamerge), so shapes match exactly.
- `matte` [null]: `{ path }`. A grey video of the clip (white = keep), made by background removal. The engine alphamerges it and composites over what's below (black on the main track).
- `anim` [{}]: `{ in?: { name, durationUs }, out?: {…}, loop?: { name, periodUs } }`.
  - Names:
    - `Fade`
    - `Slide up`
    - `Slide down`
    - `Slide left`
    - `Slide right`
    - `Zoom in`
    - `Zoom out`
    - `Pop`
    - `Spin`
    - `Blur in`
    - `Typewriter` (text only: a left-to-right reveal)
  - Loop names:
    - `Pulse`
    - `Float`
    - `Wiggle`
    - `Spin`
  - Built from the same expressions as keyframes.
- `text` [null]: a text clip. It has no media; `mediaId` is "". Fields:
  `{ content, font, size, weight, color, align, lineHeight, letterSpacing, case, stroke: {color,width}|null, background: {color,opacity,radius,padding}|null, shadow: {color,blur,x,y}|null, preset, png, boxW, boxH }`.
  - The **renderer draws the text** (Canvas 2D, the app's own fonts) to a transparent PNG at project resolution.
  - It saves the PNG under `<project>.studio/text/<clipId>-<n>.png` and passes `png`.
  - The engine composites `png` like a still image, with the look fields, anim and keyframes.
- `caption` [false]: true on caption lines; their track has role `captions`.

## RPC

- `engine.effects` → `[name]`; `engine.transitions` → `[name]`.
- `overlay.add { mediaId?, text?, atUs, durationUs?, role, trackId?, newTrackAt? }` → `{ clipId, trackId }`.
  - The default length is the media's length, or 3 s for images and text.
  - It goes on a new track on top unless `trackId` is given.
  - `newTrackAt` (an index in `project.tracks`): on a new track of its role made there, as when it is dropped between two rows.
- `text.add { atUs, text, durationUs?, trackId?, newTrackAt? }` → `{ clipId, trackId }`, the same as `overlay.add` with role `text`.
- `timeline.move { clipId, startUs, trackId?, newTrackAt? }`: with `newTrackAt`, onto a new track made at that index in `project.tracks` (between two rows, above them all, or under the sound), returning `{ trackId }`. Sound gets a sound track; a picture a track of its own track's role, so a caption line stays on a captions track; a main-track picture an overlay track. A picture track always sits above the main track.
- `timeline.moveMany { moves: [{ clipId, startUs }] }`: several clips to their own new starts, each on its own track (a selection dragged together), one undo step.
  - A clip goes onto a named track only if the track holds its kind: any sound track for sound; for pictures, a track of the same role (else, as before, its own track or a new one just above it).
- `text.set { clipId, text }` merges `text`. Send a new `png` with it.
- `adjust.add { atUs, durationUs? }` → `{ clipId, trackId }`: an adjustment layer (role `adjust`).
  - Its look fields (colour, hsl, curves, wheels, lut, effects) apply to everything below it while it plays.
- `transition.set { clipId, name|null, durationUs? }`: on a main-track clip.
- `transition.setAll { name|null, durationUs }`: every cut on the main track.
- `captions.set { trackId?, aboveTrackId?, lines: [{ startUs, endUs, text, png, words? }], style }` → `{ trackId, clipIds }`. Without `trackId` a new captions track is made: on top, or just above `aboveTrackId`.
  - Replaces the lines of that captions track, or makes a new one.
  - `style` is the text fields the lines share.
- `clip.set` takes every new field above.
- Audio page:
  - `audio.crossfade { clipIds: [a, b], durationUs }`: on one track, b is moved to overlap a's end by `durationUs`. Both get matching fades, and overlap is allowed for that pair on audio tracks.
  - `audio.spectralDelete { clipId, startUs, endUs, lowHz, highHz }`: stored on the clip as `spectral: [{ startUs, endUs, lowHz, highHz }]` and applied as `bandreject` enabled between the times.
  - `audio.drawSamples { clipId, atUs, samples: [f32…], rate }`: writes a corrected copy of the sound (WAV under `<project>.studio/edits/`) and points the clip at it, as one undo step.
- `project.setOptions` also takes `brand: { colors: [hex], fonts: [name] }`, saved in the project.

## Busy clips (Vmake text removal, 2026-10-27)

- `busy` [absent]: on a clip while outside work makes a new file for it, the job's id (the Vmake job in `<project>.studio/jobs.json`). Saved in project.json; not part of the undo history.
- While a clip is busy, no edit may change or remove it, whoever sends it (the app, MCP, undo, redo, `history.goto`): every `Doc` edit is checked with `Project::busy_kept`, and refused with "Text is still being removed from <file>…". It may still move along its track as clips before it come and go (a ripple). Copies of it (paste) aren't busy.
- `clip.busy { clipId, job }`: marks it. `clip.release { clipId, job }` → `{ released }`: clears the mark if it is that job's (a cancelled or failed job). Neither is an undo step.
- `clip.replaceMedia { clipId, mediaId, job, label? }`: with `job`, the job's result. It clears the mark and replaces the media as one undo step, which never makes the clip busy again.
- All three (and `replaceMedia` with `job`) are the app's only: an MCP client (`_actor` other than "you") is refused. `project.summary` says which clips are busy.

## Files the renderer writes (main-process IPC, project folder only)

`<project>.studio/text/*.png`, `<project>.studio/masks/*.png`, `<project>.studio/mattes/*.mp4`, `<project>.studio/stickers/*.png`.

## Who builds what

- **Engine:** everything under "Clips", "RPC" and the audio items, in crates/.
- **Renderer:**
  - Library tabs: Text, Stickers, Effects, Transitions, Captions, Audio › Music and Sound effects.
  - The Inspector controls, text drawing, masks, background removal and auto reframe (MediaPipe).
  - The services in the main process:
    - captions transcription: the transcript server (no key), proofread against the voiceover's ElevenLabs script
    - other languages: each from its own voiceover and script (no text translation)
    - the sound effects set and the music folder
- **MCP:** a `studio-mcp` binary speaking MCP over stdio to the running engine, actor tagging, and permissions.
- **Timeline, menus, shell and integration:** the lead.

## For MCP (engine side)

- **Who made an edit:** any JSON-RPC request may carry `_actor` in its params (for example `"claude"`). Edits record it as the history actor instead of `"you"`. `history.list` returns it, and the UI shows "Claude · MCP" for anything not "you".
- **`preview.frame { atUs, width? }`** → `{ path }`. A PNG of the composited frame at `atUs` (default width 540), in `cache/frames/`. It lets an agent see its work.
- **`project.summary`** → `{ text }`. The timeline as readable lines: tracks, clips with names, times, look settings, text content and captions.
- **Settings:** `project.setOptions { mcp: { allowed: "all" | "edit" | "look", askBeforeExport: bool } }`. Saved in the project; the default is `{ allowed: "all", askBeforeExport: true }`.
- **Approvals:** `approval.request { what, detail }` blocks until the user answers.
  - The engine emits the `approval.requested { id, what, detail }` event.
  - The UI answers with `approval.answer { id, ok }`, and the request returns `{ ok }`.
  - With no UI connected, it returns `{ ok: false, reason: "no window open" }`.
- **Status:** `mcp.status` → `{ clients: n, lastSeen }`. The `studio-mcp` binary sends `mcp.hello` when it connects and `mcp.bye` when it leaves. The engine counts the open connections that said hello.
- **Finding the engine:** it writes `<user data>/engine.json` `{ socket, pid, projectsDir }` on start (the user data folder is passed as `--user-data`, or else `%APPDATA%/Studio` or `~/.config/Studio`), and removes the file on exit.
