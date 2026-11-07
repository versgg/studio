//! Playback. Playing: FFmpeg decodes the timeline at preview size and each frame is
//! held until the audio clock reaches it (late frames are dropped, never drifted).
//! Paused: the single frame under the playhead is rendered; rapid seeks coalesce.
//!
//! The picture plays in stretches of a few seconds, one FFmpeg run each, and the next run
//! starts while the one before plays. One run over the rest of the timeline would open every
//! input first: with ~30 caption lines that took a second before the first frame. While
//! paused, the stretch from the playhead is started ahead and held, so play starts at once.
//!
//! Text being edited is drawn by the player itself, at once (`preview.hide`): paused frames
//! leave those clips out, so they aren't drawn twice. Each paused frame has a ticket, and
//! `preview.shown` says when the frame with that ticket is in the ring.

use crate::audio_out::AudioOut;
use crate::events::Events;
use anyhow::bail;
use serde_json::{Value, json};
use std::io::Read;
use std::process::{Child, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use studio_engine_core::model::{Project, Us};
use studio_engine_core::ring::RingWriter;
use studio_media::Ffmpeg;
use studio_media::graph::{self, VideoOut};

/// The first stretch from where play starts: short, so its run opens few inputs.
const FIRST_STRETCH_US: Us = 1_000_000;
/// The stretches after it, each started while the one before plays.
const STRETCH_US: Us = 4_000_000;
/// How long seeks and edits must rest before the stretch from the playhead is started ahead,
/// so a drag along the timeline starts one run where it stops, not one per step.
const SETTLE: Duration = Duration::from_millis(120);

/// Half the project size: plenty for the player, and cheap to move (ARCHITECTURE.md §3).
pub fn preview_size(p: &Project) -> (u32, u32) {
    (((p.width / 2) & !1).max(2), ((p.height / 2) & !1).max(2))
}

fn debug() -> bool {
    std::env::var_os("STUDIO_DEBUG").is_some()
}

/// Milliseconds on the wall clock (mod 100 s), for lining STUDIO_DEBUG notes up.
fn clock_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() % 100_000).unwrap_or(0)
}

/// The FFmpeg runs a playback reads from: the stretch playing and the next one, started
/// ahead. Closed when playback stops, so a run started after that is ended at once.
#[derive(Default)]
struct Runs {
    closed: bool,
    list: Vec<Child>,
}

struct Run {
    stop: Arc<AtomicBool>,
    children: Arc<Mutex<Runs>>,
    thread: JoinHandle<()>,
}

/// One run's picture: the timeline from `from` to `end` (its end when `last`).
struct Stretch {
    from: Us,
    end: Us,
    last: bool,
    pid: u32,
    stdout: ChildStdout,
}

/// A stretch started ahead while paused and not read yet. Play takes it when it would start
/// the very same FFmpeg command (`args`), so nothing about the picture can differ.
struct Held {
    args: Vec<String>,
    from: Us,
    end: Us,
    last: bool,
    child: Child,
    stdout: ChildStdout,
}

/// A stretch to start ahead: from `at` in `project`, once requests have rested `settle`.
/// `epoch` tells whether play (or a newer request) has come since.
struct Ahead {
    project: Arc<Project>,
    at: Us,
    settle: Duration,
    epoch: u64,
}

type AheadRequest = Arc<(Mutex<Option<Ahead>>, Condvar)>;

struct State {
    playing: bool,
    position: Us,
    run: Option<Run>,
    /// What plays (or played last), for starting the stretch ahead where it's paused.
    project: Option<Arc<Project>>,
}

/// A paused frame to render: where, of what, and its ticket.
type SeekRequest = Arc<(Mutex<Option<(Us, Arc<Project>, u64)>>, Condvar)>;

/// Clips the player draws itself while they're edited (`preview.hide`): paused frames leave
/// them out. Playback and export never do.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Hidden {
    pub clips: Vec<String>,
    /// Whole picture tracks: a captions track, whose lines get new ids each time they're set.
    pub tracks: Vec<String>,
}

impl Hidden {
    pub fn is_empty(&self) -> bool {
        self.clips.is_empty() && self.tracks.is_empty()
    }

    /// `p` as a paused frame shows it. Hidden clips move to a hidden track of their own, so
    /// they aren't drawn but the timeline keeps its length; the main track is never touched.
    pub fn apply(&self, p: &Project) -> Project {
        let mut p = p.clone();
        let mut held = vec![];
        let mut holder = None;
        for t in p.tracks.iter_mut().filter(|t| !t.main) {
            if self.tracks.contains(&t.id) {
                t.hidden = true;
                continue;
            }
            let (out, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut t.clips).into_iter().partition(|c| self.clips.contains(&c.id));
            t.clips = keep;
            if !out.is_empty() {
                holder.get_or_insert_with(|| t.clone());
                held.extend(out);
            }
        }
        if let Some(mut t) = holder {
            (t.id, t.hidden, t.clips) = ("preview-hidden".into(), true, held);
            p.tracks.push(t);
        }
        p
    }
}

pub struct Playback {
    ff: Arc<Ffmpeg>,
    ring: Arc<Mutex<RingWriter>>,
    events: Events,
    pub audio: AudioOut,
    state: Arc<Mutex<State>>,
    seek: SeekRequest,
    mixes: Arc<Mixes>,
    /// What the player is showing: "timeline", or "source" (a library clip on its own).
    /// It travels with every playback event, so the UI knows which clock moved.
    context: Mutex<&'static str>,
    /// The loop region: playing into its end starts again at its start.
    loop_range: Mutex<Option<(Us, Us)>>,
    /// Goes up whenever a run stops, so a loop's restart never undoes a pause made meanwhile.
    generation: AtomicU64,
    /// A play is starting (its sound being mixed): background work waits, as while playing.
    starting: AtomicBool,
    /// The stretch started ahead, and the ahead worker's queue of one.
    held: Arc<Mutex<Option<Held>>>,
    ahead: AheadRequest,
    /// Goes up on every request and every play: a stretch started for an older one is ended.
    ahead_epoch: Arc<AtomicU64>,
    /// What paused frames leave out (see `Hidden`), and the last paused frame's ticket.
    hidden: Mutex<Hidden>,
    tickets: AtomicU64,
    /// Itself, for restarting a loop from the playback thread.
    me: Weak<Playback>,
}

impl Playback {
    /// Made inside `Arc::new_cyclic`, which hands it `me`.
    pub fn new(ff: Arc<Ffmpeg>, ring: Arc<Mutex<RingWriter>>, events: Events, me: Weak<Playback>) -> Self {
        let audio = AudioOut::open();
        let mixes = Arc::new(Mixes { rate: audio.rate, channels: audio.channels, ..Default::default() });
        {
            let (ff, mixes) = (ff.clone(), mixes.clone());
            std::thread::Builder::new().name("premix".into()).spawn(move || premix_worker(ff, mixes)).expect("spawn premix worker");
        }
        let seek: SeekRequest = Arc::new((Mutex::new(None), Condvar::new()));
        {
            let (ff, ring, seek, events) = (ff.clone(), ring.clone(), seek.clone(), events.clone());
            std::thread::Builder::new().name("seek".into()).spawn(move || seek_worker(ff, ring, seek, events)).expect("spawn seek worker");
        }
        let (held, ahead, ahead_epoch): (Arc<Mutex<Option<Held>>>, AheadRequest, Arc<AtomicU64>) = Default::default();
        {
            let (ff, held, ahead, epoch) = (ff.clone(), held.clone(), ahead.clone(), ahead_epoch.clone());
            std::thread::Builder::new().name("ahead".into()).spawn(move || ahead_worker(ff, ahead, held, epoch)).expect("spawn ahead worker");
        }
        let state = State { playing: false, position: 0, run: None, project: None };
        Self { ff, ring, events, audio, state: Arc::new(Mutex::new(state)), seek, mixes, context: Mutex::new("timeline"), loop_range: Mutex::new(None), generation: AtomicU64::new(0), starting: AtomicBool::new(false), held, ahead, ahead_epoch, hidden: Mutex::new(Hidden::default()), tickets: AtomicU64::new(0), me }
    }

    /// Sets the loop region (at least 0.2 s), or clears it with `None`. A run already playing
    /// picks it up when it next starts.
    pub fn set_loop(&self, range: Option<(Us, Us)>) {
        *self.loop_range.lock().unwrap() = range.map(|(a, b)| (a.min(b).max(0), a.max(b))).filter(|(a, b)| b - a >= 200_000);
    }

    pub fn loop_range(&self) -> Option<(Us, Us)> {
        *self.loop_range.lock().unwrap()
    }

    pub fn is_playing(&self) -> bool {
        self.state.lock().unwrap().playing
    }

    /// Playing, or a play starting: thumbnails and proxies wait (jobs.rs).
    pub fn is_busy(&self) -> bool {
        self.starting.load(Ordering::Acquire) || self.is_playing()
    }

    pub fn position(&self) -> Us {
        let s = self.state.lock().unwrap();
        if s.playing { self.audio.position_us() } else { s.position }
    }

    pub fn status(&self) -> Value {
        let looping = self.loop_range().map(|(a, b)| json!({ "startUs": a, "endUs": b }));
        json!({ "playing": self.is_playing(), "positionUs": self.position(), "context": self.context(), "loop": looping })
    }

    pub fn context(&self) -> &'static str {
        *self.context.lock().unwrap()
    }

    pub fn set_context(&self, c: &'static str) {
        *self.context.lock().unwrap() = c;
        // A library clip on its own has nothing the player draws itself.
        if c != "timeline" {
            *self.hidden.lock().unwrap() = Hidden::default();
        }
    }

    /// Leaves `hidden` out of paused frames from now on and draws the frame again; its ticket
    /// comes back. Playing (or showing a library clip) nothing is left out: the set is
    /// cleared and there's no frame (`None`).
    pub fn set_hidden(&self, hidden: Hidden, project: Arc<Project>) -> Option<u64> {
        if self.is_playing() || self.context() != "timeline" {
            *self.hidden.lock().unwrap() = Hidden::default();
            return None;
        }
        *self.hidden.lock().unwrap() = hidden;
        Some(self.show_frame(project))
    }

    pub fn hidden(&self) -> Hidden {
        self.hidden.lock().unwrap().clone()
    }

    fn emit_state(&self) {
        self.events.emit("playback.state", self.status());
    }

    /// The sound of a project (the timeline, or a previewed clip), mixed at the device's rate
    /// and channel count. Cached by revision; waits for the premix if it's already on it.
    /// The timeline's sound, mixed (or the mix already made of the very same sound). `_revision`
    /// is the project's; a mix is known by what's in it (`mix_key`), not by when it was asked for.
    pub fn mix_for(&self, project: &Project, _revision: u64) -> anyhow::Result<Arc<Vec<f32>>> {
        self.mixes.get_or_make(&self.ff, project, false)
    }

    /// Another project was opened: the sound mixed for the last one is never played for it.
    pub fn forget_mixes(&self) {
        self.mixes.forget();
    }

    /// Mixes the timeline's sound in the background after an edit, so pressing play is quick.
    /// Edits in quick succession collapse: only the latest revision is mixed, one at a time.
    pub fn premix(&self, project: Arc<Project>, _revision: u64) {
        let (m, cv) = &self.mixes.request;
        *m.lock().unwrap() = Some(project);
        cv.notify_one();
    }

    /// Starts the picture from the playhead ahead while paused (after an edit), so pressing
    /// play is quick too.
    pub fn prepare(&self, project: Arc<Project>) {
        if !self.is_playing() {
            self.prepare_at(project, self.position(), SETTLE);
        }
    }

    /// Asks the ahead worker for the stretch from `at`, replacing any request not started yet.
    fn prepare_at(&self, project: Arc<Project>, at: Us, settle: Duration) {
        // Off unless STUDIO_PLAY_AHEAD is set: a held run keeps the files at the playhead open
        // while paused, so on Windows they can't be moved, renamed or deleted, and an export
        // started meanwhile could stall (scripts/e2e.mjs, "v2-cut"). Without it a play starts in
        // about 0.2 s, from the short first stretch.
        if std::env::var_os("STUDIO_PLAY_AHEAD").is_none() {
            return;
        }
        let (m, cv) = &*self.ahead;
        let epoch = self.ahead_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        *m.lock().unwrap() = Some(Ahead { project, at, settle, epoch });
        cv.notify_one();
    }

    /// Ends the stretch held ahead, and any request for one.
    fn drop_held(&self) {
        let held = {
            let mut h = self.held.lock().unwrap();
            self.ahead_epoch.fetch_add(1, Ordering::AcqRel);
            h.take()
        };
        if let Some(h) = held {
            kill(h.child);
        }
    }

    pub fn play(&self, project: Arc<Project>, revision: u64, from: Us) -> Result<(), String> {
        self.starting.store(true, Ordering::Release);
        let r = self.play_now(project, revision, from);
        self.starting.store(false, Ordering::Release);
        r
    }

    fn play_now(&self, project: Arc<Project>, revision: u64, from: Us) -> Result<(), String> {
        let t0 = Instant::now();
        let debug = debug();
        self.stop_run();
        // Playing, the player draws nothing itself: every clip is in the picture.
        *self.hidden.lock().unwrap() = Hidden::default();
        if debug {
            eprintln!("[engine] play: stopped the last run in {} ms", t0.elapsed().as_millis());
        }
        let total = project.duration_us();
        if total == 0 {
            return Err("Add a clip to the timeline first.".into());
        }
        let from = start_point(total, from);
        let mix = self.mix_for(&project, revision).map_err(|e| e.to_string())?;
        self.audio.load(mix);
        if debug {
            eprintln!("[engine] play: sound mixed at {} ms", t0.elapsed().as_millis());
        }

        let (w, h) = preview_size(&project);
        let fps = project.fps.max(1);
        // The stretch started ahead, if it's this very run (from within half a frame of here).
        let held = {
            let mut held = self.held.lock().unwrap();
            self.ahead_epoch.fetch_add(1, Ordering::AcqRel);
            held.take()
        };
        let ready = held.and_then(|mut h| {
            let same = (h.from - from).abs() <= 500_000 / fps as Us && matches!(h.child.try_wait(), Ok(None)) && plan(&project, h.from, FIRST_STRETCH_US).2 == h.args;
            if same {
                return Some(h);
            }
            kill(h.child);
            None
        });
        let (first, child) = match ready {
            Some(h) => {
                if debug {
                    eprintln!("[engine] play ({}) from {} at {}: the stretch to {} was started ahead", self.context(), h.from, clock_ms(), h.end);
                }
                (Stretch { from: h.from, end: h.end, last: h.last, pid: h.child.id(), stdout: h.stdout }, h.child)
            }
            None => {
                let (end, last, args) = plan(&project, from, FIRST_STRETCH_US);
                // STUDIO_DEBUG=1 shows what FFmpeg is asked and what it says.
                if debug {
                    eprintln!("[engine] play ({}) from {from} to {end} at {}: ffmpeg {}", self.context(), clock_ms(), args.join(" "));
                }
                let (child, stdout) = spawn(&self.ff, &args).map_err(|e| e.to_string())?;
                (Stretch { from, end, last, pid: child.id(), stdout }, child)
            }
        };
        let from = first.from;
        let stop = Arc::new(AtomicBool::new(false));
        let children = Arc::new(Mutex::new(Runs { closed: false, list: vec![child] }));
        {
            let mut s = self.state.lock().unwrap();
            s.playing = true;
            s.position = from;
            s.project = Some(project.clone());
        }
        // Playing into the loop region's end starts again at its start, on a fresh run.
        let generation = self.generation.load(Ordering::Acquire);
        let looping = self.loop_range().filter(|&(_, b)| from < b && self.context() == "timeline").map(|(a, b)| {
            let (me, project) = (self.me.clone(), project.clone());
            let restart: Box<dyn FnOnce() + Send> = Box::new(move || {
                std::thread::spawn(move || {
                    if let Some(p) = me.upgrade().filter(|p| p.generation.load(Ordering::Acquire) == generation) {
                        let _ = p.play(project, revision, a);
                    }
                });
            });
            (a, b, restart)
        });
        let ctx = PlayCtx { w, h, fps, total, stop: stop.clone(), audio: self.audio.clone(), ring: self.ring.clone(), events: self.events.clone(), state: self.state.clone(), context: self.context(), looping, project, ff: self.ff.clone(), children: children.clone(), me: self.me.clone() };
        match std::thread::Builder::new().name("playback".into()).spawn(move || run(ctx, first)) {
            Ok(thread) => {
                self.state.lock().unwrap().run = Some(Run { stop, children, thread });
                Ok(())
            }
            Err(e) => {
                for c in std::mem::take(&mut children.lock().unwrap().list) {
                    kill(c);
                }
                self.state.lock().unwrap().playing = false;
                Err(e.to_string())
            }
        }
    }

    /// Stops the run playing; true when it was playing.
    fn stop_run(&self) -> bool {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let (run, was_playing) = {
            let mut s = self.state.lock().unwrap();
            let was = s.playing;
            if s.playing {
                s.position = self.audio.position_us();
            }
            s.playing = false;
            (s.run.take(), was)
        };
        if let Some(r) = run {
            r.stop.store(true, Ordering::Release);
            let children = {
                let mut c = r.children.lock().unwrap();
                c.closed = true;
                std::mem::take(&mut c.list)
            };
            for c in children {
                kill(c);
            }
            let _ = r.thread.join();
        }
        self.audio.stop();
        was_playing
    }

    pub fn pause(&self) {
        let was_playing = self.stop_run();
        self.emit_state();
        // Playing on from here starts at once: its stretch starts now.
        let project = self.state.lock().unwrap().project.clone();
        if let Some(p) = project.filter(|_| was_playing) {
            self.prepare_at(p, self.position(), Duration::ZERO);
        }
    }

    pub fn seek(&self, project: Arc<Project>, revision: u64, t: Us) -> Result<(), String> {
        let t = t.clamp(0, project.duration_us());
        if self.is_playing() {
            return self.play(project, revision, t);
        }
        self.state.lock().unwrap().position = t;
        self.show_frame(project.clone());
        self.emit_state();
        self.prepare_at(project, t, SETTLE);
        Ok(())
    }

    /// Re-renders the frame under the playhead (after an edit, or on seek), without the clips
    /// the player draws itself. Returns the frame's ticket (see `preview.shown`).
    pub fn show_frame(&self, project: Arc<Project>) -> u64 {
        let t = self.position();
        let hidden = self.hidden();
        let project = if hidden.is_empty() { project } else { Arc::new(hidden.apply(&project)) };
        let ticket = self.tickets.fetch_add(1, Ordering::AcqRel) + 1;
        let (m, cv) = &*self.seek;
        *m.lock().unwrap() = Some((t, project, ticket));
        cv.notify_one();
        ticket
    }

    pub fn stop(&self) {
        self.stop_run();
        self.drop_held();
        self.state.lock().unwrap().position = 0;
        self.emit_state();
    }
}

/// Where play from `from` starts: at the end, it starts again from the beginning.
fn start_point(total: Us, from: Us) -> Us {
    if from >= total - 20_000 { 0 } else { from.max(0) }
}

/// The stretch from `from` (at least `min_us` long, see `graph::window_end`): where it ends,
/// whether that's the timeline's end, and FFmpeg's command for its picture at preview size.
fn plan(p: &Project, from: Us, min_us: Us) -> (Us, bool, Vec<String>) {
    let (w, h) = preview_size(p);
    let fps = p.fps.max(1);
    let total = p.duration_us();
    let frame_us = 1_000_000 / fps as Us;
    let end = graph::window_end(p, from, min_us, frame_us);
    let tl = graph::timeline_stretch(p, from, end, frame_us);
    let mut args = graph::build(&tl, Some(&VideoOut { width: w, height: h, fps, pix_fmt: "rgba" }), false, false);
    args.extend(["-map", "[vout]", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"].map(String::from));
    (end, end >= total, args)
}

fn spawn(ff: &Ffmpeg, args: &[String]) -> std::io::Result<(Child, ChildStdout)> {
    let mut child = ff.cmd().args(args).stdout(Stdio::piped()).stderr(if debug() { Stdio::inherit() } else { Stdio::null() }).spawn()?;
    match child.stdout.take() {
        Some(out) => Ok((child, out)),
        None => {
            kill(child);
            Err(std::io::Error::other("no decoder output"))
        }
    }
}

fn kill(mut c: Child) {
    let _ = c.kill();
    let _ = c.wait();
}

/// Starts the stretches asked for ahead and holds the latest (see `Held`).
fn ahead_worker(ff: Arc<Ffmpeg>, req: AheadRequest, held: Arc<Mutex<Option<Held>>>, epoch: Arc<AtomicU64>) {
    loop {
        let r = {
            let (m, cv) = &*req;
            let mut g = m.lock().unwrap();
            let mut r = loop {
                if let Some(r) = g.take() {
                    break r;
                }
                g = cv.wait(g).unwrap();
            };
            // Newer requests replace it until they rest.
            let mut until = Instant::now() + r.settle;
            loop {
                let now = Instant::now();
                if now >= until {
                    break r;
                }
                g = cv.wait_timeout(g, until - now).unwrap().0;
                if let Some(newer) = g.take() {
                    until = Instant::now() + newer.settle;
                    r = newer;
                }
            }
        };
        let total = r.project.duration_us();
        if total == 0 || epoch.load(Ordering::Acquire) != r.epoch {
            continue;
        }
        let from = start_point(total, r.at);
        let (end, last, args) = plan(&r.project, from, FIRST_STRETCH_US);
        if held.lock().unwrap().as_ref().is_some_and(|h| h.args == args) {
            continue;
        }
        let Ok((child, stdout)) = spawn(&ff, &args) else { continue };
        if debug() {
            eprintln!("[engine] ahead: started the stretch from {from} to {end} at {}", clock_ms());
        }
        let mut h = held.lock().unwrap();
        if epoch.load(Ordering::Acquire) != r.epoch {
            drop(h);
            kill(child);
            continue;
        }
        let old = h.replace(Held { args, from, end, last, child, stdout });
        drop(h);
        if let Some(o) = old {
            kill(o.child);
        }
    }
}

struct PlayCtx {
    w: u32,
    h: u32,
    fps: u32,
    total: Us,
    stop: Arc<AtomicBool>,
    audio: AudioOut,
    ring: Arc<Mutex<RingWriter>>,
    events: Events,
    state: Arc<Mutex<State>>,
    context: &'static str,
    /// The loop's start and end, and what starts it again.
    looping: Option<(Us, Us, Box<dyn FnOnce() + Send>)>,
    /// What plays, and where the next stretch's run goes.
    project: Arc<Project>,
    ff: Arc<Ffmpeg>,
    children: Arc<Mutex<Runs>>,
    /// Itself, for starting a stretch ahead (a loop's start, or the beginning after the end).
    me: Weak<Playback>,
}

impl PlayCtx {
    /// Starts the run for the stretch from `from`; `None` once playback has stopped (or FFmpeg
    /// won't start).
    fn start_stretch(&self, from: Us) -> Option<Stretch> {
        let (end, last, args) = plan(&self.project, from, STRETCH_US);
        if debug() {
            eprintln!("[engine] play: next stretch from {from} to {end} at {}: ffmpeg {}", clock_ms(), args.join(" "));
        }
        let (child, stdout) = spawn(&self.ff, &args).ok()?;
        let pid = child.id();
        let mut runs = self.children.lock().unwrap();
        if runs.closed {
            drop(runs);
            kill(child);
            return None;
        }
        runs.list.push(child);
        Some(Stretch { from, end, last, pid, stdout })
    }

    /// Ends a stretch's run once its frames are read (it can have one more to give).
    fn retire(&self, pid: u32) {
        let child = {
            let mut runs = self.children.lock().unwrap();
            runs.list.iter().position(|c| c.id() == pid).map(|i| runs.list.remove(i))
        };
        if let Some(c) = child {
            kill(c);
        }
    }

    fn ahead_from(&self, at: Us) {
        if let Some(p) = self.me.upgrade() {
            p.prepare_at(self.project.clone(), at, Duration::ZERO);
        }
    }
}

fn run(mut c: PlayCtx, first: Stretch) {
    let frame_us = 1_000_000 / c.fps as Us;
    let mut buf = vec![0u8; (c.w * c.h * 4) as usize];
    let mut started = false;
    let mut cur = first;
    'stretches: loop {
        let mut next: Option<Stretch> = None;
        let mut asked = false;
        let mut i: Us = 0;
        let waited = Instant::now();
        loop {
            if c.stop.load(Ordering::Acquire) {
                return;
            }
            let due = cur.from + i * frame_us;
            if c.looping.as_ref().is_some_and(|(_, end, _)| due >= *end) {
                c.audio.stop();
                if let Some((_, _, restart)) = c.looping.take() {
                    restart();
                }
                return;
            }
            // The end of the timeline ends it, however many frames FFmpeg still has (a last
            // stretch could run on in black, with the playhead past the end).
            if due >= c.total {
                break 'stretches;
            }
            // Its frames are read: the next stretch takes over from its first.
            if !cur.last && due >= cur.end {
                break;
            }
            if cur.stdout.read_exact(&mut buf).is_err() {
                if cur.last {
                    break 'stretches;
                }
                break;
            }
            i += 1;
            if i == 1 && started && debug() {
                eprintln!("[engine] play: stretch from {} waited {} ms for its first frame", cur.from, waited.elapsed().as_millis());
            }
            if !started {
                if debug() {
                    eprintln!("[engine] play: first frame from FFmpeg at {}", clock_ms());
                }
                // Start the clock only once the first picture is ready, so they begin together.
                c.audio.start(cur.from);
                started = true;
                c.events.emit("playback.state", json!({ "playing": true, "positionUs": cur.from, "context": c.context }));
                // Coming round again starts at once too.
                if let Some(&(start, _, _)) = c.looping.as_ref() {
                    c.ahead_from(start);
                }
            } else {
                loop {
                    if c.stop.load(Ordering::Acquire) {
                        return;
                    }
                    let now = c.audio.position_us();
                    if now + 1_000 >= due {
                        break;
                    }
                    std::thread::sleep(Duration::from_micros((due - now).clamp(500, 4_000) as u64));
                }
                if c.audio.position_us() > due + 2 * frame_us {
                    continue; // too late to show: drop it and catch up
                }
            }
            c.ring.lock().unwrap().write_frame(c.w, c.h, due as u64, |px, _| px.copy_from_slice(&buf));
            c.events.emit("playback.position", json!({ "positionUs": due, "context": c.context }));
            // The next stretch's run starts now, while this one plays.
            if !asked && !cur.last && c.looping.as_ref().is_none_or(|(_, end, _)| cur.end < *end) {
                asked = true;
                next = c.start_stretch(cur.end);
            }
        }
        c.retire(cur.pid);
        cur = match next.take().or_else(|| c.start_stretch(cur.end)) {
            Some(s) => s,
            None => break,
        };
    }
    if !c.stop.load(Ordering::Acquire) {
        c.audio.stop();
        {
            let mut s = c.state.lock().unwrap();
            s.playing = false;
            s.position = c.total;
        }
        c.events.emit("playback.state", json!({ "playing": false, "positionUs": c.total, "context": c.context }));
        // Play from the end starts from the beginning: that stretch starts now.
        c.ahead_from(c.total);
    }
}

fn seek_worker(ff: Arc<Ffmpeg>, ring: Arc<Mutex<RingWriter>>, req: SeekRequest, events: Events) {
    loop {
        let (t, project, ticket) = {
            let (m, cv) = &*req;
            let mut g = m.lock().unwrap();
            while g.is_none() {
                g = cv.wait(g).unwrap();
            }
            g.take().expect("checked")
        };
        let (w, h) = preview_size(&project);
        let px = frame_at(&ff, &project, t, w, h).unwrap_or_else(|| vec![0u8; (w * h * 4) as usize]);
        ring.lock().unwrap().write_frame(w, h, t as u64, |dst, _| dst.copy_from_slice(&px));
        // Requests coalesce, so this frame stands for every ticket up to its own.
        events.emit("preview.shown", json!({ "ticket": ticket, "positionUs": t }));
    }
}

/// The graph for the one frame at timeline time `t` (ending in `[vout]`), or `None` for an
/// empty spot. The main clip alone is one source frame with its look held at that moment
/// (the quick path); with picture tracks, a transition or effects there, it is playback's
/// own graph over two frames from `t`, so the paused frame matches what plays.
pub fn frame_args(p: &Project, t: Us, w: u32, h: u32) -> Option<Vec<String>> {
    let video = VideoOut { width: w, height: h, fps: p.fps.max(1), pix_fmt: "rgba" };
    if graph::plain_at(p, t) {
        let seg = graph::still_at(p, t, true)?;
        let tl = graph::Timeline { total_us: seg.dur_us, main: vec![seg], ..Default::default() };
        return Some(graph::build(&tl, Some(&video), false, false));
    }
    let frame = 1_000_000 / p.fps.max(1) as Us;
    let t = t.clamp(0, (p.duration_us() - frame).max(0));
    let tl = graph::timeline_window(p, t, t + 2 * frame, true, false);
    (!tl.main.is_empty() || !tl.layers.is_empty()).then(|| graph::build(&tl, Some(&video), false, false))
}

/// One RGBA frame at timeline time `t`, or `None` for an empty spot: the source frame shown
/// there (after the clip's speed and direction), through the same graph as playback.
fn frame_at(ff: &Ffmpeg, p: &Project, t: Us, w: u32, h: u32) -> Option<Vec<u8>> {
    let mut args = frame_args(p, t, w, h)?;
    args.extend(["-map", "[vout]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"].map(String::from));
    let out = ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    (out.stdout.len() == (w * h * 4) as usize).then_some(out.stdout)
}

/// Recent sound mixes (the timeline's and a preview's fit side by side), and the premix
/// worker's queue of one. A mix is known by what's in it: the hash of its FFmpeg command and
/// length (`mix_key`). It used to be known by the project's revision, which every quiet update
/// bumps too: a poster, filmstrip, waveform or proxy made, a folder linked. Linking 360 folders
/// (2,318 files to read) threw a 3-minute mix away thousands of times, so play almost never
/// found one and waited for FFmpeg behind all that work (2026-11-07). The cache still belongs to
/// one open project: opening another starts a new `epoch` (and a mix still being made for the
/// old one is thrown away when it's done), so the last project's sound is never played.
#[derive(Default)]
struct Mixes {
    rate: u32,
    channels: u16,
    epoch: AtomicU64,
    done: Mutex<Vec<(u64, u64, Arc<Vec<f32>>)>>,
    /// The (epoch, key) being mixed right now, if any; `ready` wakes anyone waiting for it.
    making: Mutex<Option<(u64, u64)>>,
    ready: Condvar,
    request: (Mutex<Option<Arc<Project>>>, Condvar),
}

impl Mixes {
    fn get_or_make(&self, ff: &Ffmpeg, project: &Project, background: bool) -> anyhow::Result<Arc<Vec<f32>>> {
        let epoch = self.epoch.load(Ordering::Acquire);
        let args = mix_args(project, self.rate, self.channels);
        let revision = mix_key(&args, project.duration_us());
        {
            let mut making = self.making.lock().unwrap();
            loop {
                if let Some(buf) = self.cached(epoch, revision) {
                    return Ok(buf);
                }
                // The premix runs at low priority: on a busy machine it can take minutes, so play
                // never waits for it; it mixes the sound itself, at normal priority.
                if background && *making == Some((epoch, revision)) {
                    making = self.ready.wait(making).unwrap();
                    continue;
                }
                break;
            }
            if background {
                *making = Some((epoch, revision));
            }
        }
        let result = mix_with(ff, &args, project.duration_us(), self.rate, self.channels, background);
        if let Ok(buf) = &result {
            self.keep(epoch, revision, buf.clone());
        }
        if background {
            *self.making.lock().unwrap() = None;
            self.ready.notify_all();
        }
        result
    }

    fn cached(&self, epoch: u64, revision: u64) -> Option<Arc<Vec<f32>>> {
        self.done.lock().unwrap().iter().find(|(e, r, _)| *e == epoch && *r == revision).map(|(_, _, b)| b.clone())
    }

    /// Keeps a finished mix, unless another project was opened while it was being made.
    fn keep(&self, epoch: u64, revision: u64, buf: Arc<Vec<f32>>) {
        let mut done = self.done.lock().unwrap();
        if self.epoch.load(Ordering::Acquire) != epoch {
            return;
        }
        done.retain(|(e, r, _)| !(*e == epoch && *r == revision));
        done.push((epoch, revision, buf));
        if done.len() > 3 {
            done.remove(0);
        }
    }

    /// Another project is open: none of the mixes made so far (or asked for) is its sound.
    fn forget(&self) {
        let mut done = self.done.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::AcqRel);
        done.clear();
        *self.request.0.lock().unwrap() = None;
    }
}

fn premix_worker(ff: Arc<Ffmpeg>, mixes: Arc<Mixes>) {
    loop {
        let project = {
            let (m, cv) = &mixes.request;
            let mut g = m.lock().unwrap();
            loop {
                if let Some(r) = g.take() {
                    break r;
                }
                g = cv.wait(g).unwrap();
            }
        };
        let _ = mixes.get_or_make(&ff, &project, true);
    }
}

/// The FFmpeg command that mixes the timeline's sound to raw floats.
fn mix_args(project: &Project, rate: u32, channels: u16) -> Vec<String> {
    let mut args = graph::build(&graph::timeline_from(project, 0, false), None, true, false);
    args.extend(["-map".into(), "[aout]".into(), "-f".into(), "f32le".into(), "-ac".into(), channels.to_string(), "-ar".into(), rate.to_string(), "pipe:1".into()]);
    args
}

/// What a mix is known by: its command and length. The same sound mixes the same way, whatever
/// else changed in the project (posters, linked folders, text).
fn mix_key(args: &[String], total: Us) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    args.hash(&mut h);
    total.hash(&mut h);
    h.finish()
}

#[cfg(test)]
fn mix(ff: &Ffmpeg, project: &Project, rate: u32, channels: u16, background: bool) -> anyhow::Result<Arc<Vec<f32>>> {
    mix_with(ff, &mix_args(project, rate, channels), project.duration_us(), rate, channels, background)
}

fn mix_with(ff: &Ffmpeg, args: &[String], total: Us, rate: u32, channels: u16, background: bool) -> anyhow::Result<Arc<Vec<f32>>> {
    let mut cmd = if background { ff.cmd_background() } else { ff.cmd() };
    // Never more than the timeline's length (and a second): if FFmpeg's own end doesn't come,
    // the rest is padding silence, and reading it all would fill the memory.
    let mut raw = read_at_most(cmd.args(args), mix_bytes(total + 1_000_000, rate, channels)).map_err(|e| anyhow::anyhow!("audio mix failed: {e}"))?;
    raw.truncate(mix_bytes(total, rate, channels) as usize);
    Ok(Arc::new(raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()))
}

/// What a command writes, up to `most` bytes: past that it's stopped (its output is cut there).
/// An error if it fails before that.
fn read_at_most(cmd: &mut std::process::Command, most: u64) -> anyhow::Result<Vec<u8>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) else {
        kill(child);
        bail!("no output");
    };
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let mut raw = Vec::new();
    let read = (&mut out).take(most).read_to_end(&mut raw);
    let cut = raw.len() as u64 >= most;
    drop(out);
    if cut || read.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let stderr = errors.join().unwrap_or_default();
    read?;
    if !cut && !status.success() {
        bail!("{}", stderr.lines().last().unwrap_or("unknown error"));
    }
    Ok(raw)
}

/// The bytes of `us` of sound as 32-bit float samples, whole frames.
fn mix_bytes(us: Us, rate: u32, channels: u16) -> u64 {
    (us.max(0) as u64 * rate as u64).div_ceil(1_000_000) * channels as u64 * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mix_that_never_ends_is_cut_at_the_timeline_length() {
        // FFmpeg 8 now and then lost the timestamps that end a mix, and padding silence kept
        // coming: read whole, one took 24 GB. An endless source stands in for it here.
        let Ok(ff) = Ffmpeg::detect() else { return };
        let most = mix_bytes(2_000_000, 48_000, 2);
        let mut cmd = ff.cmd();
        cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-f", "f32le", "pipe:1"]);
        let raw = read_at_most(&mut cmd, most).unwrap();
        assert_eq!(raw.len() as u64, most, "2 s of stereo floats, then stopped");
        assert_eq!(most, 2 * 48_000 * 2 * 4);
        // One that ends by itself comes back whole.
        let mut cmd = ff.cmd();
        cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.5", "-f", "f32le", "pipe:1"]);
        assert_eq!(read_at_most(&mut cmd, most).unwrap().len(), 48_000 / 2 * 2 * 4);
    }

    #[test]
    fn a_timeline_of_sound_only_plays_its_picture_black_and_its_sound() {
        // Repro (2026-11-07): a project whose video was deleted, a song and a voiceover left.
        let Ok(ff) = Ffmpeg::detect() else { return };
        let dir = std::env::temp_dir().join(format!("studio-sound-only-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let song = dir.join("song.wav");
        let ok = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=6", song.to_str().unwrap()]).status().unwrap();
        assert!(ok.success());
        let mut p = Project::new("T", "9:16");
        p.media = vec![Media { id: "s".into(), path: song.to_string_lossy().into(), name: "song.wav".into(), kind: MediaKind::Audio, duration_us: 6 * SECOND, has_audio: true, ..Default::default() }];
        p.insert("s", 0).unwrap();
        assert!(p.tracks.iter().all(|t| t.kind != studio_engine_core::model::TrackKind::Video || t.clips.is_empty()), "no picture on the timeline");
        assert_eq!(p.duration_us(), 6 * SECOND);
        // The picture: black frames, as many as the stretch is long.
        let (end, _, args) = plan(&p, 0, FIRST_STRETCH_US);
        let out = ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
        let (w, h) = preview_size(&p);
        let frames = out.stdout.len() / (w * h * 4) as usize;
        assert!(frames as i64 >= end * p.fps as i64 / 1_000_000 - 1, "{} frames for {} µs: {}", frames, end, String::from_utf8_lossy(&out.stderr));
        // The sound: the whole timeline.
        let buf = mix(&ff, &p, 48_000, 2, false).unwrap();
        assert_eq!(buf.len() as u64 * 4, mix_bytes(6 * SECOND, 48_000, 2));
        let peak = buf.iter().fold(0f32, |a, x| a.max(x.abs()));
        let args = graph::build(&graph::timeline_from(&p, 0, false), None, true, false);
        assert!(peak > 0.05, "silence (peak {peak}): ffmpeg {}", args.join(" "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mix_is_known_by_its_sound_so_posters_and_linked_folders_keep_it() {
        let mut p = Project::new("T", "9:16");
        p.media = vec![Media { id: "s".into(), path: "/m/song.wav".into(), name: "song.wav".into(), kind: MediaKind::Audio, duration_us: 6 * SECOND, has_audio: true, ..Default::default() }];
        p.insert("s", 0).unwrap();
        let key = |p: &Project| mix_key(&mix_args(p, 48_000, 2), p.duration_us());
        let before = key(&p);
        // What the background work and a linked folder change: posters, waveforms, more media.
        p.media[0].poster = Some("/cache/s/poster.jpg".into());
        p.media[0].peaks = Some("/cache/s/peaks.bin".into());
        p.media.push(Media { id: "b".into(), path: "/broll/b.mp4".into(), name: "b.mp4".into(), kind: MediaKind::Video, duration_us: 3 * SECOND, width: 720, height: 1280, fps: 30.0, has_audio: true, ..Default::default() });
        assert_eq!(key(&p), before, "the same sound: the same mix");
        // A change to the sound is a new mix.
        let id = p.tracks.iter().flat_map(|t| &t.clips).next().unwrap().id.clone();
        p.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()).find(|c| c.id == id).unwrap().volume = 0.5;
        assert_ne!(key(&p), before, "louder or quieter: a new mix");
    }

    #[test]
    fn a_mix_made_for_one_project_is_never_played_for_the_next() {
        let m = Mixes::default();
        let a = Arc::new(vec![0.5f32; 4]);
        m.keep(0, 7, a.clone());
        assert!(m.cached(0, 7).is_some(), "the open project's mix is kept");
        // Another project opens, at the same revision.
        m.forget();
        let e = m.epoch.load(Ordering::Acquire);
        assert!(m.cached(e, 7).is_none(), "the last project's mix isn't this one's");
        // A mix the old project's premix finishes afterwards is thrown away.
        m.keep(0, 7, a);
        assert!(m.cached(e, 7).is_none() && m.cached(0, 7).is_none());
    }
    use studio_engine_core::model::{Media, MediaKind, SECOND};

    #[test]
    fn stretches_cover_the_timeline_and_the_same_stretch_is_the_same_run() {
        let mut p = Project::new("T", "9:16");
        p.media = vec![Media { id: "a".into(), path: "/m/a".into(), name: "a".into(), kind: MediaKind::Video, duration_us: 10 * SECOND, width: 1080, height: 1920, fps: 30.0, ..Default::default() }];
        p.insert("a", 0).unwrap();
        let (mut from, mut min, mut ends) = (0, FIRST_STRETCH_US, vec![]);
        loop {
            let (end, last, args) = plan(&p, from, min);
            assert!(end > from && args.ends_with(&["-map", "[vout]", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"].map(String::from)));
            ends.push(end);
            if last {
                break;
            }
            (from, min) = (end, STRETCH_US);
        }
        let frame = 1_000_000 / 30;
        assert_eq!(ends, [31 * frame, 152 * frame, 273 * frame, 10 * SECOND], "a short first stretch, then 4 s ones, then the rest");
        // A stretch started ahead is matched on its command, which planning makes the same way.
        assert_eq!(plan(&p, 2 * SECOND, FIRST_STRETCH_US).2, plan(&p, 2 * SECOND, FIRST_STRETCH_US).2);
        assert_ne!(plan(&p, 2 * SECOND, FIRST_STRETCH_US).2, plan(&p, 2 * SECOND + frame, FIRST_STRETCH_US).2);
        // Play from the end starts from the beginning.
        assert_eq!(start_point(10 * SECOND, 10 * SECOND - 10_000), 0);
        assert_eq!(start_point(10 * SECOND, 3 * SECOND), 3 * SECOND);
    }

    #[test]
    fn hidden_text_is_left_out_of_paused_frames_but_not_playback() {
        let dir = std::env::temp_dir().join(format!("studio-hidden-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = |name: &str| {
            let f = dir.join(name);
            std::fs::write(&f, b"png").unwrap();
            f.to_string_lossy().into_owned()
        };
        let text = |png: String| serde_json::from_value(json!({ "content": "Hi", "png": png })).unwrap();
        let mut p = Project::new("T", "9:16");
        p.media = vec![Media { id: "a".into(), path: "/m/a".into(), name: "a".into(), kind: MediaKind::Video, duration_us: 10 * SECOND, width: 1080, height: 1920, fps: 30.0, ..Default::default() }];
        p.insert("a", 0).unwrap();
        let (a, png_a) = (png("a.png"), png("b.png"));
        let (title, title_track) = p.add_overlay(None, Some(text(a.clone())), 0, Some(12 * SECOND), "text", None).unwrap();
        let (_, other_track) = p.add_overlay(None, Some(text(png_a.clone())), 0, Some(4 * SECOND), "captions", None).unwrap();
        let frame = |p: &Project| frame_args(p, 2 * SECOND, 540, 960).unwrap().join(" ");
        assert!(frame(&p).contains(&a) && frame(&p).contains(&png_a));

        // One clip: out of the frame, the rest as it was, and the timeline as long as before.
        let one = Hidden { clips: vec![title.clone()], tracks: vec![] }.apply(&p);
        assert!(!frame(&one).contains(&a) && frame(&one).contains(&png_a));
        assert_eq!(one.duration_us(), p.duration_us());
        assert_eq!(one.tracks.iter().find(|t| t.id == title_track).unwrap().clips.len(), 0);
        // A whole track (captions), and the main track never.
        let track = Hidden { clips: vec![p.main_track().clips[0].id.clone()], tracks: vec![other_track, p.main_track().id.clone()] }.apply(&p);
        assert!(frame(&track).contains(&a) && !frame(&track).contains(&png_a));
        assert_eq!((track.main_track().clips.len(), track.main_track().hidden), (1, false));
        assert_eq!(Hidden::default().apply(&p), p);
        let _ = std::fs::remove_dir_all(dir);
    }
}
