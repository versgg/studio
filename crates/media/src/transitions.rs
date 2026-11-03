//! Transitions on the main track's cuts: which cuts have one (and how long), and joining the
//! segments with xfade where they do and concat where they don't.
//!
//! The total length never changes: the clip before runs on for half the transition past the
//! cut and the clip after starts half of it early (from source handles where the file has
//! them, held frames where not; see `graph::timeline_window`). xfade then overlaps the two by
//! the whole transition.

use crate::secs;
use studio_engine_core::look::xfade_name;
use studio_engine_core::model::{Project, Us};

/// The main track's transitions: (index of the clip after the cut, xfade's name, length).
/// Only cuts where the clip before ends exactly where this one starts count, and the length
/// is kept within both clips (so the halves at either end of a clip never overlap).
pub fn cuts(p: &Project) -> Vec<(usize, &'static str, Us)> {
    let clips = &p.main_track().clips;
    let frame = 1_000_000 / p.fps.max(1) as Us;
    let mut out = vec![];
    for i in 1..clips.len() {
        let (a, b) = (&clips[i - 1], &clips[i]);
        let Some(t) = &b.transition else { continue };
        let Some(name) = xfade_name(&t.name) else { continue };
        if a.end_us() != b.start_us || p.media(&a.media_id).is_none() || p.media(&b.media_id).is_none() {
            continue;
        }
        let d = t.duration_us.min(a.duration_us).min(b.duration_us);
        // Shorter than two frames there is nothing to see.
        if d >= 2 * frame {
            out.push((i, name, d));
        }
    }
    out
}

/// Joins `[v0]`…`[vN]` into `[out]`: runs of segments with concat, and an xfade into each
/// segment that has a transition in, starting `d` before the end of what's joined so far.
/// `segs` are each segment's picture length (with its extra picture) and its transition in.
/// The result is held to exactly the joined length (xfade can end a frame short) and ends
/// with `tail` (the pixel format).
pub fn join(segs: &[(Us, Option<(String, Us)>)], fps: u32, tail: &str, out: &str) -> Vec<String> {
    let mut f = vec![];
    let mut run: Vec<String> = vec![];
    let mut len: Us = 0;
    for (n, (seg_len, xin)) in segs.iter().enumerate() {
        match xin {
            Some((name, d)) if n > 0 && !run.is_empty() => {
                // What's joined so far as one stream (on the project's clock, as xfade wants).
                let first = if run.len() == 1 {
                    run.pop().unwrap_or_default()
                } else {
                    f.push(format!("{}concat=n={}:v=1:a=0,fps={fps}[j{n}]", run.concat(), run.len()));
                    run.clear();
                    format!("[j{n}]")
                };
                f.push(format!("{first}[v{n}]xfade=transition={name}:duration={}:offset={}[x{n}]", secs(*d), secs((len - d).max(0))));
                run.push(format!("[x{n}]"));
                len += seg_len - d;
            }
            _ => {
                run.push(format!("[v{n}]"));
                len += seg_len;
            }
        }
    }
    let hold = format!("fps={fps},tpad=stop_mode=clone:stop_duration={},trim=duration={},{tail}", secs(2_000_000 / fps.max(1) as Us), secs(len));
    if run.len() == 1 {
        f.push(format!("{}{hold}[{out}]", run[0]));
    } else {
        f.push(format!("{}concat=n={}:v=1:a=0,{hold}[{out}]", run.concat(), run.len()));
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::model::{Media, MediaKind, SECOND};

    #[test]
    fn cuts_need_touching_clips_and_fit_both() {
        let mut p = Project::new("T", "9:16");
        for (id, secs) in [("a", 4), ("b", 1)] {
            p.media.push(Media { id: id.into(), path: id.into(), name: id.into(), kind: MediaKind::Video, duration_us: secs * SECOND, ..Default::default() });
        }
        p.insert("a", 0).unwrap();
        p.insert("b", 9 * SECOND).unwrap();
        p.insert("a", 9 * SECOND).unwrap();
        let ids: Vec<String> = p.main_track().clips.iter().map(|c| c.id.clone()).collect();
        p.set_transition(&ids[1], Some("Dissolve"), Some(2 * SECOND)).unwrap();
        p.set_transition(&ids[2], Some("Circle"), Some(SECOND / 2)).unwrap();
        assert_eq!(cuts(&p), vec![(1, "fade", SECOND), (2, "circleopen", SECOND / 2)], "kept within the 1 s clip");
    }

    #[test]
    fn segments_join_with_concat_and_xfade() {
        let j = join(&[(2 * SECOND + SECOND / 4, None), (SECOND + SECOND / 4, Some(("fade".into(), SECOND / 2))), (SECOND, None)], 30, "format=rgba", "vmain");
        assert_eq!(j[0], "[v0][v1]xfade=transition=fade:duration=0.500000:offset=1.750000[x1]");
        assert_eq!(j[1], "[x1][v2]concat=n=2:v=1:a=0,fps=30,tpad=stop_mode=clone:stop_duration=0.066666,trim=duration=4.000000,format=rgba[vmain]");
        let j = join(&[(SECOND, None), (SECOND, None), (SECOND, Some(("wipeleft".into(), SECOND / 2)))], 30, "format=rgba", "o");
        assert_eq!(j[0], "[v0][v1]concat=n=2:v=1:a=0,fps=30[j2]");
        assert_eq!(j[1], "[j2][v2]xfade=transition=wipeleft:duration=0.500000:offset=1.500000[x2]");
        assert!(j[2].starts_with("[x2]fps=30,tpad") && j[2].ends_with("trim=duration=2.500000,format=rgba[o]"), "{}", j[2]);
    }
}
