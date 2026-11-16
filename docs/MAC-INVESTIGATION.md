# Studio on a Mac: what to check, and how to report it

This is a brief for whoever runs Studio on a Mac: a person, or Claude Code working on that Mac. Several problems were reported from a Mac and fixed on Linux, where they can't all be reproduced. This page explains what changed, how to check each fix on the Mac, and exactly what to post back on the GitHub issue that links here.

The repository is **public**. Read "What never goes in an issue" before posting anything.

## What never goes in an issue

Post only two things: the output of `node scripts/mac-report.mjs`, and short answers to the checks below (works / doesn't / what happened).

Never post any of the following:

- project names, file names, or folder paths (your home folder included);
- any words from a project: captions, scripts, translations, on-screen text, voice names;
- API keys, tokens, or anything from Studio's settings;
- screenshots or recordings of a project;
- Studio's log files, `history.jsonl`, `timing.json` files themselves, or a **Share project** zip. These hold project content. If a maintainer needs one, they'll ask for it privately.

`mac-report.mjs` prints numbers only, so it's safe to paste as it is. Read its output once before posting anyway.

Use your own GitHub account. Comment on the issue; send code changes as a pull request from your own fork.

## 1. Update and build

From the folder where Studio was cloned (see `INSTALL.md` for a first install):

```bash
git pull
npm install
npm run doctor
npm run build
npm start
```

`npm run doctor` says what's missing (Node, Rust, FFmpeg and its encoders). FFmpeg comes from Homebrew (`brew install ffmpeg`). Studio started from the Dock or Finder reads your login shell's PATH, so Homebrew's FFmpeg is found there too. `docs/DEVELOPING.md` has every command and test switch.

## 2. The checks

Each check says what was reported, what changed, how to check it, and what to post.

### A. Gaps in dubs and translations

**Reported:** after a dub or a translation, the new voice had long silent gaps between sentences. The project had been imported from CapCut.

**What changed:**

- Heard sentences are cut at most 9 s long, at the longest pause inside. Before, a sentence had no maximum length, so all the pauses in a 10–20 s stretch turned into one gap.
- A clip played at a speed other than 1× no longer spreads its sentences out.
- A short line may start up to 1.2 s earlier, and be spoken down to 0.92× speed, before a gap is left.
- Each language's new voice goes on one voice track of its own, not on whichever track had room.
- Every dub and translation now writes `timing.json`: numbers only, one row per sentence.

**Check:** dub a clip, and translate a project imported from CapCut (the same ones as before, if you can). Play both and note where you hear gaps.

**Post:** the report's timing tables. For each gap you hear, give the row number (the `#` column) and roughly how long it is. The table shows whether a gap comes from a short take (`take` much less than `room`) or from where the line was placed (`placed at`, `moved`, `gap after`).

### B. Dragging a sound clip hesitates, then jumps to another layer

**Reported:** dragging an audio clip to close a gap hesitated, then the clip jumped to another track.

**What changed:**

- The tracks no longer move under the pointer during a drag. Before, the "new track" row appeared and re-centred the tracks by up to 19 px, so the same pointer position landed on another row.
- A clip pushed or snapped into its neighbour on the same row now stops against it, as in CapCut, instead of going to a new track.
- Moving to another row takes 8 px past the row's edge.
- Trackpad momentum is ignored while dragging.
- Ctrl+click (the Mac's right-click) no longer changes the selection before its menu opens.

**Check:** start Studio with the drag trace on:

```bash
STUDIO_DEBUG_DRAG=1 npm start
```

Put two sound clips on one track with a gap between them. Drag the second one toward the first, past its edge, and back. Do it five times: once with a mouse if you have one, and on the trackpad with a quick flick so momentum kicks in.

**Post:** whether the clip stayed on its row, whether it stopped against its neighbour, and the number of any drag that jumped. Then the report's drag table.

### C. Cmd shortcuts and the menu bar

**What changed:** Studio now has a Mac menu bar (Studio, Edit, Window), so the standard Cmd keys reach text fields. Shortcut lists show ⌘ ⌥ ⇧.

**Check:**

1. In a text field (a caption line in the Inspector, a line in the Dub or Translations review), try Cmd+A, Cmd+C, Cmd+X, Cmd+V and Cmd+Z.
2. On the timeline, try Cmd+C, Cmd+V and Cmd+Z on clips.
3. Try Cmd+H (hide), Cmd+M (minimise) and Cmd+Q (quit).
4. Open Help › Keyboard shortcuts and see whether it shows ⌘.

**Post:** a list of what works and what doesn't.

### D. The window buttons

**What changed:** the red, yellow and green buttons sit inside Studio's title bar, with room kept for them.

**Check:** whether they overlap the layout buttons, the project name or anything else. Go to full screen and back, and check again.

**Post:** yes or no, and what overlaps.

### E. Zooming the whole app

**New:** Cmd+Shift+= and Cmd+Shift+− make the whole app bigger and smaller; Cmd+Shift+0 sets it back to 100 %. View has the same three items. Cmd+= and Cmd+− on their own still zoom the timeline.

**Check:** try both kinds of zoom with your keyboard layout. On a Nordic layout the + key is the one left of the backspace key.

**Post:** what works, and which keyboard layout you used.

### F. Smaller Mac items

**Check each of these:**

1. Inspector › Project › Show in Finder opens Finder at the project.
2. Home › From CapCut lists CapCut's projects straight away, with their covers. It reads `draft_info.json`, which is where CapCut for Mac keeps the timeline.
3. With Studio started from the Dock, importing a video works, which means FFmpeg was found.

**Post:** yes or no for each.

### G. Fixes on every platform (a quick look)

**Check each of these:**

1. Make captions in project A, and open project B before they're done. B should stay untouched. Open A again, and the captions should be on its timeline.
2. After you open another project, the timeline's waveforms belong to that project.
3. A project opens without the timeline flickering.
4. Type changes into the Dub or Translations review, then switch Library category, select another clip, and quit Studio. When you come back, the changes are still there.
5. An overlay clip's sound can be taken off with right-click › Extract audio, or with Ctrl/Cmd+Shift+S.

**Post:** yes or no for each.

## 3. If something is still wrong

These are the places to look:

| Problem | Code |
|---|---|
| Drag | `apps/desktop/src/renderer/Timeline.tsx`: `aim`, `againstNeighbour`, `STAY_PX`, the frozen `tracksTop` |
| Gaps | `apps/desktop/src/shared/speech-timing.ts` (`fitLines`, `timingOf`), `apps/desktop/src/main/voice-read.ts` (`sentencesOf`), `apps/desktop/src/main/dub.ts`, `apps/desktop/src/main/translate.ts` |
| Menu and window buttons | `apps/desktop/src/main/main.ts` (`setApplicationMenu`, `trafficLightPosition`), `apps/desktop/src/renderer/app.css` (`[data-platform='darwin'] .titlebar`) |
| Shortcut labels and zoom keys | `apps/desktop/src/renderer/keymap.ts` (`keyLabel`), `apps/desktop/src/shared/app-zoom.ts` |

How to fix something:

1. Write a test that fails first, wherever you can. Unit tests are `scripts/*.test.mjs`. App steps are in `apps/desktop/src/main/ui-check.ts`; run them with `STUDIO_UI_ONLY=<part of a step's name>`.
2. Run `npm test` before you push.
3. Open a pull request from your fork, one fix per pull request. Say what was wrong, its cause, and how you tested it on the Mac. Leave out any project content.

## 4. A comment to copy

```
**Commit tested:** (from the report)

A. Gaps: …
B. Drag: …
C. Cmd shortcuts: works: … / doesn't: …
D. Window buttons: …
E. App zoom (layout: …): …
F. Show in Finder / From CapCut / FFmpeg from the Dock: … / … / …
G. Captions between projects / waveforms / flicker / review edits kept / overlay sound: … / … / … / … / …

<details><summary>mac-report</summary>

(paste the output of: node scripts/mac-report.mjs)

</details>
```
