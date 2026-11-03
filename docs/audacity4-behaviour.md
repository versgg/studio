# How Audacity 4 behaves (read from its source, 27 Oct 2026)

The Audio page follows Audacity 4 where the user asked for it. Everything here was read in Audacity's `master` branch. Paths are under `src/`, from https://raw.githubusercontent.com/audacity/audacity/master/.

## What Studio's Audio page does the same

- **Wheel zoom** (`projectscene/view/timeline/timelinecontext.cpp`):
  - 2^(1/6) per notch (`mouseZoomPrecision` defaults to 6), so six notches double the zoom.
  - The time under the mouse stays put.
  - Max 6,000,000 px/s, about 125 px a sample at 48 kHz.
- **Zoom buttons and keys:** ×2 and ÷2, around the selection's middle, else the playhead. Ctrl+F fits the project.
- **Scrolling:** a tenth of the view per notch. *Difference:* in Studio a plain wheel scrolls sideways, as on the Edit timeline (the user's choice). In Audacity a plain wheel scrolls tracks and Shift+wheel scrolls sideways.
- **Following the playhead** (`projectscene/view/playcursor/playcursorcontroller.cpp`):
  - Half a second before the right edge, the view moves so the playhead sits at 75 %.
  - Under one second across, it jumps so the playhead sits at 10 %.
  - Scrolling by hand pauses following for 3 s.
- **Playback** (`playback/internal/playbackcontroller.cpp`):
  - **Space** plays from the last click (a selection doesn't change it). Space again stops and returns to that click (`stopAndSeekToLastSeekTime`), so Space, Space replays the same stretch.
  - **P** and the Play button pause in place.
  - **Shift+Space** plays only the selection.
  - **X** stops, and that point becomes the new start.
  - **Arrows while playing** jump 5 s, or 15 s with Shift.
- **Clicking while playing** marks the new start without jumping; the next Space stops there. A drag must move 5 px before it is a selection.
- **Snapping:** clicks and selection edges snap to clip and label edges within 4 px, even with snapping off (`SNAP_TO_CLIP_TOLERANCE_PX`).
- **Waveform stages** (`projectscene/view/tracksitemsview/au3/wavepainterutils.cpp`):
  - min/max levels above 2 samples a pixel;
  - then the wave as a line;
  - from 4 px a sample, each sample as a dot on its stem.

## Where Studio differs on purpose

- **A line under the mouse:** Studio's runs the full height. Audacity's is in the ruler only; its full-height guideline follows the mouse only with snapping on.
- **Double-click:** in Studio it grabs the playhead, as on the Edit timeline. In Audacity it selects the clip.
- **Ctrl+X on a selection:** closes up the whole track (Audacity's TrackRipple). Audacity's first Delete asks once, defaulting to Leave gap, and its Close gap only closes inside the clip (ClipRipple).
- **Loop:** off until you make a loop region (a drag along the ruler's top strip, or L with a time selection, as Audacity 4 does when there's no region). Studio's selection can be dragged in the empty row under a sound; it lands on that sound's track.
- **Home, End, a cut and grabbing the playhead** move the start line with the playhead, so Space plays from there.
- **Spectrogram:** Studio uses magma, linear frequency, 75 dB (as the canvas). Audacity uses Roseus, Mel, 80 dB range, 20 dB gain, a 2048 Hann window and 0–20 kHz.

## Not built yet, worth having

- **Selecting across tracks:** a drag across several tracks; a drag starting and ending below the last track selects all tracks.
- **Shift+click** extends a selection.
- **Keyboard selection:** `[` / `]` select left or right of the playhead.
- **Zero crossings:** Z moves to the nearest one.
- **Zoom presets:** Shift+Z toggles between the default and 4:1; Ctrl+E zooms to the selection (Studio's Ctrl+E is Export).
- **Following modes:** a pinned playhead (the audio scrolls under it) as an alternative.
- **Edge scrolling:** dragging near an edge scrolls, speeding up toward the edge (`(distance/40)^4`).
