//! One FFmpeg filter graph for the whole timeline, shared by preview playback, the
//! audio mix and export, so what plays is what exports.
//!
//! The main track is a row of segments joined by concat, or by xfade where a clip has a
//! transition in (`transitions`). Picture tracks over it are composited on top in track
//! order, and adjustment layers grade what's below them (`compose`). Each clip's sound is
//! mixed through its track's bus.

use crate::anim::{self, Moves};
use crate::compose::{self, Layer};
use crate::effects::{self, Frame};
use crate::{Ffmpeg, secs};
use std::path::Path;
use studio_engine_core::model::{Clip, Curves, Ease, Effects, Fit, Fx, HslMap, Lut, Master, Media, MediaKind, Project, Track, Us, Wheels};

#[derive(Debug, Clone, PartialEq)]
pub struct Seg {
    pub path: String,
    pub audio_path: String,
    pub kind: MediaKind,
    /// Where reading starts in the source, and how much is read: the segment's length on the
    /// timeline times its speed (for a still, its length).
    pub in_us: Us,
    pub span_us: Us,
    pub dur_us: Us,
    pub fit: Fit,
    pub sound: Sound,
    pub has_audio: bool,
    /// Crop, rotation and mirroring, as FFmpeg filters that run before the fit.
    pub picture: String,
    /// The source plays `speed` times as fast, and backwards when `reverse`.
    pub speed: f64,
    pub reverse: bool,
    /// Colour, size, rotation, position and opacity, after the fit.
    pub look: Look,
    /// A stretch of black: a gap on a main track without the magnet, or the tail after
    /// the last main clip while audio plays on.
    pub black: bool,
    /// Colour extras, effects, mask, matte, stabilising and a speed ramp.
    pub grade: Grade,
    /// Extra picture before and after the segment for transitions.
    pub head: Ext,
    pub tail: Ext,
    /// The transition from the segment before into this one: xfade's name and its length.
    pub xfade: Option<(String, Us)>,
}

/// Extra picture at one end of a segment, for a transition: `us` on the timeline, of which
/// `hold_us` holds the end frame and the rest is read from the source beyond the clip's
/// range (`src_us` of source time).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Ext {
    pub us: Us,
    pub src_us: Us,
    pub hold_us: Us,
}

/// What contract v2 adds to a clip's picture.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Grade {
    pub effects: Vec<Fx>,
    pub hsl: HslMap,
    pub curves: Curves,
    pub wheels: Wheels,
    pub lut: Option<Lut>,
    /// The mask the renderer drew at project size (white keeps).
    pub mask_png: Option<String>,
    /// A grey video of the source (white keeps), read over the same stretch as the picture.
    pub matte: Option<String>,
    /// The stabilising transforms for exactly what's read, and the strength (0–100).
    pub stab: Option<(String, f32)>,
    /// With the transforms: the clip's whole source range, which is read (the transforms count
    /// frames from its start), and how much of the clip's time to skip after them.
    pub stab_window: Option<(Us, Us)>,
    pub stab_skip_us: Us,
    /// Smooth slow motion (export only): "Fast" or "Best".
    pub smooth: Option<String>,
    /// A speed ramp: (seconds into what's read, seconds into the segment) points.
    pub ramp: Vec<(f64, f64)>,
    /// The animated blur: (clip time, sigma in project pixels), and the clip time at the
    /// segment's start in seconds.
    pub blur: anim::Track,
    pub blur_offset_s: f64,
}

impl Grade {
    pub(crate) fn of(c: &Clip) -> Self {
        Grade {
            effects: c.effects.clone(),
            hsl: c.hsl.clone(),
            curves: c.curves.clone(),
            wheels: c.wheels.clone(),
            lut: c.lut.clone(),
            mask_png: c.mask_png.clone().filter(|p| Path::new(p).is_file()),
            matte: c.matte.as_ref().map(|m| m.path.clone()).filter(|p| Path::new(p).is_file()),
            ..Default::default()
        }
    }

    /// The colour extras as filters.
    pub fn colour(&self, tag: &str) -> Vec<String> {
        effects::colour_extras(&self.hsl, &self.curves, &self.wheels, self.lut.as_ref(), tag)
    }

    /// The animated blur's filter, if the clip has one.
    pub fn blur_filter(&self, k: f64, tag: &str) -> Option<String> {
        anim::blur_filter(&self.blur, self.blur_offset_s, k, &format!("{tag}b"))
    }
}

impl Seg {
    fn black(dur_us: Us) -> Self {
        Seg { path: String::new(), audio_path: String::new(), kind: MediaKind::Video, in_us: 0, span_us: dur_us, dur_us, fit: Fit::Fill, sound: Sound::default(), has_audio: false, picture: String::new(), speed: 1.0, reverse: false, look: Look::default(), black: true, grade: Grade::default(), head: Ext::default(), tail: Ext::default(), xfade: None }
    }

    /// What the picture's input reads: the segment's own source range, widened by the
    /// source used for transitions at either end (reversed, the head comes from after it).
    pub fn picture_window(&self) -> (Us, Us) {
        if let Some(w) = self.grade.stab_window {
            return w;
        }
        let (before, after) = if self.reverse { (self.tail.src_us, self.head.src_us) } else { (self.head.src_us, self.tail.src_us) };
        (self.in_us - before, self.span_us + before + after)
    }

    /// The segment's picture length, with the extra picture for transitions.
    pub fn picture_us(&self) -> Us {
        self.dur_us + self.head.us + self.tail.us
    }
}

/// The source a clip shows from `skip` into it for `len` on the timeline: (in point, length).
/// Speed, direction and speed ramps count; a still reads its own length.
pub fn source_range(c: &Clip, skip: Us, len: Us, still: bool) -> (Us, Us) {
    if still {
        return (c.in_us + skip, len);
    }
    let (a, b) = (c.source_at(skip), c.source_at(skip + len));
    (a.min(b), (a - b).abs().max(1))
}

/// A setting over time: (seconds from the segment's start, value) points joined by straight
/// lines, flat before the first and after the last. One point is a fixed value; no points
/// leave the setting at its default.
pub type Curve = Vec<(f64, f64)>;

fn level(c: &Curve, default: f64) -> f64 {
    c.first().map_or(default, |p| p.1)
}

pub(crate) fn moving(c: &Curve) -> bool {
    c.windows(2).any(|w| w[0].1 != w[1].1)
}

/// A curve as an FFmpeg expression over `var` (seconds).
pub(crate) fn curve_expr(c: &Curve, var: &str) -> String {
    let mut e = format!("{:.4}", c.last().map_or(0.0, |p| p.1));
    for w in c.windows(2).rev() {
        let ((t0, v0), (t1, v1)) = (w[0], w[1]);
        let slope = if t1 > t0 { (v1 - v0) / (t1 - t0) } else { 0.0 };
        e = format!("if(lt({var},{t1:.4}),{v0:.4}+({slope:.6})*({var}-({t0:.4})),{e})");
    }
    match c.first() {
        Some(&(t0, v0)) => format!("if(lt({var},{t0:.4}),{v0:.4},{e})"),
        None => e,
    }
}

/// A looping animation: its name, period and the clip time at the segment's start (seconds).
#[derive(Debug, Clone, PartialEq)]
pub struct Loop {
    pub name: String,
    pub period_s: f64,
    pub offset_s: f64,
}

impl Loop {
    /// What it adds at clip time `t` (an expression over seconds): scale (multiplied),
    /// vertical offset in project pixels and rotation in degrees (added).
    fn terms(&self, t: &str, project_h: f64) -> (String, String, String) {
        let ph = format!("2*PI*({t})/{:.4}", self.period_s.max(0.1));
        match self.name.as_str() {
            "Pulse" => (format!("(1+0.06*sin({ph}))"), "0".into(), "0".into()),
            "Float" => ("1".into(), format!("({:.3}*sin({ph}))", 0.015 * project_h), "0".into()),
            "Wiggle" => ("1".into(), "0".into(), format!("(5*sin({ph}))")),
            "Spin" => ("1".into(), "0".into(), format!("(360*({t})/{:.4})", self.period_s.max(0.1))),
            _ => ("1".into(), "0".into(), "0".into()),
        }
    }

    /// Its values at one moment, for a paused frame.
    fn values(&self, project_h: f64) -> (f64, f64, f64) {
        let p = 2.0 * std::f64::consts::PI * self.offset_s / self.period_s.max(0.1);
        match self.name.as_str() {
            "Pulse" => (1.0 + 0.06 * p.sin(), 0.0, 0.0),
            "Float" => (1.0, 0.015 * project_h * p.sin(), 0.0),
            "Wiggle" => (1.0, 0.0, 5.0 * p.sin()),
            "Spin" => (1.0, 0.0, 360.0 * self.offset_s / self.period_s.max(0.1)),
            _ => (1.0, 0.0, 0.0),
        }
    }
}

/// What a clip does to its picture after the fit: its colour, then its size, rotation,
/// position and opacity. Brightness, contrast, saturation, scale, position, rotation and
/// opacity follow keyframes and animation presets; the other colour settings take their
/// value at the clip's start.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Look {
    pub brightness: Curve,
    pub contrast: Curve,
    pub saturation: Curve,
    pub temperature: f64,
    pub tint: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub sharpen: f64,
    pub vignette: f64,
    /// Percent of the fitted size.
    pub scale: Curve,
    /// Project pixels from the frame's centre.
    pub pos_x: Curve,
    pub pos_y: Curve,
    /// Degrees, clockwise.
    pub rotation: Curve,
    /// Percent.
    pub opacity: Curve,
    /// The project's size, which positions are measured in.
    pub project_w: u32,
    pub project_h: u32,
    /// A looping animation over the clip.
    pub loop_: Option<Loop>,
}

impl Look {
    /// A clip's look from `skip` into it, with keyframed and animated settings timed from
    /// there. `still` holds them at that moment (a single frame). A negative `skip` starts
    /// the segment before the clip (the picture a transition adds).
    pub fn of(c: &Clip, skip: Us, still: bool, project_w: u32, project_h: u32) -> Self {
        let moves = Moves::of(c, c.duration_us, project_w as f64, project_h as f64);
        // Clip-time points of a setting: its keyframes, or its value.
        let points = |name: &str, base: f32| -> anim::Track {
            match c.keyframes.get(name).filter(|k| !k.is_empty()) {
                Some(k) => eased_points(k),
                None => vec![(0, base as f64)],
            }
        };
        let to_curve = |pts: anim::Track, lo: f64, hi: f64| -> Curve {
            if still || pts.len() == 1 {
                return vec![(0.0, anim::at(&pts, skip, 0.0).clamp(lo, hi))];
            }
            pts.into_iter().map(|(t, v)| ((t - skip) as f64 / 1e6, v.clamp(lo, hi))).collect()
        };
        // An animation preset multiplies (opacity, scale) or adds to (position, rotation) the setting.
        let with = |name: &str, base: f32, extra: &anim::Track, mul: bool, lo: f64, hi: f64| -> Curve {
            let own = points(name, base);
            if extra.is_empty() {
                return to_curve(own, lo, hi);
            }
            let rest = if mul { 1.0 } else { 0.0 };
            to_curve(anim::combine(&own, extra, base as f64, rest, |a, b| if mul { a * b } else { a + b }), lo, hi)
        };
        let curve = |name: &str, base: f32, lo: f64, hi: f64| with(name, base, &vec![], false, lo, hi);
        let fixed = |name: &str, base: f32| c.value_at(name, 0, base as f64).clamp(-100.0, 100.0);
        let mut look = Look {
            brightness: curve("brightness", c.brightness, -100.0, 100.0),
            contrast: curve("contrast", c.contrast, -100.0, 100.0),
            saturation: curve("saturation", c.saturation, -100.0, 100.0),
            temperature: fixed("temperature", c.temperature),
            tint: fixed("tint", c.tint),
            highlights: fixed("highlights", c.highlights),
            shadows: fixed("shadows", c.shadows),
            sharpen: fixed("sharpen", c.sharpen),
            vignette: fixed("vignette", c.vignette),
            scale: with("scale", c.scale, &moves.scale, true, 0.0, 400.0),
            pos_x: with("posX", c.pos_x, &moves.dx, false, -100_000.0, 100_000.0),
            pos_y: with("posY", c.pos_y, &moves.dy, false, -100_000.0, 100_000.0),
            rotation: with("rotation", c.rotation, &moves.rotation, false, -36_000.0, 36_000.0),
            opacity: with("opacity", c.opacity, &moves.opacity, true, 0.0, 100.0),
            project_w,
            project_h,
            loop_: c.anim.loop_.as_ref().map(|l| Loop { name: l.name.clone(), period_s: l.period_us as f64 / 1e6, offset_s: skip as f64 / 1e6 }),
        };
        if !c.transform_on {
            // Bypassed: the values stay on the clip but the picture shows as fitted.
            (look.scale, look.pos_x, look.pos_y, look.rotation, look.opacity) = (vec![(0.0, 100.0)], vec![(0.0, 0.0)], vec![(0.0, 0.0)], vec![(0.0, 0.0)], vec![(0.0, 100.0)]);
            look.loop_ = None;
        }
        if still {
            // A paused frame holds the loop at its moment too.
            if let Some(l) = look.loop_.take() {
                let (s, dy, r) = l.values(project_h as f64);
                look.scale[0].1 *= s;
                look.pos_y[0].1 += dy;
                look.rotation[0].1 += r;
            }
        }
        look
    }

    pub(crate) fn animated(&self) -> bool {
        self.loop_.is_some() || [&self.brightness, &self.contrast, &self.saturation, &self.scale, &self.pos_x, &self.pos_y, &self.rotation, &self.opacity].into_iter().any(moving)
    }

    /// Size, rotation and position change over time.
    fn moves(&self) -> bool {
        self.loop_.is_some() || moving(&self.scale) || moving(&self.pos_x) || moving(&self.pos_y) || moving(&self.rotation)
    }
}

/// Keyframes as straight-line points: an eased stretch is sampled closely enough (twelve
/// steps) that straight lines between the samples follow its curve.
fn eased_points(k: &[studio_engine_core::model::Keyframe]) -> anim::Track {
    let mut out = vec![];
    for (i, p) in k.iter().enumerate() {
        out.push((p.at_us, p.value));
        if let Some(next) = k.get(i + 1).filter(|_| p.ease != Ease::Linear) {
            for s in 1..12 {
                let f = s as f64 / 12.0;
                out.push((p.at_us + ((next.at_us - p.at_us) as f64 * f).round() as Us, p.value + (next.value - p.value) * p.ease.apply(f)));
            }
        }
    }
    out
}

/// The colour settings as filters, in order: brightness, contrast and saturation (`eq`),
/// temperature and tint (`colorbalance`), highlights and shadows (`curves`), sharpen or
/// soften, vignette. Only what's off zero. `k` is the output's width over the project's,
/// so effects measured in pixels look the same in the half-size preview.
fn color_filters(l: &Look, k: f64) -> Vec<String> {
    color_filters_at(l, k, "t")
}

/// The same with keyframed values timed over `var` (an adjustment layer's colour runs on the
/// composite's clock, so its expressions count from where it starts).
pub(crate) fn color_filters_at(l: &Look, k: f64, var: &str) -> Vec<String> {
    let mut f = vec![];
    let (b, c, s) = (&l.brightness, &l.contrast, &l.saturation);
    let off = |x: &Curve| moving(x) || level(x, 0.0) != 0.0;
    if off(b) || off(c) || off(s) {
        // Brightness ±0.3, contrast 0.5–1.5, saturation 0 (grey) to 2.
        let term = |x: &Curve, base: f64, per: f64| if moving(x) { format!("'{base}+({})*{per}'", curve_expr(x, var)) } else { format!("{:.4}", base + level(x, 0.0) * per) };
        let eval = if moving(b) || moving(c) || moving(s) { ":eval=frame" } else { "" };
        f.push(format!("eq=brightness={}:contrast={}:saturation={}{eval}", term(b, 0.0, 0.003), term(c, 1.0, 0.005), term(s, 1.0, 0.01)));
    }
    if l.temperature != 0.0 || l.tint != 0.0 {
        // Warm is more red and less blue; a positive tint is magenta, so less green.
        let (warm, magenta) = (l.temperature / 100.0 * 0.3, l.tint / 100.0 * 0.3);
        f.push(format!("colorbalance=rm={:.4}:gm={:.4}:bm={:.4}:rh={:.4}:gh={:.4}:bh={:.4}:pl=1", warm, -magenta, -warm, warm / 2.0, -magenta / 2.0, -warm / 2.0));
    }
    if l.highlights != 0.0 || l.shadows != 0.0 {
        let (lo, hi) = (0.25 + l.shadows / 100.0 * 0.12, 0.75 + l.highlights / 100.0 * 0.12);
        f.push(format!("curves=m='0/0 0.25/{lo:.4} 0.75/{hi:.4} 1/1':interp=pchip"));
    }
    if l.sharpen > 0.0 {
        let size = (((5.0 * k).round() as i32) | 1).clamp(3, 13);
        f.push(format!("unsharp=lx={size}:ly={size}:la={:.3}", l.sharpen / 100.0 * 1.5));
    } else if l.sharpen < 0.0 {
        f.push(format!("gblur=sigma={:.3}", -l.sharpen / 100.0 * 4.0 * k));
    }
    if l.vignette != 0.0 {
        // Positive darkens the edges; negative (`backward`) lightens them.
        f.push(format!("vignette=a={:.4}{}", l.vignette.abs() / 100.0, if l.vignette < 0.0 { ":mode=backward" } else { "" }));
    }
    f
}

/// Opacity, as a fade of the picture itself towards black: luma to 16 + a(Y - 16) and colour
/// to grey, which is what overlaying it on black does, but cheap and able to follow keyframes.
fn opacity_filter(l: &Look) -> Option<String> {
    let o = &l.opacity;
    let black = 16.0 / 255.0 - 0.5;
    if moving(o) {
        let a = format!("clip(({})/100,0,1)", curve_expr(o, "t"));
        return Some(format!("format=yuv420p,eq=contrast='{a}':brightness='(1-{a})*({black:.5})':saturation='{a}':eval=frame"));
    }
    let a = (level(o, 100.0) / 100.0).clamp(0.0, 1.0);
    (a < 1.0).then(|| format!("format=yuv420p,eq=contrast={a:.4}:brightness={:.5}:saturation={a:.4}", (1.0 - a) * black))
}

/// Opacity on a picture with alpha (an overlay): its alpha scaled, following keyframes.
/// `tag` labels the split an animated opacity needs.
pub(crate) fn alpha_opacity(l: &Look, tag: &str) -> Option<String> {
    let o = &l.opacity;
    if moving(o) {
        // On the alpha alone as a grey picture, where eq's contrast and brightness scale it.
        let a = format!("clip(({})/100,0,1)", curve_expr(o, "t"));
        return Some(format!("format=rgba,split[{tag}oa][{tag}ob];[{tag}ob]alphaextract,eq=contrast='{a}':brightness='({a}-1)/2':eval=frame[{tag}oc];[{tag}oa][{tag}oc]alphamerge"));
    }
    let a = (level(o, 100.0) / 100.0).clamp(0.0, 1.0);
    (a < 1.0).then(|| format!("format=rgba,colorchannelmixer=aa={a:.4}"))
}

/// Where the fitted picture goes in the frame.
pub(crate) enum Place {
    /// As fitted.
    Frame,
    /// Still covering the frame (a punch-in): the part that shows, scaled up. No overlay.
    Crop(String),
    /// Over black: the picture's own chain, and the overlay's position expressions.
    Over { fg: Vec<String>, x: String, y: String, eval: &'static str },
}

fn placement(l: &Look, w: u32, h: u32, over: bool) -> Place {
    placement_at(l, w, h, over, "t")
}

/// Where the picture goes, with its position expressions over `var` (the overlay filter's
/// clock). `over` always places it over something (it has alpha, or it is an overlay).
pub(crate) fn placement_at(l: &Look, w: u32, h: u32, over: bool, var: &str) -> Place {
    let (kx, ky) = (w as f64 / l.project_w.max(1) as f64, h as f64 / l.project_h.max(1) as f64);
    let (s, px, py, rot) = (level(&l.scale, 100.0) / 100.0, level(&l.pos_x, 0.0) * kx, level(&l.pos_y, 0.0) * ky, level(&l.rotation, 0.0));
    let animated = l.moves();
    let (fw, fh) = (w as f64, h as f64);
    if !animated && rot % 360.0 == 0.0 && !over {
        if s == 1.0 && px == 0.0 && py == 0.0 {
            return Place::Frame;
        }
        let (x0, y0) = (fw / 2.0 + px - fw * s / 2.0, fh / 2.0 + py - fh * s / 2.0);
        if s >= 1.0 && x0 <= 0.0 && y0 <= 0.0 && x0 + fw * s >= fw && y0 + fh * s >= fh {
            let (cw, ch) = (fw / s, fh / s);
            let (cx, cy) = ((-x0 / s).clamp(0.0, fw - cw), (-y0 / s).clamp(0.0, fh - ch));
            return Place::Crop(format!("crop={cw:.3}:{ch:.3}:{cx:.3}:{cy:.3},scale={w}:{h}"));
        }
    }
    // A loop adds to the scale, height and rotation on the clip's own clock.
    let (lscale, ldy, lrot) = match &l.loop_ {
        Some(lp) => lp.terms(&format!("t+{:.4}", lp.offset_s), l.project_h as f64),
        None => ("1".into(), "0".into(), "0".into()),
    };
    let looped = l.loop_.is_some();
    // With alpha, so what rotation uncovers is see-through.
    let mut fg = vec!["format=yuva420p".to_string()];
    if moving(&l.rotation) || looped && lrot != "0" {
        let e = if looped && lrot != "0" { format!("{}+{lrot}", curve_expr(&l.rotation, "t")) } else { curve_expr(&l.rotation, "t") };
        fg.push(turn_moving(&e));
    } else {
        fg.extend(turn_fixed(rot));
    }
    if moving(&l.scale) || looped && lscale != "1" {
        let e = if looped && lscale != "1" { format!("({})*{lscale}", curve_expr(&l.scale, "t")) } else { curve_expr(&l.scale, "t") };
        fg.push(size_moving(&e));
    } else {
        fg.extend(size_fixed(s));
    }
    let at = |c: &Curve, k: f64| if moving(c) { format!("({})*{k:.6}", curve_expr(c, var)) } else { format!("({:.3})", level(c, 0.0) * k) };
    let ly = match &l.loop_ {
        Some(lp) if ldy != "0" => format!("+({})*{ky:.6}", lp.terms(&format!("{var}+{:.4}", lp.offset_s), l.project_h as f64).1),
        _ => String::new(),
    };
    Place::Over { fg, x: format!("(W-w)/2+{}", at(&l.pos_x, kx)), y: format!("(H-h)/2+{}{ly}", at(&l.pos_y, ky)), eval: if animated { "frame" } else { "init" } }
}

/// A turn of `deg` degrees on a canvas that just holds it; none for whole turns.
pub(crate) fn turn_fixed(deg: f64) -> Option<String> {
    let a = deg.to_radians();
    (deg % 360.0 != 0.0).then(|| format!("rotate=a={a:.6}:ow='rotw({a:.6})':oh='roth({a:.6})':c=none"))
}

/// A turn following `deg` (an expression in degrees), on a canvas that holds it at any angle.
pub(crate) fn turn_moving(deg: &str) -> String {
    format!("rotate=a='({deg})*PI/180':ow='hypot(iw,ih)':oh=ow:c=none")
}

/// A size of `s` times the fitted one; none at 1.
pub(crate) fn size_fixed(s: f64) -> Option<String> {
    (s != 1.0).then(|| format!("scale=w='max(2,trunc(iw*{s:.6}/2)*2)':h='max(2,trunc(ih*{s:.6}/2)*2)'"))
}

/// A size following `pct` (an expression in percent of the fitted size), every frame.
/// Bilinear: a size that changes sets the scaler up again on every frame, and bicubic's set-up
/// costs three times as much (and can't be told apart while it moves).
pub(crate) fn size_moving(pct: &str) -> String {
    format!("scale=w='max(2,trunc(iw*({pct})/200)*2)':h='max(2,trunc(ih*({pct})/200)*2)':eval=frame:flags=bilinear")
}

/// A curve's value at `t` seconds: straight between its points, held before the first and
/// after the last.
pub(crate) fn curve_at(c: &Curve, t: f64, default: f64) -> f64 {
    let Some(&(t0, v0)) = c.first() else { return default };
    if t <= t0 {
        return v0;
    }
    for w in c.windows(2) {
        let ((a, va), (b, vb)) = (w[0], w[1]);
        if t <= b {
            return if b > a { va + (vb - va) * (t - a) / (b - a) } else { vb };
        }
    }
    c.last().map_or(default, |p| p.1)
}

/// Extra inputs a main-track segment reads besides its picture.
#[derive(Default)]
struct SegInputs {
    mask: Option<usize>,
    matte: Option<usize>,
}

/// The filters that give a decoded source the segment's timing: its speed (or speed ramp),
/// smooth slow motion, direction, then the frames held for transitions. Shared by the picture
/// and its matte. `zero` restarts the clock at 0 even at normal speed.
pub(crate) fn timing(seg_speed: f64, reverse: bool, g: &Grade, head_hold: Us, tail_hold: Us, fps: u32, zero: bool) -> Vec<String> {
    let mut f = vec![];
    if !g.ramp.is_empty() {
        // A ramp maps each source frame's time to its time on the timeline. Backwards, the
        // source is reversed first, so the same map applies.
        if reverse {
            f.push(format!("fps={fps},reverse"));
        }
        f.push("setpts=PTS-STARTPTS".into());
        f.push(format!("setpts='({})/TB'", curve_expr(&g.ramp, "(T-STARTT)")));
    } else {
        if seg_speed != 1.0 {
            f.push(format!("setpts=(PTS-STARTPTS)/{seg_speed:.6}"));
        } else if zero {
            f.push("setpts=PTS-STARTPTS".into());
        }
        match g.smooth.as_deref() {
            Some("Best") if seg_speed < 1.0 => f.push(format!("minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1")),
            Some(_) if seg_speed < 1.0 => f.push(format!("framerate=fps={fps}")),
            _ => {}
        }
        if reverse {
            // `reverse` holds every frame of the segment in memory, which is fine for ad-length
            // clips; the fps filter first keeps that to the project's frame rate.
            f.push(format!("fps={fps},reverse"));
        }
    }
    if g.stab_skip_us > 0 {
        // Stabilised from the clip's start: on to where the segment starts.
        f.push(format!("trim=start={},setpts=PTS-STARTPTS", secs(g.stab_skip_us)));
    }
    if head_hold > 0 || tail_hold > 0 {
        f.push(format!("tpad=start_mode=clone:start_duration={}:stop_mode=clone:stop_duration={}", secs(head_hold), secs(tail_hold)));
    }
    f
}

/// Stabilising, as the first filter on the source (before the crop and the fit).
pub(crate) fn stab_filter(g: &Grade) -> String {
    match &g.stab {
        // Strength 100 smooths the camera path over about a second either side.
        Some((trf, strength)) => format!("vidstabtransform=input={}:smoothing={}:optzoom=1:interpol=bilinear,", effects::filter_path(trf), (1.0 + *strength as f64 * 0.3).round() as i64),
        None => String::new(),
    }
}

/// One main-track segment's picture, from input `input` to `[v{n}]`: crop and quarter turns,
/// the fit, speed and direction, colour, opacity, then size, rotation and position, then
/// effects. A clip with the default look keeps the plain chain, with no overlay.
fn seg_video(seg: &Seg, input: usize, n: usize, v: &VideoOut, extra: &SegInputs) -> Vec<String> {
    let (w, h, fps) = (v.width, v.height, v.fps);
    let l = &seg.look;
    let g = &seg.grade;
    let k = w as f64 / l.project_w.max(1) as f64;
    let alpha = extra.mask.is_some() || extra.matte.is_some();
    let place = placement(l, w, h, alpha);
    let mut look = color_filters(l, k);
    look.extend(g.colour(&format!("s{n}")));
    look.extend(g.blur_filter(k, &format!("s{n}")));
    look.extend(opacity_filter(l));
    // Fitted with bars, the look is the picture's: the bars go on after it, still black.
    let (fit, bars) = match seg.fit {
        Fit::Fit if !look.is_empty() => (format!("scale={w}:{h}:force_original_aspect_ratio=decrease"), Some(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"))),
        _ => (fit_filter(seg.fit, w, h), None),
    };
    let mut f = vec![format!("{}{}{fit}", stab_filter(g), seg.picture)];
    // Keyframes and the overlay run on the segment's own time, from 0.
    // Transitions too: xfade counts its offset from 0.
    let zero = l.animated() || matches!(place, Place::Over { .. }) || seg.xfade.is_some() || seg.tail.us > 0;
    f.extend(timing(seg.speed, seg.reverse, g, seg.head.hold_us, seg.tail.hold_us, fps, zero));
    f.extend(look);
    f.extend(bars);
    let total = seg.picture_us();
    let fx = effects::effect_chain(&g.effects, &Frame { w, h, fps, k, alpha: false, dur: total as f64 / 1e6 }, &format!("s{n}"));
    let fx = if fx.is_empty() { String::new() } else { format!("{},", fx.join(",")) };
    // Effects after the fps filter: one that mixes two copies (glow, edges) makes frames
    // without a duration, and fps would drop the last of them.
    let tail = format!("setsar=1,fps={fps},{fx}format={},trim=duration={}", v.pix_fmt, secs(total));
    let mut out = vec![];
    let head = if alpha {
        // A matte (the source's own grey video, timed like the picture) and a mask (the drawn
        // shape) become the picture's alpha; it then goes over black like a smaller picture.
        let mut sources = vec![];
        if let Some(mi) = extra.matte {
            let mut m = vec![format!("{}{}{}", stab_filter(g), seg.picture, fit_filter(seg.fit, w, h))];
            m.extend(timing(seg.speed, seg.reverse, g, seg.head.hold_us, seg.tail.hold_us, fps, true));
            out.push(format!("[{mi}:v]{},format=gray[mt{n}]", m.join(",")));
            sources.push(format!("[mt{n}]"));
        }
        if let Some(ki) = extra.mask {
            out.push(mask_chain(ki, w, h, &format!("mk{n}")));
            sources.push(format!("[mk{n}]"));
        }
        let al = if sources.len() == 2 {
            out.push(format!("{}blend=all_mode=multiply[al{n}]", sources.concat()));
            format!("[al{n}]")
        } else {
            sources.concat()
        };
        out.push(format!("[{input}:v]{},format=rgba[pa{n}]", f.join(",")));
        format!("[pa{n}]{al}alphamerge,")
    } else {
        format!("[{input}:v]{},", f.join(","))
    };
    match place {
        Place::Frame => out.push(format!("{head}{tail}[v{n}]")),
        Place::Crop(crop) => out.push(format!("{head}{crop},{tail}[v{n}]")),
        Place::Over { fg, x, y, eval } => {
            // The black frame already runs at the project's rate, and an fps filter after the
            // overlay would drop its last frame (overlay's frames carry no duration).
            out.push(format!("color=c=black:s={w}x{h}:r={fps}:d={}[bg{n}]", secs(total)));
            out.push(format!("{head}{}[fg{n}]", fg.join(",")));
            out.push(format!("[bg{n}][fg{n}]overlay=x='{x}':y='{y}':eval={eval},{fx}setsar=1,format={},trim=duration={}[v{n}]", v.pix_fmt, secs(total)));
        }
    }
    out
}

/// A drawn mask (input `input`) as a grey picture the size of the frame: its brightness
/// times its alpha, so white on transparent and white on black both work. One frame, which
/// `alphamerge` and `blend` repeat.
pub(crate) fn mask_chain(input: usize, w: u32, h: u32, label: &str) -> String {
    format!("[{input}:v]scale={w}:{h},format=rgba,split[{label}a][{label}b];[{label}a]alphaextract[{label}c];[{label}b]format=gray[{label}d];[{label}c][{label}d]blend=all_mode=multiply[{label}]")
}

/// A clip's own sound settings, as its audio chain applies them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sound {
    pub volume: f32,
    /// How much of the clip's start was skipped (playing from the middle): fades and the
    /// envelope stay where they are on the clip.
    pub skip_us: Us,
    /// The clip's full length and its in point in the source, for the fades and envelope.
    pub clip_us: Us,
    pub source_in_us: Us,
    pub fade_in_us: Us,
    pub fade_out_us: Us,
    pub fade_curve: String,
    pub pitch: f32,
    pub declick: bool,
    /// (source time, gain) points.
    pub envelope: Vec<(Us, f32)>,
    /// Tempo and direction; with `keep_pitch` off the pitch follows the speed.
    pub speed: f64,
    pub reverse: bool,
    pub keep_pitch: bool,
    /// Bands taken out: (source start, source end, low Hz, high Hz).
    pub spectral: Vec<(Us, Us, f32, f32)>,
}

impl Sound {
    fn of(c: &Clip, skip_us: Us) -> Self {
        Sound {
            speed: c.speed,
            reverse: c.reverse,
            keep_pitch: c.keep_pitch,
            volume: c.volume,
            skip_us,
            clip_us: c.duration_us,
            source_in_us: c.in_us,
            fade_in_us: c.fade_in_us,
            fade_out_us: c.fade_out_us,
            fade_curve: c.fade_curve.clone(),
            pitch: c.pitch,
            declick: c.declick,
            envelope: c.envelope.iter().map(|p| (p.at_us, p.gain)).collect(),
            spectral: c.spectral.iter().map(|s| (s.start_us, s.end_us, s.low_hz, s.high_hz)).collect(),
        }
    }
}

/// A clip's crop, rotation and mirrors as a filter chain ending in "," (empty if none).
pub fn picture_filter(c: &Clip) -> String {
    let mut f = String::new();
    if let Some(k) = c.crop {
        f.push_str(&format!("crop=iw*{:.5}:ih*{:.5}:iw*{:.5}:ih*{:.5},", k.w, k.h, k.x, k.y));
    }
    f.push_str(match c.rotate {
        90 => "transpose=1,",
        180 => "hflip,vflip,",
        270 => "transpose=2,",
        _ => "",
    });
    if c.flip {
        f.push_str("hflip,");
    }
    if c.flip_v {
        f.push_str("vflip,");
    }
    f
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioClip {
    pub path: String,
    pub start_us: Us,
    /// Where reading starts in the source and how much is read (its length times its speed).
    pub in_us: Us,
    pub span_us: Us,
    pub dur_us: Us,
    pub sound: Sound,
    /// Which of the timeline's buses (its track) it plays through.
    pub bus: usize,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Timeline {
    pub main: Vec<Seg>,
    /// Picture tracks over the main one, bottom first.
    pub layers: Vec<Layer>,
    pub audio: Vec<AudioClip>,
    pub total_us: Us,
    /// Built from before the asked-for start (which falls inside a transition) and trimmed
    /// off again, so the transition is the same from wherever playback starts.
    pub lead_us: Us,
    /// One bus per track, in the project's track order: the track's effects, fader and
    /// balance as a filter chain (empty when it leaves the sound as it is).
    pub buses: Vec<String>,
    /// The main track's bus.
    pub main_bus: usize,
    /// Gain on the whole mix (heard everywhere), and the master stage export adds.
    pub master_gain_db: f32,
    pub export_tail: String,
}

fn usable(path: &Option<String>) -> Option<String> {
    path.as_ref().filter(|p| Path::new(p).is_file()).cloned()
}

/// Where the stabilising transforms for one stretch of a file are kept: per clip range, and
/// per file read (the proxy in preview, the original on export), since vidstab's transforms
/// are counted in frames from where reading starts.
pub fn stab_path(cache: &Path, media_id: &str, in_us: Us, span_us: Us, proxy: bool) -> std::path::PathBuf {
    cache.join(media_id).join(format!("stab-{in_us}-{span_us}-{}.trf", if proxy { "p" } else { "o" }))
}

/// One stabilising analysis a timeline needs: read `span_us` of `path` from `in_us` and write
/// the transforms to `trf`.
#[derive(Debug, Clone, PartialEq)]
pub struct StabJob {
    pub path: String,
    pub in_us: Us,
    pub span_us: Us,
    pub trf: String,
}

/// The file a picture is read from: the proxy in preview when there is one (not for files
/// that may carry alpha, which the proxy would lose), else the original.
fn picture_path(m: &Media, use_proxy: bool, overlay: bool) -> String {
    let alpha_kind = overlay && (matches!(m.codec.as_deref(), Some("vp8" | "vp9" | "gif" | "png" | "qtrle" | "prores")) || [".webm", ".gif", ".mov", ".png"].iter().any(|e| m.path.to_ascii_lowercase().ends_with(e)));
    if use_proxy && !alpha_kind { usable(&m.proxy).unwrap_or_else(|| m.path.clone()) } else { m.path.clone() }
}

/// The stabilising transforms for a clip read from `path` (made over its whole source range),
/// if the clip is stabilised and the project has a cache: (the transforms' file, whether it's
/// there).
fn stab_for(p: &Project, c: &Clip, m: &Media, path: &str) -> Option<(String, bool)> {
    let s = c.stabilize.as_ref()?;
    let cache = p.cache_dir.as_ref()?;
    if m.kind != MediaKind::Video || s.strength <= 0.0 {
        return None;
    }
    let (in_us, span_us) = source_range(c, 0, c.duration_us, false);
    let trf = stab_path(Path::new(cache), &m.id, in_us, span_us, Some(path) == m.proxy.as_deref() && path != m.path);
    let ready = trf.is_file();
    Some((trf.to_string_lossy().into_owned(), ready))
}

/// An overlay's picture file (see `picture_path`).
pub(crate) fn overlay_path(m: &Media, use_proxy: bool) -> String {
    picture_path(m, use_proxy, true)
}

/// A clip's stabilising transforms and strength, if they're ready for what's read.
pub(crate) fn ready_stab(p: &Project, c: &Clip, m: &Media, path: &str) -> Option<(String, f32)> {
    stab_for(p, c, m, path).filter(|s| s.1).map(|s| (s.0, c.stabilize.as_ref().map_or(0.0, |x| x.strength)))
}

/// A stabilised clip shown from `skip`: it reads its whole source range and trims after the
/// transforms, its speed ramp mapped over the whole clip too.
pub(crate) fn stab_from_start(g: &mut Grade, c: &Clip, skip: Us) {
    g.stab_window = Some(source_range(c, 0, c.duration_us, false));
    g.stab_skip_us = skip;
    if c.speed_curve.is_some() {
        g.ramp = ramp_map(c, 0, c.duration_us);
    }
}

/// A clip's speed ramp as a time map (see `ramp_map`).
pub(crate) fn ramp_for(c: &Clip, skip: Us, len: Us) -> Vec<(f64, f64)> {
    ramp_map(c, skip, len)
}

/// The speed ramp as a time map for reading `len` of the clip from `skip`: (seconds into what's
/// read, seconds into the segment), sampled closely enough that straight lines between the
/// points follow the curve.
fn ramp_map(c: &Clip, skip: Us, len: Us) -> Vec<(f64, f64)> {
    let Some(curve) = &c.speed_curve else { return vec![] };
    let (d, span) = (c.duration_us.max(1) as f64, c.span_us() as f64);
    let s = |tau: Us| span * curve.source_fraction(tau as f64 / d);
    let s0 = s(skip);
    (0..=48).map(|k| skip + len * k / 48).map(|tau| ((s(tau) - s0) / 1e6, (tau - skip) as f64 / 1e6)).collect()
}

/// The part of the project from `from_us` to the end. `use_proxy` swaps in proxies
/// for picture (sound always comes from the original). Muted tracks (and, while any
/// track is soloed, the others) leave no sound in it.
pub fn timeline_from(p: &Project, from_us: Us, use_proxy: bool) -> Timeline {
    timeline_window(p, from_us, p.duration_us(), use_proxy, false)
}

/// The whole project for export: the originals, and smooth slow motion.
pub fn timeline_export(p: &Project) -> Timeline {
    timeline_window(p, 0, p.duration_us(), false, true)
}

/// The project between `from_us` and `to_us`: the main track's segments (with the extra
/// picture its transitions need), the picture tracks over it and every clip's sound. Hidden
/// picture tracks are left out (a hidden main track plays black, its sound still heard).
/// Starting or ending inside a transition widens the window to it; the start is trimmed
/// back off (`lead_us`).
pub fn timeline_window(p: &Project, from_us: Us, to_us: Us, use_proxy: bool, export: bool) -> Timeline {
    let main_track = p.main_track();
    let clips = &main_track.clips;
    let cuts = crate::transitions::cuts(p);
    let (mut from, mut to) = (from_us, to_us.max(from_us));
    for &(i, _, d) in &cuts {
        let cut = clips[i].start_us;
        let (a, b) = (cut - d / 2, cut + (d - d / 2));
        if from_us > a && from_us < b {
            from = a;
        }
        if to_us > a && to_us < b {
            to = b;
        }
    }
    let mut main: Vec<Seg> = vec![];
    // Which clip each segment shows, to link transitions to the segment before.
    let mut shown: Vec<Option<usize>> = vec![];
    let mut at = from;
    let main_heard = p.audible(main_track);
    for (i, c) in clips.iter().enumerate() {
        if c.end_us() <= from || c.start_us >= to {
            continue;
        }
        let Some(m) = p.media(&c.media_id) else { continue };
        let start = c.start_us.max(from);
        if start > at {
            main.push(Seg::black(start - at));
            shown.push(None);
        }
        let skip = start - c.start_us;
        let end = c.end_us().min(to);
        let dur = end - start;
        let still = m.kind == MediaKind::Image;
        let (in_us, span_us) = source_range(c, skip, dur, still);
        let (speed, reverse) = if still { (1.0, false) } else { (c.speed, c.reverse) };
        // The transition into this clip, if the segment before shows the clip before it.
        let xin = cuts.iter().find(|x| x.0 == i).filter(|_| skip == 0 && shown.last() == Some(&Some(i.wrapping_sub(1)))).map(|&(_, name, d)| (name.to_string(), d));
        // And out of it, if the next clip is in the window.
        let xout = cuts.iter().find(|x| x.0 == i + 1).filter(|_| end == c.end_us() && clips[i + 1].start_us < to).map(|&(_, _, d)| d);
        let mut grade = Grade::of(c);
        let path = if use_proxy { usable(&m.proxy).unwrap_or_else(|| m.path.clone()) } else { m.path.clone() };
        let stab = if still { None } else { stab_for(p, c, m, &path) };
        let fixed_source = stab.is_some() || c.speed_curve.is_some();
        let ext = |want: Us, head: bool| -> Ext {
            if want <= 0 {
                return Ext::default();
            }
            if still {
                return Ext { us: want, src_us: want, hold_us: 0 };
            }
            // Source beyond the clip's range: before it for the head (after it when reversed).
            let before = head != reverse;
            let room = if fixed_source { 0 } else if before { c.in_us } else { (m.duration_us - c.in_us - c.span_us()).max(0) };
            let src = ((want as f64 * speed).round() as Us).min(room).max(0);
            Ext { us: want, src_us: src, hold_us: (want - (src as f64 / speed).round() as Us).max(0) }
        };
        let (head, tail) = (ext(xin.as_ref().map_or(0, |x| x.1 / 2), true), ext(xout.map_or(0, |d| d - d / 2), false));
        grade.stab = stab.filter(|s| s.1).map(|s| (s.0, c.stabilize.as_ref().map_or(0.0, |x| x.strength)));
        grade.smooth = if export { c.smooth.as_ref().map(|s| s.quality.clone()) } else { None };
        grade.ramp = ramp_map(c, skip, dur);
        if grade.stab.is_some() {
            stab_from_start(&mut grade, c, skip);
        }
        grade.blur = Moves::of(c, c.duration_us, p.width as f64, p.height as f64).blur;
        grade.blur_offset_s = (skip - head.us) as f64 / 1e6;
        let seg = Seg {
            path,
            audio_path: m.path.clone(),
            kind: m.kind,
            in_us,
            span_us,
            dur_us: dur,
            fit: c.fit,
            sound: Sound::of(c, skip),
            // A speed ramp plays silent, as in CapCut.
            has_audio: m.has_audio && !c.detached && main_heard && c.speed_curve.is_none(),
            picture: picture_filter(c),
            speed,
            reverse,
            look: Look::of(c, skip - head.us, false, p.width, p.height),
            black: false,
            grade,
            head,
            tail,
            xfade: xin,
        };
        main.push(if main_track.hidden { Seg { black: true, head: Ext::default(), tail: Ext::default(), xfade: None, ..seg } } else { seg });
        shown.push(Some(i));
        at = end;
    }
    let total = p.duration_us().min(to).max(from);
    if !main.is_empty() && total > at {
        main.push(Seg::black(total - at));
    }
    let layers = compose::layers_in(p, from, to, use_proxy);
    let mut audio = vec![];
    for (bus, t) in p.tracks.iter().enumerate().filter(|(_, t)| !t.main && p.audible(t)) {
        for c in &t.clips {
            if c.end_us() <= from || c.start_us >= to {
                continue;
            }
            // Pictures, text, adjustment layers and speed ramps have no sound to mix.
            let Some(m) = p.media(&c.media_id).filter(|m| m.has_audio && m.kind != MediaKind::Image) else { continue };
            if c.detached || c.speed_curve.is_some() {
                continue;
            }
            let skip = (from - c.start_us).max(0);
            let len = c.end_us().min(to) - c.start_us - skip;
            let (in_us, span_us) = source_range(c, skip, len, false);
            audio.push(AudioClip { path: m.path.clone(), start_us: (c.start_us - from).max(0), in_us, span_us, dur_us: len, sound: Sound::of(c, skip), bus });
        }
    }
    Timeline {
        main,
        layers,
        audio,
        total_us: (total - from).max(0),
        lead_us: from_us - from,
        buses: p.tracks.iter().map(track_filter).collect(),
        main_bus: p.tracks.iter().position(|t| t.main).unwrap_or(0),
        master_gain_db: p.master.gain_db,
        export_tail: master_filter(&p.master),
    }
}

/// The stabilising analyses a project still needs before it can play (`proxy`) or export
/// stabilised, one per clip range and file.
pub fn stab_jobs(p: &Project, use_proxy: bool) -> Vec<StabJob> {
    let mut jobs = vec![];
    for t in p.tracks.iter().filter(|t| t.kind == studio_engine_core::model::TrackKind::Video) {
        for c in &t.clips {
            let Some(m) = p.media(&c.media_id) else { continue };
            let path = if t.main { if use_proxy { usable(&m.proxy).unwrap_or_else(|| m.path.clone()) } else { m.path.clone() } } else { picture_path(m, use_proxy, true) };
            let (in_us, span_us) = source_range(c, 0, c.duration_us, false);
            if let Some((trf, false)) = stab_for(p, c, m, &path) {
                jobs.push(StabJob { path, in_us, span_us, trf });
            }
        }
    }
    jobs.dedup();
    jobs
}

/// True when the picture at `t` is the main track's clip alone, as `still_at` renders it: no
/// picture track shows anything there and no transition is under way.
pub fn plain_at(p: &Project, t: Us) -> bool {
    let busy = p.tracks.iter().any(|tr| tr.is_visual() && !tr.hidden && tr.clips.iter().any(|c| t >= c.start_us && t < c.end_us()));
    let clips = &p.main_track().clips;
    let mixing = crate::transitions::cuts(p).iter().any(|&(i, _, d)| (t - clips[i].start_us).abs() < d / 2 + 1);
    // A clip with effects or an animation is drawn on its own clock, like playback.
    let clip = clips.iter().find(|c| t >= c.start_us && t < c.end_us());
    let own_clock = clip.is_some_and(|c| !c.effects.is_empty() || !c.anim.is_empty() || c.mask_png.is_some() || c.matte.is_some() || c.speed_curve.is_some() || c.stabilize.is_some());
    !busy && !mixing && !own_clock && !p.main_track().hidden
}

/// Where a stretch of playback from `from` can hand over to the next FFmpeg run: the first
/// frame (counted from `from`, `frame_us` apart) at least `min_us` on where cutting the
/// picture in two changes nothing. That is never inside a transition, nor inside a clip drawn
/// on its own clock (effects that move, animations, masks and mattes, speed ramps,
/// stabilising), whose clock the next run would start again. The project's end when there is
/// no such frame, so the stretch runs to the end.
pub fn window_end(p: &Project, from: Us, min_us: Us, frame_us: Us) -> Us {
    let total = p.duration_us();
    let frame_us = frame_us.max(1);
    let clips = &p.main_track().clips;
    // Not on a transition's first frame, and two frames past its end: cut off one frame after
    // it, xfade drops that frame.
    let mut busy: Vec<(Us, Us)> = crate::transitions::cuts(p).iter().map(|&(i, _, d)| (clips[i].start_us - d / 2 - 1, clips[i].start_us + (d - d / 2) + 2 * frame_us)).collect();
    for t in p.tracks.iter().filter(|t| (t.main || t.is_visual()) && !t.hidden) {
        let own_clock = |c: &&Clip| c.effects.iter().any(|e| compose::moves_in_time(&e.name)) || !c.anim.is_empty() || c.mask_png.is_some() || c.matte.is_some() || c.speed_curve.is_some() || c.stabilize.is_some();
        busy.extend(t.clips.iter().filter(own_clock).map(|c| (c.start_us, c.end_us())));
    }
    let mut end = from + min_us.max(frame_us);
    loop {
        end = from + (end - from + frame_us - 1) / frame_us * frame_us;
        if end >= total {
            return total;
        }
        match busy.iter().filter(|&&(a, b)| a < end && end < b).map(|&(_, b)| b).max() {
            Some(b) => end = b,
            None => return end,
        }
    }
}

/// The picture for playing from `from` to `end` (a `window_end`) in preview: two frames more
/// than it shows, so nothing that ends with the graph (a moving overlay's last frame, the
/// frame after a transition) is cut short where the next run takes over. Playback reads only
/// up to `end`.
pub fn timeline_stretch(p: &Project, from: Us, end: Us, frame_us: Us) -> Timeline {
    timeline_window(p, from, (end + 2 * frame_us).min(p.duration_us()).max(end), true, false)
}

/// The main-track picture at timeline time `t` as a one-frame segment: the source frame shown
/// there, with the clip's look at that moment. `None` where there's no picture.
pub fn still_at(p: &Project, t: Us, use_proxy: bool) -> Option<Seg> {
    let clips = &p.main_track().clips;
    let c = clips.iter().find(|c| t >= c.start_us && t < c.end_us()).or_else(|| clips.last().filter(|c| t >= c.end_us()))?;
    let m = p.media(&c.media_id)?;
    let offset = (t - c.start_us).clamp(0, (c.duration_us - 1).max(0));
    let frame = 1_000_000 / p.fps.max(1) as Us;
    let still = m.kind == MediaKind::Image;
    // The frame on screen at that moment, kept inside the clip's source range (reversed, its
    // first frame is the one just before the range's end).
    let at = if still { 0 } else { c.source_at(offset).clamp(c.in_us, (c.in_us + c.span_us() - frame).max(c.in_us)) };
    let path = if use_proxy { usable(&m.proxy).unwrap_or_else(|| m.path.clone()) } else { m.path.clone() };
    Some(Seg {
        path,
        audio_path: m.path.clone(),
        kind: m.kind,
        in_us: at,
        // Read a little more than it shows, so a source with fewer frames a second still has one.
        span_us: (2 * frame).max(500_000),
        dur_us: 2 * frame,
        fit: c.fit,
        sound: Sound::default(),
        has_audio: false,
        picture: picture_filter(c),
        speed: 1.0,
        reverse: false,
        look: Look::of(c, offset, true, p.width, p.height),
        black: false,
        grade: Grade::of(c),
        head: Ext::default(),
        tail: Ext::default(),
        xfade: None,
    })
}
fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// A track's effects chain as FFmpeg filters, in order: noise reduction, voice EQ,
/// compressor, de-esser, limiter. Empty when every effect is off.
pub fn effects_filter(e: &Effects) -> Vec<String> {
    let mut f = vec![];
    if e.noise.on && e.noise.reduction_db > 0.0 {
        // Sensitivity moves the noise floor up: at 6 it sits near afftdn's own −50 dB.
        let floor = (-60.0 + e.noise.sensitivity * 1.5).clamp(-80.0, -20.0);
        f.push(format!("afftdn=nr={:.1}:nf={floor:.1}:tn=1", e.noise.reduction_db.max(0.01)));
    }
    if e.eq.on {
        f.push(format!("highpass=f={:.0}", e.eq.highpass_hz));
        if e.eq.presence_db > 0.0 {
            f.push(format!("equalizer=f=4000:t=q:w=1:g={:.1}", e.eq.presence_db));
        }
    }
    if e.comp.on {
        let threshold = db_to_lin(e.comp.threshold_db).clamp(0.000_976_563, 1.0);
        f.push(format!("acompressor=threshold={threshold:.6}:ratio={:.2}:attack={:.0}:release={:.0}", e.comp.ratio, e.comp.attack_ms, e.comp.release_ms));
    }
    if e.deess.on && e.deess.amount_db > 0.0 {
        f.push(format!("deesser=i={:.3}:m=0.5:f=0.5:s=o", (e.deess.amount_db / 12.0).clamp(0.0, 1.0)));
    }
    if e.limiter.on {
        f.push(format!("alimiter=limit={:.4}:level=0", db_to_lin(e.limiter.ceiling_db).clamp(0.0625, 1.0)));
    }
    f
}

/// Everything a track does to its sound: its effects, then its fader and balance.
pub fn track_filter(t: &Track) -> String {
    let mut f = effects_filter(&t.effects);
    if t.gain_db != 0.0 {
        f.push(format!("volume={:.1}dB", t.gain_db));
    }
    if t.pan != 0.0 {
        // Balance: the far side comes down, the near side stays at full level.
        let (l, r) = ((1.0 - t.pan).min(1.0), (1.0 + t.pan).min(1.0));
        f.push(format!("pan=stereo|c0={l:.3}*c0|c1={r:.3}*c1"));
    }
    f.join(",")
}

/// The master stage on export, starting with a comma (or empty). The usual settings give
/// exactly the loudness pass exports always had.
pub fn master_filter(m: &Master) -> String {
    match (m.normalize, m.limiter) {
        (true, limit) => format!(",loudnorm=I={}:TP={}:LRA=11,aresample=48000", fmt_db(m.target_lufs), if limit { fmt_db(m.ceiling_db) } else { "0".into() }),
        // Four times oversampled, so the limiter catches peaks between samples too.
        (false, true) => format!(",aresample=192000,alimiter=limit={:.4}:level=0,aresample=48000", db_to_lin(m.ceiling_db).clamp(0.0625, 1.0)),
        (false, false) => String::new(),
    }
}

/// The master stage once the mix's loudness is known (the export measures it first): one
/// steady gain to the target, so the result lands on it, then the true-peak limiter.
/// Without a measurement (a silent mix) it falls back to the one-pass `master_filter`.
pub fn master_filter_measured(m: &Master, measured_lufs: Option<f64>) -> String {
    let Some(lufs) = measured_lufs.filter(|_| m.normalize) else { return master_filter(m) };
    let gain = (m.target_lufs as f64 - lufs).clamp(-40.0, 40.0);
    let mut f = format!(",volume={gain:.2}dB");
    if m.limiter {
        f.push_str(&format!(",aresample=192000,alimiter=limit={:.4}:level=0,aresample=48000", db_to_lin(m.ceiling_db).clamp(0.0625, 1.0)));
    }
    f
}

/// −14 → "-14", −1.5 → "-1.5".
fn fmt_db(x: f32) -> String {
    let s = format!("{x:.1}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

fn input_args(path: &str, kind: MediaKind, in_us: Us, dur_us: Us, fps: u32) -> Vec<String> {
    match kind {
        MediaKind::Image => vec!["-loop".into(), "1".into(), "-framerate".into(), fps.to_string(), "-t".into(), secs(dur_us), "-i".into(), path.into()],
        _ => vec!["-ss".into(), secs(in_us), "-t".into(), secs(dur_us), "-i".into(), path.into()],
    }
}

pub fn fit_filter(fit: Fit, w: u32, h: u32) -> String {
    match fit {
        Fit::Fill => format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"),
        Fit::Fit => format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"),
    }
}

pub struct VideoOut {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Pixel format at the end of the graph: `rgba` for preview, `yuv420p` for export.
    pub pix_fmt: &'static str,
}

/// Inputs plus `-filter_complex`, producing `[vout]` and/or `[aout]`.
pub fn build(tl: &Timeline, video: Option<&VideoOut>, audio: bool, loudnorm: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
    let mut filters: Vec<String> = vec![];
    let mut next_input = 0usize;
    let total = secs(tl.total_us.max(100_000));
    let fps = video.map_or(30, |v| v.fps);
    let mut seg_inputs = vec![];

    if let Some(v) = video {
        // Picture tracks on top, or a start inside a transition, take the main track's
        // picture on through more filters; otherwise it is the output.
        let layered = !tl.layers.is_empty() || tl.lead_us > 0;
        let main_out = if layered { "vmain" } else { "vout" };
        if tl.main.is_empty() {
            filters.push(format!("color=c=black:s={}x{}:r={}:d={total},format={}[{main_out}]", v.width, v.height, v.fps, v.pix_fmt));
        } else {
            for (n, seg) in tl.main.iter().enumerate() {
                // A hidden main track's segments are black, though their sound plays.
                let black;
                let seg = if seg.black && !seg.path.is_empty() {
                    black = Seg::black(seg.dur_us);
                    &black
                } else {
                    seg
                };
                if seg.black {
                    args.extend(["-f".into(), "lavfi".into(), "-t".into(), secs(seg.dur_us), "-i".into(), format!("color=c=black:s={}x{}:r={}", v.width, v.height, v.fps)]);
                } else {
                    let (in_us, span_us) = seg.picture_window();
                    args.extend(input_args(&seg.path, seg.kind, in_us, span_us, v.fps));
                }
                let input = next_input;
                seg_inputs.push(input);
                next_input += 1;
                let mut extra = SegInputs::default();
                if let Some(matte) = seg.grade.matte.as_ref().filter(|_| !seg.black) {
                    // The matte keeps the source's time; a still's matte is its one frame, held.
                    let (in_us, span_us) = if seg.kind == MediaKind::Image { (0, seg.picture_us()) } else { seg.picture_window() };
                    args.extend(input_args(matte, MediaKind::Video, in_us, span_us, v.fps));
                    extra.matte = Some(next_input);
                    next_input += 1;
                }
                if let Some(mask) = seg.grade.mask_png.as_ref().filter(|_| !seg.black) {
                    args.extend(["-i".into(), mask.clone()]);
                    extra.mask = Some(next_input);
                    next_input += 1;
                }
                filters.extend(seg_video(seg, input, n, v, &extra));
            }
            if tl.main.iter().any(|s| s.xfade.is_some()) {
                let segs: Vec<(Us, Option<(String, Us)>)> = tl.main.iter().map(|s| (s.picture_us(), s.xfade.clone())).collect();
                filters.extend(crate::transitions::join(&segs, v.fps, &format!("format={}", v.pix_fmt), main_out));
            } else {
                let labels: String = (0..tl.main.len()).map(|n| format!("[v{n}]")).collect();
                filters.push(format!("{labels}concat=n={}:v=1:a=0[{main_out}]", tl.main.len()));
            }
        }
        if layered {
            // Layers time themselves on the composite's clock, so it starts at exactly 0 (a
            // seeked input's first frame can be a little past it).
            filters.push("[vmain]setpts=PTS-STARTPTS[vbase]".into());
            filters.extend(compose::build_layers(&tl.layers, "vbase", "vlay", &mut args, &mut next_input, v, tl.total_us));
            let lead = if tl.lead_us > 0 { format!("trim=start={},setpts=PTS-STARTPTS,", secs(tl.lead_us)) } else { String::new() };
            // Layers can leave another pixel format; the output is always the one asked for.
            filters.push(format!("[vlay]{lead}format={}[vout]", v.pix_fmt));
        }
    }

    if audio {
        // Each clip's sound, grouped by the track (bus) it plays through.
        let mut per_bus: Vec<Vec<String>> = vec![vec![]; tl.buses.len().max(tl.main_bus + 1)];
        let mut at = 0;
        for (n, seg) in tl.main.iter().enumerate() {
            let start = at;
            at += seg.dur_us;
            if !seg.has_audio || seg.kind == MediaKind::Image {
                continue;
            }
            // Sound always gets an input of its own, reading the original. Never the picture's:
            // pictures are joined one after another (concat) while every sound is mixed at once
            // (amix), and an input feeding both stalls FFmpeg for good. Its demuxer can't hand
            // amix the sound while concat isn't reading that input's picture yet, so the picture
            // queue fills and everything waits (a split clip exported this way never finished).
            args.extend(input_args(&seg.audio_path, MediaKind::Audio, seg.in_us, seg.span_us, fps));
            next_input += 1;
            let input = next_input - 1;
            filters.push(audio_chain(input, &seg.sound, seg.dur_us, start, &format!("am{n}")));
            per_bus[tl.main_bus].push(format!("[am{n}]"));
        }
        for (n, clip) in tl.audio.iter().enumerate() {
            args.extend(input_args(&clip.path, MediaKind::Audio, clip.in_us, clip.span_us, fps));
            filters.push(audio_chain(next_input, &clip.sound, clip.dur_us, clip.start_us, &format!("ax{n}")));
            if clip.bus >= per_bus.len() {
                per_bus.resize(clip.bus + 1, vec![]);
            }
            per_bus[clip.bus].push(format!("[ax{n}]"));
            next_input += 1;
        }
        // A track with effects, a fader or a balance gets a bus of its own; the rest go
        // straight into the master mix.
        let mut labels = String::new();
        let mut count = 0;
        for (b, inputs) in per_bus.iter().enumerate() {
            let chain = tl.buses.get(b).map_or("", String::as_str);
            if inputs.is_empty() {
                continue;
            }
            if chain.is_empty() {
                labels.push_str(&inputs.concat());
                count += inputs.len();
                continue;
            }
            let open = if inputs.len() == 1 { inputs[0].clone() } else { format!("{}amix=inputs={}:normalize=0:dropout_transition=0,", inputs.concat(), inputs.len()) };
            filters.push(format!("{open}{chain}[bus{b}]"));
            labels.push_str(&format!("[bus{b}]"));
            count += 1;
        }
        let gain = if tl.master_gain_db != 0.0 { format!(",volume={:.1}dB", tl.master_gain_db) } else { String::new() };
        let tail = if loudnorm { tl.export_tail.as_str() } else { "" };
        if count == 0 {
            filters.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={total}[aout]"));
        } else {
            // From inside a transition the picture was built from its start; so was the sound.
            let lead = if tl.lead_us > 0 { format!(",atrim=start={},asetpts=PTS-STARTPTS", secs(tl.lead_us)) } else { String::new() };
            // The trim that ends the mix counts by timestamps, and FFmpeg 8's threaded graph now
            // and then hands it ones it can't count (1 run in 10–40 of the same mix): apad then
            // made silence forever, and a mix read into memory took 24 GB. The mix is gapless
            // after apad, so the sample count gives the right times and the trim always ends it.
            filters.push(format!("{labels}amix=inputs={count}:normalize=0:dropout_transition=0,apad,asetpts=N/SR/TB,atrim=duration={total}{lead}{gain}{tail}[aout]"));
        }
    }

    args.push("-filter_complex".into());
    args.push(filters.join(";"));
    args
}

/// Adds filters to the end of a built graph's sound (before `[aout]`), for measuring it.
pub fn append_to_audio(args: &mut [String], filters: &str) {
    if let Some(fc) = args.last_mut().filter(|f| f.ends_with("[aout]")) {
        fc.truncate(fc.len() - "[aout]".len());
        fc.push(',');
        fc.push_str(filters);
        fc.push_str("[aout]");
    }
}

/// Sound `speed` times as fast at the same pitch, in atempo steps of 0.5-2.
fn atempo(speed: f64) -> Vec<String> {
    let mut f = vec![];
    if speed <= 0.0 || !speed.is_finite() {
        return f;
    }
    let mut left = speed;
    while left > 2.0 {
        f.push("atempo=2".to_string());
        left /= 2.0;
    }
    while left < 0.5 {
        f.push("atempo=0.5".to_string());
        left /= 0.5;
    }
    if (left - 1.0).abs() > 1e-9 {
        f.push(format!("atempo={left:.6}"));
    }
    f
}

/// One clip's sound: resampled to 48 kHz stereo, then its own settings (clicks out, pitch,
/// volume and envelope, all in source time), its direction and speed, then the fades (in
/// timeline time), padded to its length and moved to its start.
fn audio_chain(input: usize, s: &Sound, dur_us: Us, start_us: Us, label: &str) -> String {
    let mut f = vec!["aresample=48000".to_string(), "aformat=sample_fmts=fltp:channel_layouts=stereo".to_string()];
    if s.declick {
        f.push("adeclick".into());
    }
    if s.pitch != 0.0 {
        // Up a semitone: play faster at a higher rate, then stretch back to the old length.
        let k = 2f32.powf(s.pitch / 12.0);
        f.push(format!("asetrate={:.0},aresample=48000,atempo={:.6}", 48_000.0 * k, 1.0 / k));
    }
    f.push(format!("volume={:.3}", s.volume));
    if let Some(e) = envelope_expr(s) {
        f.push(format!("volume=eval=frame:volume='{e}'"));
    }
    f.extend(spectral_filters(s));
    if s.reverse {
        f.push("areverse".into());
    }
    if s.keep_pitch || s.speed <= 0.0 || s.speed == 1.0 {
        f.extend(atempo(s.speed));
    } else {
        // The pitch follows the speed: the samples simply play faster or slower.
        f.push(format!("asetrate={:.0},aresample=48000", 48_000.0 * s.speed));
    }
    let curve = match s.fade_curve.as_str() {
        "scurve" => "hsin",
        "log" => "log",
        _ => "tri",
    };
    // Fades are placed on the clip: playing from its middle keeps the fade out where it was
    // and finishes what is left of the fade in.
    let fade_in_left = s.fade_in_us - s.skip_us;
    if fade_in_left > 0 {
        f.push(format!("afade=t=in:st=0:d={}:curve={curve}", secs(fade_in_left)));
    }
    if s.fade_out_us > 0 {
        let st = (s.clip_us - s.fade_out_us - s.skip_us).max(0);
        let d = s.fade_out_us.min(s.clip_us - s.skip_us).max(1);
        f.push(format!("afade=t=out:st={}:d={}:curve={curve}", secs(st), secs(d)));
    }
    f.push("apad".into());
    f.push(format!("atrim=duration={}", secs(dur_us)));
    if start_us > 0 {
        // adelay can stamp its first frames with no time at all (seen on sound read from a few
        // seconds into a file); amix then ends the whole mix there, and an apad after it never
        // stops. The chain is gapless, so the sample count gives the right times.
        f.push(format!("adelay={}:all=1,asetpts=N/SR/TB", start_us / 1000));
    }
    format!("[{input}:a]{}[{label}]", f.join(","))
}

/// The envelope as a volume expression over the clip's own time `t` (straight lines
/// between points, flat before the first and after the last). `None` without points.
/// The source time (seconds) of a clip's sound input at its t = 0: reversed, the input starts
/// at the source range's start; played from the middle, that much later.
fn origin_s(s: &Sound) -> f64 {
    let used = if s.speed > 0.0 { (s.skip_us as f64 * s.speed).round() as Us } else { s.skip_us };
    (s.source_in_us + if s.reverse { 0 } else { used }) as f64 / 1e6
}

/// Spectral delete: each band taken out between its times (source time, like the envelope)
/// by band-reject filters spread across it, each twice as wide as its share and run twice,
/// so the whole band drops by 25 dB or more, not only its middle.
fn spectral_filters(s: &Sound) -> Vec<String> {
    let origin = origin_s(s);
    let mut f = vec![];
    for &(a, b, lo, hi) in &s.spectral {
        let (ta, tb) = (a as f64 / 1e6 - origin, b as f64 / 1e6 - origin);
        let (lo, hi) = (lo.max(10.0) as f64, (hi as f64).max(lo as f64 + 10.0));
        let n = (((hi / lo).log2() * 3.0).ceil() as usize).clamp(2, 8);
        let step = (hi / lo).powf(1.0 / n as f64);
        for i in 0..n {
            let (f0, f1) = (lo * step.powi(i as i32), lo * step.powi(i as i32 + 1));
            let notch = format!("bandreject=f={:.1}:width_type=h:w={:.1}:enable='between(t,{ta:.4},{tb:.4})'", (f0 * f1).sqrt(), 2.0 * (f1 - f0));
            f.push(notch.clone());
            f.push(notch);
        }
    }
    f
}

fn envelope_expr(s: &Sound) -> Option<String> {
    let pts = &s.envelope;
    if pts.is_empty() {
        return None;
    }
    let origin = origin_s(s);
    let at = |us: Us| us as f64 / 1e6 - origin;
    let mut e = format!("{:.4}", pts[pts.len() - 1].1);
    for w in pts.windows(2).rev() {
        let ((t0, g0), (t1, g1)) = ((at(w[0].0), w[0].1), (at(w[1].0), w[1].1));
        let slope = if t1 > t0 { (g1 - g0) as f64 / (t1 - t0) } else { 0.0 };
        e = format!("if(lt(t,({t1:.4})),{g0:.4}+({slope:.6})*(t-({t0:.4})),{e})");
    }
    Some(format!("if(lt(t,({:.4})),{:.4},{e})", at(pts[0].0), pts[0].1))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Quality {
    Fast,
    Balanced,
    Best,
}

impl Quality {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "fast" => Some(Self::Fast),
            "balanced" => Some(Self::Balanced),
            "best" => Some(Self::Best),
            _ => None,
        }
    }
}

/// Encoder settings for a quality preset: NVENC when the graphics card has it, else x264.
/// VA-API (AMD/Intel on Linux) slots in here later; until then those machines use x264.
pub fn encoder_args(ff: &Ffmpeg, q: Quality) -> (Vec<String>, String) {
    let nvenc = ff.has("h264_nvenc");
    let (args, name): (&[&str], &str) = match (q, nvenc) {
        (Quality::Fast, true) => (&["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"], "NVENC H.264"),
        (Quality::Balanced, true) => (&["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-spatial-aq", "1"], "NVENC H.264, high quality"),
        (Quality::Fast, false) => (&["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"], "x264 veryfast"),
        (Quality::Balanced, false) => (&["-c:v", "libx264", "-preset", "medium", "-crf", "20"], "x264 medium"),
        (Quality::Best, _) => (&["-c:v", "libx264", "-preset", "slow", "-crf", "18"], "x264 slow"),
    };
    (args.iter().map(|s| s.to_string()).collect(), name.to_string())
}

/// The same encoder at a target bitrate (Mbit/s) instead of a constant quality: variable,
/// peaking at 1.5 times the target with a buffer of twice it. `None` keeps the quality preset.
pub fn encoder_args_at(ff: &Ffmpeg, q: Quality, mbps: Option<f64>) -> (Vec<String>, String) {
    let (args, name) = encoder_args(ff, q);
    let Some(mbps) = mbps.filter(|m| m.is_finite() && *m > 0.0) else { return (args, name) };
    let kbps = (mbps * 1000.0).round().max(100.0) as u64;
    // Every preset is flag and value pairs; the constant-quality ones go (NVENC keeps `-rc vbr`).
    let mut out: Vec<String> = args.chunks(2).filter(|p| !matches!(p[0].as_str(), "-cq" | "-crf" | "-b:v")).flatten().cloned().collect();
    out.extend(["-b:v".into(), format!("{kbps}k"), "-maxrate".into(), format!("{}k", kbps * 3 / 2), "-bufsize".into(), format!("{}k", kbps * 2)]);
    (out, format!("{name}, {mbps} Mbit/s"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::model::{Media, SECOND};

    fn project() -> Project {
        let mut p = Project::new("T", "9:16");
        let m = |id: &str, kind, secs: Us, audio| Media {
            id: id.into(), path: format!("/m/{id}"), name: id.into(), kind, duration_us: secs * SECOND, width: 1080, height: 1920, fps: 30.0, has_audio: audio,
            proxy: Some(format!("/nonexistent/{id}.proxy.mp4")), ..Default::default()
        };
        p.media = vec![m("a", MediaKind::Video, 4, true), m("img", MediaKind::Image, 0, false), m("vo", MediaKind::Audio, 10, true)];
        p.insert("a", 0).unwrap();
        p.insert("img", 99 * SECOND).unwrap();
        p.insert("vo", SECOND).unwrap();
        p
    }

    #[test]
    fn timeline_from_the_middle_trims_what_came_before() {
        let tl = timeline_from(&project(), 2 * SECOND, true);
        assert_eq!(tl.main.len(), 3);
        assert!(tl.main[2].black, "black after the last picture while the voiceover plays on");
        assert_eq!(tl.main[2].dur_us, 4 * SECOND);
        assert_eq!((tl.main[0].in_us, tl.main[0].dur_us), (2 * SECOND, 2 * SECOND));
        assert_eq!(tl.main[0].path, "/m/a", "a missing proxy falls back to the original");
        assert_eq!(tl.audio[0].start_us, 0);
        assert_eq!(tl.audio[0].in_us, SECOND);
        assert_eq!(tl.total_us, 9 * SECOND);
    }

    #[test]
    fn graph_has_one_input_per_use_and_both_outputs() {
        let tl = timeline_from(&project(), 0, false);
        let args = build(&tl, Some(&VideoOut { width: 1080, height: 1920, fps: 30, pix_fmt: "yuv420p" }), true, true);
        let inputs = args.iter().filter(|a| *a == "-i").count();
        // Clip a's sound has an input of its own: sharing the picture's stalls FFmpeg once two
        // segments read the same file (concat reads pictures in turn, amix all sounds at once).
        assert_eq!(inputs, 5, "clip a's picture, clip a's sound, image, black tail, voiceover");
        let fc = args.last().unwrap();
        assert!(fc.contains("concat=n=3:v=1:a=0[vout]"));
        assert!(fc.contains("amix=inputs=2"));
        assert!(fc.contains("adelay=1000:all=1"), "voiceover starts at 1 s: {fc}");
        assert!(fc.contains("loudnorm=I=-14"));
        assert!(args.windows(2).any(|w| w[0] == "-loop" && w[1] == "1"), "images loop");
    }

    #[test]
    fn empty_project_still_renders_picture_and_silence() {
        let p = Project::new("Empty", "1:1");
        let args = build(&timeline_from(&p, 0, false), Some(&VideoOut { width: 1080, height: 1080, fps: 30, pix_fmt: "rgba" }), true, false);
        let fc = args.last().unwrap();
        assert!(fc.contains("color=c=black:s=1080x1080"));
        assert!(fc.contains("anullsrc"));
    }

    #[test]
    fn gaps_play_black_and_extracted_sound_leaves_the_video() {
        let mut p = project();
        p.set_magnet(false);
        let a = p.main_track().clips[0].id.clone();
        p.move_clip(&a, SECOND, None).unwrap();
        let tl = timeline_from(&p, 0, false);
        assert!(tl.main[0].black && tl.main[0].dur_us == SECOND, "the gap before a");
        assert!(!tl.main[1].black);
        p.extract_audio(std::slice::from_ref(&a)).unwrap();
        let tl = timeline_from(&p, 0, false);
        assert!(!tl.main[1].has_audio, "a's picture plays silent");
        assert_eq!(tl.audio.len(), 2, "the voiceover and a's extracted sound");
        let args = build(&tl, Some(&VideoOut { width: 1080, height: 1920, fps: 30, pix_fmt: "rgba" }), true, false);
        assert!(args.iter().any(|x| x.starts_with("color=c=black:s=1080x1920")));
    }

    #[test]
    fn crop_rotate_and_mirror_run_before_the_fit() {
        use studio_engine_core::model::{ClipChange, Crop};
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        p.set_clip(&a, ClipChange { crop: Some(Some(Crop { x: 0.25, y: 0.0, w: 0.5, h: 1.0 })), rotate: Some(90), flip: Some(true), ..Default::default() }).unwrap();
        let f = picture_filter(p.clip(&a).unwrap());
        assert_eq!(f, "crop=iw*0.50000:ih*1.00000:iw*0.25000:ih*0.00000,transpose=1,hflip,");
        let fc = build(&timeline_from(&p, 0, false), Some(&VideoOut { width: 1080, height: 1920, fps: 30, pix_fmt: "rgba" }), false, false).last().unwrap().clone();
        assert!(fc.contains("[0:v]crop=iw*0.50000"), "{fc}");
    }

    fn sound_graph(p: &Project, export: bool) -> String {
        build(&timeline_from(p, 0, false), None, true, export).last().unwrap().clone()
    }

    fn voice_track(p: &Project) -> String {
        p.tracks.iter().find(|t| !t.main).unwrap().id.clone()
    }

    #[test]
    fn a_track_with_effects_gets_its_own_bus_in_order() {
        use studio_engine_core::model::{Effects, TrackChange};
        let mut p = project();
        assert!(!sound_graph(&p, false).contains("[bus"), "a neutral mix has no buses");
        let mut fx = Effects::default();
        fx.noise.on = true;
        fx.eq.on = true;
        fx.comp.on = true;
        fx.deess.on = true;
        fx.limiter.on = true;
        let t = voice_track(&p);
        p.set_track(&t, TrackChange { effects: Some(fx), gain_db: Some(-6.0), pan: Some(-0.5), ..Default::default() }).unwrap();
        let fc = sound_graph(&p, false);
        let bus = fc.split(';').find(|f| f.ends_with("[bus1]")).unwrap_or_else(|| panic!("{fc}"));
        let order = ["afftdn=nr=12.0:nf=-51.0:tn=1", "highpass=f=80", "equalizer=f=4000:t=q:w=1:g=3.0", "acompressor=threshold=0.125893:ratio=3.00:attack=10:release=120", "deesser=i=0.333", "alimiter=limit=0.8913:level=0", "volume=-6.0dB", "pan=stereo|c0=1.000*c0|c1=0.500*c1"];
        let mut at = 0;
        for f in order {
            let i = bus[at..].find(f).unwrap_or_else(|| panic!("{f} missing or out of order in {bus}"));
            at += i + f.len();
        }
        assert!(bus.starts_with("[ax0]"), "the voiceover feeds its track's bus: {bus}");
        assert!(fc.contains("[am0][bus1]amix=inputs=2"), "{fc}");
    }

    #[test]
    fn mute_and_solo_decide_what_is_heard() {
        use studio_engine_core::model::TrackChange;
        let mut p = project();
        let t = voice_track(&p);
        let main = p.main_track().id.clone();
        p.set_track(&t, TrackChange { mute: Some(true), ..Default::default() }).unwrap();
        let tl = timeline_from(&p, 0, false);
        assert!(tl.audio.is_empty() && tl.main[0].has_audio);
        p.set_track(&t, TrackChange { mute: Some(false), ..Default::default() }).unwrap();
        p.set_track(&t, TrackChange { solo: Some(true), ..Default::default() }).unwrap();
        let tl = timeline_from(&p, 0, false);
        assert!(tl.audio.len() == 1 && !tl.main[0].has_audio, "the soloed voiceover alone");
        p.set_track(&main, TrackChange { mute: Some(true), solo: Some(false), ..Default::default() }).unwrap();
        p.set_track(&t, TrackChange { solo: Some(false), mute: Some(true), ..Default::default() }).unwrap();
        assert!(sound_graph(&p, false).contains("anullsrc"), "everything muted is silence");
    }

    #[test]
    fn the_master_stage_follows_the_project_settings() {
        use studio_engine_core::model::MasterChange;
        let mut p = project();
        let fc = sound_graph(&p, true);
        assert!(fc.ends_with(",loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]"), "the usual export pass: {fc}");
        assert!(!sound_graph(&p, false).contains("loudnorm"), "playback isn't levelled");
        p.set_master(MasterChange { limiter: Some(false), target_lufs: Some(-16.0), ..Default::default() }).unwrap();
        assert!(sound_graph(&p, true).contains("loudnorm=I=-16:TP=0:LRA=11"));
        p.set_master(MasterChange { normalize: Some(false), limiter: Some(true), ceiling_db: Some(-2.0), ..Default::default() }).unwrap();
        let fc = sound_graph(&p, true);
        assert!(fc.contains("aresample=192000,alimiter=limit=0.7943:level=0") && !fc.contains("loudnorm"), "{fc}");
        p.set_master(MasterChange { limiter: Some(false), gain_db: Some(3.5), ..Default::default() }).unwrap();
        let fc = sound_graph(&p, true);
        assert!(fc.ends_with("atrim=duration=11.000000,volume=3.5dB[aout]"), "the mix gain is heard everywhere, with no export stage: {fc}");

        // Measured first, the export levels with one steady gain, then limits.
        let m = Master::default();
        assert_eq!(master_filter_measured(&m, Some(-9.5)), ",volume=-4.50dB,aresample=192000,alimiter=limit=0.8913:level=0,aresample=48000");
        assert_eq!(master_filter_measured(&m, None), master_filter(&m), "a silent mix falls back to one pass");
        assert_eq!(master_filter_measured(&Master { normalize: false, limiter: false, ..m }, Some(-9.5)), "");
    }

    #[test]
    fn clip_fades_pitch_clicks_and_envelope_are_in_its_chain() {
        use studio_engine_core::model::{ClipChange, EnvPoint};
        let mut p = project();
        let vo = p.tracks.iter().find(|t| !t.main).unwrap().clips[0].id.clone();
        p.set_clip(&vo, ClipChange { fade_in_us: Some(SECOND / 2), fade_out_us: Some(2 * SECOND), fade_curve: Some("log".into()), pitch: Some(12.0), declick: Some(true), ..Default::default() }).unwrap();
        let env = vec![EnvPoint { at_us: SECOND, gain: 1.0 }, EnvPoint { at_us: 3 * SECOND, gain: 0.5 }];
        p.set_clip(&vo, ClipChange { envelope: Some(env), ..Default::default() }).unwrap();
        let fc = sound_graph(&p, false);
        let chain = fc.split(';').find(|f| f.ends_with("[ax0]")).unwrap();
        assert!(chain.contains("adeclick,asetrate=96000,aresample=48000,atempo=0.500000,volume=1.000"), "{chain}");
        assert!(chain.contains("afade=t=in:st=0:d=0.500000:curve=log"), "{chain}");
        assert!(chain.contains("afade=t=out:st=8.000000:d=2.000000:curve=log"), "{chain}");
        assert!(chain.contains("volume=eval=frame:volume='if(lt(t,(1.0000)),1.0000,if(lt(t,(3.0000)),1.0000+(-0.250000)*(t-(1.0000)),0.5000))'"), "{chain}");
        assert!(chain.ends_with("apad,atrim=duration=10.000000,adelay=1000:all=1,asetpts=N/SR/TB[ax0]"), "{chain}");
        // The mix ends by sample count too: its trim used to wait on timestamps FFmpeg 8 sometimes lost.
        assert!(sound_graph(&p, false).contains("dropout_transition=0,apad,asetpts=N/SR/TB,atrim=duration="), "{}", sound_graph(&p, false));
    }

    #[test]
    fn measuring_filters_go_before_the_sound_output() {
        let mut args = build(&timeline_from(&project(), 0, false), None, true, false);
        append_to_audio(&mut args, "ebur128=peak=true");
        assert!(args.last().unwrap().ends_with(",ebur128=peak=true[aout]"));
    }

    const PREVIEW: VideoOut = VideoOut { width: 540, height: 960, fps: 30, pix_fmt: "rgba" };

    fn graph_of(p: &Project, from: Us) -> String {
        build(&timeline_from(p, from, false), Some(&PREVIEW), true, false).last().unwrap().clone()
    }

    #[test]
    fn speed_and_reverse_read_the_right_part_of_the_source() {
        use studio_engine_core::model::ClipChange;
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        p.set_clip(&a, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().duration_us, 2 * SECOND, "4 s of source at double speed");
        assert_eq!(p.main_track().clips[1].start_us, 2 * SECOND, "the image moves up");
        let tl = timeline_from(&p, SECOND / 2, false);
        assert_eq!((tl.main[0].in_us, tl.main[0].span_us, tl.main[0].dur_us), (SECOND, 3 * SECOND, 3 * SECOND / 2), "half a second in is a second into the source");
        let args = build(&tl, Some(&PREVIEW), true, false);
        assert!(args.windows(4).any(|w| w[0] == "-ss" && w[1] == "1.000000" && w[2] == "-t" && w[3] == "3.000000"), "{args:?}");
        let fc = args.last().unwrap();
        assert!(fc.contains("setpts=(PTS-STARTPTS)/2.000000") && fc.contains(",atempo=2.000000,") && !fc.contains("reverse"), "{fc}");

        // Backwards at a quarter speed: 4 s of source over 16 s. From 4 s in, what's left is
        // the first 3 s of the source, played from its end.
        p.set_clip(&a, ClipChange { reverse: Some(true), speed: Some(0.25), ..Default::default() }).unwrap();
        assert_eq!(p.clip(&a).unwrap().duration_us, 16 * SECOND);
        let tl = timeline_from(&p, 4 * SECOND, false);
        assert_eq!((tl.main[0].in_us, tl.main[0].span_us), (0, 3 * SECOND));
        let fc = graph_of(&p, 4 * SECOND);
        assert!(fc.contains("setpts=(PTS-STARTPTS)/0.250000,fps=30,reverse,"), "{fc}");
        assert!(fc.contains("areverse,atempo=0.5,atempo=0.500000"), "{fc}");
        assert_eq!(atempo(10.0), vec!["atempo=2", "atempo=2", "atempo=2", "atempo=1.250000"]);
        assert!(atempo(1.0).is_empty());
    }

    #[test]
    fn colour_sliders_become_filters_in_order() {
        use studio_engine_core::model::ClipChange;
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        let plain = graph_of(&p, 0);
        assert!(!plain.contains("eq=") && !plain.contains("overlay") && !plain.replace("asetpts", "").contains("setpts"), "a plain clip keeps the cheap chain: {plain}");
        let c = ClipChange { brightness: Some(50.0), contrast: Some(-20.0), saturation: Some(-100.0), temperature: Some(40.0), tint: Some(10.0), highlights: Some(30.0), shadows: Some(-30.0), sharpen: Some(50.0), vignette: Some(60.0), ..Default::default() };
        p.set_clip(&a, c).unwrap();
        let fc = graph_of(&p, 0);
        let order = ["eq=brightness=0.1500:contrast=0.9000:saturation=0.0000", "colorbalance=rm=0.1200:gm=-0.0300:bm=-0.1200:rh=0.0600:gh=-0.0150:bh=-0.0600:pl=1", "curves=m='0/0 0.25/0.2140 0.75/0.7860 1/1':interp=pchip", "unsharp=lx=3:ly=3:la=0.750", "vignette=a=0.6000"];
        let mut at = 0;
        for f in order {
            let i = fc[at..].find(f).unwrap_or_else(|| panic!("{f} missing or out of order in {fc}"));
            at += i + f.len();
        }
        assert!(!fc.contains("overlay"), "colour alone needs no overlay");
        p.set_clip(&a, ClipChange { sharpen: Some(-50.0), vignette: Some(-20.0), ..Default::default() }).unwrap();
        let fc = graph_of(&p, 0);
        assert!(fc.contains("gblur=sigma=1.000") && fc.contains("vignette=a=0.2000:mode=backward"), "{fc}");
        p.set_clip(&a, ClipChange { fit: Some(Fit::Fit), ..Default::default() }).unwrap();
        let fc = graph_of(&p, 0);
        assert!(fc.contains("scale=540:960:force_original_aspect_ratio=decrease,eq=") && fc.contains("vignette=a=0.2000:mode=backward,pad=540:960"), "the bars stay black: {fc}");
    }

    #[test]
    fn size_position_rotation_and_opacity_take_the_cheapest_path() {
        use studio_engine_core::model::ClipChange;
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        // A punch-in still covers the frame: crop and scale, no overlay. 100 project px is 50 at preview size.
        p.set_clip(&a, ClipChange { scale: Some(150.0), pos_x: Some(100.0), ..Default::default() }).unwrap();
        let fc = graph_of(&p, 0);
        assert!(fc.contains("crop=360.000:640.000:56.667:160.000,scale=540:960") && !fc.contains("overlay"), "{fc}");
        // Smaller than the frame: over black, placed once.
        p.set_clip(&a, ClipChange { scale: Some(50.0), opacity: Some(50.0), ..Default::default() }).unwrap();
        let fc = graph_of(&p, 0);
        assert!(fc.contains("color=c=black:s=540x960:r=30:d=4.000000[bg0]"), "{fc}");
        assert!(fc.contains("[bg0][fg0]overlay=x='(W-w)/2+(50.000)':y='(H-h)/2+(0.000)':eval=init,setsar=1,format=rgba,trim=duration=4.000000[v0]"), "{fc}");
        assert!(fc.contains("format=yuv420p,eq=contrast=0.5000:brightness=-0.21863:saturation=0.5000"), "opacity fades towards black: {fc}");
        assert!(fc.contains("scale=w='max(2,trunc(iw*0.500000/2)*2)'"), "{fc}");
        p.set_clip(&a, ClipChange { scale: Some(100.0), pos_x: Some(0.0), opacity: Some(100.0), rotation: Some(15.0), ..Default::default() }).unwrap();
        let fc = graph_of(&p, 0);
        assert!(fc.contains("format=yuva420p,rotate=a=0.261799:ow='rotw(0.261799)':oh='roth(0.261799)':c=none[fg0]"), "{fc}");
    }

    #[test]
    fn keyframes_animate_over_the_segments_own_time() {
        use studio_engine_core::model::{ClipChange, Keyframe, Keyframes};
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        let k = |pts: &[(Us, f64)]| pts.iter().map(|&(at_us, value)| Keyframe { at_us, value, ..Default::default() }).collect::<Vec<_>>();
        let mut keys = Keyframes::new();
        keys.insert("posX".into(), k(&[(SECOND, 0.0), (3 * SECOND, 200.0)]));
        keys.insert("rotation".into(), k(&[(0, 0.0), (2 * SECOND, 90.0)]));
        keys.insert("scale".into(), k(&[(0, 100.0), (2 * SECOND, 50.0)]));
        keys.insert("opacity".into(), k(&[(0, 100.0), (SECOND, 0.0)]));
        keys.insert("brightness".into(), k(&[(0, 0.0), (SECOND, 100.0)]));
        keys.insert("hsl-Orange-h".into(), k(&[(0, 10.0)]));
        p.set_clip(&a, ClipChange { keyframes: Some(keys), ..Default::default() }).unwrap();
        // Played from 2 s in: the segment's t = 0 is the clip's 2 s.
        let fc = graph_of(&p, 2 * SECOND);
        assert!(fc.contains("setpts=PTS-STARTPTS"), "{fc}");
        assert!(fc.contains("overlay=x='(W-w)/2+(if(lt(t,-1.0000),0.0000,if(lt(t,1.0000),0.0000+(100.000000)*(t-(-1.0000)),200.0000)))*0.500000'"), "{fc}");
        assert!(fc.contains("eval=frame,setsar=1"), "{fc}");
        assert!(fc.contains("rotate=a='(if(lt(t,-2.0000),0.0000,if(lt(t,0.0000),0.0000+(45.000000)*(t-(-2.0000)),90.0000)))*PI/180':ow='hypot(iw,ih)'"), "{fc}");
        assert!(fc.contains(":eval=frame:flags=bilinear[fg0]") && fc.contains("scale=w='max(2,trunc(iw*(if(lt(t,-2.0000)"), "{fc}");
        assert!(fc.contains("eq=contrast='clip((if(lt(t,-2.0000)"), "{fc}");
        assert!(fc.contains("eq=brightness='0+(if(lt(t,-2.0000)") && fc.contains("*0.003':contrast=1.0000:saturation=1.0000:eval=frame"), "{fc}");
        assert!(!fc.contains("Orange"), "other keyframes are only kept");
        // A paused frame holds every setting at its moment: no expressions.
        let still = still_at(&p, 2 * SECOND, false).unwrap();
        assert_eq!((level(&still.look.pos_x, 0.0), level(&still.look.rotation, 0.0), level(&still.look.opacity, 100.0)), (100.0, 90.0, 0.0));
    }

    #[test]
    fn playback_stretches_end_on_a_frame_and_never_inside_a_transition_or_a_moving_clip() {
        use studio_engine_core::model::{ClipChange, Fx, TrackChange};
        let mut p = Project::new("T", "9:16");
        let m = |id: &str| Media { id: id.into(), path: format!("/m/{id}"), name: id.into(), kind: MediaKind::Video, duration_us: 6 * SECOND, width: 1080, height: 1920, fps: 30.0, ..Default::default() };
        p.media = vec![m("a"), m("b"), m("c")];
        p.insert("a", 0).unwrap();
        let b = p.insert("b", 99 * SECOND).unwrap();
        let c = p.insert("c", 99 * SECOND).unwrap();
        let frame = 1_000_000 / 30;
        // At least the minimum on, on one of playback's frames (counted from where it starts).
        let e = window_end(&p, 100_000, SECOND, frame);
        assert_eq!(e, 100_000 + 31 * frame, "30 frames are a little short of a second");
        // A transition into b (5.5–6.5 s): the stretch runs on to two frames past its end.
        p.set_transition(&b, Some("Dissolve"), Some(SECOND)).unwrap();
        let e = window_end(&p, 5 * SECOND, SECOND, frame);
        assert!(e >= 6_500_000 + 2 * frame && e < 6_500_000 + 3 * frame && (e - 5 * SECOND) % frame == 0, "{e}");
        assert_eq!(window_end(&p, 3 * SECOND, SECOND, frame), 3 * SECOND + 31 * frame, "well before it, as usual");
        // A clip with an effect that moves (12–18 s) can't be cut: here that's the end.
        p.set_clip(&c, ClipChange { effects: Some(vec![Fx { name: "Zoom pulse".into(), amount: 100.0 }]), ..Default::default() }).unwrap();
        assert_eq!(window_end(&p, 11_500_000, SECOND, frame), p.duration_us());
        // One that doesn't move can, and a hidden track's clips don't count.
        p.set_clip(&c, ClipChange { effects: Some(vec![Fx { name: "Sepia".into(), amount: 100.0 }]), ..Default::default() }).unwrap();
        assert_eq!(window_end(&p, 11_500_000, SECOND, frame), 11_500_000 + 31 * frame);
        p.set_clip(&c, ClipChange { effects: Some(vec![Fx { name: "Shake".into(), amount: 100.0 }]), ..Default::default() }).unwrap();
        let main = p.main_track().id.clone();
        p.set_track(&main, TrackChange { hidden: Some(true), ..Default::default() }).unwrap();
        assert_eq!(window_end(&p, 11_500_000, SECOND, frame), 11_500_000 + 31 * frame);
        // Near the end, the stretch is the rest.
        assert_eq!(window_end(&p, 17_500_000, SECOND, frame), p.duration_us());
    }

    #[test]
    fn a_paused_frame_shows_the_source_under_the_playhead() {
        use studio_engine_core::model::ClipChange;
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        p.set_clip(&a, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(still_at(&p, SECOND / 2, false).unwrap().in_us, SECOND);
        p.set_clip(&a, ClipChange { reverse: Some(true), ..Default::default() }).unwrap();
        assert_eq!(still_at(&p, SECOND / 2, false).unwrap().in_us, 3 * SECOND, "backwards, half a second in is a second before the end");
        assert_eq!(still_at(&p, 0, false).unwrap().in_us, 4 * SECOND - 33_333, "the first frame is the last one in the range");
        assert!(still_at(&p, 0, false).unwrap().look == Look::of(p.clip(&a).unwrap(), 0, true, 1080, 1920));
    }

    /// Renders a one-clip project's picture at 54×96 and returns each frame's mean RGB.
    fn frame_means(ff: &Ffmpeg, p: &Project) -> Vec<[f64; 3]> {
        let mut args = build(&timeline_from(p, 0, false), Some(&VideoOut { width: 54, height: 96, fps: 10, pix_fmt: "rgba" }), true, false);
        args.extend(["-map", "[vout]", "-f", "rawvideo", "pipe:1", "-map", "[aout]", "-f", "null", "-"].map(String::from));
        let out = ff.cmd().args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).output().unwrap();
        assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stderr), args.last().unwrap());
        out.stdout.chunks_exact(54 * 96 * 4).map(|f| [0, 1, 2].map(|c| f.iter().skip(c).step_by(4).map(|&x| x as f64).sum::<f64>() / (54.0 * 96.0))).collect()
    }

    /// The real thing: each look, speed and direction makes a graph FFmpeg runs, with the
    /// right length and a picture that changes the way it should. Skipped without FFmpeg.
    #[test]
    fn looks_speed_and_reverse_run_in_ffmpeg() {
        use studio_engine_core::model::{ClipChange, Keyframe, Keyframes};
        let Ok(ff) = Ffmpeg::detect() else { return };
        let dir = std::env::temp_dir().join(format!("studio-graph-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Two seconds that get brighter: black to white, so time order shows in the means.
        let src = dir.join("ramp.mp4");
        let ok = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=108x192:r=10:d=2,geq=lum='255*T/2':cb=128:cr=128", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y"]).arg(&src).status().unwrap();
        assert!(ok.success());
        let mut p = Project::new("T", "9:16");
        p.fps = 10;
        p.media.push(Media { id: "m".into(), path: src.to_string_lossy().into(), name: "ramp".into(), kind: MediaKind::Video, duration_us: 2 * SECOND, width: 108, height: 192, fps: 10.0, has_audio: true, ..Default::default() });
        let a = p.insert("m", 0).unwrap();
        let plain = frame_means(&ff, &p);
        assert_eq!(plain.len(), 20);
        assert!(plain[19][0] > plain[1][0] + 150.0, "the ramp gets brighter: {:?} {:?}", plain[1], plain[19]);

        let mut q = p.clone();
        q.set_clip(&a, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        let fast = frame_means(&ff, &q);
        assert_eq!(fast.len(), 10, "double speed is half as long");
        assert!((fast[5][0] - plain[10][0]).abs() < 20.0, "0.5 s at double speed shows the source's 1 s: {:?} vs {:?}", fast[5], plain[10]);

        q.set_clip(&a, ClipChange { speed: Some(1.0), reverse: Some(true), ..Default::default() }).unwrap();
        let back = frame_means(&ff, &q);
        assert_eq!(back.len(), 20);
        assert!(back[1][0] > back[18][0] + 150.0 && (back[2][0] - plain[17][0]).abs() < 20.0, "backwards it gets darker: {:?} {:?}", back[2], plain[17]);

        let mut q = p.clone();
        q.set_clip(&a, ClipChange { brightness: Some(100.0), ..Default::default() }).unwrap();
        assert!(frame_means(&ff, &q)[5][0] > plain[5][0] + 30.0, "brighter");
        q.set_clip(&a, ClipChange { brightness: Some(0.0), temperature: Some(100.0), ..Default::default() }).unwrap();
        let warm = frame_means(&ff, &q)[15];
        assert!(warm[0] > warm[2] + 10.0, "warm is redder than it is blue: {warm:?}");
        let mut q = p.clone();
        q.set_clip(&a, ClipChange { opacity: Some(50.0), ..Default::default() }).unwrap();
        let half = frame_means(&ff, &q)[19][1];
        assert!((half - plain[19][1] / 2.0).abs() < 15.0, "half opacity over black is half as bright: {half} vs {}", plain[19][1]);
        let mut q = p.clone();
        q.set_clip(&a, ClipChange { scale: Some(50.0), ..Default::default() }).unwrap();
        let small = frame_means(&ff, &q)[19][1];
        assert!((small - plain[19][1] / 4.0).abs() < 15.0, "half the size covers a quarter of the frame: {small} vs {}", plain[19][1]);
        q.set_clip(&a, ClipChange { scale: Some(150.0), pos_x: Some(200.0), rotation: Some(20.0), sharpen: Some(60.0), vignette: Some(50.0), saturation: Some(-50.0), highlights: Some(20.0), shadows: Some(20.0), tint: Some(30.0), ..Default::default() }).unwrap();
        assert_eq!(frame_means(&ff, &q).len(), 20, "everything at once runs");

        // Every animated setting at once, played from the middle.
        let mut keys = Keyframes::new();
        for (name, from, to) in [("posX", -300.0, 300.0), ("posY", 0.0, 100.0), ("rotation", 0.0, 180.0), ("scale", 40.0, 120.0), ("opacity", 100.0, 0.0), ("brightness", 0.0, 50.0), ("contrast", 0.0, 20.0), ("saturation", 0.0, -100.0)] {
            keys.insert(name.into(), vec![Keyframe { at_us: 0, value: from, ..Default::default() }, Keyframe { at_us: 2 * SECOND, value: to, ..Default::default() }]);
        }
        q.set_clip(&a, ClipChange { keyframes: Some(keys), ..Default::default() }).unwrap();
        let moving = frame_means(&ff, &q);
        assert_eq!(moving.len(), 20);
        assert!(moving[19][1] < 20.0, "faded out by the end: {:?}", moving[19]);
        let mut args = build(&timeline_from(&q, SECOND, true), Some(&PREVIEW), true, false);
        args.extend(["-map", "[vout]", "-map", "[aout]", "-f", "null", "-"].map(String::from));
        assert!(ff.cmd().args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap().success());
        let _ = std::fs::remove_dir_all(dir);
    }
}
