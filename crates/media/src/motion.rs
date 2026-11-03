//! Stills that turn or change size, rendered once. FFmpeg can only turn and size a picture
//! frame by frame by setting its filters up again on every frame (30–50 ms of CPU each), so
//! a few photos flying in at once outran real time in playback (a
//! slideshow of polaroids, 2026-11-01). A picture whose turn or size moves is drawn once, at the preview's size, into
//! the project's cache (`<cache>/<media id>/motion-<key>.mov`, QuickTime Animation: alpha,
//! and the quickest of FFmpeg's alpha codecs to read back), every frame its own keyframe so
//! any stretch starts on its own frame. Playback lays that file on like a video; until it's
//! made, and for export (a size of its own), the picture is turned and sized as it plays.

use crate::compose::{Pic, fit_against};
use crate::graph::{Curve, curve_at, curve_expr, moving, size_fixed, size_moving, turn_fixed, turn_moving};
use crate::{Ffmpeg, derive::run};
use std::path::{Path, PathBuf};
use studio_engine_core::model::{Clip, Fit, Media, Project, Us};

/// A canvas side past which the picture is turned and sized as it plays instead (a very large
/// picture made very large would make a file too big to be worth reading).
const MAX_SIDE: f64 = 2048.0;

/// The most picture a file may hold, in pixels shown over all its frames (~2.5 bytes each in
/// QuickTime Animation: a 5 s polaroid flying in and shrinking away is ~9 M, 22 MB). A photo
/// the frame's size zooming slowly for 5 s would be ~90 M (200 MB+), and alone it keeps up
/// when sized frame by frame.
const MAX_SHOWN_PX: f64 = 25e6;

/// What a picture's rendered motion depends on, apart from the output's size and rate.
#[derive(Debug, Clone, PartialEq)]
pub struct Motion {
    /// `<cache>/<media id>`, where the file goes.
    dir: PathBuf,
    /// The source, its picture filters and fit, the project's size and the clip's whole-clip
    /// turn and size: anything that changes them changes the file's name.
    key: String,
    /// The picture's size after its crop and quarter turns, before it's fitted.
    src: (f64, f64),
    rotation: Curve,
    scale: Curve,
    /// The clip's length, and where in it this layer starts.
    dur_us: Us,
    pub(crate) skip_us: Us,
}

/// The motion of a clip's picture (an image) whose turn or size changes over the clip, if
/// the project has a cache. `rotation` and `scale` are the clip's own curves from its start.
pub(crate) fn motion_of(p: &Project, c: &Clip, m: &Media, path: &str, rotation: &Curve, scale: &Curve, skip: Us) -> Option<Box<Motion>> {
    if !moving(rotation) && !moving(scale) || m.width == 0 || m.height == 0 {
        return None;
    }
    let cache = p.cache_dir.as_ref()?;
    let meta = std::fs::metadata(path).ok()?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let crop = c.crop.map_or((1.0, 1.0), |k| (k.w, k.h));
    let (w, h) = (m.width as f64 * crop.0, m.height as f64 * crop.1);
    let src = if c.rotate % 180 == 90 { (h, w) } else { (w, h) };
    let key = format!("{path}|{}|{stamp}|{}|{:?}|{}x{}|{}|{rotation:?}|{scale:?}", meta.len(), crate::graph::picture_filter(c), c.fit, p.width, p.height, c.duration_us);
    Some(Box::new(Motion { dir: Path::new(cache).join(&m.id), key, src, rotation: rotation.clone(), scale: scale.clone(), dur_us: c.duration_us, skip_us: skip }))
}

impl Motion {
    /// The file for output `w`×`h` at `fps`.
    pub fn file(&self, w: u32, h: u32, fps: u32) -> PathBuf {
        self.dir.join(format!("motion-{:016x}.mov", fnv(&format!("{}|{w}x{h}@{fps}", self.key))))
    }

    /// The canvas every frame is drawn on: big enough for the picture at its largest and at
    /// any angle it takes, its middle the picture's middle; even sides. None past `MAX_SIDE`,
    /// or when the file would hold more than `MAX_SHOWN_PX`.
    fn canvas(&self, fit: Fit, w: u32, h: u32, fps: u32) -> Option<(u32, u32)> {
        let (sw, sh) = self.src;
        let k = if fit == Fit::Fit { (w as f64 / sw).min(h as f64 / sh) } else { (w as f64 / sw).max(h as f64 / sh) };
        let (fw, fh) = (sw * k, sh * k);
        let frames = (self.dur_us as f64 / 1e6 * fps as f64).ceil() as u64;
        let shown: f64 = (0..frames).map(|n| (curve_at(&self.scale, n as f64 / fps as f64, 100.0) / 100.0).powi(2)).sum::<f64>() * fw * fh;
        if shown > MAX_SHOWN_PX {
            return None;
        }
        let (bw, bh) = if moving(&self.rotation) {
            let d = fw.hypot(fh);
            (d, d)
        } else {
            let a = curve_at(&self.rotation, 0.0, 0.0).to_radians();
            (fw * a.cos().abs() + fh * a.sin().abs(), fw * a.sin().abs() + fh * a.cos().abs())
        };
        // Straight lines between points: the largest size is at one of them.
        let most = self.scale.iter().map(|p| p.1).fold(curve_at(&self.scale, 0.0, 100.0), f64::max) / 100.0;
        let side = |x: f64| ((x * most + 4.0) / 2.0).ceil() as u32 * 2;
        let (cw, ch) = (side(bw), side(bh));
        (cw as f64 <= MAX_SIDE && ch as f64 <= MAX_SIDE).then_some((cw, ch))
    }
}

/// One file to render: the picture, and the filters that turn it into the motion's frames.
#[derive(Debug, Clone, PartialEq)]
pub struct MotionJob {
    pub src: String,
    pub filter: String,
    pub fps: u32,
    pub out: String,
}

/// The job that renders `pic`'s motion at `w`×`h`, `fps`; None when it isn't one to keep.
pub(crate) fn job(pic: &Pic, m: &Motion, w: u32, h: u32, fps: u32) -> Option<MotionJob> {
    let (cw, ch) = m.canvas(pic.fit, w, h, fps)?;
    // Turned, then sized, as `placement_at` does it: what doesn't change once before the
    // picture repeats, the rest frame by frame on the clip's clock.
    let turn = if moving(&m.rotation) { Some(turn_moving(&curve_expr(&m.rotation, "t"))) } else { turn_fixed(curve_at(&m.rotation, 0.0, 0.0)) };
    let size = if moving(&m.scale) { Some(size_moving(&curve_expr(&m.scale, "t"))) } else { size_fixed(curve_at(&m.scale, 0.0, 100.0) / 100.0) };
    let mut pre = vec![];
    let mut per = vec![];
    for f in [turn, size].into_iter().flatten() {
        if per.is_empty() && !(f.contains("eval=frame") || f.starts_with("rotate=a='")) { pre.push(f) } else { per.push(f) }
    }
    let frames = (m.dur_us as f64 / 1e6 * fps as f64).ceil() as u64 + 1;
    let mut c = vec![format!("[0:v]{}{},format=rgba", pic.picture, fit_against(pic.fit, w, h))];
    c.extend(pre);
    c.push(format!("loop=loop=-1:size=1,settb=AVTB,setpts=N/({fps}*TB),trim=end_frame={frames}"));
    c.extend(per);
    // Centred again on every frame: the picture's size changes.
    c.push(format!("pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"));
    Some(MotionJob { src: pic.path.clone(), filter: c.join(","), fps, out: m.file(w, h, fps).to_string_lossy().into_owned() })
}

/// The motion files a project's pictures need at `w`×`h`, `fps` and doesn't have yet.
pub fn motion_jobs(p: &Project, w: u32, h: u32, fps: u32) -> Vec<MotionJob> {
    let mut jobs: Vec<MotionJob> = vec![];
    for pic in wanted(p) {
        let Some(j) = pic.motion.as_ref().and_then(|m| job(&pic, m, w, h, fps)) else { continue };
        if !Path::new(&j.out).is_file() && !jobs.iter().any(|x| x.out == j.out) {
            jobs.push(j);
        }
    }
    jobs
}

/// Deletes the motion files in the project's cache that none of its pictures use at
/// `w`×`h`, `fps` (left by edits, or by clips since removed).
pub fn prune_motion(p: &Project, w: u32, h: u32, fps: u32) {
    let Some(cache) = p.cache_dir.as_ref() else { return };
    let keep: Vec<PathBuf> = wanted(p).iter().filter_map(|pic| pic.motion.as_ref().map(|m| m.file(w, h, fps))).collect();
    let Ok(dirs) = std::fs::read_dir(cache) else { return };
    for f in dirs.flatten().filter_map(|d| std::fs::read_dir(d.path()).ok()).flatten().flatten() {
        let path = f.path();
        let name = f.file_name().to_string_lossy().into_owned();
        if name.starts_with("motion-") && !keep.contains(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The timeline's pictures that would play from a motion file.
fn wanted(p: &Project) -> Vec<Pic> {
    crate::compose::layers_in(p, 0, p.duration_us(), true)
        .into_iter()
        .filter_map(|l| match l {
            crate::compose::Layer::Pic(pic) if crate::compose::keeps_motion(&pic) => Some(pic),
            _ => None,
        })
        .collect()
}

/// FNV-1a: a file name from a key, the same on every run and build.
fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
}

impl Ffmpeg {
    /// Renders a motion file (see the module's notes), at background priority, written under
    /// another name and moved into place so it's never read half made.
    pub fn render_motion(&self, job: &MotionJob, background: bool) -> anyhow::Result<()> {
        let out = Path::new(&job.out);
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let part = out.with_extension("part.mov");
        let mut c = if background { self.cmd_background() } else { self.cmd() };
        // At the timeline's rate: left to itself the file would take the picture's (25).
        c.args(["-hide_banner", "-loglevel", "error", "-i", &job.src, "-filter_complex", &job.filter, "-an", "-r", &job.fps.to_string(), "-c:v", "qtrle", "-pix_fmt", "argb", "-g", "1", "-y"]).arg(&part);
        let r = run(c, "motion");
        if r.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        r?;
        std::fs::rename(&part, out)?;
        Ok(())
    }
}
