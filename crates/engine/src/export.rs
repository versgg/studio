//! Export queue. Same graph as preview at full size, encoded with NVENC (or x264), then
//! the project's master stage (by default levelled to −14 LUFS with true peaks under
//! −1 dBTP). One job per format; progress streams to the UI.

use crate::events::Events;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use studio_engine_core::model::{Project, TrackKind, Us, format_size};
use studio_media::Ffmpeg;
use studio_media::graph::{self, Quality, VideoOut, encoder_args, encoder_args_at};

/// What an export can ask for beyond the formats and quality.
#[derive(Debug, Default, Clone)]
pub struct ExportOptions {
    /// Exact file names (without .mp4) per format, e.g. "9:16" to "Promo-9x16-v3".
    pub names: BTreeMap<String, String>,
    /// A target video bitrate in Mbit/s instead of the quality preset's constant quality.
    pub bitrate_mbps: Option<f64>,
    /// The output frame rate, instead of the project's.
    pub fps: Option<u32>,
}

struct Job {
    id: String,
    width: u32,
    height: u32,
    path: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

pub struct Exports {
    ff: Arc<Ffmpeg>,
    events: Events,
    next: AtomicU64,
    active: Arc<Mutex<HashMap<String, (Arc<Mutex<Option<Child>>>, Arc<AtomicBool>)>>>,
}

/// `<folder>/<base>-WxH.mp4` (with no size, `<folder>/<base>.mp4`), then "-2", "-3" and on
/// while that's taken.
fn unique_path(folder: &Path, base: &str, size: Option<(u32, u32)>) -> PathBuf {
    let clean: String = base.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c }).collect();
    let stem = match size {
        Some((w, h)) => format!("{clean}-{w}x{h}"),
        None => clean,
    };
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("{stem}.mp4") } else { format!("{stem}-{n}.mp4") };
        let p = folder.join(name);
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

impl Exports {
    pub fn new(ff: Arc<Ffmpeg>, events: Events) -> Self {
        Self { ff, events, next: AtomicU64::new(1), active: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn start(&self, project: Project, formats: &[String], quality: Quality, folder: &Path, base: &str, options: ExportOptions) -> Result<Value, String> {
        if project.duration_us() == 0 {
            return Err("The timeline is empty.".into());
        }
        std::fs::create_dir_all(folder).map_err(|e| format!("Can't create {}: {e}", folder.display()))?;
        let mut jobs = vec![];
        for f in formats {
            let (width, height) = format_size(f).ok_or_else(|| format!("Unknown format {f}"))?;
            let id = format!("e{}", self.next.fetch_add(1, Ordering::Relaxed));
            let path = match options.names.get(f).map(|n| n.trim()).filter(|n| !n.is_empty()) {
                Some(stem) => unique_path(folder, stem, None),
                None => unique_path(folder, base, Some((width, height))),
            };
            // Reserve the name so two jobs in one batch never share it.
            let _ = std::fs::File::create(&path);
            let child = Arc::new(Mutex::new(None));
            let cancelled = Arc::new(AtomicBool::new(false));
            self.active.lock().unwrap().insert(id.clone(), (child.clone(), cancelled.clone()));
            jobs.push(Job { id, width, height, path, child, cancelled });
        }
        let (_, encoder) = encoder_args_at(&self.ff, quality, options.bitrate_mbps);
        let listed: Vec<Value> = jobs.iter().map(|j| json!({ "jobId": j.id, "width": j.width, "height": j.height, "path": j.path.to_string_lossy(), "encoder": encoder })).collect();
        let (ff, events, active) = (self.ff.clone(), self.events.clone(), self.active.clone());
        std::thread::Builder::new()
            .name("export".into())
            .spawn(move || {
                for job in jobs {
                    run_job(&ff, &events, &project, quality, &options, &job);
                    active.lock().unwrap().remove(&job.id);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(json!({ "jobs": listed }))
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let Some((child, cancelled)) = self.active.lock().unwrap().get(job_id).cloned() else { return false };
        cancelled.store(true, Ordering::Release);
        if let Some(c) = child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
        true
    }
}

fn run_job(ff: &Ffmpeg, events: &Events, project: &Project, quality: Quality, options: &ExportOptions, job: &Job) {
    if job.cancelled.load(Ordering::Acquire) {
        let _ = std::fs::remove_file(&job.path);
        events.emit("export.cancelled", json!({ "jobId": job.id }));
        return;
    }
    let mut p = project.clone();
    p.width = job.width;
    p.height = job.height;
    let t0 = Instant::now();
    let (enc, encoder) = encoder_args_at(ff, quality, options.bitrate_mbps);
    let fps = options.fps.unwrap_or(p.fps).clamp(1, 240);
    events.emit("export.started", json!({ "jobId": job.id, "encoder": encoder }));
    // Stabilised clips: export reads the originals, so it waits for their transforms.
    for s in graph::stab_jobs(&p, false) {
        if job.cancelled.load(Ordering::Acquire) {
            break;
        }
        if let Err(e) = ff.stabilize_detect(Path::new(&s.path), s.in_us, s.span_us, Path::new(&s.trf), false) {
            let _ = std::fs::remove_file(&job.path);
            events.emit("export.failed", json!({ "jobId": job.id, "error": format!("Stabilising failed: {e}") }));
            return;
        }
    }
    // The originals, and smooth slow motion (export only).
    let mut tl = graph::timeline_export(&p);
    // Loudness normalisation measures the mix first, so the file lands on the target
    // (one pass of loudnorm can miss it by a couple of LU on short, punchy ads).
    if p.master.normalize {
        let measured = crate::audio::measure_mix(ff, &p, false).ok().and_then(|l| l.integrated);
        tl.export_tail = graph::master_filter_measured(&p.master, measured);
    }
    let total = tl.total_us.max(1);
    let mut args = graph::build(&tl, Some(&VideoOut { width: job.width, height: job.height, fps, pix_fmt: "yuv420p" }), true, true);
    args.extend(["-map".into(), "[vout]".into(), "-map".into(), "[aout]".into()]);
    args.extend(enc);
    // Never longer than the timeline, whatever the graph does (a mix that never ended used to
    // leave an export at 100 % for good).
    let length = format!("{:.6}", total as f64 / 1e6);
    for a in ["-pix_fmt", "yuv420p", "-r", &fps.to_string(), "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-t", &length, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-y"] {
        args.push(a.to_string());
    }
    args.push(job.path.to_string_lossy().into_owned());

    let mut child = match ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            events.emit("export.failed", json!({ "jobId": job.id, "error": e.to_string() }));
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    *job.child.lock().unwrap() = Some(child);
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let mut last_emit = Instant::now();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<i64>().ok()) {
            if last_emit.elapsed().as_millis() >= 150 {
                last_emit = Instant::now();
                events.emit("export.progress", json!({ "jobId": job.id, "fraction": (v as f64 / total as f64).clamp(0.0, 1.0) }));
            }
        }
    }
    let status = job.child.lock().unwrap().take().map(|mut c| c.wait());
    let stderr = err_reader.join().unwrap_or_default();
    let ok = matches!(status, Some(Ok(s)) if s.success());
    if job.cancelled.load(Ordering::Acquire) {
        let _ = std::fs::remove_file(&job.path);
        events.emit("export.cancelled", json!({ "jobId": job.id }));
    } else if ok {
        let bytes = std::fs::metadata(&job.path).map(|m| m.len()).unwrap_or(0);
        events.emit("export.done", json!({ "jobId": job.id, "path": job.path.to_string_lossy(), "seconds": t0.elapsed().as_secs_f64(), "bytes": bytes, "encoder": encoder }));
    } else {
        let _ = std::fs::remove_file(&job.path);
        let reason = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("FFmpeg stopped without saying why").to_string();
        events.emit("export.failed", json!({ "jobId": job.id, "error": reason }));
    }
}

/// Renders a project to one file at its own size, for compound clips. The sound isn't
/// levelled, so it matches the timeline; a project with no picture becomes an .m4a.
pub fn render_file(ff: &Ffmpeg, p: &Project, out: &Path) -> anyhow::Result<()> {
    let tl = graph::timeline_from(p, 0, false);
    let picture = p.tracks.iter().any(|t| t.kind == TrackKind::Video && !t.clips.is_empty());
    let video = picture.then(|| VideoOut { width: p.width, height: p.height, fps: p.fps, pix_fmt: "yuv420p" });
    let mut args = graph::build(&tl, video.as_ref(), true, false);
    if picture {
        args.extend(["-map".into(), "[vout]".into()]);
        args.extend(encoder_args(ff, Quality::Balanced).0);
        args.extend(["-pix_fmt".into(), "yuv420p".into(), "-r".into(), p.fps.to_string()]);
    }
    for a in ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-y"] {
        args.push(a.to_string());
    }
    args.push(out.to_string_lossy().into_owned());
    let result = ff.cmd().args(&args).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    if !result.status.success() {
        anyhow::bail!("render failed: {}", String::from_utf8_lossy(&result.stderr).lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}

/// Copies part of a file (from `in_us`, `dur_us` long) to an .mp4 at its own size, for
/// sending just the used part of a clip to an outside service.
pub fn cut_range(ff: &Ffmpeg, src: &Path, in_us: i64, dur_us: i64, out: &Path) -> anyhow::Result<()> {
    let secs = |us: i64| format!("{:.6}", us as f64 / 1_000_000.0);
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-ss"].iter().map(|s| s.to_string()).collect();
    args.extend([secs(in_us), "-t".into(), secs(dur_us), "-i".into(), src.to_string_lossy().into_owned()]);
    // An .m4a is the sound alone (for the voice changer); anything else keeps the picture.
    let sound_only = out.extension().is_some_and(|e| e.eq_ignore_ascii_case("m4a"));
    if sound_only {
        args.extend(["-vn".into(), "-map".into(), "0:a:0".into()]);
    } else {
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0?".into()]);
        args.extend(encoder_args(ff, Quality::Balanced).0);
        args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    }
    for a in ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y"] {
        args.push(a.into());
    }
    args.push(out.to_string_lossy().into_owned());
    let r = ff.cmd().args(&args).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    if !r.status.success() {
        anyhow::bail!("couldn't cut the clip: {}", String::from_utf8_lossy(&r.stderr).lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}

/// Saves one source frame at `at_us` (ignored for a still) as a PNG at the file's own size,
/// through `picture` (a clip's crop, quarter turns and mirror) but not the project's fit.
pub fn frame_png(ff: &Ffmpeg, src: &Path, still: bool, at_us: i64, picture: &str, out: &Path) -> anyhow::Result<()> {
    let mut cmd = ff.cmd();
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    if !still {
        cmd.args(["-ss", &format!("{:.6}", at_us.max(0) as f64 / 1_000_000.0)]);
    }
    cmd.arg("-i").arg(src).args(["-frames:v", "1"]);
    let filters = picture.trim_end_matches(',');
    if !filters.is_empty() {
        cmd.args(["-vf", filters]);
    }
    let r = cmd.args(["-update", "1", "-y"]).arg(out).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    if !r.status.success() || !out.is_file() {
        anyhow::bail!("couldn't save the frame: {}", String::from_utf8_lossy(&r.stderr).lines().last().unwrap_or("no frame there"));
    }
    Ok(())
}

/// The composited frame at `at_us` as a PNG, `w`×`h`: the paused frame's graph (picture
/// tracks, transitions, effects and all), or black where there's nothing.
pub fn still_png(ff: &Ffmpeg, p: &Project, at_us: Us, w: u32, h: u32, out: &Path) -> anyhow::Result<()> {
    let mut args = crate::playback::frame_args(p, at_us, w, h).unwrap_or_else(|| {
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &format!("color=c=black:s={w}x{h}:d=0.1"), "-filter_complex", "[0:v]format=rgba[vout]"].map(String::from).to_vec()
    });
    args.extend(["-map", "[vout]", "-frames:v", "1", "-update", "1", "-y"].map(String::from));
    args.push(out.to_string_lossy().into_owned());
    let r = ff.cmd().args(&args).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    if !r.status.success() || !out.is_file() {
        anyhow::bail!("couldn't render the frame: {} ({})", String::from_utf8_lossy(&r.stderr).lines().last().unwrap_or("no frame there"), args.join(" "));
    }
    Ok(())
}

/// Re-writes a recording as an .m4a. The browser's recorder leaves the length out of its
/// WebM files, so they're read through once here and saved with a proper one.
pub fn to_audio(ff: &Ffmpeg, input: &Path, out: &Path) -> anyhow::Result<()> {
    let r = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-i"]).arg(input).args(["-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-y"]).arg(out).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    if !r.status.success() {
        anyhow::bail!("couldn't save the recording: {}", String::from_utf8_lossy(&r.stderr).lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}
