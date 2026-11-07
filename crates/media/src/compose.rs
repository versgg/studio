//! Picture tracks over the main one. Overlays (video, pictures, stickers, text drawings) are
//! composited on top in track order, each from an input of its own; adjustment layers grade
//! everything below them while they play.
//!
//! An overlay's picture is fitted against the frame (no crop or bars: what overflows is
//! simply off screen), graded, given its alpha (its own, a matte's, a mask's, a typewriter
//! reveal's, its opacity), then sized, turned and placed. With effects or a blend mode it is
//! first placed on a see-through layer the size of the frame, so effects that move pixels
//! keep to a known size and the blend sees the whole frame.

use crate::anim::Moves;
use crate::effects::{self, Frame};
use crate::motion::Motion;
use crate::graph::{Curve, Grade, Look, Place, VideoOut, alpha_opacity, color_filters_at, curve_at, curve_expr, mask_chain, moving, picture_filter, placement_at, size_fixed, size_moving, source_range, stab_filter, timing, turn_fixed, turn_moving};
use crate::secs;
use std::path::Path;
use studio_engine_core::model::{Fit, MediaKind, Project, Us};

/// One thing drawn over (or done to) the picture below, in stacking order.
#[derive(Debug, Clone, PartialEq)]
pub enum Layer {
    Pic(Pic),
    Adjust(Adjust),
}

/// A picture on top: a video, an image or sticker, or a text clip's drawing.
#[derive(Debug, Clone, PartialEq)]
pub struct Pic {
    pub path: String,
    /// A still (an image or a text drawing), read once.
    pub still: bool,
    /// The picture's codec, so a WebM's alpha is decoded.
    pub codec: Option<String>,
    /// What's read of a video: from `in_us`, `span_us` long.
    pub in_us: Us,
    pub span_us: Us,
    /// When it shows on the window's clock, and for how long.
    pub start_us: Us,
    pub dur_us: Us,
    pub fit: Fit,
    pub picture: String,
    pub speed: f64,
    pub reverse: bool,
    pub look: Look,
    pub grade: Grade,
    pub blend: String,
    /// Typewriter reveals on the layer's own clock: (start s, length s, true for the way in).
    pub reveal: Vec<(f64, f64, bool)>,
    /// A text clip's box in project pixels (centred in its drawing), which a reveal sweeps.
    pub text_box: Option<(f64, f64)>,
    /// A text clip's drawing (a still the project's size).
    pub drawing: bool,
    /// An image whose turn or size changes: rendered once into the cache (motion.rs).
    pub motion: Option<Box<Motion>>,
}

/// An adjustment layer: its colour, colour extras and effects applied to the picture below
/// from `start_us` for `dur_us`.
#[derive(Debug, Clone, PartialEq)]
pub struct Adjust {
    pub start_us: Us,
    pub dur_us: Us,
    pub look: Look,
    pub grade: Grade,
}

/// Effects whose picture changes from frame to frame.
pub(crate) fn moves_in_time(name: &str) -> bool {
    matches!(name, "Film grain" | "VHS" | "Glitch" | "Shake" | "Zoom pulse" | "Light leak")
}

/// The picture tracks' clips between `from` and `to`, bottom track first, timed from `from`.
/// Hidden tracks, text clips not drawn yet and missing files are left out.
pub fn layers_in(p: &Project, from: Us, to: Us, use_proxy: bool) -> Vec<Layer> {
    let mut out = vec![];
    for t in p.tracks.iter().filter(|t| t.is_visual() && !t.hidden) {
        for c in &t.clips {
            if c.end_us() <= from || c.start_us >= to {
                continue;
            }
            let start = c.start_us.max(from);
            let skip = start - c.start_us;
            let dur = c.end_us().min(to) - start;
            let look = Look::of(c, skip, false, p.width, p.height);
            let mut grade = Grade::of(c);
            grade.blur = Moves::of(c, c.duration_us, p.width as f64, p.height as f64).blur;
            grade.blur_offset_s = skip as f64 / 1e6;
            if c.is_synthetic() && c.text.is_none() {
                out.push(Layer::Adjust(Adjust { start_us: start - from, dur_us: dur, look, grade }));
                continue;
            }
            let (path, still, codec) = match (&c.text, p.media(&c.media_id)) {
                (Some(text), _) => match text.get("png").and_then(|v| v.as_str()).filter(|p| Path::new(p).is_file()) {
                    Some(png) => (png.to_string(), true, None),
                    None => continue,
                },
                (None, Some(m)) if m.kind != MediaKind::Audio => (crate::graph::overlay_path(m, use_proxy), m.kind == MediaKind::Image, m.codec.clone()),
                _ => continue,
            };
            let (mut in_us, mut span_us) = source_range(c, skip, dur, still);
            if !still {
                let m = p.media(&c.media_id).expect("checked above");
                grade.ramp = crate::graph::ramp_for(c, skip, dur);
                grade.stab = crate::graph::ready_stab(p, c, m, &path);
                if grade.stab.is_some() {
                    crate::graph::stab_from_start(&mut grade, c, skip);
                    (in_us, span_us) = grade.stab_window.unwrap_or((in_us, span_us));
                }
            }
            let num = |k: &str| c.text.as_ref().and_then(|t| t.get(k)).and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
            let moves = Moves::of(c, c.duration_us, p.width as f64, p.height as f64);
            let motion = match (&c.text, p.media(&c.media_id)) {
                (None, Some(m)) if still => {
                    let whole = Look::of(c, 0, false, p.width, p.height);
                    crate::motion::motion_of(p, c, m, &path, &whole.rotation, &whole.scale, skip)
                }
                _ => None,
            };
            out.push(Layer::Pic(Pic {
                path,
                still,
                codec,
                in_us,
                span_us,
                start_us: start - from,
                dur_us: dur,
                fit: c.fit,
                picture: picture_filter(c),
                speed: if still { 1.0 } else { c.speed },
                reverse: !still && c.reverse,
                look,
                grade,
                blend: c.blend.clone(),
                reveal: moves.reveal.iter().map(|&(a, d, inward)| ((a - skip) as f64 / 1e6, d as f64 / 1e6, inward)).collect(),
                text_box: num("boxW").zip(num("boxH")),
                drawing: c.text.is_some(),
                motion,
            }));
        }
    }
    out
}

/// The filters that put `layers` over `[base]`, ending in `[out]`. Inputs they need are
/// added to `args`, numbered from `next_input`.
pub fn build_layers(layers: &[Layer], base: &str, out: &str, args: &mut Vec<String>, next_input: &mut usize, v: &VideoOut, total_us: Us) -> Vec<String> {
    let mut f = vec![];
    let mut cur = base.to_string();
    let mut j = 0;
    while j < layers.len() {
        let run = if plain_layers() { vec![] } else { slide_run(&layers[j..]) };
        let last = j + run.len().max(1) - 1;
        let next = if last + 1 == layers.len() { out.to_string() } else { format!("c{j}") };
        let made = match &layers[j] {
            _ if run.len() > 1 => slides_filters(&run, j, &cur, &next, args, next_input, v, total_us),
            Layer::Pic(pic) => pic_filters(pic, j, &cur, &next, args, next_input, v, total_us),
            Layer::Adjust(a) => adjust_filters(a, j, &cur, &next, v, total_us),
        };
        f.extend(made);
        cur = next;
        j = last + 1;
    }
    if layers.is_empty() {
        f.push(format!("[{base}]null[{out}]"));
    }
    f
}

#[cfg(test)]
thread_local! {
    /// Tests draw a timeline both ways: captions rows as one layer and stills in stretches,
    /// or every clip on its own frame by frame.
    pub(crate) static PLAIN_LAYERS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn plain_layers() -> bool {
    #[cfg(test)]
    return PLAIN_LAYERS.with(|c| c.get());
    #[cfg(not(test))]
    false
}

/// Seconds, for a filter option.
fn s(us: Us) -> String {
    secs(us)
}

/// The format an overlay works in: the composite's own (YUV for export), so laying a picture
/// on doesn't turn every frame of the video into RGBA and back. An overlay also copies every
/// frame it passes, shown or not, so there should be few of them over a long timeline.
fn over_fmt(v: &VideoOut) -> &'static str {
    if v.pix_fmt.starts_with("yuv420") { "yuv420" } else { "auto" }
}

/// A text drawing with nothing that changes over its time and no grade of its own beyond
/// the look's colour: one that can share a layer with the next.
fn slide(layer: &Layer) -> Option<&Pic> {
    let Layer::Pic(p) = layer else { return None };
    let g = &p.grade;
    let plain = g.effects.is_empty() && g.mask_png.is_none() && g.matte.is_none() && g.blur.is_empty() && g.colour("x").is_empty();
    (p.drawing && p.still && p.reveal.is_empty() && !p.look.animated() && p.blend == "normal" && plain).then_some(p)
}

/// The text drawings from the first layer on that follow one another (each after the last
/// has gone) with the same look: a captions row, shown as one layer that changes picture at
/// each line's start. One overlay instead of one per line.
fn slide_run(layers: &[Layer]) -> Vec<&Pic> {
    let mut run: Vec<&Pic> = vec![];
    for l in layers {
        let Some(p) = slide(l) else { break };
        if let Some(prev) = run.last() {
            if p.look != prev.look || p.fit != prev.fit || p.picture != prev.picture || p.start_us < prev.start_us + prev.dur_us {
                break;
            }
        }
        run.push(p);
    }
    run
}

/// A run of text drawings (`slide_run`) over `[cur]`: each one's single frame at its start,
/// interleaved into one stream, fitted, sized and placed once, and laid on while any of them
/// shows.
#[allow(clippy::too_many_arguments)]
fn slides_filters(run: &[&Pic], j: usize, cur: &str, next: &str, args: &mut Vec<String>, next_input: &mut usize, v: &VideoOut, total_us: Us) -> Vec<String> {
    let (w, h) = (v.width, v.height);
    let tag = format!("o{j}");
    let first = run[0];
    let l = &first.look;
    let k = w as f64 / l.project_w.max(1) as f64;
    let mut f = vec![];
    let mut ins = String::new();
    for (i, p) in run.iter().enumerate() {
        args.extend(["-i".into(), p.path.clone()]);
        f.push(format!("[{}:v]{}{},format=rgba,{},setpts=PTS-STARTPTS+{}/TB[{tag}s{i}]", *next_input, p.picture, fit_against(p.fit, w, h), to_frame(w, h), s(p.start_us)));
        ins.push_str(&format!("[{tag}s{i}]"));
        *next_input += 1;
    }
    let mut c = vec![format!("interleave=nb_inputs={}", run.len())];
    c.extend(color_filters_at(l, k, "t"));
    c.extend(alpha_opacity(l, &tag));
    let Place::Over { mut fg, x, y, .. } = placement_at(l, w, h, true, "t") else { unreachable!("overlays are always placed over") };
    fg[0] = "format=rgba".into();
    c.extend(fg);
    f.push(format!("{ins}{}[{tag}t]", c.join(",")));
    let on: Vec<String> = run.iter().map(|p| format!("between(t,{},{})", s(p.start_us), s((p.start_us + p.dur_us).min(total_us) - 1))).collect();
    f.push(format!("[{cur}][{tag}t]overlay=x='{x}':y='{y}':eval=init:eof_action=repeat:enable='{}':format={}[{next}]", on.join("+"), over_fmt(v)));
    f
}

/// `[cur]` with a piece of it, [a, b) on its clock, replaced by `middle` (which reads
/// `[{tag}mid]`, starting at 0, and ends in `[{tag}q1]`): split, trim and concat, so only the
/// frames inside the range go through it.
fn splice(cur: &str, next: &str, tag: &str, a: Us, b: Us, total_us: Us, pix: &str, middle: Vec<String>) -> Vec<String> {
    let (before, after) = (a > 0, b < total_us);
    let mut f = vec![];
    let parts = 1 + before as usize + after as usize;
    let mut pieces = String::new();
    if parts == 1 {
        f.push(format!("[{cur}]setpts=PTS-STARTPTS[{tag}mid]"));
    } else {
        let outs: String = (0..parts).map(|i| format!("[{tag}s{i}]")).collect();
        f.push(format!("[{cur}]split={parts}{outs}"));
        let mut i = 0;
        if before {
            f.push(format!("[{tag}s{i}]trim=end={},setpts=PTS-STARTPTS,format={pix}[{tag}q0]", s(a)));
            pieces.push_str(&format!("[{tag}q0]"));
            i += 1;
        }
        f.push(format!("[{tag}s{i}]trim=start={}:end={},setpts=PTS-STARTPTS[{tag}mid]", s(a), s(b)));
        i += 1;
        if after {
            f.push(format!("[{tag}s{i}]trim=start={},setpts=PTS-STARTPTS,format={pix}[{tag}q2]", s(b)));
        }
    }
    f.extend(middle);
    if parts == 1 {
        f.push(format!("[{tag}q1]null[{next}]"));
        return f;
    }
    pieces.push_str(&format!("[{tag}q1]"));
    if after {
        pieces.push_str(&format!("[{tag}q2]"));
    }
    f.push(format!("{pieces}concat=n={parts}:v=1:a=0[{next}]"));
    f
}

/// Filters that support timeline editing (`enable`), so an adjustment layer made only of
/// them runs in place, switched on between its times.
const TIMELINE: &[&str] = &["eq", "colorbalance", "curves", "unsharp", "gblur", "vignette", "huesaturation", "lut3d", "hue", "noise", "colorchannelmixer", "pixelize", "lenscorrection", "negate", "chromashift", "rgbashift", "perspective"];

fn with_enable(filter: &str, expr: &str) -> String {
    if filter.contains('=') { format!("{filter}:enable='{expr}'") } else { format!("{filter}=enable='{expr}'") }
}

/// An adjustment layer: its look on the picture below while it plays. Made only of filters
/// with timeline editing, it runs in place with `enable`; otherwise the composite is split,
/// trimmed and joined again around it.
fn adjust_filters(a: &Adjust, j: usize, cur: &str, next: &str, v: &VideoOut, total_us: Us) -> Vec<String> {
    let (w, h, fps) = (v.width, v.height, v.fps);
    let k = w as f64 / a.look.project_w.max(1) as f64;
    let tag = format!("a{j}");
    let (start, end) = (a.start_us.max(0), (a.start_us + a.dur_us).min(total_us));
    let chain_at = |var: &str| {
        let mut c = color_filters_at(&a.look, k, var);
        c.extend(a.grade.colour(&tag));
        c.extend(a.grade.blur_filter(k, &tag));
        c.extend(effects::effect_chain(&a.grade.effects, &Frame { w, h, fps, k, alpha: false, dur: a.dur_us as f64 / 1e6 }, &tag));
        c
    };
    let in_place = chain_at(&format!("(t-{})", s(start)));
    if in_place.is_empty() || end <= start {
        return vec![format!("[{cur}]null[{next}]")];
    }
    let simple = in_place.iter().all(|f| !f.contains('[') && TIMELINE.contains(&f.split(['=', ':']).next().unwrap_or("")));
    if simple {
        let on = format!("between(t,{},{})", s(start), s(end - 1));
        return vec![format!("[{cur}]{}[{next}]", in_place.iter().map(|f| with_enable(f, &on)).collect::<Vec<_>>().join(","))];
    }
    let middle = vec![format!("[{tag}mid]{},format={}[{tag}q1]", chain_at("t").join(","), v.pix_fmt)];
    splice(cur, next, &tag, start, end, total_us, v.pix_fmt, middle)
}

/// How an overlay's fitted picture is made the size of the frame (for masks, mattes and
/// reveals, which are drawn in frame space): cropped where it overflows, padded with
/// see-through where it falls short.
fn to_frame(w: u32, h: u32) -> String {
    format!("crop=w='min(iw,{w})':h='min(ih,{h})',pad=w={w}:h={h}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0")
}

/// An overlay's fit against the frame: covering it (fill) or inside it (fit), with no crop.
pub(crate) fn fit_against(fit: Fit, w: u32, h: u32) -> String {
    let how = if fit == Fit::Fit { "decrease" } else { "increase" };
    format!("scale={w}:{h}:force_original_aspect_ratio={how}:force_divisible_by=2")
}

/// The `-i` for an overlay's picture: a still read once, a video's stretch (WebM through
/// libvpx, which keeps its alpha).
/// An overlay's stream ends at its last frame, and FFmpeg's overlay lets the picture below
/// through from there: a piece cut between frames (any cut made on the timeline) ends a little
/// before its time is up, so the main track showed for the frame at each cut between pieces laid
/// end to end on an overlay track (the user had to overlap them, 2026-11-07). The last frame is
/// held two frames longer; the overlay's own `enable` still ends it exactly on time.
fn hold_last(fps: u32) -> String {
    format!("tpad=stop_mode=clone:stop_duration={}", s(2_000_000 / fps.max(1) as Us))
}

fn pic_input(p: &Pic) -> Vec<String> {
    if p.still {
        return vec!["-i".into(), p.path.clone()];
    }
    let mut a = vec![];
    if p.path.to_ascii_lowercase().ends_with(".webm") || matches!(p.codec.as_deref(), Some("vp8" | "vp9")) {
        a.extend(["-c:v".into(), if p.codec.as_deref() == Some("vp8") { "libvpx" } else { "libvpx-vp9" }.into()]);
    }
    a.extend(["-ss".into(), secs(p.in_us), "-t".into(), secs(p.span_us), "-i".into(), p.path.clone()]);
    a
}

/// One overlay over `[cur]`, into `[next]`.
#[allow(clippy::too_many_arguments)]
fn pic_filters(pic: &Pic, j: usize, cur: &str, next: &str, args: &mut Vec<String>, next_input: &mut usize, v: &VideoOut, total_us: Us) -> Vec<String> {
    let (w, h, fps) = (v.width, v.height, v.fps);
    let tag = format!("o{j}");
    let l = &pic.look;
    let g = &pic.grade;
    let k = w as f64 / l.project_w.max(1) as f64;
    let (start, dur) = (pic.start_us, pic.dur_us);
    let end = (start + dur).min(total_us);
    // Turned and sized once already (motion.rs): read like a video. Playback only: an export
    // draws from the picture itself.
    if let Some(file) = pic.motion.as_ref().filter(|_| keeps_motion(pic) && v.pix_fmt == "rgba").map(|m| m.file(w, h, fps)).filter(|f| f.is_file()) {
        return motion_filters(pic, &file, &tag, cur, next, args, next_input, v, total_us);
    }
    let mut f = vec![];
    args.extend(pic_input(pic));
    let input = *next_input;
    *next_input += 1;
    let varying = !pic.still || l.animated() || !pic.reveal.is_empty() || !g.blur.is_empty() || g.effects.iter().any(|e| moves_in_time(&e.name));
    let framed = g.matte.is_some() || g.mask_png.is_some() || !pic.reveal.is_empty();
    // A still that turns or changes size for part of its time: those parts frame by frame,
    // the rest turned and sized once.
    if pic.still && l.loop_.is_none() && !framed && g.blur.is_empty() && g.effects.is_empty() && pic.blend == "normal" && !plain_layers() {
        let spans = geometry_spans(l, dur as f64 / 1e6, fps);
        if spans.len() > 1 {
            return spans_filters(pic, &spans, input, &tag, cur, next, v, total_us);
        }
    }
    // Picture, fit, and (for masks and reveals) the frame's size.
    let mut c = vec![format!("{}{}{}", stab_filter(g), pic.picture, fit_against(pic.fit, w, h)), "format=rgba".into()];
    if framed {
        c.push(to_frame(w, h));
    }
    // Its own clock from 0: a still repeats its one frame (once fitted, so it's cheap), timed
    // in microseconds: a picture's own clock (1/25 s) would round a 30 fps animation onto 25
    // poses a second.
    let time = if !pic.still {
        let mut t = timing(pic.speed, pic.reverse, g, 0, 0, fps, true);
        t.push(format!("trim=duration={}", s(dur)));
        t
    } else if varying {
        vec![format!("loop=loop=-1:size=1,settb=AVTB,setpts=N/({fps}*TB),trim=duration={}", s(dur))]
    } else {
        vec!["setpts=PTS-STARTPTS".into()]
    };
    c.extend(time.iter().cloned());
    let mut colour = color_filters_at(l, k, "t");
    colour.extend(g.colour(&tag));
    if !colour.is_empty() {
        c.push(effects::keep_alpha(&colour.join(","), &format!("{tag}k")));
    }
    c.extend(g.blur_filter(k, &tag));
    let Place::Over { mut fg, x, y, eval } = placement_at(l, w, h, true, "t") else { unreachable!("overlays are always placed over") };
    // Kept in RGBA: text edges stay sharp in colour.
    fg[0] = "format=rgba".into();
    // A still repeated for its time (it moves, or fades) with a size or turn that doesn't
    // change: sized and turned once, before it's repeated, not on every frame.
    if pic.still && varying && g.blur.is_empty() && !framed {
        // `fg` is the format, then the turn and the size, either of them changing or not: the
        // fixed ones before the first changing one move ahead of the repeat.
        let changes = |x: &String| x.contains("eval=frame") || x.starts_with("rotate=a='");
        let n = fg.iter().skip(1).take_while(|x| !changes(x)).count();
        let fixed: Vec<String> = fg.drain(1..1 + n).collect();
        c.splice(2..2, fixed);
    }
    // Alpha from a matte, a mask and typewriter reveals, multiplied into the picture's own.
    let mut sources = vec![];
    if let Some(matte) = &g.matte {
        // The matte keeps the source's time; a still's matte is its one frame, held.
        if !pic.still {
            args.extend(["-ss".into(), secs(pic.in_us), "-t".into(), secs(pic.span_us)]);
        }
        args.extend(["-i".into(), matte.clone()]);
        let mut m = vec![format!("{}{}{}", stab_filter(g), pic.picture, fit_against(pic.fit, w, h)), to_frame(w, h)];
        m.extend(time.iter().cloned());
        f.push(format!("[{}:v]{},format=gray[{tag}mt]", *next_input, m.join(",")));
        *next_input += 1;
        sources.push(format!("[{tag}mt]"));
    }
    if let Some(mask) = &g.mask_png {
        args.extend(["-i".into(), mask.clone()]);
        f.push(mask_chain(*next_input, w, h, &format!("{tag}mk")));
        *next_input += 1;
        sources.push(format!("[{tag}mk]"));
    }
    for (i, &(at, len, inward)) in pic.reveal.iter().enumerate() {
        // A white edge sweeping across the text's box: left of it shows, right of it doesn't.
        let bw = pic.text_box.map_or(w as f64, |(bw, _)| (bw * k).min(w as f64));
        let x0 = (w as f64 - bw) / 2.0;
        let p = format!("clip((t-({at:.4}))/{:.4},0,1)", len.max(0.01));
        let edge = if inward { p } else { format!("(1-{p})") };
        let r = format!("{tag}r{i}");
        f.push(format!("color=c=black:s={w}x{h}:r={fps}:d={}[{r}k];color=c=white:s={w}x{h}:r={fps}:d={}[{r}w];[{r}k][{r}w]overlay=x='{x0:.2}+{bw:.2}*{edge}-W':y=0:eval=frame,format=gray[{r}]", s(dur), s(dur)));
        sources.push(format!("[{r}]"));
    }
    if !sources.is_empty() {
        f.push(format!("[{input}:v]{},split[{tag}pa][{tag}pb]", c.join(",")));
        let mut al = format!("[{tag}pc]");
        f.push(format!("[{tag}pb]alphaextract{al}"));
        for (i, src) in sources.iter().enumerate() {
            let out = format!("[{tag}m{i}]");
            f.push(format!("{al}{src}blend=all_mode=multiply{out}"));
            al = out;
        }
        f.push(format!("[{tag}pa]{al}alphamerge[{tag}p]"));
    } else {
        f.push(format!("[{input}:v]{}[{tag}p]", c.join(",")));
    }
    let mut after = vec![];
    after.extend(alpha_opacity(l, &tag));
    after.extend(fg);
    let canvas = !g.effects.is_empty() || pic.blend != "normal";
    let a = s(start);
    if canvas {
        // Placed on a see-through layer the size of the frame, then the effects.
        f.push(format!("[{tag}p]{}[{tag}f]", after.join(",")));
        f.push(format!("color=c=black@0:s={w}x{h}:r={fps}:d={},format=rgba[{tag}cv]", s(dur)));
        let fx = effects::effect_chain(&g.effects, &Frame { w, h, fps, k, alpha: true, dur: dur as f64 / 1e6 }, &tag);
        let fx = if fx.is_empty() { String::new() } else { format!(",{}", fx.join(",")) };
        f.push(format!("[{tag}cv][{tag}f]overlay=x='{x}':y='{y}':eval={eval}:format=auto{fx},trim=duration={}[{tag}l]", s(dur)));
        if pic.blend != "normal" {
            return f.into_iter().chain(blend_splice(pic, &tag, cur, next, start, end, total_us, v)).collect();
        }
        f.push(format!("[{tag}l]{},setpts=PTS-STARTPTS+{a}/TB[{tag}t]", hold_last(fps)));
        f.push(format!("[{cur}][{tag}t]overlay=x=0:y=0:eof_action=pass:enable='between(t,{a},{})':format={}[{next}]", s(end - 1), over_fmt(v)));
        return f;
    }
    if varying {
        after.push(hold_last(fps));
    }
    after.push(format!("setpts=PTS-STARTPTS+{a}/TB"));
    f.push(format!("[{tag}p]{}[{tag}t]", after.join(",")));
    // On the composite's clock, the position's expressions count from the overlay's start.
    let Place::Over { x, y, .. } = placement_at(l, w, h, true, &format!("(t-{a})")) else { unreachable!() };
    // A still that doesn't change is one frame, held for its time.
    let eof = if varying { "pass" } else { "repeat" };
    f.push(format!("[{cur}][{tag}t]overlay=x='{x}':y='{y}':eval={eval}:eof_action={eof}:enable='between(t,{a},{})':format={}[{next}]", s(end - 1), over_fmt(v)));
    f
}

/// Whether a picture plays from its motion file once that's made: an image that turns or
/// changes size, with nothing else drawn frame by frame on the picture itself (masks, mattes,
/// blur, effects, a blend mode, a loop animation).
pub(crate) fn keeps_motion(pic: &Pic) -> bool {
    let g = &pic.grade;
    pic.motion.is_some() && pic.still && !pic.drawing && pic.look.loop_.is_none() && g.matte.is_none() && g.mask_png.is_none() && pic.reveal.is_empty() && g.blur.is_empty() && g.effects.is_empty() && pic.blend == "normal" && !plain_layers()
}

/// A picture from its motion file (frames already turned and sized, on a canvas centred on
/// the picture): read from where this stretch starts in the clip, given its colour and
/// opacity, and laid on at its place.
#[allow(clippy::too_many_arguments)]
fn motion_filters(pic: &Pic, file: &Path, tag: &str, cur: &str, next: &str, args: &mut Vec<String>, next_input: &mut usize, v: &VideoOut, total_us: Us) -> Vec<String> {
    let (w, h) = (v.width, v.height);
    let l = &pic.look;
    let k = w as f64 / l.project_w.max(1) as f64;
    let skip = pic.motion.as_ref().map_or(0, |m| m.skip_us);
    args.extend(["-ss".into(), secs(skip), "-t".into(), secs(pic.dur_us), "-i".into(), file.to_string_lossy().into_owned()]);
    let input = *next_input;
    *next_input += 1;
    let mut c = vec!["format=rgba".to_string(), "setpts=PTS-STARTPTS".into()];
    let mut colour = color_filters_at(l, k, "t");
    colour.extend(pic.grade.colour(tag));
    if !colour.is_empty() {
        c.push(effects::keep_alpha(&colour.join(","), &format!("{tag}k")));
    }
    c.extend(alpha_opacity(l, tag));
    let a = s(pic.start_us);
    c.push(hold_last(v.fps));
    c.push(format!("setpts=PTS+{a}/TB"));
    let Place::Over { x, y, eval, .. } = placement_at(l, w, h, true, &format!("(t-{a})")) else { unreachable!("overlays are always placed over") };
    let end = (pic.start_us + pic.dur_us).min(total_us);
    vec![
        format!("[{input}:v]{}[{tag}t]", c.join(",")),
        format!("[{cur}][{tag}t]overlay=x='{x}':y='{y}':eval={eval}:eof_action=pass:enable='between(t,{a},{})':format={}[{next}]", s(end - 1), over_fmt(v)),
    ]
}

/// The stretches of a still's time, in frames, over which its turn and its size are each
/// fixed (at that value) or changing: (first frame, frames, turn, size). Empty when neither
/// changes.
fn geometry_spans(l: &Look, dur: f64, fps: u32) -> Vec<(u64, u64, Option<f64>, Option<f64>)> {
    if !moving(&l.rotation) && !moving(&l.scale) {
        return vec![];
    }
    // Fixed or changing between the keyframes' own times; then each stretch in whole frames.
    let mut at: Vec<f64> = l.rotation.iter().chain(l.scale.iter()).map(|p| p.0).filter(|t| *t > 0.0 && *t < dur).collect();
    at.extend([0.0, dur]);
    at.sort_by(f64::total_cmp);
    at.dedup();
    let mut spans: Vec<(f64, f64, Option<f64>, Option<f64>)> = vec![];
    for w in at.windows(2) {
        let (a, b) = (w[0], w[1]);
        let fixed = |c: &Curve, d: f64| {
            let (x, y) = (curve_at(c, a, d), curve_at(c, b, d));
            ((x - y).abs() < 1e-9).then_some(x)
        };
        let (turn, size) = (fixed(&l.rotation, 0.0), fixed(&l.scale, 100.0));
        match spans.last_mut() {
            Some(last) if last.2 == turn && last.3 == size => last.1 = b,
            _ => spans.push((a, b, turn, size)),
        }
    }
    let frames = |t: f64| (t * fps as f64).round() as u64;
    spans.into_iter().map(|(a, b, turn, size)| (frames(a), frames(b).saturating_sub(frames(a)), turn, size)).filter(|s| s.1 > 0).collect()
}

/// A still in stretches (`geometry_spans`): each stretch repeats the picture turned and sized
/// once where that's fixed, and frame by frame only where it changes, laid on for its own
/// time (the stretches' sizes differ, so they aren't joined into one stream).
#[allow(clippy::too_many_arguments)]
fn spans_filters(pic: &Pic, spans: &[(u64, u64, Option<f64>, Option<f64>)], input: usize, tag: &str, cur: &str, next: &str, v: &VideoOut, total_us: Us) -> Vec<String> {
    let (w, h, fps) = (v.width, v.height, v.fps);
    let l = &pic.look;
    let k = w as f64 / l.project_w.max(1) as f64;
    let mut f = vec![];
    let outs: String = (0..spans.len()).map(|i| format!("[{tag}f{i}]")).collect();
    f.push(format!("[{input}:v]{}{},format=rgba,split={}{outs}", pic.picture, fit_against(pic.fit, w, h), spans.len()));
    let a = s(pic.start_us);
    let Place::Over { x, y, .. } = placement_at(l, w, h, true, &format!("(t-{a})")) else { unreachable!("overlays are always placed over") };
    let end = (pic.start_us + pic.dur_us).min(total_us);
    let mut below = cur.to_string();
    for (i, &(first, n, turn, size)) in spans.iter().enumerate() {
        let st = format!("{tag}{i}");
        let mut c: Vec<String> = vec![];
        // Fixed: once, before the picture repeats; then on the clip's own clock.
        c.extend(turn.and_then(turn_fixed));
        c.extend(size.and_then(|s| size_fixed(s / 100.0)));
        // A frame past its stretch: an overlay lets go of a stream at its last frame's time,
        // which would leave that frame out (the overlay's window still ends the stretch).
        c.push(format!("loop=loop=-1:size=1,settb=AVTB,setpts=N/({fps}*TB),trim=end_frame={},setpts=PTS+{first}/({fps}*TB)", n + 1));
        let mut colour = color_filters_at(l, k, "t");
        colour.extend(pic.grade.colour(&st));
        if !colour.is_empty() {
            c.push(effects::keep_alpha(&colour.join(","), &format!("{st}k")));
        }
        c.extend(alpha_opacity(l, &st));
        // Changing: frame by frame.
        if turn.is_none() {
            c.push(turn_moving(&curve_expr(&l.rotation, "t")));
        }
        if size.is_none() {
            c.push(size_moving(&curve_expr(&l.scale, "t")));
        }
        c.push(format!("setpts=PTS+{a}/TB"));
        f.push(format!("[{tag}f{i}]{}[{tag}g{i}]", c.join(",")));
        let (from, to) = (pic.start_us + (first * 1_000_000 / fps as u64) as Us, (pic.start_us + ((first + n) * 1_000_000 / fps as u64) as Us).min(end));
        let out = if i + 1 == spans.len() { next.to_string() } else { format!("{tag}c{i}") };
        f.push(format!("[{below}][{tag}g{i}]overlay=x='{x}':y='{y}':eval=frame:eof_action=pass:enable='between(t,{},{})':format={}[{out}]", s(from), s(to - 1), over_fmt(v)));
        below = out;
    }
    f
}

/// A blend mode: the composite's frames under the layer go through `blend` with it, and the
/// result is laid over them through the layer's alpha. Only those frames are split off.
#[allow(clippy::too_many_arguments)]
fn blend_splice(pic: &Pic, tag: &str, cur: &str, next: &str, start: Us, end: Us, total_us: Us, v: &VideoOut) -> Vec<String> {
    let mode = match pic.blend.as_str() {
        "add" => "addition",
        m => m,
    };
    // FFmpeg's overlay mode decides by its top input (the picture below, here); the rest
    // read the layer as their top.
    let (top, bottom) = if mode == "overlay" { (format!("[{tag}m2]"), format!("[{tag}lc]")) } else { (format!("[{tag}lc]"), format!("[{tag}m2]")) };
    let middle = vec![
        format!("[{tag}mid]format=gbrp,split[{tag}m1][{tag}m2]"),
        format!("[{tag}l]split[{tag}l1][{tag}l2]"),
        format!("[{tag}l1]alphaextract[{tag}la]"),
        format!("[{tag}l2]format=gbrp[{tag}lc]"),
        format!("{top}{bottom}blend=all_mode={mode},format=gbrap[{tag}bl]"),
        format!("[{tag}bl][{tag}la]alphamerge[{tag}bm]"),
        format!("[{tag}m1][{tag}bm]overlay=format=auto,format={}[{tag}q1]", v.pix_fmt),
    ];
    splice(cur, next, tag, start, end, total_us, v.pix_fmt, middle)
}

