//! Animation presets (a clip's way in, way out and loop) built from the same curves keyframes
//! make: opacity, scale, position and rotation over the clip's time. Two need filters of
//! their own: the blur (stepped with `sendcmd`) and the typewriter reveal (a moving alpha
//! edge, for text).

use studio_engine_core::model::{AnimStep, Clip, Us};

/// Points (clip time, value) of one setting the animation drives.
pub type Track = Vec<(Us, f64)>;

/// What a clip's in and out animations do, as curves over the clip's own time. Opacity and
/// scale multiply the clip's own values, the offsets (project pixels) and rotation (degrees)
/// add to them, and the blur is a gaussian sigma in project pixels.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Moves {
    pub opacity: Track,
    pub scale: Track,
    pub dx: Track,
    pub dy: Track,
    pub rotation: Track,
    pub blur: Track,
    /// Typewriter reveals: (start, length, true for the way in) in clip time.
    pub reveal: Vec<(Us, Us, bool)>,
}

/// Ease-out (fast then settling) from 0 to 1, sampled so straight lines between the points
/// follow the curve closely.
const EASE: [(f64, f64); 6] = [(0.0, 0.0), (0.15, 0.386), (0.3, 0.657), (0.5, 0.875), (0.75, 0.984), (1.0, 1.0)];

/// `from` to `to` over [a, a + d], eased when `ease`. On the way out the easing is mirrored
/// (slow then fast), so the clip leaves the way it came in.
fn ramp(a: Us, d: Us, from: f64, to: f64, ease: bool, out: bool) -> Track {
    let shape: Vec<(f64, f64)> = if !ease {
        vec![(0.0, 0.0), (1.0, 1.0)]
    } else if out {
        EASE.iter().rev().map(|&(p, e)| (1.0 - p, 1.0 - e)).collect()
    } else {
        EASE.to_vec()
    };
    shape.into_iter().map(|(p, e)| (a + (d as f64 * p).round() as Us, from + (to - from) * e)).collect()
}

/// Joins two curves on the same setting that cover different parts of the clip (the way in
/// and the way out), holding the rest value between them.
fn join(mut a: Track, b: Track) -> Track {
    if a.is_empty() {
        return b;
    }
    let last = a.last().map_or(Us::MIN, |l| l.0);
    a.extend(b.into_iter().filter(|p| p.0 > last));
    a
}

impl Moves {
    /// The moves for a clip `len` long, in a frame of `w`×`h` project pixels.
    pub fn of(c: &Clip, len: Us, w: f64, h: f64) -> Moves {
        let mut m = Moves::default();
        for (step, out) in [(&c.anim.in_, false), (&c.anim.out, true)] {
            let Some(AnimStep { name, duration_us }) = step else { continue };
            let d = (*duration_us).clamp(1, len.max(1));
            let a = if out { len - d } else { 0 };
            // The way out runs the way in backwards in time, leaving in the direction it moves.
            let span = |rest: f64, away: f64, ease: bool| if out { ramp(a, d, rest, away, ease, true) } else { ramp(a, d, away, rest, ease, false) };
            let fade_part = |part: f64| {
                let dd = ((d as f64) * part).round() as Us;
                if out { ramp(len - dd, dd, 1.0, 0.0, false, true) } else { ramp(0, dd, 0.0, 1.0, false, false) }
            };
            let sign = if out { -1.0 } else { 1.0 };
            let mut o = Moves::default();
            match name.as_str() {
                "Fade" => o.opacity = span(1.0, 0.0, false),
                "Slide up" => (o.dy, o.opacity) = (span(0.0, 0.12 * h * sign, true), fade_part(0.6)),
                "Slide down" => (o.dy, o.opacity) = (span(0.0, -0.12 * h * sign, true), fade_part(0.6)),
                "Slide left" => (o.dx, o.opacity) = (span(0.0, 0.12 * w * sign, true), fade_part(0.6)),
                "Slide right" => (o.dx, o.opacity) = (span(0.0, -0.12 * w * sign, true), fade_part(0.6)),
                "Zoom in" => (o.scale, o.opacity) = (span(1.0, if out { 1.4 } else { 0.6 }, true), fade_part(1.0)),
                "Zoom out" => (o.scale, o.opacity) = (span(1.0, if out { 0.6 } else { 1.4 }, true), fade_part(1.0)),
                "Pop" => {
                    // Overshoots to 115 % and settles.
                    let peak = a + (d as f64 * if out { 0.3 } else { 0.7 }).round() as Us;
                    o.scale = if out { vec![(a, 1.0), (peak, 1.15), (a + d, 0.0)] } else { vec![(a, 0.0), (peak, 1.15), (a + d, 1.0)] };
                    o.opacity = fade_part(0.3);
                }
                "Spin" => (o.rotation, o.scale, o.opacity) = (span(0.0, -180.0 * sign, true), span(1.0, 0.4, true), fade_part(1.0)),
                "Blur in" => (o.blur, o.opacity) = (span(0.0, 30.0, true), fade_part(0.5)),
                "Typewriter" => o.reveal.push((a, d, !out)),
                _ => {}
            }
            m.opacity = join(std::mem::take(&mut m.opacity), o.opacity);
            m.scale = join(std::mem::take(&mut m.scale), o.scale);
            m.dx = join(std::mem::take(&mut m.dx), o.dx);
            m.dy = join(std::mem::take(&mut m.dy), o.dy);
            m.rotation = join(std::mem::take(&mut m.rotation), o.rotation);
            m.blur = join(std::mem::take(&mut m.blur), o.blur);
            m.reveal.extend(o.reveal);
        }
        m
    }
}

/// A curve's value at `t`: straight lines between points, flat outside them; `rest` without points.
pub fn at(t: &Track, x: Us, rest: f64) -> f64 {
    let (Some(first), Some(last)) = (t.first(), t.last()) else { return rest };
    if x <= first.0 {
        return first.1;
    }
    if x >= last.0 {
        return last.1;
    }
    let i = t.iter().position(|p| p.0 > x).unwrap_or(t.len() - 1);
    let (a, b) = (t[i - 1], t[i]);
    a.1 + (b.1 - a.1) * (x - a.0) as f64 / (b.0 - a.0).max(1) as f64
}

/// Two curves combined point by point (`f`), sampled at both curves' points and between
/// them, so the result is again straight lines that follow the product or sum closely.
pub fn combine(base: &Track, anim: &Track, rest_base: f64, rest_anim: f64, f: impl Fn(f64, f64) -> f64) -> Track {
    let mut xs: Vec<Us> = base.iter().chain(anim.iter()).map(|p| p.0).collect();
    xs.sort();
    xs.dedup();
    let mut fine = vec![];
    for w in xs.windows(2) {
        for k in 0..4 {
            fine.push(w[0] + (w[1] - w[0]) * k / 4);
        }
    }
    fine.extend(xs.last());
    fine.into_iter().map(|x| (x, f(at(base, x, rest_base), at(anim, x, rest_anim)))).collect()
}

/// The animated blur: a gaussian blur whose sigma steps along the curve (`sendcmd`, ten
/// steps a second), switched off where there's none. `offset_s` is the clip time at the
/// chain's t = 0, and `k` the output's scale.
pub fn blur_filter(blur: &Track, offset_s: f64, k: f64, tag: &str) -> Option<String> {
    let (first, last) = (blur.first()?, blur.last()?);
    let (a, b) = (first.0 as f64 / 1e6 - offset_s, last.0 as f64 / 1e6 - offset_s);
    let steps = (((b - a) * 10.0).ceil() as usize).clamp(2, 200);
    let cmds: Vec<String> = (0..=steps)
        .map(|i| {
            let t = a + (b - a) * i as f64 / steps as f64;
            let sigma = at(blur, ((t + offset_s) * 1e6) as Us, 0.0) * k;
            format!("{:.3} gblur@{tag} sigma {:.2}", t.max(0.0), sigma.max(0.0))
        })
        .collect();
    let start = at(blur, ((offset_s.max(0.0)) * 1e6) as Us, 0.0) * k;
    // Only on while the curve isn't at rest: before it for a way out, after it for a way in.
    let on = if first.1 > last.1 { format!("lt(t,{b:.3})") } else { format!("gte(t,{a:.3})") };
    Some(format!("sendcmd=c='{}',gblur@{tag}=sigma={start:.2}:enable='{on}'", cmds.join(";")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::model::{AnimLoop, AnimStep, SECOND};

    fn clip(in_: Option<&str>, out: Option<&str>) -> Clip {
        let mut c = Clip::new("c".into(), String::new(), 0, 0, 4 * SECOND);
        c.anim.in_ = in_.map(|n| AnimStep { name: n.into(), duration_us: SECOND });
        c.anim.out = out.map(|n| AnimStep { name: n.into(), duration_us: SECOND });
        c.anim.loop_ = Some(AnimLoop { name: "Pulse".into(), period_us: SECOND });
        c
    }

    #[test]
    fn ways_in_and_out_are_curves_over_the_clip() {
        let m = Moves::of(&clip(Some("Fade"), Some("Fade")), 4 * SECOND, 1080.0, 1920.0);
        assert_eq!(m.opacity, vec![(0, 0.0), (SECOND, 1.0), (3 * SECOND, 1.0), (4 * SECOND, 0.0)]);
        let m = Moves::of(&clip(Some("Slide up"), Some("Slide up")), 4 * SECOND, 1080.0, 1920.0);
        assert!((at(&m.dy, 0, 0.0) - 230.4).abs() < 1e-6 && at(&m.dy, SECOND, 0.0) == 0.0, "comes up from below");
        assert!((at(&m.dy, 4 * SECOND, 0.0) + 230.4).abs() < 1e-6, "and leaves upwards");
        assert!(at(&m.dy, SECOND / 2, 0.0) < 0.2 * 230.4, "eased: most of the way there by halfway");
        let pop = Moves::of(&clip(Some("Pop"), None), 4 * SECOND, 1080.0, 1920.0);
        assert_eq!(pop.scale.iter().map(|p| p.1).fold(0.0, f64::max), 1.15);
        let tw = Moves::of(&clip(Some("Typewriter"), Some("Blur in")), 4 * SECOND, 1080.0, 1920.0);
        assert_eq!(tw.reveal, vec![(0, SECOND, true)]);
        assert_eq!((at(&tw.blur, 3 * SECOND, 0.0), at(&tw.blur, 4 * SECOND, 0.0)), (0.0, 30.0));
    }

    #[test]
    fn combined_curves_follow_the_product_and_blur_steps() {
        let base = vec![(0, 50.0), (2 * SECOND, 100.0)];
        let anim = vec![(0, 0.0), (SECOND, 1.0)];
        let c = combine(&base, &anim, 100.0, 1.0, |a, b| a * b);
        assert!((at(&c, SECOND / 2, 0.0) - 62.5 * 0.5).abs() < 2.0, "{c:?}");
        assert_eq!(at(&c, 2 * SECOND, 0.0), 100.0);
        let f = blur_filter(&vec![(0, 30.0), (SECOND, 0.0)], 0.0, 0.5, "b1").unwrap();
        assert!(f.starts_with("sendcmd=c='0.000 gblur@b1 sigma 15.00;") && f.ends_with(",gblur@b1=sigma=15.00:enable='lt(t,1.000)'"), "{f}");
        assert!(blur_filter(&vec![], 0.0, 1.0, "x").is_none());
    }
}
