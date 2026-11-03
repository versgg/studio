//! What contract v2 adds to a clip: effects, transitions, colour extras (HSL, curves,
//! wheels, LUT), stabilising, smooth slow motion, speed curves, masks, mattes, animation
//! presets, text and spectral edits. Plain data with the rules that keep it in range; the
//! graph in `studio_media` turns it into FFmpeg filters.

use crate::model::Us;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The Effects tab's tiles, in its order. `engine.effects` lists them, and a name not here is
/// refused (the graph maps each one to filters in `studio_media::effects`).
pub const EFFECTS: &[&str] = &["Blur", "Glow", "Film grain", "VHS", "Glitch", "Shake", "Zoom pulse", "Sharpen", "Black & white", "Sepia", "Vintage", "Chromatic", "Pixelate", "Mirror", "Edge", "Invert", "Light leak", "Lens distort"];

/// The Transitions tab's tiles and the xfade transition each one is.
pub const TRANSITIONS: &[(&str, &str)] = &[
    ("Dissolve", "fade"),
    ("Fade through black", "fadeblack"),
    ("Fade through white", "fadewhite"),
    ("Wipe left", "wipeleft"),
    ("Wipe right", "wiperight"),
    ("Slide up", "slideup"),
    ("Slide down", "slidedown"),
    ("Slide left", "slideleft"),
    ("Slide right", "slideright"),
    ("Zoom in", "zoomin"),
    ("Circle", "circleopen"),
    ("Pixelize", "pixelize"),
    ("Blur", "hblur"),
    ("Radial", "radial"),
    ("Squeeze", "squeezeh"),
    ("Smooth", "smoothleft"),
];

/// How an overlay clip mixes with what's below it.
pub const BLENDS: &[&str] = &["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "softlight", "difference"];

/// Animation presets for a clip's start and end, and the loops.
pub const ANIMS: &[&str] = &["Fade", "Slide up", "Slide down", "Slide left", "Slide right", "Zoom in", "Zoom out", "Pop", "Spin", "Blur in", "Typewriter"];
pub const LOOPS: &[&str] = &["Pulse", "Float", "Wiggle", "Spin"];

/// The HSL tab's colour ranges.
pub const HSL_RANGES: &[&str] = &["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Magenta"];

/// What a picture track over the main track holds.
pub const VISUAL_ROLES: &[&str] = &["text", "captions", "sticker", "overlay", "adjust"];

/// The xfade name of a transition tile.
pub fn xfade_name(name: &str) -> Option<&'static str> {
    TRANSITIONS.iter().find(|(n, _)| *n == name).map(|(_, x)| *x)
}

fn hundred() -> f32 {
    100.0
}

/// One effect on a clip: a tile's name and how strong it is (0–100).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fx {
    pub name: String,
    #[serde(default = "hundred")]
    pub amount: f32,
}

/// The transition into a main-track clip from the one before it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub name: String,
    #[serde(default = "half_second")]
    pub duration_us: Us,
}

fn half_second() -> Us {
    500_000
}

/// Hue, saturation and lightness shifts for one colour range, each −100 to 100.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hsl {
    pub h: f32,
    pub s: f32,
    pub l: f32,
}

/// Points `[x, y]` in 0–1 per curve; a curve that's missing is left straight.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Curves {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub red: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub green: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blue: Option<Vec<[f64; 2]>>,
}

/// One colour wheel: the push (x, y in −1…1) and the brightness (−100…100).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Wheel {
    pub x: f32,
    pub y: f32,
    pub lum: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Wheels {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lift: Option<Wheel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gamma: Option<Wheel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gain: Option<Wheel>,
}

/// A .cube file, blended with the original by `strength` (0–100).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lut {
    pub path: String,
    #[serde(default = "hundred")]
    pub strength: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stabilize {
    #[serde(default = "hundred")]
    pub strength: f32,
}

/// Smooth slow motion on export: "Fast" (frame blending) or "Best" (motion interpolation).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Smooth {
    pub quality: String,
}

/// A speed ramp: `[t, speed]` points, t from 0 to 1 over the clip and speed 0.1–10.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedCurve {
    #[serde(default)]
    pub name: String,
    pub points: Vec<[f64; 2]>,
}

impl SpeedCurve {
    /// Sorted, kept in range and running from t = 0 to t = 1 (the ends held flat). `None`
    /// without any usable point.
    pub fn clean(mut self) -> Option<SpeedCurve> {
        self.points.retain(|p| p[0].is_finite() && p[1].is_finite());
        for p in &mut self.points {
            p[0] = p[0].clamp(0.0, 1.0);
            p[1] = p[1].clamp(0.1, 10.0);
        }
        self.points.sort_by(|a, b| a[0].total_cmp(&b[0]));
        self.points.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-6);
        let (first, last) = (*self.points.first()?, *self.points.last()?);
        if first[0] > 0.0 {
            self.points.insert(0, [0.0, first[1]]);
        }
        if last[0] < 1.0 {
            self.points.push([1.0, last[1]]);
        }
        Some(self)
    }

    /// The speed at `u` (0–1 through the clip): straight lines between points.
    pub fn at(&self, u: f64) -> f64 {
        let p = &self.points;
        if p.is_empty() {
            return 1.0;
        }
        let i = p.iter().position(|q| q[0] > u).unwrap_or(p.len());
        if i == 0 {
            return p[0][1];
        }
        if i == p.len() {
            return p[p.len() - 1][1];
        }
        let (a, b) = (p[i - 1], p[i]);
        a[1] + (b[1] - a[1]) * (u - a[0]) / (b[0] - a[0]).max(1e-9)
    }

    /// How much source a second on the timeline reads on average: the clip's `speed`.
    pub fn mean(&self) -> f64 {
        self.integral(1.0).max(0.1)
    }

    /// ∫ speed from 0 to `u`.
    fn integral(&self, u: f64) -> f64 {
        let mut sum = 0.0;
        for w in self.points.windows(2) {
            let (a, b) = (w[0], w[1]);
            if a[0] >= u {
                break;
            }
            let end = b[0].min(u);
            let v_end = a[1] + (b[1] - a[1]) * (end - a[0]) / (b[0] - a[0]).max(1e-9);
            sum += (a[1] + v_end) / 2.0 * (end - a[0]);
        }
        sum
    }

    /// The part of the clip's source shown by `u` through the clip (both 0–1): where the
    /// picture is in its source range.
    pub fn source_fraction(&self, u: f64) -> f64 {
        (self.integral(u.clamp(0.0, 1.0)) / self.integral(1.0).max(1e-9)).clamp(0.0, 1.0)
    }
}

/// A shape mask in fractions of the frame. The renderer draws it (shape, feather and
/// invert included) to the clip's `maskPng`, which is what the engine uses.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mask {
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub feather: f64,
    pub invert: bool,
}

/// A grey video of the clip's source (white keeps), made by background removal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Matte {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimStep {
    pub name: String,
    #[serde(default = "half_second")]
    pub duration_us: Us,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimLoop {
    pub name: String,
    #[serde(default = "one_second")]
    pub period_us: Us,
}

fn one_second() -> Us {
    1_000_000
}

/// Animation presets: one for the start, one for the end, and a loop over the whole clip.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Anim {
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    pub in_: Option<AnimStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out: Option<AnimStep>,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_: Option<AnimLoop>,
}

impl Anim {
    pub fn is_empty(&self) -> bool {
        self.in_.is_none() && self.out.is_none() && self.loop_.is_none()
    }
}

/// A text clip's look as the renderer keeps it (content, font, size, colour, stroke and the
/// rest). The renderer draws it to `png`; the engine reads `png` and `content`, and keeps
/// every other key as it is.
pub type TextSpec = serde_json::Map<String, serde_json::Value>;

/// A frequency band taken out of a clip's sound between two times. Times are in the source
/// file, like the volume envelope's, so trimming and moving never shift it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spectral {
    pub start_us: Us,
    pub end_us: Us,
    pub low_hz: f32,
    pub high_hz: f32,
}

/// HSL settings by range name.
pub type HslMap = BTreeMap<String, Hsl>;

/// Keeps a list of `[x, y]` points inside 0–1, in x order, at least two of them.
pub fn clean_points(points: Vec<[f64; 2]>) -> Option<Vec<[f64; 2]>> {
    let mut p: Vec<[f64; 2]> = points.into_iter().filter(|p| p[0].is_finite() && p[1].is_finite()).map(|p| [p[0].clamp(0.0, 1.0), p[1].clamp(0.0, 1.0)]).collect();
    p.sort_by(|a, b| a[0].total_cmp(&b[0]));
    p.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-4);
    (p.len() >= 2).then_some(p)
}

/// The project's brand kit, for the text and sticker tabs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Brand {
    pub colors: Vec<String>,
    pub fonts: Vec<String>,
}

/// What an MCP client may do in this project, and whether it asks before exporting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpOptions {
    /// "all", "edit" or "look".
    pub allowed: String,
    pub ask_before_export: bool,
}

impl Default for McpOptions {
    fn default() -> Self {
        McpOptions { allowed: "all".into(), ask_before_export: true }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_curves_are_cleaned_and_measured() {
        let c = SpeedCurve { name: "Ramp".into(), points: vec![[0.5, 4.0], [0.2, 1.0], [7.0, 99.0]] }.clean().unwrap();
        assert_eq!(c.points, vec![[0.0, 1.0], [0.2, 1.0], [0.5, 4.0], [1.0, 10.0]]);
        let flat = SpeedCurve { name: String::new(), points: vec![[0.3, 2.0]] }.clean().unwrap();
        assert!((flat.mean() - 2.0).abs() < 1e-9 && (flat.source_fraction(0.25) - 0.25).abs() < 1e-9);
        // 1× then 3×: the second half reads three times as much source.
        let ramp = SpeedCurve { name: String::new(), points: vec![[0.0, 1.0], [0.5, 1.0], [0.5001, 3.0], [1.0, 3.0]] }.clean().unwrap();
        assert!((ramp.mean() - 2.0).abs() < 0.01, "{}", ramp.mean());
        assert!((ramp.source_fraction(0.5) - 0.25).abs() < 0.01);
        assert!((ramp.at(0.75) - 3.0).abs() < 1e-9);
        assert!(SpeedCurve { name: String::new(), points: vec![] }.clean().is_none());
    }

    #[test]
    fn names_map_and_points_are_kept_in_range() {
        assert_eq!(xfade_name("Fade through black"), Some("fadeblack"));
        assert_eq!(xfade_name("Nope"), None);
        assert_eq!(EFFECTS.len(), 18);
        assert_eq!(clean_points(vec![[0.5, 2.0], [0.0, -1.0], [0.5, 0.3]]), Some(vec![[0.0, 0.0], [0.5, 1.0]]));
        assert_eq!(clean_points(vec![[0.5, 0.5]]), None);
        let anim: Anim = serde_json::from_str(r#"{ "in": { "name": "Fade", "durationUs": 300000 }, "loop": { "name": "Pulse" } }"#).unwrap();
        assert_eq!((anim.in_.as_ref().unwrap().duration_us, anim.loop_.as_ref().unwrap().period_us), (300_000, 1_000_000));
        assert_eq!(serde_json::to_value(&anim).unwrap()["in"]["durationUs"], 300_000);
    }
}
