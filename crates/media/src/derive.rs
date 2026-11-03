//! Files derived from each media item and cached on disk: poster, filmstrip,
//! waveform peaks and an every-frame-a-keyframe proxy for fast scrubbing. All of it runs
//! at a lower priority than playback (`cmd_background`).

use crate::{Ffmpeg, secs};
use anyhow::bail;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};
use studio_engine_core::model::{MediaKind, Us};

/// A proxy's longer side. A video no bigger than this plays from its own file.
pub const PROXY_SIZE: u32 = 960;

/// How many keyframes an MP4 or MOV's video has, read from its sample tables (nothing
/// decoded, no FFmpeg). None for other containers or anything unexpected.
pub fn keyframes(path: &Path) -> Option<u32> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut at = 0u64;
    // The movie box, wherever it sits among the top-level boxes (often after the media data).
    let moov = loop {
        f.seek(SeekFrom::Start(at)).ok()?;
        let mut h = [0u8; 16];
        f.read_exact(&mut h[..8]).ok()?;
        let (head, size) = match u32::from_be_bytes(h[..4].try_into().ok()?) {
            0 => (8, len - at),
            1 => {
                f.read_exact(&mut h[8..]).ok()?;
                (16, u64::from_be_bytes(h[8..].try_into().ok()?))
            }
            n => (8, n as u64),
        };
        if size < head || at + size > len {
            return None;
        }
        if &h[4..8] == b"moov" {
            if size > 256 << 20 {
                return None;
            }
            let mut body = vec![0u8; (size - head) as usize];
            f.read_exact(&mut body).ok()?;
            break body;
        }
        at += size;
    };
    boxes(&moov).filter(|(k, _)| k == b"trak").find_map(|(_, trak)| {
        let mdia = child(trak, b"mdia")?;
        // hdlr: version and flags, a reserved word, then the track's kind.
        if child(mdia, b"hdlr")?.get(8..12)? != b"vide" {
            return None;
        }
        let stbl = child(child(mdia, b"minf")?, b"stbl")?;
        match child(stbl, b"stss") {
            // Version and flags, then how many sync samples.
            Some(stss) => word(stss, 4),
            // No sync-sample table: every sample is a keyframe (stsz: version and flags, size, count).
            None => word(child(stbl, b"stsz")?, 8),
        }
    })
}

/// The boxes directly inside `data`, as (kind, contents).
fn boxes(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut at = 0;
    std::iter::from_fn(move || {
        let h = data.get(at..at + 8)?;
        let (head, size) = match u32::from_be_bytes(h[..4].try_into().ok()?) {
            0 => (8, data.len() - at),
            1 => (16, usize::try_from(u64::from_be_bytes(data.get(at + 8..at + 16)?.try_into().ok()?)).ok()?),
            n => (8, n as usize),
        };
        let body = data.get(at + head..at.checked_add(size)?)?;
        at += size;
        Some((h[4..8].try_into().ok()?, body))
    })
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|(k, _)| k == kind).map(|(_, b)| b)
}

fn word(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

pub(crate) fn run(mut cmd: Command, what: &str) -> anyhow::Result<()> {
    let out = cmd.stderr(Stdio::piped()).stdout(Stdio::null()).output()?;
    if !out.status.success() {
        bail!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}

impl Ffmpeg {
    /// One still for the media bin.
    pub fn poster(&self, src: &Path, out: &Path, kind: MediaKind, duration_us: Us) -> anyhow::Result<()> {
        let mut c = self.cmd_background();
        c.args(["-hide_banner", "-loglevel", "error"]);
        if kind == MediaKind::Video {
            c.args(["-ss", &secs(duration_us * 2 / 5)]);
        }
        c.arg("-i").arg(src).args(["-frames:v", "1", "-vf", "scale=-2:360", "-q:v", "4", "-y"]).arg(out);
        run(c, "poster")
    }

    /// Ten frames side by side at timeline height, for the clip filmstrip.
    pub fn strip(&self, src: &Path, out: &Path, kind: MediaKind, duration_us: Us) -> anyhow::Result<()> {
        let mut c = self.cmd_background();
        c.args(["-hide_banner", "-loglevel", "error"]);
        if kind == MediaKind::Video {
            if keyframes(src).is_some_and(|n| n >= 10) {
                // A keyframe for every tile (phone and ad clips have one every 2–5 s): only
                // those are decoded, 3–4× faster.
                c.args(["-skip_frame", "nokey"]);
            } else {
                // Fewer (many clips have only 2–4, which would leave gaps): the frames others
                // are built from, without the deblocking filter. Invisible at 96 px, and a
                // third faster than every frame, which adds up over hundreds of clips.
                c.args(["-skip_loop_filter", "all", "-flags2", "fast", "-skip_frame", "noref"]);
            }
        }
        c.arg("-i").arg(src).args(["-an"]);
        let vf = if kind == MediaKind::Video {
            let rate = 10.0 / (duration_us.max(100_000) as f64 / 1_000_000.0);
            format!("fps={rate:.6},scale=-2:96,tile=10x1")
        } else {
            "scale=-2:96".to_string()
        };
        c.args(["-vf", &vf, "-frames:v", "1", "-q:v", "5", "-y"]).arg(out);
        run(c, "filmstrip")
    }

    /// 100 waveform peaks per second (0–255), normalised to the loudest moment.
    pub fn peaks(&self, src: &Path) -> anyhow::Result<Vec<u8>> {
        let mut child = self.cmd_background().args(["-hide_banner", "-loglevel", "error"]).arg("-i").arg(src).args(["-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let mut raw = vec![];
        child.stdout.take().expect("piped").read_to_end(&mut raw)?;
        child.wait()?;
        let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let peaks: Vec<u16> = samples.chunks(80).map(|c| c.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0)).collect();
        let max = peaks.iter().copied().max().unwrap_or(0).max(1) as f32;
        Ok(peaks.iter().map(|&p| ((p as f32 / max) * 255.0).round() as u8).collect())
    }

    /// Stabilising's first pass: how the camera moves over `span_us` of `src` from `in_us`,
    /// written to `trf` for vidstabtransform. Written under another name and moved into place,
    /// so a half-made file never counts as ready.
    pub fn stabilize_detect(&self, src: &Path, in_us: Us, span_us: Us, trf: &Path, background: bool) -> anyhow::Result<()> {
        let part = trf.with_extension("trf.part");
        if let Some(dir) = trf.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut c = if background { self.cmd_background() } else { self.cmd() };
        c.args(["-hide_banner", "-loglevel", "error", "-ss", &secs(in_us), "-t", &secs(span_us)]).arg("-i").arg(src);
        c.args(["-an", "-vf", &format!("vidstabdetect=shakiness=6:accuracy=12:result={}", crate::effects::filter_path(&part.to_string_lossy())), "-f", "null", "-"]);
        run(c, "stabilise")?;
        std::fs::rename(&part, trf)?;
        Ok(())
    }

    /// Small, every-frame-a-keyframe copy (fits `PROXY_SIZE`, never bigger than the source)
    /// so any frame decodes instantly.
    pub fn proxy(&self, src: &Path, out: &Path) -> anyhow::Result<()> {
        let mut c = self.cmd_background();
        let s = PROXY_SIZE;
        let fit = format!("scale=w='if(gt(iw,ih),min({s},iw),-2)':h='if(gt(iw,ih),-2,min({s},ih))'");
        c.args(["-hide_banner", "-loglevel", "error"]).arg("-i").arg(src).args(["-an", "-vf", &fit]);
        if self.has("libx264") {
            c.args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-g", "1", "-pix_fmt", "yuv420p"]);
        } else {
            c.args(["-c:v", "mjpeg", "-q:v", "5"]);
        }
        // Written under another name and moved into place, so it's never read half made.
        let part = out.with_extension("part.mp4");
        c.args(["-y"]).arg(&part);
        run(c, "proxy")?;
        std::fs::rename(&part, out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframes_come_from_the_sample_tables_and_pick_the_filmstrip_s_way() {
        let Ok(ff) = Ffmpeg::detect() else { return };
        let dir = std::env::temp_dir().join(format!("studio-keyframes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 3 s at 30 fps with a keyframe every `gop` frames (and none at scene changes).
        let make = |name: &str, gop: &str, extra: &[&str]| {
            let out = dir.join(name);
            let mut c = ff.cmd();
            c.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=108x192:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
            c.args(["-g", gop, "-keyint_min", gop, "-sc_threshold", "0"]).args(extra).arg("-y").arg(&out);
            assert!(c.status().unwrap().success());
            out
        };
        let sparse = make("sparse.mp4", "30", &[]);
        let dense = make("dense.mov", "6", &["-movflags", "+faststart"]);
        let every = make("every.mp4", "1", &[]);
        let other = make("other.mkv", "6", &[]);
        assert_eq!(keyframes(&sparse), Some(3), "the movie box after the media data");
        assert_eq!(keyframes(&dense), Some(15), "the movie box first");
        assert_eq!(keyframes(&every), Some(90), "every frame a keyframe");
        assert_eq!(keyframes(&other), None, "not an MP4");
        assert_eq!(keyframes(&dir.join("nowhere.mp4")), None);
        // Both ways make the same ten tiles at 96 px.
        for src in [&sparse, &dense] {
            let out = src.with_extension("strip.jpg");
            ff.strip(src, &out, MediaKind::Video, 3_000_000).unwrap();
            let p = ff.probe(&out).unwrap();
            assert_eq!((p.width, p.height), (540, 96), "{}", src.display());
        }
        // A proxy is never bigger than its source.
        let proxy = dir.join("proxy.mp4");
        ff.proxy(&sparse, &proxy).unwrap();
        let p = ff.probe(&proxy).unwrap();
        assert_eq!((p.width, p.height), (108, 192));
        let _ = std::fs::remove_dir_all(&dir);
    }
}