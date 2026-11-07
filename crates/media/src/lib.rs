//! Media I/O through the FFmpeg command-line tools.
//!
//! The engine never shells out to FFmpeg directly; it goes through this crate, so the
//! backend can later move to linked libav* (ARCHITECTURE.md §2) without touching callers.

pub mod anim;
pub mod compose;
pub mod derive;
pub mod effects;
pub mod graph;
pub mod motion;
pub mod transitions;
#[cfg(test)]
mod tests_v2;

use anyhow::{Context, bail};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use studio_engine_core::model::{MediaKind, Us};

pub struct Ffmpeg {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub version: String,
    pub encoders: Vec<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Finds a tool in `STUDIO_FFMPEG_DIR`, next to the engine binary, or on PATH.
fn find_tool(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    let mut dirs: Vec<PathBuf> = vec![];
    if let Some(d) = std::env::var_os("STUDIO_FFMPEG_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(d);
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    // Started from the Dock or Finder (or by another app, as MCP clients start studio-mcp), a Mac
    // gives launchd's short PATH: Homebrew's folders (Apple silicon, then Intel) are looked in too.
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

/// A `Command` that never flashes a console window on Windows.
pub fn quiet(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

pub fn secs(us: Us) -> String {
    format!("{:.6}", us as f64 / 1_000_000.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub kind: MediaKind,
    pub duration_us: Us,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    /// The picture's codec ("h264", "vp9", "gif"...).
    pub codec: Option<String>,
    /// The sound's own sample rate.
    pub sample_rate: Option<u32>,
}

fn rational(s: &str) -> f64 {
    let mut it = s.split('/');
    let n: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let d: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(1.0);
    if d == 0.0 { 0.0 } else { n / d }
}

/// Reads ffprobe's JSON (split out so it can be tested without FFmpeg installed).
pub fn parse_probe(json: &Value) -> anyhow::Result<Probe> {
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1));
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let format_name = json["format"]["format_name"].as_str().unwrap_or("");
    let duration = json["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).or_else(|| video.and_then(|v| v["duration"].as_str()?.parse().ok())).unwrap_or(0.0);
    let codec = video.and_then(|v| v["codec_name"].as_str()).unwrap_or("");
    let still_codec = matches!(codec, "png" | "mjpeg" | "webp" | "bmp" | "tiff" | "jpegls");
    let is_image = video.is_some() && (format_name.ends_with("_pipe") || format_name == "image2" || (still_codec && duration < 0.05));
    let kind = match (is_image, video.is_some(), has_audio) {
        (true, _, _) => MediaKind::Image,
        (false, true, _) => MediaKind::Video,
        (false, false, true) => MediaKind::Audio,
        _ => bail!("no video or audio streams"),
    };
    let (width, height, fps) = video.map_or((0, 0, 0.0), |v| {
        let fps = v["avg_frame_rate"].as_str().map(rational).filter(|f| *f > 0.0).or_else(|| v["r_frame_rate"].as_str().map(rational)).unwrap_or(0.0);
        (v["width"].as_u64().unwrap_or(0) as u32, v["height"].as_u64().unwrap_or(0) as u32, fps)
    });
    Ok(Probe { kind, duration_us: if kind == MediaKind::Image { 0 } else { (duration * 1_000_000.0) as Us }, width, height, fps, has_audio: has_audio && kind != MediaKind::Image, codec: video.and_then(|v| v["codec_name"].as_str()).map(str::to_string), sample_rate: streams.iter().find(|s| s["codec_type"] == "audio").and_then(|s| s["sample_rate"].as_str()?.parse().ok()) })
}

impl Ffmpeg {
    pub fn detect() -> anyhow::Result<Self> {
        let ffmpeg = find_tool("ffmpeg").context("FFmpeg was not found. Install it, or set STUDIO_FFMPEG_DIR to the folder with ffmpeg and ffprobe.")?;
        let ffprobe = find_tool("ffprobe").context("ffprobe was not found next to ffmpeg.")?;
        let version_out = quiet(&ffmpeg).args(["-hide_banner", "-version"]).output()?;
        let version = String::from_utf8_lossy(&version_out.stdout).lines().next().unwrap_or("").to_string();
        let enc_out = quiet(&ffmpeg).args(["-hide_banner", "-encoders"]).output()?;
        let encoders = String::from_utf8_lossy(&enc_out.stdout)
            .lines()
            .filter_map(|l| {
                let mut parts = l.split_whitespace();
                let flags = parts.next()?;
                let name = parts.next()?;
                (flags.len() == 6 && (flags.starts_with('V') || flags.starts_with('A'))).then(|| name.to_string())
            })
            .collect();
        Ok(Self { ffmpeg, ffprobe, version, encoders })
    }

    pub fn has(&self, encoder: &str) -> bool {
        self.encoders.iter().any(|e| e == encoder)
    }

    pub fn cmd(&self) -> Command {
        quiet(&self.ffmpeg)
    }

    /// FFmpeg for background work (thumbnails, waveforms, proxies) at a lower priority, so
    /// playback, previews and exports always get the CPU first.
    pub fn cmd_background(&self) -> Command {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new(&self.ffmpeg);
            c.stdin(Stdio::null());
            c.creation_flags(0x0800_0000 | 0x0000_4000); // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
            c
        }
        #[cfg(unix)]
        {
            let mut c = match find_tool("nice") {
                Some(nice) => {
                    let mut c = quiet(&nice);
                    c.arg("-n").arg("10").arg(&self.ffmpeg);
                    c
                }
                None => quiet(&self.ffmpeg),
            };
            // Ends with the engine, even when it's killed outright (Windows' kill-on-close
            // job does this there). The kernel sends it when the thread that started it ends;
            // background work waits for its FFmpeg on that thread.
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::process::CommandExt;
                // SAFETY: prctl is async-signal-safe, and nothing else runs between fork and exec.
                unsafe {
                    c.pre_exec(|| {
                        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                        Ok(())
                    });
                }
            }
            c
        }
    }

    /// A file's sound's sample rate (for media probed before it was kept).
    pub fn sample_rate(&self, path: &Path) -> anyhow::Result<u32> {
        let out = quiet(&self.ffprobe).args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0"]).arg(path).output()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().context("no sound in that file")
    }

    pub fn probe(&self, path: &Path) -> anyhow::Result<Probe> {
        let out = quiet(&self.ffprobe).args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]).arg(path).output()?;
        if !out.status.success() {
            bail!("FFmpeg can't read this file ({})", String::from_utf8_lossy(&out.stderr).trim());
        }
        parse_probe(&serde_json::from_slice(&out.stdout)?)
    }

    /// Probes many files at once (a dropped folder can hold hundreds), `threads` at a time.
    /// Results come back in the same order as `paths`.
    pub fn probe_many(&self, paths: &[PathBuf], threads: usize) -> Vec<anyhow::Result<Probe>> {
        let next = std::sync::atomic::AtomicUsize::new(0);
        let results: Vec<std::sync::Mutex<Option<anyhow::Result<Probe>>>> = paths.iter().map(|_| std::sync::Mutex::new(None)).collect();
        std::thread::scope(|s| {
            for _ in 0..threads.clamp(1, paths.len().max(1)) {
                s.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(path) = paths.get(i) else { break };
                        *results[i].lock().unwrap() = Some(self.probe(path));
                    }
                });
            }
        });
        results.into_iter().map(|r| r.into_inner().unwrap().unwrap_or_else(|| Err(anyhow::anyhow!("not probed")))).collect()
    }
}

/// File types the library picks up when a folder is linked.
pub const MEDIA_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "png", "jpg", "jpeg", "webp", "gif"];

pub fn is_media_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Every media file under `root`, with its subfolder relative to `root` ("" for the top,
/// "/" separated on every platform). Hidden folders and files are skipped. Sorted by path.
pub fn scan_folder(root: &Path) -> std::io::Result<Vec<(PathBuf, String)>> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(PathBuf, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                walk(&path, &if rel.is_empty() { name } else { format!("{rel}/{name}") }, out);
            } else if is_media_file(&path) {
                out.push((path, rel.to_string()));
            }
        }
    }
    if !root.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("{} is not a folder", root.display())));
    }
    let mut out = vec![];
    walk(root, "", &mut out);
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scans_a_folder_tree_for_media() {
        let root = std::env::temp_dir().join(format!("studio-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["", "01 Produkt", "05 Stock/Jul", ".hidden"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        for f in ["a.MP4", "notes.md", "01 Produkt/b.mov", "05 Stock/Jul/c.mp4", "05 Stock/Jul/voice.wav", ".hidden/d.mp4", ".e.mp4"] {
            std::fs::write(root.join(f), b"").unwrap();
        }
        let found: Vec<(String, String)> = scan_folder(&root).unwrap().into_iter().map(|(p, d)| (p.file_name().unwrap().to_string_lossy().into_owned(), d)).collect();
        assert_eq!(found, vec![("b.mov".into(), "01 Produkt".into()), ("c.mp4".into(), "05 Stock/Jul".into()), ("voice.wav".into(), "05 Stock/Jul".into()), ("a.MP4".into(), "".into())]);
        assert!(scan_folder(&root.join("a.MP4")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recognises_video_audio_and_images() {
        let video = json!({ "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.5" }, "streams": [
            { "codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920, "avg_frame_rate": "30000/1001", "disposition": { "attached_pic": 0 } },
            { "codec_type": "audio", "codec_name": "aac" } ] });
        let p = parse_probe(&video).unwrap();
        assert_eq!((p.kind, p.width, p.height, p.duration_us, p.has_audio), (MediaKind::Video, 1080, 1920, 10_500_000, true));
        assert!((p.fps - 29.97).abs() < 0.01);

        let mp3 = json!({ "format": { "format_name": "mp3", "duration": "3.0" }, "streams": [
            { "codec_type": "audio", "codec_name": "mp3" },
            { "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } } ] });
        assert_eq!(parse_probe(&mp3).unwrap().kind, MediaKind::Audio, "cover art is not video");

        let png = json!({ "format": { "format_name": "png_pipe" }, "streams": [ { "codec_type": "video", "codec_name": "png", "width": 1080, "height": 1350 } ] });
        let p = parse_probe(&png).unwrap();
        assert_eq!((p.kind, p.duration_us, p.has_audio), (MediaKind::Image, 0, false));

        assert!(parse_probe(&json!({ "format": {}, "streams": [] })).is_err());
    }
}
