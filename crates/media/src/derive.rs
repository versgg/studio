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

/// JPEGs are full range: FFmpeg 8's encoder refuses a picture marked TV range (most phone and
/// TikTok clips: 375 of 400 in one B-roll folder), so their posters and filmstrips all failed
/// with "Nothing was written into output file". yuvj420p has swscale convert the range.
const FULL_RANGE: &str = "format=yuvj420p";
const POSTER_VF: &str = "scale=-2:360:flags=fast_bilinear,format=yuvj420p";

impl Ffmpeg {
    /// One still for the media bin: the keyframe at or before 40 % of a video, decoded alone on
    /// one thread with its sound left closed (a tenth of the CPU of decoding up to that frame,
    /// on all cores, as before: 0.08 s instead of 0.8 s for a 720p phone clip). A clip whose
    /// picture ends before its sound (2.6 s of picture in a 10 s file) has nothing there, so it
    /// falls back to its first keyframe, then to its first frame decoded in full.
    pub fn poster(&self, src: &Path, out: &Path, kind: MediaKind, duration_us: Us) -> anyhow::Result<()> {
        if kind != MediaKind::Video {
            let mut c = self.cmd_background();
            c.args(["-hide_banner", "-loglevel", "error", "-threads", "1"]).arg("-i").arg(src).args(["-frames:v", "1", "-vf", POSTER_VF, "-q:v", "4", "-y"]).arg(out);
            return run(c, "poster");
        }
        let attempt = |at: Us, keyframes_only: bool| {
            let mut c = self.cmd_background();
            c.args(["-hide_banner", "-loglevel", "error", "-threads", "1"]);
            if keyframes_only {
                c.args(["-skip_frame", "nokey", "-noaccurate_seek"]);
            }
            c.args(["-ss", &secs(at), "-an", "-sn", "-dn"]).arg("-i").arg(src).args(["-frames:v", "1", "-vf", POSTER_VF, "-threads", "1", "-q:v", "4", "-y"]).arg(out);
            run(c, "poster").and_then(|()| if out.metadata().is_ok_and(|m| m.len() > 0) { Ok(()) } else { anyhow::bail!("poster: no picture") })
        };
        attempt(duration_us * 2 / 5, true).or_else(|_| attempt(0, true)).or_else(|_| attempt(0, false))
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
            format!("fps={rate:.6},scale=-2:96,tile=10x1,{FULL_RANGE}")
        } else {
            format!("scale=-2:96,{FULL_RANGE}")
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
        let x264 = self.has("libx264");
        // An MJPEG proxy (no x264) is JPEG too: full range.
        let vf = if x264 { fit } else { format!("{fit},{FULL_RANGE}") };
        c.args(["-hide_banner", "-loglevel", "error"]).arg("-i").arg(src).args(["-an", "-vf", &vf]);
        if x264 {
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

    /// Opt-in, on real files: `STUDIO_POSTER_SAMPLE=<folder> cargo test -p studio-media --release -- --ignored poster_sample --nocapture`
    /// makes a poster for up to 200 videos under the folder (into a temp folder) and prints how many failed and how long it took.
    #[test]
    #[ignore]
    fn poster_sample() {
        let Some(root) = std::env::var_os("STUDIO_POSTER_SAMPLE") else { return };
        let ff = Ffmpeg::detect().unwrap();
        let mut files = vec![];
        let mut stack = vec![std::path::PathBuf::from(root)];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "mp4") && files.len() < 200 {
                    files.push(p);
                }
            }
        }
        let out = std::env::temp_dir().join(format!("studio-poster-sample-{}", std::process::id()));
        std::fs::create_dir_all(&out).unwrap();
        let t = std::time::Instant::now();
        let durations: Vec<Us> = ff.probe_many(&files, 8).into_iter().map(|p| p.map(|p| p.duration_us).unwrap_or(0)).collect();
        let failed: Vec<String> = std::thread::scope(|s| {
            let jobs: Vec<(usize, (&std::path::PathBuf, Us))> = files.iter().zip(durations).enumerate().collect();
            let chunks: Vec<Vec<(usize, (&std::path::PathBuf, Us))>> = jobs.chunks(files.len().div_ceil(6).max(1)).map(|c| c.to_vec()).collect();
            let handles: Vec<_> = chunks.into_iter().map(|chunk| {
                let (ff, out) = (&ff, &out);
                s.spawn(move || chunk.into_iter().filter_map(|(i, (f, dur))| {
                    ff.poster(f, &out.join(format!("{i}.jpg")), MediaKind::Video, dur).err().map(|e| format!("{}: {e}", f.display()))
                }).collect::<Vec<_>>())
            }).collect();
            handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        println!("posters: {} files, {} failed, {:.1} s", files.len(), failed.len(), t.elapsed().as_secs_f64());
        for f in failed.iter().take(5) {
            println!("  {f}");
        }
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn a_tv_range_clip_whose_picture_ends_early_gets_its_poster_and_filmstrip() {
        // Repro (2026-11-07): a cut TikTok clip, TV range, 2.6 s of picture in a 10 s file.
        let Ok(ff) = Ffmpeg::detect() else { return };
        if !ff.has("libx264") {
            return;
        }
        let dir = std::env::temp_dir().join(format!("studio-tv-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("tv.mp4");
        let made = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=1", "-f", "lavfi", "-i", "sine=d=4"])
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-c:a", "aac"]).arg(&src).status().unwrap();
        assert!(made.success());
        let t = std::time::Instant::now();
        ff.poster(&src, &dir.join("poster.jpg"), MediaKind::Video, 4_000_000).expect("a poster, from its first keyframe");
        assert!(std::fs::metadata(dir.join("poster.jpg")).unwrap().len() > 1000);
        ff.strip(&src, &dir.join("strip.jpg"), MediaKind::Video, 4_000_000).expect("a filmstrip");
        assert!(t.elapsed().as_secs() < 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

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