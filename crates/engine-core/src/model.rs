//! The project model and every edit it supports, as plain functions with tests.
//!
//! Times are microseconds. The main video track is magnetic: its clips always sit
//! back to back from 0, so removing or shortening one closes the gap (ripple).
//! Audio tracks are free-form; a clip that would overlap goes to the first audio
//! track with room, and a new track appears when none has room. Empty audio tracks
//! disappear. Tracks appear and disappear as you work, like CapCut.

pub use crate::look::{Anim, AnimLoop, AnimStep, Brand, Curves, Fx, Hsl, HslMap, Lut, Mask, Matte, McpOptions, Smooth, Spectral, SpeedCurve, Stabilize, TextSpec, Transition, Wheel, Wheels};
pub use crate::layers::{CaptionDrawing, CaptionLine};
use crate::look::{ANIMS, BLENDS, EFFECTS, HSL_RANGES, LOOPS, VISUAL_ROLES, clean_points, xfade_name};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Us = i64;
pub const SECOND: Us = 1_000_000;
pub const IMAGE_DEFAULT: Us = 3 * SECOND;
pub const MIN_CLIP: Us = 100_000; // 0.1 s

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Video,
    Audio,
    Image,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Fill the frame and crop the overflow (the usual choice for ads).
    #[default]
    Fill,
    /// Show the whole picture, with bars.
    Fit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub duration_us: Us,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub strip: Option<String>,
    #[serde(default)]
    pub peaks: Option<String>,
    /// The linked folder this file belongs to, and its subfolder there ("" is the top, "/" separated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// The last rescan of its folder didn't find the file.
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
    /// A compound clip's render: the clips it was made from, timed from its start, so it
    /// can be broken apart again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<Part>>,
    /// The picture's codec ("vp9", "vp8", "gif"...), so a WebM's alpha is decoded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    /// The sound's own sample rate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
}

/// One clip inside a compound clip, whether it sat on the main track, and its picture
/// track's role if it sat on one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub clip: Clip,
    pub main: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// A copied clip, as the clipboard sends it back: where it sat (main track or not) and how
/// far after the first copied clip it started. `role` is its track's role when it sat on a
/// picture track over the main one (text and adjustment clips are recognised without it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteItem {
    pub clip: Clip,
    pub main: bool,
    pub offset_us: Us,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A folder on disk linked into the project. The library mirrors its tree; files stay where they are.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub path: String,
    pub name: String,
    /// Files removed from the library by hand; rescans leave them out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub start_us: Us,
    pub in_us: Us,
    pub duration_us: Us,
    #[serde(default = "one")]
    pub volume: f32,
    #[serde(default)]
    pub fit: Fit,
    /// Clips sharing a link (a video and its extracted audio) move and split
    /// together while the project's linkage is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// This video clip's sound was extracted to an audio track, so it plays silent.
    #[serde(default, skip_serializing_if = "is_false")]
    pub detached: bool,
    /// The part of the source picture kept, as fractions of its width and height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    /// Mirrored left to right.
    #[serde(default, skip_serializing_if = "is_false")]
    pub flip: bool,
    /// Clockwise quarter turns: 0, 90, 180 or 270.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotate: u16,
    /// Sound fading in from the clip's start and out to its end.
    #[serde(default, skip_serializing_if = "is_zero_us")]
    pub fade_in_us: Us,
    #[serde(default, skip_serializing_if = "is_zero_us")]
    pub fade_out_us: Us,
    /// The fades' shape: "lin" (the default), "scurve" or "log".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fade_curve: String,
    /// Pitch shift in semitones, keeping the speed.
    #[serde(default, skip_serializing_if = "is_zero_f32")]
    pub pitch: f32,
    /// Pops and mouth clicks taken out.
    #[serde(default, skip_serializing_if = "is_false")]
    pub declick: bool,
    /// The volume envelope: gain points at source times, joined by straight lines.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub envelope: Vec<EnvPoint>,
    // The look and timing below are always written out, so the inspector can read each one back.
    /// The picture's size after the fit, in percent (0–400).
    #[serde(default = "hundred")]
    pub scale: f32,
    /// Where the picture's centre sits, in project pixels from the frame's centre (+x right, +y down).
    #[serde(default)]
    pub pos_x: f32,
    #[serde(default)]
    pub pos_y: f32,
    /// Free rotation after the fit, in degrees clockwise (`rotate` turns the source first).
    #[serde(default)]
    pub rotation: f32,
    /// Percent; below 100 the picture fades towards the black behind it.
    #[serde(default = "hundred")]
    pub opacity: f32,
    /// Colour, each −100 to 100; 0 leaves the picture as it is.
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub tint: f32,
    #[serde(default)]
    pub saturation: f32,
    #[serde(default)]
    pub brightness: f32,
    #[serde(default)]
    pub contrast: f32,
    #[serde(default)]
    pub highlights: f32,
    #[serde(default)]
    pub shadows: f32,
    /// Positive sharpens, negative softens.
    #[serde(default)]
    pub sharpen: f32,
    /// Positive darkens the edges, negative lightens them.
    #[serde(default)]
    pub vignette: f32,
    /// 0.1–10: the clip plays `duration_us * speed` of its source (see `span_us`).
    #[serde(default = "one_f64")]
    pub speed: f64,
    /// Plays its part of the source backwards.
    #[serde(default)]
    pub reverse: bool,
    /// Animated settings by name: values at times from the clip's start on the timeline, in
    /// time order. Any name is kept; the graph animates scale, position, rotation, opacity,
    /// brightness, contrast and saturation.
    #[serde(default)]
    pub keyframes: Keyframes,
    // Contract v2 (docs/contract-v2.md), always written out too.
    /// Upside down.
    #[serde(default)]
    pub flip_v: bool,
    /// Off: scale, position, rotation and opacity are bypassed (their values are kept).
    #[serde(default = "yes")]
    pub transform_on: bool,
    /// How an overlay clip mixes with what's below (see `look::BLENDS`).
    #[serde(default = "normal")]
    pub blend: String,
    /// Video effects, in order.
    #[serde(default)]
    pub effects: Vec<Fx>,
    /// On a main-track clip: the transition into it from the clip before.
    #[serde(default)]
    pub transition: Option<Transition>,
    #[serde(default)]
    pub hsl: HslMap,
    #[serde(default)]
    pub curves: Curves,
    #[serde(default)]
    pub wheels: Wheels,
    #[serde(default)]
    pub lut: Option<Lut>,
    #[serde(default)]
    pub stabilize: Option<Stabilize>,
    /// Smooth slow motion (export only).
    #[serde(default)]
    pub smooth: Option<Smooth>,
    /// With a speed other than 1 the sound keeps its pitch; off, the pitch follows the speed.
    #[serde(default = "yes")]
    pub keep_pitch: bool,
    /// A speed ramp. `speed` is then its mean, so the clip keeps its source range.
    #[serde(default)]
    pub speed_curve: Option<SpeedCurve>,
    #[serde(default)]
    pub mask: Option<Mask>,
    /// The mask as the renderer drew it at project size (white keeps): what the engine uses.
    #[serde(default)]
    pub mask_png: Option<String>,
    #[serde(default)]
    pub matte: Option<Matte>,
    #[serde(default)]
    pub anim: Anim,
    /// A text clip (no media): the renderer's drawing of it is `text.png`.
    #[serde(default)]
    pub text: Option<TextSpec>,
    /// A caption line, on a captions track.
    #[serde(default)]
    pub caption: bool,
    /// Frequency bands taken out of the sound (spectral delete).
    #[serde(default)]
    pub spectral: Vec<Spectral>,
    /// Set while outside work makes a new file for this clip (Vmake text removal): the job's
    /// id. Until it's cleared, edits leave the clip alone (see `busy_kept`). Only the app sets
    /// and clears it (`clip.busy`, `clip.release`); it isn't part of the undo history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<String>,
}

fn normal() -> String {
    "normal".into()
}

/// A clip's keyframes, by setting.
pub type Keyframes = BTreeMap<String, Vec<Keyframe>>;

/// One keyframe: a setting's value at a time from the clip's start on the timeline, and how
/// it moves on from there to the next keyframe.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub at_us: Us,
    pub value: f64,
    #[serde(default)]
    pub ease: Ease,
}

/// How a keyframed setting moves from one keyframe to the next.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ease {
    #[default]
    Linear,
    /// Starts slowly (quadratic).
    #[serde(rename = "Ease in")]
    In,
    /// Slows down at the end (quadratic).
    #[serde(rename = "Ease out")]
    Out,
    /// Both (smoothstep).
    #[serde(rename = "Ease in and out")]
    InOut,
}

impl Ease {
    /// How far along the way (0–1) the value is when `p` (0–1) of the time has gone.
    pub fn apply(self, p: f64) -> f64 {
        let p = p.clamp(0.0, 1.0);
        match self {
            Ease::Linear => p,
            Ease::In => p * p,
            Ease::Out => 1.0 - (1.0 - p) * (1.0 - p),
            Ease::InOut => p * p * (3.0 - 2.0 * p),
        }
    }
}

/// A keyframed value at `at`: from each keyframe to the next along that keyframe's ease
/// (straight by default), flat before the first and after the last. `None` without points.
pub fn keyframe_value(points: &[Keyframe], at: Us) -> Option<f64> {
    let (first, last) = (points.first()?, points.last()?);
    if at <= first.at_us {
        return Some(first.value);
    }
    if at >= last.at_us {
        return Some(last.value);
    }
    let i = points.iter().position(|p| p.at_us > at)?;
    let (a, b) = (points[i - 1], points[i]);
    let p = (at - a.at_us) as f64 / (b.at_us - a.at_us).max(1) as f64;
    Some(a.value + (b.value - a.value) * a.ease.apply(p))
}

/// The ease of the keyframe that starts the stretch `at` is in.
fn ease_at(points: &[Keyframe], at: Us) -> Ease {
    points.iter().rev().find(|p| p.at_us <= at).map_or(Ease::Linear, |p| p.ease)
}

/// The keyframes between `a` and `b`, timed from `a`. A setting still moving at either end
/// gets a point there with its value at that moment, so the cut piece looks the same.
fn cut_keyframes(keys: &Keyframes, a: Us, b: Us) -> Keyframes {
    let mut out = Keyframes::new();
    for (name, pts) in keys {
        let mut cut = vec![];
        if pts.first().is_some_and(|p| p.at_us < a) {
            cut.push(Keyframe { at_us: 0, value: keyframe_value(pts, a).unwrap_or(0.0), ease: ease_at(pts, a) });
        }
        cut.extend(pts.iter().filter(|p| p.at_us >= a && p.at_us <= b).map(|p| Keyframe { at_us: p.at_us - a, ..*p }));
        if pts.last().is_some_and(|p| p.at_us > b) {
            cut.push(Keyframe { at_us: b - a, value: keyframe_value(pts, b).unwrap_or(0.0), ease: ease_at(pts, b) });
        }
        cut.dedup_by_key(|p| p.at_us);
        if !cut.is_empty() {
            out.insert(name.clone(), cut);
        }
    }
    out
}

/// One point of a clip's volume envelope: a gain (1 = as recorded) at a time in the source
/// file, so trimming and splitting never move it against the sound.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPoint {
    pub at_us: Us,
    pub gain: f32,
}

fn is_zero(n: &u16) -> bool {
    *n == 0
}

fn is_zero_us(n: &Us) -> bool {
    *n == 0
}

fn is_zero_f32(n: &f32) -> bool {
    *n == 0.0
}

/// A crop rectangle in fractions of the source frame (0–1), applied before rotation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Crop {
    /// Kept inside the frame and at least 5 % on each side; `None` if it's the whole frame.
    pub fn clean(self) -> Option<Crop> {
        let w = self.w.clamp(0.05, 1.0);
        let h = self.h.clamp(0.05, 1.0);
        let c = Crop { x: self.x.clamp(0.0, 1.0 - w), y: self.y.clamp(0.0, 1.0 - h), w, h };
        let whole = c.x < 1e-4 && c.y < 1e-4 && c.w > 1.0 - 1e-4 && c.h > 1.0 - 1e-4;
        (!whole).then_some(c)
    }
}

fn one() -> f32 {
    1.0
}

fn one_f64() -> f64 {
    1.0
}

fn hundred() -> f32 {
    100.0
}

fn yes() -> bool {
    true
}

impl Clip {
    /// A plain clip: full volume, filled, no fades or other settings.
    pub fn new(id: String, media_id: String, start_us: Us, in_us: Us, duration_us: Us) -> Self {
        Clip {
            id,
            media_id,
            start_us,
            in_us,
            duration_us,
            volume: 1.0,
            fit: Fit::Fill,
            link: None,
            detached: false,
            crop: None,
            flip: false,
            rotate: 0,
            fade_in_us: 0,
            fade_out_us: 0,
            fade_curve: String::new(),
            pitch: 0.0,
            declick: false,
            envelope: vec![],
            scale: 100.0,
            pos_x: 0.0,
            pos_y: 0.0,
            rotation: 0.0,
            opacity: 100.0,
            temperature: 0.0,
            tint: 0.0,
            saturation: 0.0,
            brightness: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            sharpen: 0.0,
            vignette: 0.0,
            speed: 1.0,
            reverse: false,
            keyframes: Keyframes::new(),
            flip_v: false,
            transform_on: true,
            blend: normal(),
            effects: vec![],
            transition: None,
            hsl: HslMap::new(),
            curves: Curves::default(),
            wheels: Wheels::default(),
            lut: None,
            stabilize: None,
            smooth: None,
            keep_pitch: true,
            speed_curve: None,
            mask: None,
            mask_png: None,
            matte: None,
            anim: Anim::default(),
            text: None,
            caption: false,
            spectral: vec![],
            busy: None,
        }
    }

    /// True for a clip with no media of its own: a text clip or an adjustment layer.
    pub fn is_synthetic(&self) -> bool {
        self.media_id.is_empty()
    }

    pub fn end_us(&self) -> Us {
        self.start_us + self.duration_us
    }

    /// How much of the source the clip plays: its length times its speed.
    pub fn span_us(&self) -> Us {
        (self.duration_us as f64 * self.speed).round() as Us
    }

    /// The source time shown `offset` after the clip's start. Reversed, the clip starts at
    /// the end of its source range and works back to `in_us`.
    pub fn source_at(&self, offset: Us) -> Us {
        let o = match &self.speed_curve {
            // On a ramp, the share of the source shown so far follows the curve.
            Some(c) => (self.span_us() as f64 * c.source_fraction(offset as f64 / self.duration_us.max(1) as f64)).round() as Us,
            None => (offset as f64 * self.speed).round() as Us,
        };
        if self.reverse { self.in_us + self.span_us() - o } else { self.in_us + o }
    }

    /// A setting's value `offset` after the clip's start: from its keyframes if it has any,
    /// else `base` (the slider's value).
    pub fn value_at(&self, name: &str, offset: Us, base: f64) -> f64 {
        self.keyframes.get(name).and_then(|k| keyframe_value(k, offset)).unwrap_or(base)
    }

    /// The part from `a` to `b` (offsets from the clip's start) as a clip of its own, starting
    /// at `start_us + a`: the matching source range (for a reversed clip, the later part of
    /// the source comes first) and the keyframes cut to it. Fades are left to the caller.
    pub(crate) fn piece(&self, a: Us, b: Us) -> Clip {
        let mut p = self.clone();
        p.start_us = self.start_us + a;
        p.in_us = if self.reverse { self.source_at(b) } else { self.source_at(a) };
        p.duration_us = b - a;
        p.keyframes = cut_keyframes(&self.keyframes, a, b);
        // A speed ramp is cut with it: the piece reads its own part of the ramp's source.
        if let Some(curve) = &self.speed_curve {
            let d = self.duration_us.max(1) as f64;
            let (ua, ub) = (a as f64 / d, b as f64 / d);
            let span = self.span_us() as f64;
            let (fa, fb) = (curve.source_fraction(ua), curve.source_fraction(ub));
            p.in_us = self.in_us + (span * if self.reverse { 1.0 - fb } else { fa }).round() as Us;
            let mut pts = vec![[0.0, curve.at(ua)]];
            pts.extend(curve.points.iter().filter(|q| q[0] > ua && q[0] < ub).map(|q| [(q[0] - ua) / (ub - ua).max(1e-9), q[1]]));
            pts.push([1.0, curve.at(ub)]);
            let sub = SpeedCurve { name: curve.name.clone(), points: pts }.clean();
            p.speed = (span * (fb - fa) / (b - a).max(1) as f64).clamp(0.1, 10.0);
            p.speed_curve = sub;
        }
        // The way in (transition, start animation) stays with the first piece, the way out
        // with the last.
        if a > 0 {
            p.transition = None;
            p.anim.in_ = None;
        }
        if b < self.duration_us {
            p.anim.out = None;
        }
        p
    }

    /// Changes the speed, keeping the source range: the clip gets longer or shorter on the
    /// timeline, its keyframes stay with the picture and its fades keep their length.
    fn retime(&mut self, speed: f64, source_us: Us) {
        let span = self.span_us();
        let old = self.speed;
        self.speed = speed;
        self.duration_us = ((span as f64 / speed).round() as Us).max(MIN_CLIP);
        // A clip at the shortest length can't keep all of a short span; it stays in its source.
        self.in_us = self.in_us.min((source_us - self.span_us()).max(0));
        for pts in self.keyframes.values_mut() {
            for p in pts.iter_mut() {
                p.at_us = (p.at_us as f64 * old / speed).round() as Us;
            }
        }
        self.fade_in_us = self.fade_in_us.min(self.duration_us);
        self.fade_out_us = self.fade_out_us.min(self.duration_us - self.fade_in_us);
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub main: bool,
    pub clips: Vec<Clip>,
    /// The track's fader, in dB (−60 to +12).
    #[serde(default)]
    pub gain_db: f32,
    /// Balance: −1 is hard left, 1 hard right.
    #[serde(default)]
    pub pan: f32,
    #[serde(default)]
    pub mute: bool,
    /// While any track is soloed, only soloed tracks are heard.
    #[serde(default)]
    pub solo: bool,
    /// Effects run live on the track's sound in playback, the sound mix and export.
    #[serde(default)]
    pub effects: Effects,
    /// "voice" or "music": how the Audio page shows the track ("" lets it guess).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub role: String,
    /// A locked track's clips can't be moved, trimmed, split, deleted or retimed, and nothing
    /// is pasted onto it; the edits say so (see `check_unlocked`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// A hidden picture track is left out of preview and export (its sound still plays).
    #[serde(default)]
    pub hidden: bool,
}

impl Track {
    pub fn new(id: String, kind: TrackKind, main: bool) -> Self {
        Track { id, kind, main, clips: vec![], gain_db: 0.0, pan: 0.0, mute: false, solo: false, effects: Effects::default(), role: String::new(), locked: false, hidden: false }
    }

    /// A picture track over the main one (text, captions, stickers, overlays, adjustment layers).
    pub fn is_visual(&self) -> bool {
        self.kind == TrackKind::Video && !self.main
    }
}

/// The kind of track a clip off the main track sits on: sound, or a picture track with its role.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Lane {
    Audio,
    Visual(String),
}

impl Lane {
    /// True if `t` is this kind of track: any sound track for sound; for pictures, a track over
    /// the video with the same role (an old one with none is an overlay track), so text stays
    /// on text tracks and caption lines on captions tracks.
    pub(crate) fn holds(&self, t: &Track) -> bool {
        let role = |r: &str| if r.is_empty() { "overlay".to_string() } else { r.to_string() };
        match self {
            Lane::Audio => !t.main && t.kind == TrackKind::Audio,
            Lane::Visual(r) => t.is_visual() && role(&t.role) == role(r),
        }
    }
}

/// Where a picture lifted off the main track goes: the track an id names (an id that names
/// none, the space above every track: a new track on top), or a new track made at an index in
/// the track list (dropped between two rows).
#[derive(Clone, Copy)]
enum Onto<'a> {
    Track(&'a str),
    NewAt(usize),
}

/// True if `c` fits on `t` among its other clips. On a sound track two clips may overlap by
/// as much as they crossfade: the earlier one's fade out and the later one's fade in both
/// cover the overlap (`audio.crossfade` sets that up).
pub(crate) fn fits(t: &Track, c: &Clip) -> bool {
    t.clips.iter().filter(|o| o.id != c.id).all(|o| {
        let overlap = c.end_us().min(o.end_us()) - c.start_us.max(o.start_us);
        if overlap <= 0 {
            return true;
        }
        let (first, second) = if o.start_us < c.start_us { (o, c) } else { (c, o) };
        t.kind == TrackKind::Audio && second.start_us > first.start_us && second.end_us() > first.end_us() && overlap <= first.fade_out_us && overlap <= second.fade_in_us
    })
}

/// A track's effects chain, in the order the sound runs through it. Each one keeps its
/// settings while it's off.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    pub noise: NoiseReduction,
    pub eq: VoiceEq,
    pub comp: Compressor,
    pub deess: DeEsser,
    pub limiter: Limiter,
}

/// Broadband noise reduction (FFmpeg's afftdn, tracking the noise as it goes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoiseReduction {
    pub on: bool,
    /// How far the noise is pushed down, 0–30 dB.
    pub reduction_db: f32,
    /// 0–24: higher counts more of the quiet sound as noise.
    pub sensitivity: f32,
}

impl Default for NoiseReduction {
    fn default() -> Self {
        NoiseReduction { on: false, reduction_db: 12.0, sensitivity: 6.0 }
    }
}

/// A voice EQ: a high-pass for rumble and a presence lift around 4 kHz.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceEq {
    pub on: bool,
    /// 20–300 Hz.
    pub highpass_hz: f32,
    /// 0–12 dB.
    pub presence_db: f32,
}

impl Default for VoiceEq {
    fn default() -> Self {
        VoiceEq { on: false, highpass_hz: 80.0, presence_db: 3.0 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Compressor {
    pub on: bool,
    /// −60–0 dB.
    pub threshold_db: f32,
    /// 1–10 (to one).
    pub ratio: f32,
    /// 1–100 ms.
    pub attack_ms: f32,
    /// 10–1000 ms.
    pub release_ms: f32,
}

impl Default for Compressor {
    fn default() -> Self {
        Compressor { on: false, threshold_db: -18.0, ratio: 3.0, attack_ms: 10.0, release_ms: 120.0 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeEsser {
    pub on: bool,
    /// 0–12 dB.
    pub amount_db: f32,
}

impl Default for DeEsser {
    fn default() -> Self {
        DeEsser { on: false, amount_db: 4.0 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limiter {
    pub on: bool,
    /// −6–0 dB.
    pub ceiling_db: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Limiter { on: false, ceiling_db: -1.0 }
    }
}

impl Effects {
    /// Keeps every setting in its range.
    pub fn clean(&mut self) {
        let n = &mut self.noise;
        n.reduction_db = n.reduction_db.clamp(0.0, 30.0);
        n.sensitivity = n.sensitivity.clamp(0.0, 24.0);
        let e = &mut self.eq;
        e.highpass_hz = e.highpass_hz.clamp(20.0, 300.0);
        e.presence_db = e.presence_db.clamp(0.0, 12.0);
        let c = &mut self.comp;
        c.threshold_db = c.threshold_db.clamp(-60.0, 0.0);
        c.ratio = c.ratio.clamp(1.0, 10.0);
        c.attack_ms = c.attack_ms.clamp(1.0, 100.0);
        c.release_ms = c.release_ms.clamp(10.0, 1000.0);
        self.deess.amount_db = self.deess.amount_db.clamp(0.0, 12.0);
        self.limiter.ceiling_db = self.limiter.ceiling_db.clamp(-6.0, 0.0);
    }

    /// How many effects are switched on.
    pub fn count_on(&self) -> usize {
        [self.noise.on, self.eq.on, self.comp.on, self.deess.on, self.limiter.on].iter().filter(|x| **x).count()
    }
}

/// What everything you export goes through, after the tracks are mixed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Master {
    /// Levels the export to `target_lufs` (EBU R128).
    pub normalize: bool,
    pub target_lufs: f32,
    /// Keeps true peaks under `ceiling_db` dBTP.
    pub limiter: bool,
    pub ceiling_db: f32,
    /// Gain on the whole mix, heard in playback too ("Normalise the mix" sets it).
    pub gain_db: f32,
}

impl Default for Master {
    fn default() -> Self {
        Master { normalize: true, target_lufs: -14.0, limiter: true, ceiling_db: -1.0, gain_db: 0.0 }
    }
}

/// A named stretch of the timeline on the labels track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub start_us: Us,
    pub end_us: Us,
    pub text: String,
}

/// What `set_track` changes; `None` leaves a setting as it is.
#[derive(Debug, Default, Clone)]
pub struct TrackChange {
    pub gain_db: Option<f32>,
    pub pan: Option<f32>,
    pub mute: Option<bool>,
    pub solo: Option<bool>,
    pub effects: Option<Effects>,
    pub role: Option<String>,
    pub locked: Option<bool>,
    pub hidden: Option<bool>,
}

/// What `set_master` changes; `None` leaves a setting as it is.
#[derive(Debug, Default, Clone)]
pub struct MasterChange {
    pub normalize: Option<bool>,
    pub target_lufs: Option<f32>,
    pub limiter: Option<bool>,
    pub ceiling_db: Option<f32>,
    pub gain_db: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub media: Vec<Media>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub next_id: u64,
    /// The main track closes gaps by itself (CapCut's main track magnet). Off: clips sit
    /// where you put them, gaps play black, and a clip dropped onto another pushes it on.
    #[serde(default = "yes")]
    pub magnet: bool,
    /// Linked clips (a video and its extracted audio) move and split together; deleting the
    /// video leaves its audio.
    #[serde(default = "yes")]
    pub linkage: bool,
    /// The master stage: export loudness and limiting, and a gain on the whole mix.
    #[serde(default)]
    pub master: Master,
    /// Labels on the Audio page's labels track and markers (a label whose start and end
    /// are equal), in time order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<Label>,
    /// The frame used as the video's cover (thumbnail), in timeline time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_us: Option<Us>,
    /// The brand kit (colours and fonts) the text and sticker tabs offer.
    #[serde(default)]
    pub brand: Brand,
    /// What MCP clients may do here.
    #[serde(default)]
    pub mcp: McpOptions,
    /// The project's cache folder (not saved): where stabilising transforms are kept.
    #[serde(skip)]
    pub cache_dir: Option<String>,
}

/// Output sizes for the formats an ad goes out in.
pub fn format_size(aspect: &str) -> Option<(u32, u32)> {
    match aspect {
        "9:16" => Some((1080, 1920)),
        "4:5" => Some((1080, 1350)),
        "1:1" => Some((1080, 1080)),
        "16:9" => Some((1920, 1080)),
        _ => None,
    }
}

/// What `set_clip` changes; `None` leaves a setting as it is.
#[derive(Debug, Default, Clone)]
pub struct ClipChange {
    pub volume: Option<f32>,
    pub fit: Option<Fit>,
    pub detached: Option<bool>,
    /// `Some(None)` removes the crop.
    pub crop: Option<Option<Crop>>,
    pub flip: Option<bool>,
    pub rotate: Option<u16>,
    pub fade_in_us: Option<Us>,
    pub fade_out_us: Option<Us>,
    pub fade_curve: Option<String>,
    pub pitch: Option<f32>,
    pub declick: Option<bool>,
    pub envelope: Option<Vec<EnvPoint>>,
    pub scale: Option<f32>,
    pub pos_x: Option<f32>,
    pub pos_y: Option<f32>,
    pub rotation: Option<f32>,
    pub opacity: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub saturation: Option<f32>,
    pub brightness: Option<f32>,
    pub contrast: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub sharpen: Option<f32>,
    pub vignette: Option<f32>,
    pub speed: Option<f64>,
    pub reverse: Option<bool>,
    /// Replaces all of the clip's keyframes.
    pub keyframes: Option<Keyframes>,
    // Contract v2. `Some(None)` removes an optional setting.
    pub flip_v: Option<bool>,
    pub transform_on: Option<bool>,
    pub blend: Option<String>,
    pub effects: Option<Vec<Fx>>,
    pub transition: Option<Option<Transition>>,
    pub hsl: Option<HslMap>,
    pub curves: Option<Curves>,
    pub wheels: Option<Wheels>,
    pub lut: Option<Option<Lut>>,
    pub stabilize: Option<Option<Stabilize>>,
    pub smooth: Option<Option<Smooth>>,
    pub keep_pitch: Option<bool>,
    pub speed_curve: Option<Option<SpeedCurve>>,
    pub mask: Option<Option<Mask>>,
    pub mask_png: Option<Option<String>>,
    pub matte: Option<Option<Matte>>,
    pub anim: Option<Anim>,
    /// Merged into the clip's text (keys sent replace those keys; `null` removes one).
    pub text: Option<TextSpec>,
    pub caption: Option<bool>,
    pub spectral: Option<Vec<Spectral>>,
}

impl ClipChange {
    /// Refuses names the engine doesn't know (effects, blend modes, transitions, animations,
    /// HSL ranges, smooth qualities), naming the first one.
    pub fn check(&self) -> Result<(), EditError> {
        if let Some(fx) = &self.effects {
            if let Some(bad) = fx.iter().find(|f| !EFFECTS.contains(&f.name.as_str())) {
                return err(format!("Unknown effect \"{}\"", bad.name));
            }
        }
        if let Some(b) = self.blend.as_deref().filter(|b| !BLENDS.contains(b)) {
            return err(format!("Unknown blend mode \"{b}\""));
        }
        if let Some(Some(t)) = &self.transition {
            if xfade_name(&t.name).is_none() {
                return err(format!("Unknown transition \"{}\"", t.name));
            }
        }
        if let Some(a) = &self.anim {
            for step in [&a.in_, &a.out].into_iter().flatten() {
                if !ANIMS.contains(&step.name.as_str()) {
                    return err(format!("Unknown animation \"{}\"", step.name));
                }
            }
            if let Some(l) = a.loop_.as_ref().filter(|l| !LOOPS.contains(&l.name.as_str())) {
                return err(format!("Unknown loop animation \"{}\"", l.name));
            }
        }
        if let Some(bad) = self.hsl.as_ref().and_then(|h| h.keys().find(|k| !HSL_RANGES.contains(&k.as_str()))) {
            return err(format!("Unknown HSL range \"{bad}\""));
        }
        if let Some(Some(s)) = &self.smooth {
            if !matches!(s.quality.as_str(), "Fast" | "Best") {
                return err(format!("Unknown smooth quality \"{}\" (Fast or Best)", s.quality));
            }
        }
        Ok(())
    }
}

/// Applies contract v2's settings to a clip, each kept in range (all but the speed ramp,
/// which `set_clip` retimes the clip with).
fn set_v2(clip: &mut Clip, c: &ClipChange, has_source: bool) {
    if let Some(v) = c.flip_v {
        clip.flip_v = v;
    }
    if let Some(v) = c.transform_on {
        clip.transform_on = v;
    }
    if let Some(b) = &c.blend {
        clip.blend = b.clone();
    }
    if let Some(fx) = &c.effects {
        clip.effects = fx.iter().filter(|f| f.amount.is_finite()).map(|f| Fx { name: f.name.clone(), amount: f.amount.clamp(0.0, 100.0) }).collect();
    }
    if let Some(t) = &c.transition {
        clip.transition = t.clone().map(|t| Transition { duration_us: t.duration_us.clamp(MIN_CLIP, clip.duration_us.max(MIN_CLIP)), ..t });
    }
    if let Some(h) = &c.hsl {
        clip.hsl = h.iter().map(|(k, v)| (k.clone(), Hsl { h: v.h.clamp(-100.0, 100.0), s: v.s.clamp(-100.0, 100.0), l: v.l.clamp(-100.0, 100.0) })).filter(|(_, v)| v.h != 0.0 || v.s != 0.0 || v.l != 0.0).collect();
    }
    if let Some(k) = &c.curves {
        // A straight curve is the same as none.
        let tidy = |p: &Option<Vec<[f64; 2]>>| p.clone().and_then(clean_points).filter(|p| p.iter().any(|q| (q[0] - q[1]).abs() > 1e-4));
        clip.curves = Curves { master: tidy(&k.master), red: tidy(&k.red), green: tidy(&k.green), blue: tidy(&k.blue) };
    }
    if let Some(w) = &c.wheels {
        let tidy = |w: &Option<Wheel>| w.map(|w| Wheel { x: w.x.clamp(-1.0, 1.0), y: w.y.clamp(-1.0, 1.0), lum: w.lum.clamp(-100.0, 100.0) }).filter(|w| w.x != 0.0 || w.y != 0.0 || w.lum != 0.0);
        clip.wheels = Wheels { lift: tidy(&w.lift), gamma: tidy(&w.gamma), gain: tidy(&w.gain) };
    }
    if let Some(l) = &c.lut {
        clip.lut = l.clone().filter(|l| !l.path.is_empty()).map(|l| Lut { strength: if l.strength.is_finite() { l.strength.clamp(0.0, 100.0) } else { 100.0 }, ..l });
    }
    if let Some(s) = &c.stabilize {
        clip.stabilize = s.clone().filter(|_| has_source).map(|s| Stabilize { strength: if s.strength.is_finite() { s.strength.clamp(0.0, 100.0) } else { 100.0 } });
    }
    if let Some(s) = &c.smooth {
        clip.smooth = s.clone();
    }
    if let Some(k) = c.keep_pitch {
        clip.keep_pitch = k;
    }
    if let Some(m) = &c.mask {
        clip.mask = m.clone().map(|m| Mask { x: m.x.clamp(-2.0, 3.0), y: m.y.clamp(-2.0, 3.0), w: m.w.clamp(0.0, 4.0), h: m.h.clamp(0.0, 4.0), feather: m.feather.clamp(0.0, 100.0), ..m });
    }
    if let Some(p) = &c.mask_png {
        clip.mask_png = p.clone().filter(|p| !p.is_empty());
    }
    if let Some(m) = &c.matte {
        clip.matte = m.clone().filter(|m| !m.path.is_empty());
    }
    if let Some(a) = &c.anim {
        let len = clip.duration_us.max(MIN_CLIP);
        let step = |s: &Option<AnimStep>| s.clone().map(|s| AnimStep { duration_us: s.duration_us.clamp(MIN_CLIP / 2, len), ..s });
        clip.anim = Anim { in_: step(&a.in_), out: step(&a.out), loop_: a.loop_.clone().map(|l| AnimLoop { period_us: l.period_us.clamp(MIN_CLIP, 60 * SECOND), ..l }) };
    }
    if let Some(patch) = &c.text {
        let text = clip.text.get_or_insert_with(TextSpec::new);
        for (k, v) in patch {
            if v.is_null() {
                text.remove(k);
            } else {
                text.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(on) = c.caption {
        clip.caption = on;
    }
    if let Some(s) = &c.spectral {
        clip.spectral = s.iter().filter_map(|s| Spectral::clean(*s)).collect();
    }
}

impl Spectral {
    /// Start before end, and the band inside what can be heard, at least 10 Hz wide.
    pub fn clean(s: Spectral) -> Option<Spectral> {
        let (lo, hi) = (s.low_hz.min(s.high_hz).clamp(10.0, 24_000.0), s.low_hz.max(s.high_hz).clamp(10.0, 24_000.0));
        let (a, b) = (s.start_us.min(s.end_us).max(0), s.start_us.max(s.end_us));
        (s.low_hz.is_finite() && s.high_hz.is_finite() && hi - lo >= 10.0 && b > a).then_some(Spectral { start_us: a, end_us: b, low_hz: lo, high_hz: hi })
    }
}

#[derive(Debug, PartialEq)]
pub struct EditError(pub String);

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub(crate) type R<T> = Result<T, EditError>;
pub(crate) fn err<T>(msg: impl Into<String>) -> R<T> {
    Err(EditError(msg.into()))
}

impl Project {
    pub fn new(name: &str, aspect: &str) -> Self {
        let (width, height) = format_size(aspect).unwrap_or((1080, 1920));
        let mut p = Project { name: name.into(), width, height, fps: 30, media: vec![], folders: vec![], tracks: vec![], next_id: 1, magnet: true, linkage: true, master: Master::default(), labels: vec![], cover_us: None, brand: Brand::default(), mcp: McpOptions::default(), cache_dir: None };
        let id = p.make_id("t");
        p.tracks.push(Track::new(id, TrackKind::Video, true));
        p
    }

    pub fn make_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}{}", self.next_id);
        self.next_id += 1;
        id
    }

    pub fn duration_us(&self) -> Us {
        self.tracks.iter().flat_map(|t| t.clips.iter()).map(Clip::end_us).max().unwrap_or(0)
    }

    pub fn media(&self, id: &str) -> Option<&Media> {
        self.media.iter().find(|m| m.id == id)
    }

    pub fn main_track(&self) -> &Track {
        self.tracks.iter().find(|t| t.main).expect("project always has a main track")
    }

    pub(crate) fn main_track_mut(&mut self) -> &mut Track {
        self.tracks.iter_mut().find(|t| t.main).expect("project always has a main track")
    }

    pub fn find_clip(&self, clip_id: &str) -> Option<(usize, usize)> {
        self.tracks.iter().enumerate().find_map(|(ti, t)| t.clips.iter().position(|c| c.id == clip_id).map(|ci| (ti, ci)))
    }

    pub fn clip(&self, clip_id: &str) -> Option<&Clip> {
        self.find_clip(clip_id).map(|(t, c)| &self.tracks[t].clips[c])
    }

    pub fn set_format(&mut self, aspect: &str) -> R<()> {
        let Some((w, h)) = format_size(aspect) else { return err(format!("unknown format {aspect}")) };
        self.width = w;
        self.height = h;
        Ok(())
    }

    /// Restores the invariants after any edit. The main track never overlaps: with the
    /// magnet on it's packed from 0; with it off, clips keep their times and an overlap
    /// pushes the later clip on.
    pub fn normalize(&mut self) {
        let magnet = self.magnet;
        let main = self.main_track_mut();
        if !magnet {
            main.clips.sort_by_key(|c| c.start_us);
        }
        let mut t = 0;
        for c in &mut main.clips {
            c.start_us = if magnet { t } else { c.start_us.max(t) };
            t = c.start_us + c.duration_us;
        }
        for track in self.tracks.iter_mut().filter(|t| !t.main) {
            track.clips.sort_by_key(|c| c.start_us);
        }
        self.tracks.retain(|t| t.main || !t.clips.is_empty());
    }

    pub(crate) fn default_duration(media: &Media) -> Us {
        if media.kind == MediaKind::Image { IMAGE_DEFAULT } else { media.duration_us.max(MIN_CLIP) }
    }

    fn main_index_at(&self, at: Us) -> usize {
        self.main_track().clips.iter().position(|c| at < c.start_us + c.duration_us / 2).unwrap_or(self.main_track().clips.len())
    }

    /// What the interface calls a track, for messages: "main", its role, or its first file.
    pub(crate) fn track_name(&self, t: &Track) -> String {
        if t.main {
            return "main".into();
        }
        if !t.role.is_empty() {
            return t.role.clone();
        }
        let file = t.clips.first().and_then(|c| self.media(&c.media_id)).map(|m| m.name.rsplit_once('.').map_or(m.name.as_str(), |(stem, _)| stem).to_string());
        file.unwrap_or_else(|| "audio".into())
    }

    /// Refuses an edit that would change clips on a locked track, or a busy clip.
    pub(crate) fn check_unlocked(&self, clip_ids: &[String]) -> R<()> {
        if let Some(c) = self.tracks.iter().flat_map(|t| &t.clips).find(|c| c.busy.is_some() && clip_ids.contains(&c.id)) {
            return err(self.busy_message(c));
        }
        match self.tracks.iter().find(|t| t.locked && t.clips.iter().any(|c| clip_ids.contains(&c.id))) {
            Some(t) => err(format!("The {} track is locked", self.track_name(t))),
            None => Ok(()),
        }
    }

    fn busy_message(&self, c: &Clip) -> String {
        let name = self.media(&c.media_id).map_or(c.id.as_str(), |m| m.name.as_str());
        format!("Text is still being removed from {name}. Wait for it, or cancel it from the clip's right-click menu")
    }

    /// Marks a clip busy with outside work (`job`), or clears the mark (`None`).
    pub fn set_busy(&mut self, clip_id: &str, job: Option<&str>) -> R<()> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        if let Some(j) = job {
            // Its result replaces the clip's media, which a locked track wouldn't allow.
            if self.tracks[ti].locked {
                return err(format!("The {} track is locked", self.track_name(&self.tracks[ti])));
            }
            let c = &self.tracks[ti].clips[ci];
            if c.busy.as_deref().is_some_and(|b| b != j) {
                return err(self.busy_message(c));
            }
        }
        self.tracks[ti].clips[ci].busy = job.map(str::to_string);
        Ok(())
    }

    /// Whether going from `before` to this project leaves its busy clips alone: each still
    /// there, on the same track, and unchanged but for where it starts (clips before it on
    /// the main track may come and go). `Doc` checks every edit, undo and redo with it, so
    /// nothing (the app, MCP, history) changes or removes a clip while work on it runs.
    pub fn busy_kept(&self, before: &Project) -> R<()> {
        for t in &before.tracks {
            for c in t.clips.iter().filter(|c| c.busy.is_some()) {
                let now = self.tracks.iter().find_map(|t2| t2.clips.iter().find(|x| x.id == c.id).map(|x| (t2, x)));
                let kept = now.is_some_and(|(t2, x)| t2.id == t.id && Clip { start_us: c.start_us, ..x.clone() } == *c);
                if !kept {
                    return err(before.busy_message(c));
                }
            }
        }
        Ok(())
    }

    /// Refuses putting clips into the main track while it's locked.
    fn check_main_unlocked(&self) -> R<()> {
        if self.main_track().locked { err("The main track is locked") } else { Ok(()) }
    }

    /// What kind of track the track at `ti` is, for clips that leave it.
    pub(crate) fn lane_of(&self, ti: usize) -> Lane {
        let t = &self.tracks[ti];
        if t.is_visual() { Lane::Visual(t.role.clone()) } else { Lane::Audio }
    }

    /// Index of a track `c` fits on, creating one if needed. Sound: `prefer` if it's free,
    /// else the first free unlocked sound track. Pictures: `prefer` if it's a free picture
    /// track of the lane's role, else the track it came from (`home`), else a new track with
    /// the lane's role just above `home` (or on top), so it keeps its place in the stack.
    pub(crate) fn track_for(&mut self, lane: &Lane, c: &Clip, prefer: Option<&str>, home: Option<&str>) -> usize {
        let free = |t: &Track| !t.locked && lane.holds(t) && fits(t, c);
        if let Some(i) = prefer.and_then(|id| self.tracks.iter().position(|t| t.id == id)).filter(|&i| free(&self.tracks[i])) {
            return i;
        }
        let home = home.and_then(|id| self.tracks.iter().position(|t| t.id == id));
        let Lane::Visual(role) = lane else {
            if let Some(i) = self.tracks.iter().position(free) {
                return i;
            }
            let id = self.make_id("t");
            self.tracks.push(Track::new(id, TrackKind::Audio, false));
            return self.tracks.len() - 1;
        };
        if let Some(i) = home.filter(|&i| free(&self.tracks[i])) {
            return i;
        }
        let mut t = Track::new(self.make_id("t"), TrackKind::Video, false);
        t.role = role.clone();
        let at = home.map_or(self.tracks.len(), |i| i + 1);
        self.tracks.insert(at, t);
        at
    }

    /// A new, empty track for `lane` made at `index` in the track list (kept above the main
    /// track), for a clip dropped between two rows or above them all. Returns its index.
    pub(crate) fn new_track_at(&mut self, lane: &Lane, index: usize) -> usize {
        let main = self.tracks.iter().position(|t| t.main).unwrap_or(0);
        let mut t = Track::new(self.make_id("t"), if *lane == Lane::Audio { TrackKind::Audio } else { TrackKind::Video }, false);
        if let Lane::Visual(role) = lane {
            t.role = role.clone();
        }
        let at = index.clamp(main + 1, self.tracks.len());
        self.tracks.insert(at, t);
        at
    }

    /// Puts media on the timeline. Video and images go into the main track at `at`;
    /// audio goes on an audio track starting at `at`. Returns the new clip's id.
    pub fn insert(&mut self, media_id: &str, at: Us) -> R<String> {
        let Some(media) = self.media(media_id).cloned() else { return err(format!("no media {media_id}")) };
        if media.kind != MediaKind::Audio {
            self.check_main_unlocked()?;
        }
        let id = self.make_id("c");
        let clip = Clip::new(id.clone(), media.id.clone(), at.max(0), 0, Self::default_duration(&media));
        let before = self.main_starts();
        if media.kind == MediaKind::Audio {
            let ti = self.track_for(&Lane::Audio, &clip, None, None);
            self.tracks[ti].clips.push(clip);
        } else if self.magnet {
            let index = self.main_index_at(at);
            self.main_track_mut().clips.insert(index, clip);
        } else {
            self.main_track_mut().clips.push(clip);
        }
        self.normalize();
        self.follow_links(&before);
        Ok(id)
    }

    /// Moves several clips at once to their own new starts, each on its own track: a selection
    /// dragged together. Those going right move from the right end and those going left from
    /// the left, so they never meet each other on the way.
    pub fn move_many(&mut self, moves: &[(String, Us)]) -> R<()> {
        let mut list: Vec<(String, Us, Us)> = vec![];
        for (id, to) in moves {
            let c = self.clip(id).ok_or_else(|| EditError(format!("no clip {id}")))?;
            list.push((id.clone(), c.start_us, (*to).max(0)));
        }
        list.sort_by_key(|(_, from, _)| *from);
        if list.iter().map(|(_, from, to)| to - from).sum::<Us>() > 0 {
            list.reverse();
        }
        for (id, _, to) in list {
            let track = self.find_clip(&id).map(|(t, _)| self.tracks[t].id.clone());
            self.move_clip(&id, to, track.as_deref())?;
        }
        Ok(())
    }

    /// Moves a clip. On the magnetic main track `start_us` picks the new position in the
    /// order; otherwise it is the new start time (and `track_id` the preferred audio track).
    pub fn move_clip(&mut self, clip_id: &str, start_us: Us, track_id: Option<&str>) -> R<()> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        self.check_unlocked(&[clip_id.to_string()])?;
        // Pictures go up off the main track onto a track over it, and back down into it.
        let to_main = track_id.is_some_and(|id| self.track(id).is_some_and(|t| t.main));
        match track_id {
            Some(id) if self.tracks[ti].main && !to_main => return self.lift_off_main(ti, ci, start_us, Onto::Track(id)),
            Some(_) if !self.tracks[ti].main && to_main => return self.drop_into_main(ti, ci, start_us),
            _ => {}
        }
        let before = self.main_starts();
        if self.tracks[ti].main && self.magnet {
            let clip = self.tracks[ti].clips.remove(ci);
            self.normalize();
            let index = self.main_index_at(start_us);
            self.main_track_mut().clips.insert(index, clip);
        } else if self.tracks[ti].main {
            self.tracks[ti].clips[ci].start_us = start_us.max(0);
        } else {
            let (lane, home) = (self.lane_of(ti), self.tracks[ti].id.clone());
            let mut clip = self.tracks[ti].clips.remove(ci);
            clip.start_us = start_us.max(0);
            // A picture dropped above every track (an id that names none) gets a new one on top.
            let target = match &lane {
                Lane::Visual(role) if track_id.is_some_and(|id| self.track(id).is_none()) => {
                    let mut t = Track::new(self.make_id("t"), TrackKind::Video, false);
                    t.role = role.clone();
                    self.tracks.push(t);
                    self.tracks.len() - 1
                }
                _ => self.track_for(&lane, &clip, track_id, Some(&home)),
            };
            self.tracks[target].clips.push(clip);
        }
        self.normalize();
        self.follow_links(&before);
        Ok(())
    }

    /// Moves a clip, starting at `start_us`, onto a new track made at `index` in the track list:
    /// dropped between two rows, above them all, or over a row with no room for it there. Sound
    /// gets a new sound track; a picture a new track of its own track's role (a caption line a
    /// captions track), and a main-track picture a new overlay track (see `lift_off_main`).
    /// Returns the new track's id.
    pub fn move_to_new_track(&mut self, clip_id: &str, start_us: Us, index: usize) -> R<String> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        self.check_unlocked(&[clip_id.to_string()])?;
        if self.tracks[ti].main {
            self.lift_off_main(ti, ci, start_us, Onto::NewAt(index))?;
        } else {
            let before = self.main_starts();
            let lane = self.lane_of(ti);
            let mut clip = self.tracks[ti].clips.remove(ci);
            clip.start_us = start_us.max(0);
            // Made before the old track goes (if this was its last clip), so `index` still
            // counts the tracks the caller saw.
            let at = self.new_track_at(&lane, index);
            self.tracks[at].clips.push(clip);
            self.normalize();
            self.follow_links(&before);
        }
        Ok(self.find_clip(clip_id).map(|(t, _)| self.tracks[t].id.clone()).unwrap_or_default())
    }

    /// A main-track picture lifted onto a track over the video, starting at `start_us`. Over an
    /// overlay track it goes on that track if it fits there, else on a new overlay track just
    /// above it; over a track of another kind (text, stickers) on a new one above that; with an
    /// id that names no track (the space above them all), on a new track on top; with an index,
    /// on a new overlay track made there. The main track closes up behind it, and its own sound
    /// on an audio track moves with it.
    fn lift_off_main(&mut self, ti: usize, ci: usize, start_us: Us, onto: Onto) -> R<()> {
        let target = match onto {
            Onto::Track(id) => self.tracks.iter().position(|t| t.id == id),
            Onto::NewAt(_) => None,
        };
        if let Some(t) = target.map(|i| &self.tracks[i]) {
            if t.kind == TrackKind::Audio {
                return err("Pictures go on a track over the video, not on an audio track");
            }
            if t.locked {
                return err("That track is locked");
            }
        }
        let before = self.main_starts();
        let mut clip = self.tracks[ti].clips.remove(ci);
        let shift = start_us.max(0) - clip.start_us;
        clip.start_us = start_us.max(0);
        // A transition belongs to a cut on the main track.
        clip.transition = None;
        let (id, link) = (clip.id.clone(), clip.link.clone());
        let lane = Lane::Visual("overlay".into());
        let at = match (onto, target) {
            (Onto::NewAt(index), _) => self.new_track_at(&lane, index),
            (_, Some(i)) if lane.holds(&self.tracks[i]) => {
                let over = self.tracks[i].id.clone();
                self.track_for(&lane, &clip, Some(&over), Some(&over))
            }
            (_, above) => {
                let mut t = Track::new(self.make_id("t"), TrackKind::Video, false);
                t.role = "overlay".into();
                let at = above.map_or(self.tracks.len(), |i| i + 1);
                self.tracks.insert(at, t);
                at
            }
        };
        self.tracks[at].clips.push(clip);
        self.normalize();
        self.follow_links(&before);
        if let (Some(link), true) = (link, self.linkage) {
            self.shift_links(&[(link, shift)], Some(&id));
        }
        Ok(())
    }

    /// A picture from a track over the video dropped into the main track at `start_us` (with the
    /// magnet on, between the clips there). Text, captions and adjustment layers stay over it.
    fn drop_into_main(&mut self, ti: usize, ci: usize, start_us: Us) -> R<()> {
        let c = &self.tracks[ti].clips[ci];
        let picture = self.media(&c.media_id).is_some_and(|m| m.kind != MediaKind::Audio);
        if !picture || c.caption || c.text.is_some() {
            return err("Only video and pictures go in the main track");
        }
        if self.main_track().locked {
            return err("The main track is locked");
        }
        let before = self.main_starts();
        let clip = self.tracks[ti].clips.remove(ci);
        let (id, link, old) = (clip.id.clone(), clip.link.clone(), clip.start_us);
        if self.magnet {
            self.normalize();
            let index = self.main_index_at(start_us);
            self.main_track_mut().clips.insert(index, clip);
        } else {
            let mut clip = clip;
            clip.start_us = start_us.max(0);
            self.main_track_mut().clips.push(clip);
        }
        self.normalize();
        self.follow_links(&before);
        let now = self.main_track().clips.iter().find(|c| c.id == id).map_or(old, |c| c.start_us);
        if let (Some(link), true) = (link, self.linkage) {
            self.shift_links(&[(link, now - old)], Some(&id));
        }
        Ok(())
    }

    /// Sets a clip's source range: `in_us` in the source and `duration_us` on the timeline
    /// (and, on audio tracks, its start). Clamped to the media: at its speed, the clip can
    /// play at most (media length − in) / speed.
    pub fn trim(&mut self, clip_id: &str, in_us: Us, duration_us: Us, start_us: Option<Us>) -> R<()> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        self.check_unlocked(&[clip_id.to_string()])?;
        // A still (an image, a text clip, an adjustment layer) can be any length.
        let source = if self.tracks[ti].clips[ci].is_synthetic() { None } else { Some(self.media(&self.tracks[ti].clips[ci].media_id).cloned().ok_or(EditError("clip media missing".into()))?) };
        let still = source.as_ref().is_none_or(|m| m.kind == MediaKind::Image);
        let speed = if still { 1.0 } else { self.tracks[ti].clips[ci].speed };
        let limit = match &source {
            Some(m) if !still => m.duration_us,
            _ => Us::MAX / 4,
        };
        let in_us = in_us.clamp(0, (limit - (MIN_CLIP as f64 * speed) as Us).max(0));
        let duration_us = duration_us.clamp(MIN_CLIP, ((((limit - in_us) as f64) / speed) as Us).max(MIN_CLIP));
        let main = self.tracks[ti].main;
        let free = !main || !self.magnet;
        let before = self.main_starts();
        let clip = &mut self.tracks[ti].clips[ci];
        let first_shown = clip.source_at(0);
        clip.in_us = in_us;
        clip.duration_us = duration_us;
        // Keyframes stay with the picture when the start moves through the source.
        let moved = clip.source_at(0) - first_shown;
        let shift = ((if clip.reverse { -moved } else { moved }) as f64 / speed).round() as Us;
        if shift != 0 {
            for p in clip.keyframes.values_mut().flatten() {
                p.at_us -= shift;
            }
        }
        if let (true, Some(s)) = (free, start_us) {
            clip.start_us = s.max(0);
        }
        if !main {
            // If the new range overlaps a neighbour, hop to a free track.
            let (lane, home) = (self.lane_of(ti), self.tracks[ti].id.clone());
            let clip = self.tracks[ti].clips.remove(ci);
            let target = self.track_for(&lane, &clip, Some(&home), Some(&home));
            self.tracks[target].clips.push(clip);
        }
        self.normalize();
        self.follow_links(&before);
        Ok(())
    }

    /// Splits only the clips asked for (or, with none, the main-track clip under `at`),
    /// never their neighbours or linked audio. Returns the new right-hand clips. Linked clips
    /// split together stay linked in pairs: both right halves share a new link.
    pub fn split(&mut self, at: Us, clip_ids: &[String]) -> R<Vec<String>> {
        let main = self.main_track().id.clone();
        let mut targets = vec![];
        for (ti, t) in self.tracks.iter().enumerate() {
            for (ci, c) in t.clips.iter().enumerate() {
                // Both halves at least a frame long.
                let frame = 1_000_000 / self.fps.max(1) as Us;
                let inside = at >= c.start_us + frame && at <= c.end_us() - frame;
                let picked = if clip_ids.is_empty() { t.id == main } else { clip_ids.contains(&c.id) };
                if inside && picked {
                    targets.push((ti, ci));
                }
            }
        }
        if targets.is_empty() {
            return err(if clip_ids.is_empty() { "Nothing to split at the playhead" } else { "Move the playhead inside the selected clip to split it" });
        }
        self.check_unlocked(&targets.iter().map(|&(ti, ci)| self.tracks[ti].clips[ci].id.clone()).collect::<Vec<_>>())?;
        let mut created = vec![];
        let mut new_links: Vec<(String, String)> = vec![];
        for (ti, ci) in targets.into_iter().rev() {
            let id = self.make_id("c");
            let link = match self.tracks[ti].clips[ci].link.clone() {
                Some(old) => Some(match new_links.iter().find(|(o, _)| *o == old) {
                    Some((_, n)) => n.clone(),
                    None => {
                        let n = self.make_id("l");
                        new_links.push((old, n.clone()));
                        n
                    }
                }),
                None => None,
            };
            let whole = self.tracks[ti].clips[ci].clone();
            let left = at - whole.start_us;
            // Each half plays its own part of the source (a reversed clip's left half is
            // the later part), with the keyframes cut to it.
            let mut right = whole.piece(left, whole.duration_us);
            right.id = id.clone();
            right.link = link;
            // The fade in stays with the left half, the fade out with the right.
            right.fade_in_us = 0;
            right.fade_out_us = whole.fade_out_us.min(right.duration_us);
            let mut l = whole.piece(0, left);
            l.fade_out_us = 0;
            l.fade_in_us = whole.fade_in_us.min(left);
            self.tracks[ti].clips[ci] = l;
            self.tracks[ti].clips.insert(ci + 1, right);
            created.push(id);
        }
        self.normalize();
        Ok(created)
    }

    /// Removes clips. Audio extracted from a deleted video stays where it is, as an ordinary
    /// sound clip (as in CapCut): its link goes once nothing else shares it. With the magnet on
    /// the main track closes up (ripple); empty audio tracks go away.
    pub fn delete(&mut self, clip_ids: &[String]) -> R<()> {
        let ids = clip_ids.to_vec();
        self.check_unlocked(&ids)?;
        let starts = self.main_starts();
        let before: usize = self.tracks.iter().map(|t| t.clips.len()).sum();
        for t in &mut self.tracks {
            t.clips.retain(|c| !ids.contains(&c.id));
        }
        let after: usize = self.tracks.iter().map(|t| t.clips.len()).sum();
        if before == after {
            return err("Nothing to delete");
        }
        // A link left with one clip links nothing.
        let mut count: BTreeMap<String, usize> = BTreeMap::new();
        for c in self.tracks.iter().flat_map(|t| &t.clips) {
            if let Some(l) = &c.link {
                *count.entry(l.clone()).or_default() += 1;
            }
        }
        for c in self.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
            if c.link.as_ref().is_some_and(|l| count.get(l) == Some(&1)) {
                c.link = None;
            }
        }
        self.normalize();
        self.follow_links(&starts);
        Ok(())
    }

    /// Delete left / delete right: cuts only the selected clips (or, with none selected, the
    /// main-track clip under `at`) and drops the part before it (`keep_right`) or after it.
    /// With the magnet on, the main track closes up.
    pub fn trim_at(&mut self, at: Us, clip_ids: &[String], keep_right: bool) -> R<()> {
        let ids: Vec<String> = if clip_ids.is_empty() { self.main_track().clips.iter().filter(|c| at > c.start_us && at < c.end_us()).map(|c| c.id.clone()).collect() } else { clip_ids.to_vec() };
        // Any stretch can go, however short; what stays must be at least a frame long.
        let frame = 1_000_000 / self.fps.max(1) as Us;
        let picked = ids.clone();
        let ids: Vec<String> = ids
            .into_iter()
            .filter(|id| self.clip(id).is_some_and(|c| if keep_right { at > c.start_us && c.end_us() - at >= frame } else { at < c.end_us() && at - c.start_us >= frame }))
            .collect();
        self.check_unlocked(&ids)?;
        let before = self.main_starts();
        let mut changed = 0;
        let magnet = self.magnet;
        for t in &mut self.tracks {
            let main = t.main;
            for c in t.clips.iter_mut().filter(|c| ids.contains(&c.id)) {
                let cut = at - c.start_us;
                // The kept part plays its own stretch of the source (see `Clip::piece`).
                let mut kept = if keep_right { c.piece(cut, c.duration_us) } else { c.piece(0, cut) };
                if keep_right && main && magnet {
                    kept.start_us = c.start_us;
                }
                kept.fade_in_us = c.fade_in_us.min(kept.duration_us);
                kept.fade_out_us = c.fade_out_us.min(kept.duration_us - kept.fade_in_us);
                *c = kept;
                changed += 1;
            }
        }
        if changed == 0 {
            let inside = picked.iter().any(|id| self.clip(id).is_some_and(|c| at > c.start_us && at < c.end_us()));
            return err(if inside {
                "That would leave less than a frame of the clip"
            } else if clip_ids.is_empty() {
                "Put the playhead inside a clip to cut it"
            } else {
                "Move the playhead inside the selected clip to cut it"
            });
        }
        self.normalize();
        self.follow_links(&before);
        Ok(())
    }

    /// `ids` plus, while linkage is on, the clips linked to them. With `both_ways` off only
    /// main-track clips pull in their linked audio (deleting extracted audio leaves the video).
    fn with_linked(&self, ids: &[String], both_ways: bool) -> Vec<String> {
        let mut out = ids.to_vec();
        if !self.linkage {
            return out;
        }
        let main = &self.main_track().id;
        let links: Vec<String> = self.tracks.iter().filter(|t| both_ways || &t.id == main).flat_map(|t| &t.clips).filter(|c| ids.contains(&c.id)).filter_map(|c| c.link.clone()).collect();
        for c in self.tracks.iter().flat_map(|t| &t.clips) {
            if c.link.as_ref().is_some_and(|l| links.contains(l)) && !out.contains(&c.id) {
                out.push(c.id.clone());
            }
        }
        out
    }

    pub(crate) fn main_starts(&self) -> Vec<(Option<String>, Us, String)> {
        self.main_track().clips.iter().map(|c| (c.link.clone(), c.start_us, c.id.clone())).collect()
    }

    /// While linkage is on, audio linked to a main-track clip keeps its place relative to
    /// that clip when the main track shifts (ripple, reorder, the magnet closing a gap).
    pub(crate) fn follow_links(&mut self, before: &[(Option<String>, Us, String)]) {
        if !self.linkage {
            return;
        }
        let shifts: Vec<(String, Us)> = before
            .iter()
            .filter_map(|(link, start, id)| {
                let now = self.main_track().clips.iter().find(|c| &c.id == id)?.start_us;
                if now == *start {
                    return None;
                }
                Some((link.clone()?, now - start))
            })
            .collect();
        self.shift_links(&shifts, None);
    }

    /// Moves the sound linked to each link (a video's own, on an audio track) by its shift, as
    /// the video moved; `except` is the clip that moved itself.
    fn shift_links(&mut self, shifts: &[(String, Us)], except: Option<&str>) {
        if shifts.iter().all(|(_, d)| *d == 0) {
            return;
        }
        let mut moved = vec![];
        // A locked track's clips stay put.
        for t in self.tracks.iter_mut().filter(|t| !t.main && !t.locked && t.kind == TrackKind::Audio) {
            let mut i = 0;
            while i < t.clips.len() {
                let link = t.clips[i].link.as_ref().filter(|_| except != Some(t.clips[i].id.as_str()));
                match link.and_then(|l| shifts.iter().find(|(x, _)| x == l)) {
                    Some(&(_, d)) => {
                        let mut c = t.clips.remove(i);
                        c.start_us = (c.start_us + d).max(0);
                        moved.push((t.id.clone(), c));
                    }
                    None => i += 1,
                }
            }
        }
        for (track, c) in moved {
            let ti = self.track_for(&Lane::Audio, &c, Some(&track), None);
            self.tracks[ti].clips.push(c);
        }
        self.normalize();
    }

    /// Puts each video clip's sound on an audio track of its own (same time, same range)
    /// and silences the video. The two are linked. Returns the new audio clips.
    pub fn extract_audio(&mut self, clip_ids: &[String]) -> R<Vec<String>> {
        self.check_unlocked(clip_ids)?;
        let mut created = vec![];
        for id in clip_ids {
            let Some((ti, ci)) = self.find_clip(id) else { continue };
            let c = self.tracks[ti].clips[ci].clone();
            let has_sound = self.media(&c.media_id).is_some_and(|m| m.has_audio && m.kind == MediaKind::Video);
            if !self.tracks[ti].main || c.detached || !has_sound {
                continue;
            }
            let link = match c.link.clone() {
                Some(l) => l,
                None => self.make_id("l"),
            };
            let audio_id = self.make_id("c");
            // Same speed and direction, so the sound stays with the picture.
            let audio = Clip { volume: c.volume, link: Some(link.clone()), speed: c.speed, reverse: c.reverse, ..Clip::new(audio_id.clone(), c.media_id.clone(), c.start_us, c.in_us, c.duration_us) };
            let video = &mut self.tracks[ti].clips[ci];
            video.detached = true;
            video.link = Some(link);
            let at = self.track_for(&Lane::Audio, &audio, None, None);
            self.tracks[at].clips.push(audio);
            created.push(audio_id);
        }
        if created.is_empty() {
            return err("Select a video clip with sound to extract its audio");
        }
        self.normalize();
        Ok(created)
    }

    /// Takes media out of the library, with any clips that use them. A file from a linked
    /// folder is remembered as removed, so rescans leave it out. Returns (media, clips).
    pub fn remove_media(&mut self, ids: &[String]) -> R<(usize, usize)> {
        let gone: Vec<Media> = self.media.iter().filter(|m| ids.contains(&m.id)).cloned().collect();
        if gone.is_empty() {
            return err("Nothing to remove");
        }
        for m in &gone {
            if let Some(f) = m.folder.as_ref().and_then(|id| self.folders.iter_mut().find(|f| &f.id == id)) {
                if !f.hidden.contains(&m.path) {
                    f.hidden.push(m.path.clone());
                }
            }
        }
        let before = self.main_starts();
        let clips: usize = self.tracks.iter().map(|t| t.clips.iter().filter(|c| ids.contains(&c.media_id)).count()).sum();
        self.media.retain(|m| !ids.contains(&m.id));
        for t in &mut self.tracks {
            t.clips.retain(|c| !ids.contains(&c.media_id));
        }
        self.normalize();
        self.follow_links(&before);
        Ok((gone.len(), clips))
    }

    /// Puts cut media back. Returns each one's id in the project: its own, or that of the
    /// same file if it has been imported again meanwhile.
    pub fn restore_media(&mut self, media: Vec<Media>) -> R<Vec<String>> {
        let mut ids = vec![];
        for mut m in media {
            if let Some(x) = self.media.iter().find(|x| x.id == m.id || x.path == m.path) {
                ids.push(x.id.clone());
                continue;
            }
            match m.folder.as_ref().and_then(|id| self.folders.iter_mut().find(|f| &f.id == id)) {
                Some(f) => f.hidden.retain(|h| h != &m.path),
                None => {
                    m.folder = None;
                    m.dir = None;
                }
            }
            ids.push(m.id.clone());
            self.media.push(m);
        }
        if ids.is_empty() {
            return err("Nothing to paste");
        }
        Ok(ids)
    }

    /// Pastes copied clips at `at`, keeping their spacing. Main-track clips go into the main
    /// track (in order at `at` with the magnet on, at their own times without it); the rest
    /// onto free audio tracks. Links between pasted clips carry over as new links.
    pub fn paste(&mut self, items: Vec<PasteItem>, at: Us) -> R<Vec<String>> {
        // Text clips and adjustment layers have no media to look for.
        let mut items: Vec<PasteItem> = items.into_iter().filter(|i| i.clip.is_synthetic() || self.media(&i.clip.media_id).is_some()).collect();
        let mut layer_tracks: Vec<(Lane, String)> = vec![];
        if items.is_empty() {
            return err("The copied clips' media is no longer in the library");
        }
        if items.iter().any(|i| i.main) {
            self.check_main_unlocked()?;
        }
        items.sort_by_key(|i| i.offset_us);
        let before = self.main_starts();
        let mut links: Vec<(String, String)> = vec![];
        let mut index = self.magnet.then(|| self.main_index_at(at.max(0)));
        let mut created = vec![];
        for item in items {
            let mut c = item.clip;
            c.id = self.make_id("c");
            // A copy is a clip of its own: the work on the one it came from isn't its.
            c.busy = None;
            c.start_us = (at + item.offset_us).max(0);
            c.link = match c.link.take() {
                Some(old) => Some(match links.iter().find(|(o, _)| *o == old) {
                    Some((_, n)) => n.clone(),
                    None => {
                        let n = self.make_id("l");
                        links.push((old, n.clone()));
                        n
                    }
                }),
                None => None,
            };
            created.push(c.id.clone());
            if item.main {
                match index.as_mut() {
                    Some(i) => {
                        self.main_track_mut().clips.insert(*i, c);
                        *i += 1;
                    }
                    None => self.main_track_mut().clips.push(c),
                }
            } else {
                let lane = self.lane_for_paste(&c, item.role.as_deref());
                // Picture clips pasted together share the track made for the first of their role.
                let prefer = layer_tracks.iter().find(|(l, _)| *l == lane).map(|(_, t)| t.clone());
                let t = self.track_for(&lane, &c, prefer.as_deref(), prefer.as_deref());
                if lane != Lane::Audio && prefer.is_none() {
                    layer_tracks.push((lane, self.tracks[t].id.clone()));
                }
                self.tracks[t].clips.push(c);
            }
        }
        self.normalize();
        self.follow_links(&before);
        Ok(created)
    }

    /// The selected clips alone, as a project starting at 0: from the first selected clip's
    /// start to the last one's end, gaps kept. For compound clips and exporting a selection.
    /// Returns it with the range's start and end on this timeline.
    pub fn sub_project(&self, clip_ids: &[String]) -> R<(Project, Us, Us)> {
        let picked: Vec<&Clip> = self.tracks.iter().flat_map(|t| &t.clips).filter(|c| clip_ids.contains(&c.id)).collect();
        let Some(start) = picked.iter().map(|c| c.start_us).min() else { return err("Select the clips first") };
        let end = picked.iter().map(|c| c.end_us()).max().unwrap_or(start);
        let mut p = self.clone();
        p.magnet = false;
        p.linkage = false;
        for t in &mut p.tracks {
            t.clips.retain(|c| clip_ids.contains(&c.id));
            for c in &mut t.clips {
                c.start_us -= start;
            }
        }
        p.tracks.retain(|t| t.main || !t.clips.is_empty());
        Ok((p, start, end))
    }

    /// Replaces the selected clips with one clip of `media` (their render), which remembers
    /// them as its parts. It sits where the selection started: on the main track if any main
    /// clip was selected, else on an audio track. Returns the new clip's id.
    pub fn make_compound(&mut self, clip_ids: &[String], mut media: Media) -> R<String> {
        self.check_unlocked(clip_ids)?;
        let (sub, start, _) = self.sub_project(clip_ids)?;
        let on_main = !sub.main_track().clips.is_empty();
        // Without a main clip, a selection with pictures in it becomes an overlay.
        let lane = if sub.tracks.iter().any(|t| t.is_visual()) { Lane::Visual("overlay".into()) } else { Lane::Audio };
        media.parts = Some(sub.tracks.iter().flat_map(|t| t.clips.iter().map(move |c| Part { clip: c.clone(), main: t.main, role: t.is_visual().then(|| t.role.clone()) })).collect());
        media.id = self.make_id("m");
        let clip = Clip::new(self.make_id("c"), media.id.clone(), start, 0, media.duration_us.max(MIN_CLIP));
        let id = clip.id.clone();
        self.media.push(media);
        let before = self.main_starts();
        for t in &mut self.tracks {
            t.clips.retain(|c| !clip_ids.contains(&c.id));
        }
        self.normalize();
        if on_main && self.magnet {
            let i = self.main_index_at(start);
            self.main_track_mut().clips.insert(i, clip);
        } else if on_main {
            self.main_track_mut().clips.push(clip);
        } else {
            let t = self.track_for(&lane, &clip, None, None);
            self.tracks[t].clips.push(clip);
        }
        self.normalize();
        self.follow_links(&before);
        Ok(id)
    }

    /// Puts a compound clip's parts back where it sits. Returns the restored clips.
    pub fn break_compound(&mut self, clip_id: &str) -> R<Vec<String>> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        let c = self.tracks[ti].clips[ci].clone();
        let Some(parts) = self.media(&c.media_id).and_then(|m| m.parts.clone()) else { return err("That isn't a compound clip") };
        self.check_unlocked(std::slice::from_ref(&c.id))?;
        let before = self.main_starts();
        let on_main = self.tracks[ti].main;
        self.tracks[ti].clips.remove(ci);
        let items: Vec<PasteItem> = parts.into_iter().map(|p| PasteItem { offset_us: p.clip.start_us, clip: p.clip, main: p.main, role: p.role }).collect();
        if on_main && self.magnet {
            // Paste at the gap the compound left, after closing it.
            self.normalize();
            let at = self.main_track().clips.get(ci).map_or(self.main_track().clips.iter().map(Clip::end_us).max().unwrap_or(0), |n| n.start_us);
            let ids = self.paste(items, at)?;
            self.follow_links(&before);
            return Ok(ids);
        }
        let ids = self.paste(items, c.start_us)?;
        self.follow_links(&before);
        Ok(ids)
    }

    /// Points a clip at other media (a cleaned copy of its own part), from the start.
    /// The clip plays another file from its start, keeping its place, track and settings. Its
    /// length stays, at most the new file's; with `whole` it becomes the new file's whole length
    /// (a sentence said again, longer or shorter than before).
    pub fn replace_media(&mut self, clip_id: &str, media_id: &str, whole: bool) -> R<()> {
        let Some((len, image)) = self.media(media_id).map(|m| if m.kind == MediaKind::Image { (Us::MAX / 4, true) } else { (m.duration_us, false) }) else { return err(format!("no media {media_id}")) };
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        self.check_unlocked(&[clip_id.to_string()])?;
        let before = self.main_starts();
        let c = &mut self.tracks[ti].clips[ci];
        c.media_id = media_id.into();
        c.in_us = 0;
        let full = (len as f64 / c.speed) as Us;
        c.duration_us = if whole && !image { full } else { c.duration_us.min(full) }.max(MIN_CLIP);
        self.normalize();
        self.follow_links(&before);
        Ok(())
    }

    /// Turns the main track magnet on (closing every gap) or off.
    pub fn set_magnet(&mut self, on: bool) {
        let before = self.main_starts();
        self.magnet = on;
        self.normalize();
        self.follow_links(&before);
    }

    /// True if any clip on the timeline uses this media.
    pub fn is_used(&self, media_id: &str) -> bool {
        self.tracks.iter().any(|t| t.clips.iter().any(|c| c.media_id == media_id))
    }

    /// Links a folder (or finds it if it's already linked) and returns its id.
    pub fn link_folder(&mut self, path: &str, name: &str) -> String {
        if let Some(f) = self.folders.iter().find(|f| f.path == path) {
            return f.id.clone();
        }
        let id = self.make_id("f");
        self.folders.push(Folder { id: id.clone(), path: path.into(), name: name.into(), hidden: vec![] });
        id
    }

    /// Applies a rescan of a linked folder: `present` is every media file in it now,
    /// `added` the newly found ones (ids are assigned here). Files that are gone are
    /// flagged missing, not removed, so clips using them keep their place.
    /// Returns (added, missing).
    pub fn sync_folder(&mut self, folder_id: &str, present: &[String], added: Vec<Media>) -> R<(usize, usize)> {
        if !self.folders.iter().any(|f| f.id == folder_id) {
            return err(format!("no folder {folder_id}"));
        }
        let mut missing = 0;
        for m in self.media.iter_mut().filter(|m| m.folder.as_deref() == Some(folder_id)) {
            m.missing = !present.contains(&m.path);
            missing += m.missing as usize;
        }
        let count = added.len();
        for mut m in added {
            m.id = self.make_id("m");
            m.folder = Some(folder_id.into());
            self.media.push(m);
        }
        Ok((count, missing))
    }

    /// Unlinks a folder. Its files leave the library unless a clip uses them; those stay, unfiled.
    pub fn unlink_folder(&mut self, folder_id: &str) -> R<usize> {
        let Some(i) = self.folders.iter().position(|f| f.id == folder_id) else { return err(format!("no folder {folder_id}")) };
        self.folders.remove(i);
        let used: Vec<String> = self.media.iter().filter(|m| m.folder.as_deref() == Some(folder_id) && self.is_used(&m.id)).map(|m| m.id.clone()).collect();
        let before = self.media.len();
        self.media.retain(|m| m.folder.as_deref() != Some(folder_id) || used.contains(&m.id));
        for m in self.media.iter_mut().filter(|m| used.contains(&m.id)) {
            m.folder = None;
            m.dir = None;
        }
        Ok(before - self.media.len())
    }

    /// Changes a clip's settings. A new speed keeps its source range, so the clip gets longer
    /// or shorter and the main track closes up behind it; while linkage is on, the sound
    /// extracted from it takes the same speed and direction.
    pub fn set_clip(&mut self, clip_id: &str, change: ClipChange) -> R<()> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        change.check()?;
        if matches!(change.transition, Some(Some(_))) && !self.tracks[ti].main {
            return err("Transitions go between clips on the main track");
        }
        // Speed and direction need source time; a still image has none.
        let source_us = self.media(&self.tracks[ti].clips[ci].media_id).filter(|m| m.kind != MediaKind::Image).map(|m| m.duration_us);
        let before = self.main_starts();
        let was = (self.tracks[ti].clips[ci].speed, self.tracks[ti].clips[ci].reverse);
        // A new speed (or speed ramp) changes the clip's length, which a locked track doesn't allow.
        let new_curve = change.speed_curve.clone().map(|c| c.and_then(SpeedCurve::clean));
        let ramp_changes = new_curve.as_ref().is_some_and(|c| *c != self.tracks[ti].clips[ci].speed_curve);
        if source_us.is_some() && (change.speed.is_some_and(|s| s.is_finite() && s.clamp(0.1, 10.0) != was.0) || change.reverse.is_some_and(|r| r != was.1) || ramp_changes) {
            self.check_unlocked(&[clip_id.to_string()])?;
        }
        let clip = &mut self.tracks[ti].clips[ci];
        set_v2(clip, &change, source_us.is_some());
        let ClipChange {
            volume,
            fit,
            detached,
            crop,
            flip,
            rotate,
            fade_in_us,
            fade_out_us,
            fade_curve,
            pitch,
            declick,
            envelope,
            scale,
            pos_x,
            pos_y,
            rotation,
            opacity,
            temperature,
            tint,
            saturation,
            brightness,
            contrast,
            highlights,
            shadows,
            sharpen,
            vignette,
            speed,
            reverse,
            keyframes,
            ..
        } = change;
        let within = |v: Option<f32>, lo: f32, hi: f32| v.filter(|x| x.is_finite()).map(|x| x.clamp(lo, hi));
        for (field, v, lo, hi) in [(&mut clip.scale, scale, 0.0, 400.0), (&mut clip.opacity, opacity, 0.0, 100.0), (&mut clip.pos_x, pos_x, -100_000.0, 100_000.0), (&mut clip.pos_y, pos_y, -100_000.0, 100_000.0), (&mut clip.rotation, rotation, -36_000.0, 36_000.0)] {
            if let Some(v) = within(v, lo, hi) {
                *field = v;
            }
        }
        for (field, v) in [(&mut clip.temperature, temperature), (&mut clip.tint, tint), (&mut clip.saturation, saturation), (&mut clip.brightness, brightness), (&mut clip.contrast, contrast), (&mut clip.highlights, highlights), (&mut clip.shadows, shadows), (&mut clip.sharpen, sharpen), (&mut clip.vignette, vignette)] {
            if let Some(v) = within(v, -100.0, 100.0) {
                *field = v;
            }
        }
        if let Some(mut keys) = keyframes {
            for points in keys.values_mut() {
                points.retain(|p| p.value.is_finite());
                points.sort_by_key(|p| p.at_us);
                points.dedup_by_key(|p| p.at_us);
            }
            keys.retain(|_, points| !points.is_empty());
            clip.keyframes = keys;
        }
        if let Some(source_us) = source_us {
            // A ramp sets the speed to its mean; a plain speed takes the ramp off.
            let speed = match new_curve {
                Some(Some(c)) => {
                    let mean = c.mean();
                    clip.speed_curve = Some(c);
                    Some(mean)
                }
                Some(None) => {
                    clip.speed_curve = None;
                    speed
                }
                None => {
                    if speed.is_some() {
                        clip.speed_curve = None;
                    }
                    speed
                }
            };
            if let Some(s) = speed.filter(|s| s.is_finite()).map(|s| s.clamp(0.1, 10.0)).filter(|s| *s != clip.speed) {
                clip.retime(s, source_us);
            }
            if let Some(r) = reverse {
                clip.reverse = r;
            }
        }
        if let Some(f) = fade_in_us {
            clip.fade_in_us = f.clamp(0, clip.duration_us);
        }
        if let Some(f) = fade_out_us {
            clip.fade_out_us = f.clamp(0, clip.duration_us);
        }
        // Fades never overlap: a new fade in shortens the fade out, and the other way round.
        if clip.fade_in_us + clip.fade_out_us > clip.duration_us {
            if fade_in_us.is_some() {
                clip.fade_out_us = clip.duration_us - clip.fade_in_us;
            } else {
                clip.fade_in_us = clip.duration_us - clip.fade_out_us;
            }
        }
        if let Some(c) = fade_curve {
            clip.fade_curve = if matches!(c.as_str(), "scurve" | "log") { c } else { String::new() };
        }
        if let Some(p) = pitch {
            clip.pitch = (p * 10.0).round().clamp(-120.0, 120.0) / 10.0;
        }
        if let Some(d) = declick {
            clip.declick = d;
        }
        if let Some(mut points) = envelope {
            points.retain(|p| p.gain.is_finite());
            for p in &mut points {
                p.gain = p.gain.clamp(0.0, 4.0);
            }
            points.sort_by_key(|p| p.at_us);
            points.dedup_by_key(|p| p.at_us);
            clip.envelope = points;
        }
        if let Some(d) = detached {
            clip.detached = d;
        }
        if let Some(c) = crop {
            clip.crop = c.and_then(Crop::clean);
        }
        if let Some(f) = flip {
            clip.flip = f;
        }
        if let Some(r) = rotate {
            clip.rotate = (r / 90 % 4) * 90;
        }
        if let Some(v) = volume {
            clip.volume = v.clamp(0.0, 4.0);
        }
        if let Some(f) = fit {
            clip.fit = f;
        }
        let now = (clip.speed, clip.reverse);
        if now != was {
            let mut retimed = vec![clip_id.to_string()];
            if self.tracks[ti].main {
                for id in self.with_linked(&retimed, false).into_iter().skip(1) {
                    let Some((lt, lc)) = self.find_clip(&id).filter(|(lt, _)| !self.tracks[*lt].locked) else { continue };
                    let source_us = self.media(&self.tracks[lt].clips[lc].media_id).map_or(0, |m| m.duration_us);
                    let linked = &mut self.tracks[lt].clips[lc];
                    if linked.speed != now.0 {
                        linked.retime(now.0, source_us);
                    }
                    linked.reverse = now.1;
                    retimed.push(id);
                }
            }
            // A longer clip on an audio track may now run into the next one: it hops to a free track.
            for id in &retimed {
                let Some((t, c)) = self.find_clip(id).filter(|(t, _)| !self.tracks[*t].main) else { continue };
                let clip = self.tracks[t].clips.remove(c);
                let (lane, home) = (self.lane_of(t), self.tracks[t].id.clone());
                let target = self.track_for(&lane, &clip, Some(&home), Some(&home));
                self.tracks[target].clips.push(clip);
            }
            self.normalize();
            self.follow_links(&before);
        }
        Ok(())
    }

    pub fn track(&self, track_id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == track_id)
    }

    /// A track's mix: fader, balance, mute, solo, effects and role.
    pub fn set_track(&mut self, track_id: &str, change: TrackChange) -> R<()> {
        let Some(t) = self.tracks.iter_mut().find(|t| t.id == track_id) else { return err(format!("no track {track_id}")) };
        let TrackChange { gain_db, pan, mute, solo, effects, role, locked, hidden } = change;
        if let Some(l) = locked {
            t.locked = l;
        }
        if let Some(h) = hidden {
            t.hidden = h;
        }
        if let Some(g) = gain_db.filter(|g| g.is_finite()) {
            t.gain_db = (g * 10.0).round().clamp(-600.0, 120.0) / 10.0;
        }
        if let Some(p) = pan.filter(|p| p.is_finite()) {
            t.pan = (p * 100.0).round().clamp(-100.0, 100.0) / 100.0;
        }
        if let Some(m) = mute {
            t.mute = m;
        }
        if let Some(s) = solo {
            t.solo = s;
        }
        if let Some(mut e) = effects {
            e.clean();
            t.effects = e;
        }
        if let Some(r) = role {
            // Sound tracks are voice or music; picture tracks keep what they hold.
            let known = if t.kind == TrackKind::Audio { matches!(r.as_str(), "voice" | "music") } else { VISUAL_ROLES.contains(&r.as_str()) };
            t.role = if known { r } else { String::new() };
        }
        Ok(())
    }

    /// True if this track is heard: not muted, and soloed when any track is.
    pub fn audible(&self, track: &Track) -> bool {
        !track.mute && (track.solo || !self.tracks.iter().any(|t| t.solo))
    }

    pub fn set_master(&mut self, change: MasterChange) -> R<()> {
        let m = &mut self.master;
        if let Some(n) = change.normalize {
            m.normalize = n;
        }
        if let Some(l) = change.limiter {
            m.limiter = l;
        }
        if let Some(t) = change.target_lufs.filter(|x| x.is_finite()) {
            m.target_lufs = t.clamp(-30.0, -5.0);
        }
        if let Some(c) = change.ceiling_db.filter(|x| x.is_finite()) {
            m.ceiling_db = c.clamp(-9.0, 0.0);
        }
        if let Some(g) = change.gain_db.filter(|x| x.is_finite()) {
            m.gain_db = (g * 10.0).round().clamp(-240.0, 240.0) / 10.0;
        }
        Ok(())
    }

    /// Puts a file's sound on a new audio track of its own at `at`. Returns the new clip.
    pub fn insert_on_new_track(&mut self, media_id: &str, at: Us) -> R<String> {
        let Some(media) = self.media(media_id).cloned() else { return err(format!("no media {media_id}")) };
        if media.kind == MediaKind::Image || !media.has_audio {
            return err("That file has no sound");
        }
        let id = self.make_id("c");
        let track = self.make_id("t");
        let mut t = Track::new(track, TrackKind::Audio, false);
        t.clips.push(Clip::new(id.clone(), media.id.clone(), at.max(0), 0, Self::default_duration(&media)));
        self.tracks.push(t);
        self.normalize();
        Ok(id)
    }

    /// Cuts stretches out of a clip and closes them up: `cuts` are offsets from the clip's
    /// start. The pieces sit back to back where the clip began (on the magnetic main track
    /// the clips after it follow). Returns the pieces, the first keeping the clip's id.
    pub fn remove_ranges(&mut self, clip_id: &str, cuts: &[(Us, Us)]) -> R<Vec<String>> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        self.check_unlocked(&[clip_id.to_string()])?;
        let c = self.tracks[ti].clips[ci].clone();
        let mut cuts: Vec<(Us, Us)> = cuts.iter().map(|&(a, b)| (a.clamp(0, c.duration_us), b.clamp(0, c.duration_us))).filter(|(a, b)| b - a > 0).collect();
        cuts.sort();
        let mut keep = vec![];
        let mut at = 0;
        for (a, b) in cuts {
            if a > at {
                keep.push((at, a));
            }
            at = at.max(b);
        }
        if at < c.duration_us {
            keep.push((at, c.duration_us));
        }
        keep.retain(|(a, b)| b - a >= MIN_CLIP / 2);
        let kept: Us = keep.iter().map(|(a, b)| b - a).sum();
        if keep.is_empty() || kept >= c.duration_us {
            return err("There are no pauses to take out of that clip");
        }
        let before = self.main_starts();
        let mut pieces = vec![];
        let mut start = c.start_us;
        let last = keep.len() - 1;
        for (n, (a, b)) in keep.into_iter().enumerate() {
            let mut p = c.piece(a, b);
            if n > 0 {
                p.id = self.make_id("c");
                p.link = None;
            }
            p.start_us = start;
            p.fade_in_us = if n == 0 { c.fade_in_us.min(p.duration_us) } else { 0 };
            p.fade_out_us = if n == last { c.fade_out_us.min(p.duration_us) } else { 0 };
            start += p.duration_us;
            pieces.push(p);
        }
        let ids = pieces.iter().map(|p| p.id.clone()).collect();
        self.tracks[ti].clips.splice(ci..=ci, pieces);
        self.normalize();
        self.follow_links(&before);
        Ok(ids)
    }

    /// Freeze frame: splits a main-track clip at `at` and puts `still` (its frame there, saved
    /// as an image) between the halves for `hold_us`, with the clip's fit and its look as it
    /// is at that moment. At either end of the clip the still goes before or after it. Later
    /// clips move on by the hold; with the magnet off every clip from there on moves by it, so
    /// gaps are kept. Returns the new clip's id.
    pub fn freeze_frame(&mut self, clip_id: &str, at: Us, mut still: Media, hold_us: Us) -> R<String> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        if !self.tracks[ti].main {
            return err("Freeze frame works on the main track");
        }
        self.check_unlocked(&[clip_id.to_string()])?;
        let c = self.tracks[ti].clips[ci].clone();
        if at < c.start_us || at > c.end_us() {
            return err("Put the playhead on the clip to freeze its frame");
        }
        still.id = self.make_id("m");
        let offset = (at - c.start_us).min(c.duration_us);
        let mut f = Clip::new(self.make_id("c"), still.id.clone(), at, 0, hold_us.max(MIN_CLIP));
        // The crop, quarter turns and mirror are already in the saved frame. The rest of the
        // look carries over as the graph shows it at that moment (see studio_media::graph::Look).
        f.fit = c.fit;
        let now = |name: &str, base: f32| c.value_at(name, offset, base as f64) as f32;
        let fixed = |name: &str, base: f32| c.value_at(name, 0, base as f64) as f32;
        (f.scale, f.pos_x, f.pos_y, f.rotation, f.opacity) = (now("scale", c.scale), now("posX", c.pos_x), now("posY", c.pos_y), now("rotation", c.rotation), now("opacity", c.opacity));
        (f.brightness, f.contrast, f.saturation) = (now("brightness", c.brightness), now("contrast", c.contrast), now("saturation", c.saturation));
        (f.temperature, f.tint, f.highlights, f.shadows, f.sharpen, f.vignette) = (fixed("temperature", c.temperature), fixed("tint", c.tint), fixed("highlights", c.highlights), fixed("shadows", c.shadows), fixed("sharpen", c.sharpen), fixed("vignette", c.vignette));
        let id = f.id.clone();
        self.media.push(still);
        let before = self.main_starts();
        let (index, place) = if at > c.start_us + MIN_CLIP / 2 && at < c.end_us() - MIN_CLIP / 2 {
            self.split(at, std::slice::from_ref(&c.id))?;
            (ci + 1, at)
        } else if at - c.start_us <= c.end_us() - at {
            (ci, c.start_us)
        } else {
            (ci + 1, c.end_us())
        };
        f.start_us = place;
        if !self.magnet {
            for x in self.main_track_mut().clips.iter_mut().filter(|x| x.start_us >= place) {
                x.start_us += f.duration_us;
            }
        }
        self.main_track_mut().clips.insert(index, f);
        self.normalize();
        self.follow_links(&before);
        Ok(id)
    }

    /// Splits one clip at each of `times` (timeline times inside it). Returns every piece.
    pub fn split_at_times(&mut self, clip_id: &str, times: &[Us]) -> R<Vec<String>> {
        let mut times = times.to_vec();
        times.sort();
        let mut pieces = vec![clip_id.to_string()];
        for t in times {
            let current = pieces.last().cloned().unwrap_or_default();
            if let Ok(right) = self.split(t, std::slice::from_ref(&current)) {
                pieces.extend(right);
            }
        }
        if pieces.len() == 1 {
            return err("There are no pauses to split that clip at");
        }
        Ok(pieces)
    }

    /// Adds labels (start, end, text); equal start and end make a marker. Returns their ids.
    pub fn add_labels(&mut self, items: Vec<(Us, Us, String)>) -> R<Vec<String>> {
        if items.is_empty() {
            return err("Nothing to label");
        }
        let mut ids = vec![];
        for (a, b, text) in items {
            let id = self.make_id("lb");
            let (start, end) = (a.min(b).max(0), a.max(b).max(0));
            self.labels.push(Label { id: id.clone(), start_us: start, end_us: end, text });
            ids.push(id);
        }
        self.labels.sort_by_key(|l| l.start_us);
        Ok(ids)
    }

    pub fn set_label(&mut self, id: &str, text: Option<String>, start_us: Option<Us>, end_us: Option<Us>) -> R<()> {
        let Some(l) = self.labels.iter_mut().find(|l| l.id == id) else { return err(format!("no label {id}")) };
        if let Some(t) = text {
            l.text = t;
        }
        let (a, b) = (start_us.unwrap_or(l.start_us).max(0), end_us.unwrap_or(l.end_us).max(0));
        (l.start_us, l.end_us) = (a.min(b), a.max(b));
        self.labels.sort_by_key(|l| l.start_us);
        Ok(())
    }

    pub fn delete_labels(&mut self, ids: &[String]) -> R<()> {
        let before = self.labels.len();
        self.labels.retain(|l| !ids.contains(&l.id));
        if self.labels.len() == before {
            return err("Nothing to delete");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(id: &str, kind: MediaKind, secs: f64) -> Media {
        Media {
            id: id.into(),
            path: format!("{id}.mp4"),
            name: id.into(),
            kind,
            duration_us: (secs * SECOND as f64) as Us,
            width: 1080,
            height: 1920,
            fps: 30.0,
            has_audio: kind != MediaKind::Image,
            ..Default::default()
        }
    }

    fn project() -> Project {
        let mut p = Project::new("Test", "9:16");
        p.media = vec![media("a", MediaKind::Video, 4.0), media("b", MediaKind::Video, 2.0), media("img", MediaKind::Image, 0.0), media("vo", MediaKind::Audio, 10.0)];
        p
    }

    fn main_ids(p: &Project) -> Vec<(String, Us, Us)> {
        p.main_track().clips.iter().map(|c| (c.media_id.clone(), c.start_us, c.duration_us)).collect()
    }

    #[test]
    fn pictures_move_between_the_main_track_and_the_tracks_over_it() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        let main = p.main_track().id.clone();
        let b = p.main_track().clips[1].id.clone();
        // Up into the space above the tracks: a new overlay track, and the main track closes up.
        p.move_clip(&b, SECOND, Some("above")).unwrap();
        assert_eq!(main_ids(&p).len(), 1);
        let (ti, ci) = p.find_clip(&b).unwrap();
        assert!(p.tracks[ti].is_visual() && p.tracks[ti].role == "overlay");
        assert_eq!(p.tracks[ti].clips[ci].start_us, SECOND);
        let over = p.tracks[ti].id.clone();
        // Another picture over the same time stacks on a new track just above, not on top of it.
        p.insert("img", 99 * SECOND).unwrap();
        let img = p.main_track().clips[1].id.clone();
        p.move_clip(&img, SECOND, Some(&over)).unwrap();
        let (ii, _) = p.find_clip(&img).unwrap();
        let (bi, _) = p.find_clip(&b).unwrap();
        assert!(ii == bi + 1 && p.tracks[ii].role == "overlay", "img on its own track above b's");
        // Where it fits, it joins the track it was dropped on.
        p.move_clip(&img, 20 * SECOND, Some(&over)).unwrap();
        assert_eq!(p.find_clip(&img).unwrap().0, p.find_clip(&b).unwrap().0);
        // Above every track, an overlay gets a new track on top.
        p.move_clip(&img, 20 * SECOND, Some("above")).unwrap();
        let (ii, _) = p.find_clip(&img).unwrap();
        assert!(ii == p.tracks.len() - 1 && ii != p.find_clip(&b).unwrap().0 && p.tracks[ii].role == "overlay");
        // Down again: b goes back into the main track, before a.
        p.move_clip(&b, 0, Some(&main)).unwrap();
        assert_eq!(main_ids(&p).iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        // Sound and text don't go on those tracks.
        let vo = p.insert_on_new_track("vo", 0).unwrap();
        let vo_track = p.tracks[p.find_clip(&vo).unwrap().0].id.clone();
        assert!(p.move_clip(&b, 0, Some(&vo_track)).is_err());
        let (text, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        assert!(p.move_clip(&text, 0, Some(&main)).is_err());
    }

    #[test]
    fn a_lifted_video_takes_its_own_sound_with_it() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        let b = p.main_track().clips[1].id.clone();
        let sound = p.extract_audio(&[b.clone()]).unwrap()[0].clone();
        let (si, sc) = p.find_clip(&sound).unwrap();
        assert_eq!(p.tracks[si].clips[sc].start_us, 4 * SECOND);
        p.move_clip(&b, 6 * SECOND, Some("above")).unwrap();
        let (si, sc) = p.find_clip(&sound).unwrap();
        assert_eq!(p.tracks[si].clips[sc].start_us, 6 * SECOND, "the sound followed the picture up and along");
    }

    #[test]
    fn a_clip_dropped_between_rows_gets_a_new_track_of_its_kind_there() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        let (t1, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        let (t2, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        let (t3, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        let roles = |p: &Project| p.tracks.iter().map(|t| t.role.clone()).collect::<Vec<_>>();
        let on = |p: &Project, c: &str| p.find_clip(c).unwrap().0;
        assert_eq!(roles(&p), ["", "text", "text", "text"]);
        // t3 (top) between t1's row and t2's: a new text track at index 2, and its old one goes.
        let id = p.move_to_new_track(&t3, 2 * SECOND, 2).unwrap();
        assert_eq!(roles(&p), ["", "text", "text", "text"]);
        assert_eq!((on(&p, &t1), on(&p, &t3), on(&p, &t2)), (1, 2, 3));
        assert_eq!((p.tracks[2].id.as_str(), p.clip(&t3).unwrap().start_us), (id.as_str(), 2 * SECOND));
        // Above every row (the end of the list), and an index under the main track stays over it.
        p.move_to_new_track(&t1, 0, p.tracks.len()).unwrap();
        assert_eq!(on(&p, &t1), p.tracks.len() - 1);
        p.move_to_new_track(&t1, 0, 0).unwrap();
        assert_eq!(on(&p, &t1), 1, "just above the main track");

        // A caption line on a new row stays a caption line, on a captions track, with its words.
        let mut style = TextSpec::new();
        style.insert("preset".into(), "Clean · sv · 72".into());
        let words = serde_json::json!([{ "w": "hej", "s": 0, "e": 300_000 }]);
        let line = CaptionLine { start_us: 0, end_us: SECOND, text: "hej".into(), png: Some("hej.png".into()), words: Some(words.clone()), ..Default::default() };
        let (_, lines) = p.set_captions(None, None, vec![line], style).unwrap();
        p.move_to_new_track(&lines[0], 3 * SECOND, 1).unwrap();
        let (ci, c) = (on(&p, &lines[0]), p.clip(&lines[0]).unwrap());
        assert_eq!((p.tracks[ci].role.as_str(), ci, c.caption, c.start_us), ("captions", 1, true, 3 * SECOND));
        let text = c.text.as_ref().unwrap();
        assert_eq!((text["preset"].as_str(), text["content"].as_str(), &text["words"]), (Some("Clean · sv · 72"), Some("hej"), &words));

        // Sound gets a new sound track where it's dropped, between the other two.
        let v1 = p.insert_on_new_track("vo", 0).unwrap();
        let v2 = p.insert_on_new_track("vo", 0).unwrap();
        let v3 = p.insert_on_new_track("vo", 20 * SECOND).unwrap();
        let at = on(&p, &v2);
        p.move_to_new_track(&v3, SECOND, at).unwrap();
        assert!(p.tracks[on(&p, &v3)].kind == TrackKind::Audio && on(&p, &v1) < on(&p, &v3) && on(&p, &v3) < on(&p, &v2));

        // A main-track picture becomes an overlay on a new track there; the main track closes up.
        let b = p.main_track().clips[1].id.clone();
        p.move_to_new_track(&b, SECOND, 2).unwrap();
        assert_eq!((p.tracks[2].role.as_str(), on(&p, &b), main_ids(&p).len()), ("overlay", 2, 1));

        // A locked track's clips stay put.
        let t2_track = p.tracks[on(&p, &t2)].id.clone();
        p.set_track(&t2_track, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        assert!(p.move_to_new_track(&t2, 0, 1).is_err());
    }

    #[test]
    fn clips_keep_to_tracks_of_their_own_role() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        let (text, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        let (_, lines) = p.set_captions(None, None, vec![CaptionLine { start_us: 5 * SECOND, end_us: 6 * SECOND, text: "x".into(), ..Default::default() }], TextSpec::new()).unwrap();
        let caps = p.tracks[p.find_clip(&lines[0]).unwrap().0].id.clone();
        // Text dropped on the captions track (free at that time) keeps to a text track, and the line to its own.
        p.move_clip(&text, 0, Some(&caps)).unwrap();
        assert_eq!(p.tracks[p.find_clip(&text).unwrap().0].role, "text");
        assert_eq!(p.tracks[p.find_clip(&lines[0]).unwrap().0].clips.len(), 1);
        // An old overlay track with no role still takes overlays.
        let img = p.add_overlay(Some("img"), None, 0, None, "overlay", None).unwrap().0;
        let ti = p.find_clip(&img).unwrap().0;
        p.tracks[ti].role.clear();
        let img2 = p.add_overlay(Some("img"), None, 10 * SECOND, None, "overlay", None).unwrap().0;
        let old = p.tracks[ti].id.clone();
        p.move_clip(&img2, 10 * SECOND, Some(&old)).unwrap();
        assert_eq!(p.tracks[p.find_clip(&img2).unwrap().0].id, old);
    }

    #[test]
    fn a_selection_moves_together_each_on_its_own_track() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        let (t1, _) = p.add_overlay(None, None, 0, Some(SECOND), "text", None).unwrap();
        let (t2, _) = p.add_overlay(None, None, SECOND, Some(SECOND), "text", None).unwrap();
        let (t3, _) = p.add_overlay(None, None, 3 * SECOND, Some(SECOND), "text", None).unwrap();
        let track = |p: &Project, id: &str| p.tracks[p.find_clip(id).unwrap().0].id.clone();
        let before = [track(&p, &t1), track(&p, &t2), track(&p, &t3)];
        // Right by 2 s: t2 (1–2 s) moves past where t3 starts only because t3 moves first.
        p.move_many(&[(t1.clone(), 2 * SECOND), (t2.clone(), 3 * SECOND), (t3.clone(), 5 * SECOND)]).unwrap();
        let at = |p: &Project, id: &str| p.clip(id).unwrap().start_us;
        assert_eq!((at(&p, &t1), at(&p, &t2), at(&p, &t3)), (2 * SECOND, 3 * SECOND, 5 * SECOND));
        assert_eq!([track(&p, &t1), track(&p, &t2), track(&p, &t3)], before, "each stays on its track");
        // And back left, never before 0.
        p.move_many(&[(t1.clone(), -SECOND), (t2.clone(), 0), (t3.clone(), 2 * SECOND)]).unwrap();
        assert_eq!((at(&p, &t1), at(&p, &t2), at(&p, &t3)), (0, 0, 2 * SECOND));
    }

    #[test]
    fn main_track_is_magnetic() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        p.insert("b", 99 * SECOND).unwrap();
        p.insert("img", 0).unwrap();
        assert_eq!(main_ids(&p), vec![("img".into(), 0, 3 * SECOND), ("a".into(), 3 * SECOND, 4 * SECOND), ("b".into(), 7 * SECOND, 2 * SECOND)]);
        assert_eq!(p.duration_us(), 9 * SECOND);
    }

    #[test]
    fn split_then_ripple_delete_closes_the_gap() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        let right = p.split(SECOND, &[]).unwrap();
        assert_eq!(right.len(), 1);
        let clip = p.clip(&right[0]).unwrap();
        assert_eq!((clip.start_us, clip.in_us, clip.duration_us), (SECOND, SECOND, 3 * SECOND));
        p.delete(&right).unwrap();
        assert_eq!(main_ids(&p), vec![("a".into(), 0, SECOND), ("b".into(), SECOND, 2 * SECOND)]);
    }

    #[test]
    fn audio_gets_its_own_tracks_which_vanish_when_empty() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        let vo = p.insert("vo", 0).unwrap();
        let vo2 = p.insert("vo", 2 * SECOND).unwrap();
        assert_eq!(p.tracks.len(), 3, "overlapping audio makes a second audio track");
        p.delete(&[vo.clone()]).unwrap();
        p.delete(&[vo2]).unwrap();
        assert_eq!(p.tracks.len(), 1, "empty audio tracks disappear");
    }

    #[test]
    fn moving_on_the_main_track_reorders() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        p.move_clip(&a, 10 * SECOND, None).unwrap();
        assert_eq!(main_ids(&p).iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn trim_is_clamped_to_the_media() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.trim(&a, 3 * SECOND, 10 * SECOND, None).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.in_us, c.duration_us), (3 * SECOND, SECOND));
        p.trim(&a, -5, 1, None).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.in_us, c.duration_us), (0, MIN_CLIP));
    }

    #[test]
    fn audio_trim_into_a_neighbour_hops_tracks() {
        let mut p = project();
        let first = p.insert("vo", 0).unwrap();
        p.trim(&first, 0, 2 * SECOND, None).unwrap();
        let second = p.insert("vo", 3 * SECOND).unwrap();
        assert_eq!(p.tracks.len(), 2);
        p.trim(&first, 0, 5 * SECOND, Some(0)).unwrap();
        assert_eq!(p.tracks.len(), 3, "the longer clip no longer fits next to {second}");
    }

    #[test]
    fn serialises_round_trip() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"durationUs\""));
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn formats_have_ad_sizes() {
        assert_eq!(format_size("4:5"), Some((1080, 1350)));
        let mut p = project();
        assert!(p.set_format("3:2").is_err());
        p.set_format("16:9").unwrap();
        assert_eq!((p.width, p.height), (1920, 1080));
    }

    #[test]
    fn linked_folders_sync_and_unlink() {
        let mut p = project();
        let f = p.link_folder("/ads/B-roll", "B-roll");
        assert_eq!(p.link_folder("/ads/B-roll", "B-roll"), f, "linking the same folder twice finds it");
        let found = |path: &str, dir: &str| Media { path: path.into(), name: path.into(), dir: Some(dir.into()), duration_us: SECOND, ..Default::default() };
        let (added, missing) = p.sync_folder(&f, &["/ads/B-roll/x.mp4".into(), "/ads/B-roll/Jul/y.mp4".into()], vec![found("/ads/B-roll/x.mp4", ""), found("/ads/B-roll/Jul/y.mp4", "Jul")]).unwrap();
        assert_eq!((added, missing), (2, 0));
        let y = p.media.iter().find(|m| m.path.ends_with("y.mp4")).unwrap().id.clone();
        assert_eq!(p.media.iter().filter(|m| m.folder.as_deref() == Some(f.as_str())).count(), 2);

        // y.mp4 disappears from disk: flagged, not removed.
        let (_, missing) = p.sync_folder(&f, &["/ads/B-roll/x.mp4".into()], vec![]).unwrap();
        assert_eq!(missing, 1);
        assert!(p.media(&y).unwrap().missing);

        // Unlinking keeps files a clip uses (unfiled) and drops the rest.
        p.insert(&y, 0).unwrap();
        assert_eq!(p.unlink_folder(&f).unwrap(), 1);
        assert!(p.folders.is_empty());
        assert_eq!(p.media(&y).unwrap().folder, None);
        assert!(p.sync_folder(&f, &[], vec![]).is_err());
    }

    #[test]
    fn magnet_off_keeps_gaps_and_pushes_overlaps() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let b = p.insert("b", 0).unwrap();
        p.set_magnet(false);
        p.move_clip(&b, 6 * SECOND, None).unwrap();
        assert_eq!(main_ids(&p), vec![("a".into(), 2 * SECOND, 4 * SECOND), ("b".into(), 6 * SECOND, 2 * SECOND)], "gaps stay where the clips were");
        p.delete(std::slice::from_ref(&a)).unwrap();
        assert_eq!(p.clip(&b).unwrap().start_us, 6 * SECOND, "deleting doesn't close up");
        let c = p.insert("a", 7 * SECOND).unwrap();
        assert_eq!(p.clip(&b).unwrap().start_us, 6 * SECOND);
        assert_eq!(p.clip(&c).unwrap().start_us, 8 * SECOND, "dropping onto a clip pushes past it");
        p.set_magnet(true);
        assert_eq!(p.clip(&b).unwrap().start_us, 0, "the magnet closes the gaps");
    }

    #[test]
    fn extracted_audio_is_linked_to_its_video() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let b = p.insert("b", 0).unwrap(); // b first, a after it at 2 s
        let audio = p.extract_audio(std::slice::from_ref(&a)).unwrap();
        assert_eq!(audio.len(), 1);
        let x = p.clip(&audio[0]).unwrap().clone();
        assert_eq!((x.start_us, x.in_us, x.duration_us, x.media_id.as_str()), (2 * SECOND, 0, 4 * SECOND, "a"));
        assert!(p.clip(&a).unwrap().detached);
        assert!(p.extract_audio(std::slice::from_ref(&a)).is_err(), "only once");

        // Moving the video moves its audio.
        p.move_clip(&a, 0, None).unwrap();
        assert_eq!(p.clip(&audio[0]).unwrap().start_us, 0);
        // Splitting only the video leaves its audio whole; selecting both splits both, in pairs.
        let mut q = p.clone();
        assert_eq!(q.split(SECOND / 2, std::slice::from_ref(&a)).unwrap().len(), 1);
        assert_eq!(q.clip(&audio[0]).unwrap().duration_us, 4 * SECOND, "the extracted audio stays whole");
        let right = p.split(SECOND, &[a.clone(), audio[0].clone()]).unwrap();
        assert_eq!(right.len(), 2);
        let links: Vec<_> = right.iter().map(|id| p.clip(id).unwrap().link.clone()).collect();
        assert_eq!(links[0], links[1]);
        assert_ne!(links[0], p.clip(&a).unwrap().link);
        // Deleting the audio leaves the video; deleting the video leaves its audio, where it
        // was, as an ordinary sound clip (as in CapCut).
        p.delete(std::slice::from_ref(&audio[0])).unwrap();
        assert!(p.clip(&a).is_some());
        let kept = p.clip(&right[1]).unwrap().clone();
        p.delete(std::slice::from_ref(&right[0])).unwrap();
        let after = p.clip(&right[1]).expect("the extracted audio stays on the timeline");
        assert_eq!((after.start_us, after.duration_us), (kept.start_us, kept.duration_us), "where it was");
        assert_eq!(after.link, None, "and linked to nothing");
        let _ = b;
        // With linkage off, the video moves alone.
        let mut q = project();
        let a = q.insert("a", 0).unwrap();
        q.insert("b", 0).unwrap();
        let audio = q.extract_audio(std::slice::from_ref(&a)).unwrap();
        q.linkage = false;
        q.move_clip(&a, 0, None).unwrap();
        assert_eq!(q.clip(&audio[0]).unwrap().start_us, 2 * SECOND);
    }

    #[test]
    fn delete_left_and_right_cut_at_the_playhead() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let b = p.insert("b", 4 * SECOND).unwrap();
        p.trim_at(SECOND, &[], true).unwrap();
        assert_eq!(main_ids(&p), vec![("a".into(), 0, 3 * SECOND), ("b".into(), 3 * SECOND, 2 * SECOND)], "delete left ripples");
        assert_eq!(p.clip(&a).unwrap().in_us, SECOND);
        p.trim_at(4 * SECOND, std::slice::from_ref(&b), false).unwrap();
        assert_eq!(p.clip(&b).unwrap().duration_us, SECOND, "delete right keeps the part before");
        assert!(p.trim_at(0, &[], true).is_err());

        // Only what's selected is cut: the video, not its extracted audio.
        let audio = p.extract_audio(std::slice::from_ref(&a)).unwrap();
        p.trim_at(SECOND / 2, std::slice::from_ref(&a), false).unwrap();
        assert_eq!((p.clip(&a).unwrap().duration_us, p.clip(&audio[0]).unwrap().duration_us), (SECOND / 2, 3 * SECOND));
        assert!(p.trim_at(3 * SECOND, std::slice::from_ref(&a), false).is_err(), "the playhead is outside the selected clip");
    }

    #[test]
    fn delete_left_takes_a_sliver_as_short_as_you_like() {
        // The playhead 0.08 s into a clip: Q takes those 0.08 s away (it used to refuse
        // anything under 0.1 s, even though the part kept was long).
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.trim_at(80_000, std::slice::from_ref(&a), true).unwrap();
        assert_eq!((p.clip(&a).unwrap().in_us, p.clip(&a).unwrap().duration_us), (80_000, 4 * SECOND - 80_000));
        // What stays must be at least a frame: 10 ms before the end leaves too little.
        let err = p.trim_at(p.clip(&a).unwrap().end_us() - 10_000, std::slice::from_ref(&a), true).unwrap_err();
        assert_eq!(err.0, "That would leave less than a frame of the clip");
    }

    #[test]
    fn crop_rotate_and_mirror_are_clip_settings() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.set_clip(&a, ClipChange { crop: Some(Some(Crop { x: 0.1, y: 0.2, w: 0.5, h: 0.5 })), flip: Some(true), rotate: Some(450), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.flip, c.rotate), (true, 90));
        assert_eq!(c.crop, Some(Crop { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }));
        p.set_clip(&a, ClipChange { crop: Some(Some(Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 })), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().crop, None, "the whole frame is no crop");
    }

    #[test]
    fn removed_media_goes_with_its_clips_and_comes_back() {
        let mut p = project();
        let f = p.link_folder("/ads", "ads");
        p.media[0].folder = Some(f.clone());
        let c = p.insert("a", 0).unwrap();
        let a = p.media("a").unwrap().clone();
        assert_eq!(p.remove_media(&["a".into()]).unwrap(), (1, 1));
        assert!(p.clip(&c).is_none() && p.media("a").is_none());
        assert_eq!(p.folders[0].hidden, vec!["a.mp4".to_string()], "rescans will leave it out");
        assert_eq!(p.restore_media(vec![a]).unwrap(), vec!["a".to_string()]);
        assert!(p.folders[0].hidden.is_empty());
    }

    #[test]
    fn paste_keeps_spacing_and_pairs_links() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let audio = p.extract_audio(std::slice::from_ref(&a)).unwrap();
        let items = vec![
            PasteItem { clip: p.clip(&a).unwrap().clone(), main: true, offset_us: 0, role: None },
            PasteItem { clip: p.clip(&audio[0]).unwrap().clone(), main: false, offset_us: 0, role: None },
        ];
        let new = p.paste(items, 4 * SECOND).unwrap();
        assert_eq!(new.len(), 2);
        let (v, x) = (p.clip(&new[0]).unwrap(), p.clip(&new[1]).unwrap());
        assert_eq!((v.start_us, x.start_us), (4 * SECOND, 4 * SECOND));
        assert_eq!(v.link, x.link);
        assert_ne!(v.link, p.clip(&a).unwrap().link, "a new pair, not tied to the original");
    }

    #[test]
    fn compound_clips_replace_the_selection_and_break_apart() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let b = p.insert("b", 4 * SECOND).unwrap();
        let img = p.insert("img", 6 * SECOND).unwrap();
        let (sub, start, end) = p.sub_project(&[a.clone(), b.clone()]).unwrap();
        assert_eq!((start, end, sub.duration_us(), sub.main_track().clips.len()), (0, 6 * SECOND, 6 * SECOND, 2));
        let render = Media { path: "compound-1.mp4".into(), name: "Compound 1".into(), duration_us: 6 * SECOND, has_audio: true, ..Default::default() };
        let cc = p.make_compound(&[a.clone(), b.clone()], render).unwrap();
        assert_eq!(p.main_track().clips.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![cc.clone(), img.clone()]);
        assert_eq!(p.clip(&img).unwrap().start_us, 6 * SECOND);
        let parts = p.break_compound(&cc).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(main_ids(&p).iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["a", "b", "img"]);
        assert!(p.break_compound(&img).is_err());
    }

    #[test]
    fn old_projects_load_with_a_neutral_mix_and_the_usual_master() {
        let json = r#"{"name":"Old","width":1080,"height":1920,"fps":30,"media":[],"tracks":[{"id":"t1","kind":"video","main":true,"clips":[{"id":"c1","mediaId":"m1","startUs":0,"inUs":0,"durationUs":1000000}]}]}"#;
        let p: Project = serde_json::from_str(json).unwrap();
        let t = &p.tracks[0];
        assert_eq!((t.gain_db, t.pan, t.mute, t.solo, t.effects.count_on()), (0.0, 0.0, false, false, 0));
        assert_eq!(t.effects.comp.threshold_db, -18.0, "effects keep their settings while off");
        assert!(p.master.normalize && p.master.limiter && p.master.target_lufs == -14.0);
        let c = &t.clips[0];
        assert_eq!((c.volume, c.fade_in_us, c.pitch, c.declick), (1.0, 0, 0.0, false));
        assert!(p.labels.is_empty());
        let back: Project = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn track_mix_is_kept_in_range_and_solo_silences_the_rest() {
        let mut p = project();
        p.insert("a", 0).unwrap();
        let vo = p.insert("vo", 0).unwrap();
        let voice = p.tracks.iter().find(|t| t.clips.iter().any(|c| c.id == vo)).unwrap().id.clone();
        let mut fx = Effects::default();
        fx.comp.on = true;
        fx.comp.ratio = 40.0;
        fx.limiter.ceiling_db = -20.0;
        p.set_track(&voice, TrackChange { gain_db: Some(30.0), pan: Some(-0.333), effects: Some(fx), role: Some("voice".into()), ..Default::default() }).unwrap();
        let t = p.track(&voice).unwrap();
        assert_eq!((t.gain_db, t.pan, t.role.as_str()), (12.0, -0.33, "voice"));
        assert_eq!((t.effects.comp.ratio, t.effects.limiter.ceiling_db, t.effects.count_on()), (10.0, -6.0, 1));
        assert!(p.set_track("nope", TrackChange::default()).is_err());

        let main = p.main_track().id.clone();
        assert!(p.tracks.iter().all(|t| p.audible(t)));
        p.set_track(&voice, TrackChange { solo: Some(true), ..Default::default() }).unwrap();
        assert!(!p.audible(p.track(&main).unwrap()) && p.audible(p.track(&voice).unwrap()));
        p.set_track(&voice, TrackChange { mute: Some(true), ..Default::default() }).unwrap();
        assert!(!p.audible(p.track(&voice).unwrap()), "mute wins over solo");
    }

    #[test]
    fn master_settings_are_kept_in_range() {
        let mut p = project();
        p.set_master(MasterChange { normalize: Some(false), target_lufs: Some(-50.0), ceiling_db: Some(3.0), gain_db: Some(4.26), ..Default::default() }).unwrap();
        assert_eq!((p.master.normalize, p.master.limiter, p.master.target_lufs, p.master.ceiling_db, p.master.gain_db), (false, true, -30.0, 0.0, 4.3));
    }

    #[test]
    fn fades_never_overlap_and_split_keeps_each_at_its_end() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.set_clip(&a, ClipChange { fade_in_us: Some(SECOND), fade_out_us: Some(SECOND), fade_curve: Some("scurve".into()), ..Default::default() }).unwrap();
        p.set_clip(&a, ClipChange { fade_in_us: Some(7 * SECOND / 2), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.fade_in_us, c.fade_out_us, c.fade_curve.as_str()), (7 * SECOND / 2, SECOND / 2, "scurve"));
        p.set_clip(&a, ClipChange { fade_curve: Some("bogus".into()), pitch: Some(3.14), declick: Some(true), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.fade_curve.as_str(), c.pitch, c.declick), ("", 3.1, true));
        let right = p.split(2 * SECOND, &[]).unwrap();
        let (l, r) = (p.clip(&a).unwrap(), p.clip(&right[0]).unwrap());
        assert_eq!((l.fade_in_us, l.fade_out_us, r.fade_in_us, r.fade_out_us), (2 * SECOND, 0, 0, SECOND / 2));
    }

    #[test]
    fn envelopes_are_sorted_and_kept_in_range() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let pts = vec![EnvPoint { at_us: SECOND, gain: 9.0 }, EnvPoint { at_us: 0, gain: 0.5 }, EnvPoint { at_us: SECOND, gain: 1.0 }];
        p.set_clip(&a, ClipChange { envelope: Some(pts), ..Default::default() }).unwrap();
        let env = &p.clip(&a).unwrap().envelope;
        assert_eq!(env.len(), 2);
        assert_eq!((env[0].at_us, env[0].gain, env[1].gain), (0, 0.5, 4.0));
    }

    #[test]
    fn removing_pauses_closes_them_up() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        let pieces = p.remove_ranges(&a, &[(SECOND, 2 * SECOND), (3 * SECOND, 7 * SECOND / 2)]).unwrap();
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces[0], a, "the first piece keeps the clip's id");
        let got: Vec<(Us, Us, Us)> = pieces.iter().map(|id| p.clip(id).unwrap()).map(|c| (c.start_us, c.in_us, c.duration_us)).collect();
        assert_eq!(got, vec![(0, 0, SECOND), (SECOND, 2 * SECOND, SECOND), (2 * SECOND, 7 * SECOND / 2, SECOND / 2)]);
        assert_eq!(main_ids(&p).last().unwrap(), &("b".to_string(), 5 * SECOND / 2, 2 * SECOND), "the next clip moves up");
        assert!(p.remove_ranges(&a, &[]).is_err());

        // On an audio track the pieces close up where the clip began.
        let vo = p.insert("vo", SECOND).unwrap();
        let pieces = p.remove_ranges(&vo, &[(0, SECOND / 2), (9 * SECOND, 10 * SECOND)]).unwrap();
        let c = p.clip(&pieces[0]).unwrap();
        assert_eq!((pieces.len(), c.start_us, c.in_us, c.duration_us), (1, SECOND, SECOND / 2, 17 * SECOND / 2));
    }

    #[test]
    fn split_at_times_makes_one_clip_per_phrase() {
        let mut p = project();
        let vo = p.insert("vo", 0).unwrap();
        let pieces = p.split_at_times(&vo, &[6 * SECOND, 2 * SECOND, 20 * SECOND]).unwrap();
        assert_eq!(pieces.len(), 3);
        let lens: Vec<Us> = pieces.iter().map(|id| p.clip(id).unwrap().duration_us).collect();
        assert_eq!(lens, vec![2 * SECOND, 4 * SECOND, 4 * SECOND]);
        let single = p.split_at_times(&pieces[0], &[]);
        assert!(single.is_err());
    }

    #[test]
    fn new_track_insert_and_labels() {
        let mut p = project();
        let c = p.insert_on_new_track("vo", 0).unwrap();
        let c2 = p.insert_on_new_track("a", 0).unwrap();
        assert_eq!(p.tracks.len(), 3, "each insert gets its own track");
        assert_ne!(p.find_clip(&c).unwrap().0, p.find_clip(&c2).unwrap().0);
        assert!(p.insert_on_new_track("img", 0).is_err());

        let ids = p.add_labels(vec![(3 * SECOND, 2 * SECOND, "Product".into()), (0, SECOND, "Hook".into())]).unwrap();
        assert_eq!(p.labels.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Hook", "Product"]);
        assert_eq!((p.labels[1].start_us, p.labels[1].end_us), (2 * SECOND, 3 * SECOND));
        p.set_label(&ids[0], Some("Gift".into()), None, Some(4 * SECOND)).unwrap();
        assert_eq!((p.labels[1].text.as_str(), p.labels[1].end_us), ("Gift", 4 * SECOND));
        p.delete_labels(&ids).unwrap();
        assert!(p.labels.is_empty() && p.delete_labels(&ids).is_err());
        let marker = p.add_labels(vec![(SECOND, SECOND, "Marker 1".into())]).unwrap();
        assert_eq!((p.labels[0].start_us, p.labels[0].end_us, marker.len()), (SECOND, SECOND, 1), "a marker is a point");
    }

    fn keys(name: &str, pts: &[(Us, f64)]) -> Keyframes {
        Keyframes::from([(name.to_string(), pts.iter().map(|&(at_us, value)| Keyframe { at_us, value, ..Default::default() }).collect())])
    }

    #[test]
    fn speed_keeps_the_source_range_and_edits_count_in_source_time() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let b = p.insert("b", 10 * SECOND).unwrap();
        p.set_clip(&a, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.duration_us, c.span_us()), (2 * SECOND, 4 * SECOND));
        assert_eq!(p.clip(&b).unwrap().start_us, 2 * SECOND, "the main track closes up");
        p.set_clip(&a, ClipChange { speed: Some(50.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().speed, 10.0, "kept in range");
        p.set_clip(&a, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().duration_us, 2 * SECOND, "and back: the same source range");

        // Split: half a second on the timeline is a second of source.
        let right = p.split(SECOND / 2, std::slice::from_ref(&a)).unwrap();
        let r = p.clip(&right[0]).unwrap();
        assert_eq!((r.in_us, r.duration_us, r.span_us()), (SECOND, 3 * SECOND / 2, 3 * SECOND));
        // Trim: at double speed the clip can't run past the source's end.
        p.trim(&right[0], SECOND, 10 * SECOND, None).unwrap();
        assert_eq!(p.clip(&right[0]).unwrap().duration_us, 3 * SECOND / 2);
        // Delete left half a second into it moves its in point by a second.
        p.trim_at(SECOND, std::slice::from_ref(&right[0]), true).unwrap();
        let r = p.clip(&right[0]).unwrap();
        assert_eq!((r.in_us, r.duration_us), (2 * SECOND, SECOND));
        // A still has no source time: speed and direction do nothing.
        let img = p.insert("img", 0).unwrap();
        p.set_clip(&img, ClipChange { speed: Some(2.0), reverse: Some(true), ..Default::default() }).unwrap();
        let i = p.clip(&img).unwrap();
        assert_eq!((i.speed, i.reverse, i.duration_us), (1.0, false, 3 * SECOND));
    }

    #[test]
    fn a_reversed_clip_plays_from_the_end_of_its_range_and_splits_that_way() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.set_clip(&a, ClipChange { reverse: Some(true), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.source_at(0), c.source_at(SECOND), c.source_at(4 * SECOND)), (4 * SECOND, 3 * SECOND, 0));
        let right = p.split(SECOND, &[]).unwrap();
        let (l, r) = (p.clip(&a).unwrap(), p.clip(&right[0]).unwrap());
        assert_eq!((l.in_us, l.duration_us, l.source_at(0)), (3 * SECOND, SECOND, 4 * SECOND), "the left half is the end of the source");
        assert_eq!((r.in_us, r.duration_us, r.source_at(0)), (0, 3 * SECOND, 3 * SECOND), "the right half carries on from there");
        // Backwards at half speed, delete right keeps the first second: the last half second of source.
        p.set_clip(&a, ClipChange { speed: Some(0.5), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().duration_us, 2 * SECOND);
        p.trim_at(SECOND, std::slice::from_ref(&a), false).unwrap();
        let l = p.clip(&a).unwrap();
        assert_eq!((l.in_us, l.duration_us, l.source_at(0)), (7 * SECOND / 2, SECOND, 4 * SECOND));
        // Cutting pauses out of it keeps each piece's own stretch of source.
        let mut q = project();
        let vo = q.insert("vo", 0).unwrap();
        q.set_clip(&vo, ClipChange { reverse: Some(true), ..Default::default() }).unwrap();
        let pieces = q.remove_ranges(&vo, &[(2 * SECOND, 4 * SECOND)]).unwrap();
        let ins: Vec<Us> = pieces.iter().map(|id| q.clip(id).unwrap().in_us).collect();
        assert_eq!(ins, vec![8 * SECOND, 0], "the first piece plays the source's last 2 s backwards");
    }

    #[test]
    fn keyframes_are_cleaned_and_stay_with_the_picture() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let mut k = keys("posX", &[(2 * SECOND, 100.0), (0, 0.0), (SECOND, f64::NAN)]);
        k.extend(keys("hsl-Orange-h", &[(0, 12.0)]));
        k.insert("empty".into(), vec![]);
        p.set_clip(&a, ClipChange { keyframes: Some(k), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!(c.keyframes.keys().collect::<Vec<_>>(), ["hsl-Orange-h", "posX"], "any setting is kept; empty lists go");
        assert_eq!(c.keyframes["posX"], keys("posX", &[(0, 0.0), (2 * SECOND, 100.0)])["posX"]);
        assert_eq!((c.value_at("posX", SECOND, 0.0), c.value_at("posX", 3 * SECOND, 0.0), c.value_at("scale", 0, 100.0)), (50.0, 100.0, 100.0));
        // Split at 1 s: each half keeps its part of the move, meeting at 50.
        let right = p.split(SECOND, &[]).unwrap();
        assert_eq!(p.clip(&a).unwrap().keyframes["posX"], keys("posX", &[(0, 0.0), (SECOND, 50.0)])["posX"]);
        let r = p.clip(&right[0]).unwrap();
        assert_eq!(r.keyframes["posX"], keys("posX", &[(0, 50.0), (SECOND, 100.0)])["posX"]);
        assert_eq!(r.keyframes["hsl-Orange-h"], keys("x", &[(0, 12.0)])["x"], "a single point stays");
        // At double speed the move takes half as long.
        p.set_clip(&right[0], ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&right[0]).unwrap().keyframes["posX"][1].at_us, SECOND / 2);
        // Trimming a second of source off the start (half a second at this speed) moves them back.
        p.trim(&right[0], 2 * SECOND, SECOND, None).unwrap();
        assert_eq!(p.clip(&right[0]).unwrap().keyframes["posX"][0].at_us, -SECOND / 2);
    }

    #[test]
    fn look_settings_are_kept_in_range_and_always_saved() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.set_clip(&a, ClipChange { scale: Some(900.0), opacity: Some(-5.0), rotation: Some(725.5), pos_x: Some(f32::NAN), pos_y: Some(-40.0), brightness: Some(250.0), vignette: Some(-30.0), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap();
        assert_eq!((c.scale, c.opacity, c.rotation, c.pos_x, c.pos_y, c.brightness, c.vignette), (400.0, 0.0, 725.5, 0.0, -40.0, 100.0, -30.0));
        let json = serde_json::to_value(c).unwrap();
        for key in ["scale", "posX", "posY", "rotation", "opacity", "temperature", "tint", "saturation", "brightness", "contrast", "highlights", "shadows", "sharpen", "vignette", "speed", "reverse", "keyframes"] {
            assert!(json.get(key).is_some(), "{key} is always in the snapshot");
        }
        let old: Clip = serde_json::from_str(r#"{"id":"c1","mediaId":"m1","startUs":0,"inUs":0,"durationUs":1000000}"#).unwrap();
        assert_eq!((old.scale, old.opacity, old.speed, old.reverse, old.keyframes.len()), (100.0, 100.0, 1.0, false, 0));
    }

    #[test]
    fn linked_sound_keeps_time_with_its_picture() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let audio = p.extract_audio(std::slice::from_ref(&a)).unwrap();
        p.set_clip(&a, ClipChange { speed: Some(0.5), reverse: Some(true), ..Default::default() }).unwrap();
        let x = p.clip(&audio[0]).unwrap();
        assert_eq!((x.speed, x.reverse, x.duration_us, x.start_us), (0.5, true, 8 * SECOND, 0));
        let b = p.insert("b", 0).unwrap();
        p.set_clip(&b, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&audio[0]).unwrap().start_us, SECOND, "it follows its picture along the main track");
        let bx = p.extract_audio(std::slice::from_ref(&b)).unwrap();
        let y = p.clip(&bx[0]).unwrap();
        assert_eq!((y.speed, y.duration_us), (2.0, SECOND), "sound extracted from a fast clip is fast too");
    }

    #[test]
    fn locked_tracks_refuse_edits() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        let vo = p.insert("vo", 0).unwrap();
        let voice = p.tracks.iter().find(|t| !t.main).unwrap().id.clone();
        p.set_track(&voice, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        let locked = "The vo track is locked";
        assert_eq!(p.move_clip(&vo, SECOND, None).unwrap_err().0, locked);
        assert_eq!(p.trim(&vo, 0, SECOND, None).unwrap_err().0, locked);
        assert_eq!(p.split(SECOND, std::slice::from_ref(&vo)).unwrap_err().0, locked);
        assert_eq!(p.delete(std::slice::from_ref(&vo)).unwrap_err().0, locked);
        assert_eq!(p.trim_at(SECOND, std::slice::from_ref(&vo), true).unwrap_err().0, locked);
        assert_eq!(p.set_clip(&vo, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap_err().0, locked);
        let vo2 = p.insert("vo", 0).unwrap();
        assert_ne!(p.find_clip(&vo2).unwrap().0, p.find_clip(&vo).unwrap().0, "new sound goes on a track of its own");
        p.set_track(&voice, TrackChange { role: Some("voice".into()), ..Default::default() }).unwrap();
        assert_eq!(p.delete(std::slice::from_ref(&vo)).unwrap_err().0, "The voice track is locked");

        let main = p.main_track().id.clone();
        p.set_track(&main, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        assert_eq!(p.insert("b", 0).unwrap_err().0, "The main track is locked");
        let copy = PasteItem { clip: p.clip(&a).unwrap().clone(), main: true, offset_us: 0, role: None };
        assert_eq!(p.paste(vec![copy], 0).unwrap_err().0, "The main track is locked");
        assert!(p.split(SECOND, &[]).is_err());
        p.set_clip(&a, ClipChange { brightness: Some(20.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().brightness, 20.0, "the look isn't an edit of the track");
    }

    #[test]
    fn busy_clips_refuse_edits_but_ride_the_main_track() {
        let mut p = project();
        let b = p.insert("b", 0).unwrap();
        let a = p.insert("a", 0).unwrap();
        p.set_busy(&a, Some("job1")).unwrap();
        let busy = "Text is still being removed from a. Wait for it, or cancel it from the clip's right-click menu";
        assert_eq!(p.move_clip(&a, 3 * SECOND, None).unwrap_err().0, busy);
        assert_eq!(p.trim(&a, 0, SECOND, None).unwrap_err().0, busy);
        assert_eq!(p.split(SECOND, std::slice::from_ref(&a)).unwrap_err().0, busy);
        assert_eq!(p.split(SECOND, &[]).unwrap_err().0, busy, "the main clip under the playhead");
        assert_eq!(p.delete(&[a.clone(), b.clone()]).unwrap_err().0, busy);
        assert_eq!(p.trim_at(SECOND, std::slice::from_ref(&a), true).unwrap_err().0, busy);
        assert_eq!(p.replace_media(&a, "b", false).unwrap_err().0, busy);
        assert_eq!(p.set_busy(&a, Some("job2")).unwrap_err().0, busy, "one job at a time");
        p.set_busy(&a, Some("job1")).unwrap();

        // Any other change to it is caught by comparing before and after.
        let before = p.clone();
        p.set_clip(&a, ClipChange { brightness: Some(20.0), ..Default::default() }).unwrap();
        assert_eq!(p.busy_kept(&before).unwrap_err().0, busy);
        let mut gone = before.clone();
        gone.tracks[0].clips.retain(|c| c.id != a);
        assert_eq!(gone.busy_kept(&before).unwrap_err().0, busy);
        // Clips before it come and go: it moves along the main track, and that's fine.
        let mut p = before.clone();
        let first = p.insert("b", 0).unwrap();
        assert_eq!(p.clip(&a).unwrap().start_us, 2 * SECOND);
        p.busy_kept(&before).unwrap();
        p.delete(std::slice::from_ref(&first)).unwrap();
        p.delete(std::slice::from_ref(&b)).unwrap();
        p.busy_kept(&before).unwrap();

        // A copy isn't busy, and the mark is saved with the project.
        let copy = PasteItem { clip: p.clip(&a).unwrap().clone(), main: true, offset_us: 0, role: None };
        let pasted = p.paste(vec![copy], 0).unwrap();
        assert_eq!(p.clip(&pasted[0]).unwrap().busy, None);
        let back: Project = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.clip(&a).unwrap().busy.as_deref(), Some("job1"));
        p.set_busy(&a, None).unwrap();
        p.move_clip(&a, 0, None).unwrap();
        assert!(!serde_json::to_string(&p).unwrap().contains("\"busy\""), "not written when clear");

        let main = p.main_track().id.clone();
        p.set_track(&main, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        assert_eq!(p.set_busy(&a, Some("job3")).unwrap_err().0, "The main track is locked");
    }

    #[test]
    fn freeze_frame_holds_a_frame_between_the_halves() {
        let mut p = project();
        let a = p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        p.set_clip(&a, ClipChange { scale: Some(120.0), brightness: Some(30.0), flip: Some(true), keyframes: Some(keys("posX", &[(0, 0.0), (2 * SECOND, 100.0)])), ..Default::default() }).unwrap();
        let still = || Media { path: "freeze.png".into(), name: "Freeze frame 1".into(), kind: MediaKind::Image, width: 1080, height: 1920, ..Default::default() };
        let f = p.freeze_frame(&a, SECOND, still(), IMAGE_DEFAULT).unwrap();
        let times: Vec<(Us, Us)> = main_ids(&p).into_iter().map(|x| (x.1, x.2)).collect();
        assert_eq!(times, vec![(0, SECOND), (SECOND, 3 * SECOND), (4 * SECOND, 3 * SECOND), (7 * SECOND, 2 * SECOND)]);
        let fc = p.clip(&f).unwrap();
        assert_eq!((fc.scale, fc.brightness, fc.pos_x, fc.flip, fc.keyframes.len()), (120.0, 30.0, 50.0, false, 0), "the look at that moment; the mirror is in the image");
        assert_eq!(p.media(&fc.media_id).unwrap().kind, MediaKind::Image);

        // Magnet off: everything after it moves on by the hold, gaps kept.
        let mut q = project();
        q.set_magnet(false);
        let a = q.insert("a", 0).unwrap();
        let b = q.insert("b", 6 * SECOND).unwrap();
        q.freeze_frame(&a, 2 * SECOND, still(), IMAGE_DEFAULT).unwrap();
        assert_eq!(q.clip(&b).unwrap().start_us, 9 * SECOND);
        // At the clip's very start it goes before it.
        q.freeze_frame(&a, 0, still(), IMAGE_DEFAULT).unwrap();
        assert_eq!(q.clip(&a).unwrap().start_us, 3 * SECOND);
        assert!(q.freeze_frame(&a, 50 * SECOND, still(), IMAGE_DEFAULT).is_err());
    }
}
