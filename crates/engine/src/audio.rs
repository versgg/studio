//! The Audio page's engine side: the mix's loudness, and per file its waveform levels
//! (peak and RMS) and spectrogram, cached in the project's cache folder. A worker makes
//! them in the background and announces each result as an event, so the connection never
//! waits on FFmpeg. The silence finder and level probes behind "Fix and tidy" live here too.

use crate::events::Events;
use anyhow::{Context, bail};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex};
use studio_engine_core::model::{Project, Us};
use studio_media::graph;
use studio_media::{Ffmpeg, secs};

/// Loudness of the mix as you hear it in playback (EBU R128).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS (`None` for silence).
    pub integrated: Option<f64>,
    /// Loudness range, LU.
    pub lra: Option<f64>,
    /// True peak, dBTP.
    pub true_peak: Option<f64>,
    /// Short-term loudness (3 s window) every `step_us`, from the start; floored at −70.
    pub short: Vec<f64>,
    pub step_us: Us,
}

fn number_after(line: &str, key: &str) -> Option<f64> {
    let rest = &line[line.find(key)? + key.len()..];
    rest.split_whitespace().next()?.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Reads ebur128's log: one line per 100 ms (`framelog=info`) and the summary at the end.
/// The series is thinned to at most `max_points`.
pub fn parse_ebur128(log: &str, max_points: usize) -> Option<Loudness> {
    let mut short = vec![];
    let mut summary = false;
    let (mut integrated, mut lra, mut true_peak) = (None, None, None);
    for line in log.lines() {
        if line.contains("Summary:") {
            summary = true;
            continue;
        }
        if !summary {
            if line.contains(" t: ") && line.contains(" S:") {
                short.push(number_after(line, " S:").unwrap_or(-70.0).max(-70.0));
            }
            continue;
        }
        let l = line.trim_start();
        if l.starts_with("I:") {
            integrated = number_after(l, "I:");
        } else if l.starts_with("LRA:") {
            lra = number_after(l, "LRA:");
        } else if l.starts_with("Peak:") {
            true_peak = number_after(l, "Peak:");
        }
    }
    if !summary {
        return None;
    }
    let k = short.len().div_ceil(max_points.max(1)).max(1);
    let short = short.iter().step_by(k).map(|v| (v * 10.0).round() / 10.0).collect();
    // Silence reads as −70 LUFS integrated; there is nothing to show then.
    Some(Loudness { integrated: integrated.filter(|v| *v > -69.9), lra, true_peak, short, step_us: k as Us * 100_000 })
}

/// A string that changes whenever the mix's sound would: the FFmpeg command for it.
pub fn mix_key(p: &Project) -> String {
    graph::build(&graph::timeline_from(p, 0, false), None, true, false).join("\u{1}")
}

/// Measures the mix as playback hears it: the tracks with their effects and the mix gain,
/// before the export's master stage.
pub fn measure_mix(ff: &Ffmpeg, p: &Project, background: bool) -> anyhow::Result<Loudness> {
    if p.duration_us() == 0 {
        bail!("The timeline is empty.");
    }
    let mut args = graph::build(&graph::timeline_from(p, 0, false), None, true, false);
    graph::append_to_audio(&mut args, "ebur128=peak=true:framelog=info");
    if let Some(i) = args.iter().position(|a| a == "-loglevel") {
        args[i + 1] = "info".into();
    }
    // Never longer than the timeline, whatever the graph does.
    let length = format!("{:.6}", p.duration_us() as f64 / 1e6);
    args.extend(["-nostats", "-map", "[aout]", "-t", &length, "-f", "null", "-"].map(String::from));
    let mut cmd = if background { ff.cmd_background() } else { ff.cmd() };
    let out = cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    let log = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        bail!("couldn't measure the mix: {}", log.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("FFmpeg stopped"));
    }
    parse_ebur128(&log, 400).context("FFmpeg gave no loudness summary")
}

/// Decodes a file's sound (mono, 8 kHz) at background priority.
fn decode(ff: &Ffmpeg, src: &Path) -> anyhow::Result<Vec<i16>> {
    let mut child = ff.cmd_background().args(["-hide_banner", "-loglevel", "error"]).arg("-i").arg(src).args(["-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut raw = vec![];
    child.stdout.take().expect("piped").read_to_end(&mut raw)?;
    child.wait()?;
    Ok(raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// Peak and RMS per 10 ms on the file's own scale (255 is full scale), so quiet takes look
/// quiet, the way Audacity draws them.
pub fn levels_from(samples: &[i16]) -> (Vec<u8>, Vec<u8>) {
    let mut peak = vec![];
    let mut rms = vec![];
    for c in samples.chunks(80) {
        let p = c.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
        let r = (c.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum::<f64>() / c.len().max(1) as f64).sqrt();
        peak.push((p * 255.0).round().min(255.0) as u8);
        rms.push((r * 255.0).round().min(255.0) as u8);
    }
    (peak, rms)
}

pub fn write_levels(ff: &Ffmpeg, src: &Path, out: &Path) -> anyhow::Result<()> {
    let (peak, rms) = levels_from(&decode(ff, src)?);
    std::fs::write(out, json!({ "rate": 100, "peak": peak, "rms": rms }).to_string())?;
    Ok(())
}

/// A spectrogram of the whole file, 0–8 kHz, about 64 px a second.
pub fn write_spectrogram(ff: &Ffmpeg, src: &Path, out: &Path, duration_us: Us) -> anyhow::Result<()> {
    let w = ((duration_us as f64 / 1e6) * 64.0).round().clamp(256.0, 8192.0) as u32;
    let r = ff
        .cmd_background()
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(src)
        .args(["-vn", "-lavfi", &format!("aresample=16000,aformat=channel_layouts=mono,showspectrumpic=s={w}x256:legend=0:color=magma:scale=log:fscale=lin:drange=75"), "-frames:v", "1", "-y"])
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()?;
    if !r.status.success() {
        bail!("spectrogram failed: {}", String::from_utf8_lossy(&r.stderr).lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}

/// Runs FFmpeg over part of a file with an analysis filter and returns its log.
fn analyse(ff: &Ffmpeg, src: &Path, in_us: Us, dur_us: Us, filter: &str) -> anyhow::Result<String> {
    let out = ff.cmd().args(["-hide_banner", "-nostats", "-loglevel", "info", "-ss", &secs(in_us), "-t", &secs(dur_us)]).arg("-i").arg(src).args(["-vn", "-af", filter, "-f", "null", "-"]).stdout(Stdio::null()).stderr(Stdio::piped()).output()?;
    let log = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        bail!("FFmpeg couldn't read the sound: {}", log.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(""));
    }
    Ok(log)
}

/// The loudest sample (dBFS) or the integrated loudness (LUFS) of part of a file.
pub fn level_of(ff: &Ffmpeg, src: &Path, in_us: Us, dur_us: Us, loudness: bool) -> anyhow::Result<f64> {
    if loudness {
        let log = analyse(ff, src, in_us, dur_us, "ebur128")?;
        return parse_ebur128(&log, 1).and_then(|l| l.integrated).context("that part is silent");
    }
    let log = analyse(ff, src, in_us, dur_us, "volumedetect")?;
    log.lines().find_map(|l| number_after(l, "max_volume:")).filter(|v| *v > -90.0).context("that part is silent")
}

/// Where to cut out the pauses: each pause of at least `min_us` is cut, leaving `keep_us` of
/// air on each side of it.
pub fn cuts_for(silences: &[(Us, Us)], min_us: Us, keep_us: Us) -> Vec<(Us, Us)> {
    silences.iter().filter(|(a, b)| b - a >= min_us && b - a > 2 * keep_us).map(|&(a, b)| (a + keep_us, b - keep_us)).collect()
}

/// A file's levels as `write_levels` saved them: the peak of every 10 ms on the 0–255 scale.
pub fn read_peaks(path: &Path) -> anyhow::Result<Vec<u8>> {
    let v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    Ok(v["peak"].as_array().context("the levels file has no peaks")?.iter().map(|x| x.as_u64().unwrap_or(0).min(255) as u8).collect())
}

/// Pauses in a file's levels between `in_us` and `in_us + dur_us` of the source: stretches of
/// at least `min_us` where every 10 ms peak is under `noise_db`, as (start, end) from `in_us`.
/// Reading the cached levels instead of the sound takes well under a millisecond a minute,
/// so the Audio page can ask on every slider move. Peaks are kept to 1/255 of full scale, so
/// thresholds under about −48 dB count only true silence.
pub fn silences_in_levels(peaks: &[u8], in_us: Us, dur_us: Us, noise_db: f32, min_us: Us) -> Vec<(Us, Us)> {
    const STEP: Us = 10_000;
    let limit = (10f64.powf(noise_db as f64 / 20.0) * 255.0).max(0.5);
    let (first, last) = ((in_us.max(0) / STEP) as usize, ((in_us + dur_us + STEP - 1).max(0) / STEP) as usize);
    let mut out = vec![];
    let mut open: Option<Us> = None;
    for i in first..last {
        // Past the end of the file there is no sound.
        let quiet = peaks.get(i).is_none_or(|&p| (p as f64) < limit);
        let t = (i as Us * STEP - in_us).clamp(0, dur_us);
        match (quiet, open) {
            (true, None) => open = Some(t),
            (false, Some(s)) => {
                if t - s >= min_us {
                    out.push((s, t));
                }
                open = None;
            }
            _ => {}
        }
    }
    if let Some(s) = open.filter(|s| dur_us - s >= min_us) {
        out.push((s, dur_us));
    }
    out
}

/// Raw samples of a file's sound from `in_us` for `dur_us`, mixed to mono at the file's own
/// rate, as little-endian 32-bit floats. At normal priority: someone is waiting to see them.
pub fn samples(ff: &Ffmpeg, src: &Path, in_us: Us, dur_us: Us) -> anyhow::Result<Vec<u8>> {
    let out = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-ss", &secs(in_us), "-t", &secs(dur_us)]).arg("-i").arg(src).args(["-vn", "-ac", "1", "-f", "f32le", "pipe:1"]).stdout(Stdio::piped()).stderr(Stdio::piped()).output()?;
    if !out.status.success() {
        bail!("FFmpeg couldn't read the sound: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or(""));
    }
    Ok(out.stdout)
}

/// Where to split for one clip per phrase: the middle of each pause inside the clip.
pub fn split_points(silences: &[(Us, Us)], dur_us: Us) -> Vec<Us> {
    silences.iter().filter(|(a, b)| *a > 0 && *b < dur_us).map(|(a, b)| (a + b) / 2).collect()
}

/// The sounds between the pauses, as (start, end) from the clip's start.
pub fn sounds_between(silences: &[(Us, Us)], dur_us: Us) -> Vec<(Us, Us)> {
    let mut out = vec![];
    let mut at = 0;
    for &(a, b) in silences {
        if a - at >= 100_000 {
            out.push((at, a));
        }
        at = at.max(b);
    }
    if dur_us - at >= 100_000 {
        out.push((at, dur_us));
    }
    out
}

enum Work {
    Loudness { key: String, project: Arc<Project> },
    File { what: &'static str, media_id: String, src: PathBuf, out: PathBuf, duration_us: Us },
}

#[derive(Default)]
struct Queue {
    loudness: Option<(String, Arc<Project>)>,
    files: VecDeque<Work>,
    /// Files queued or being made, so asking twice doesn't make them twice.
    pending: Vec<PathBuf>,
}

/// The background worker for the Audio page's analysis.
pub struct Analysis {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    /// The last loudness measured, and the mix it belongs to.
    last: Arc<Mutex<Option<(String, Value)>>>,
}

impl Analysis {
    pub fn start(ff: Arc<Ffmpeg>, events: Events) -> Self {
        let queue: Arc<(Mutex<Queue>, Condvar)> = Arc::default();
        let last: Arc<Mutex<Option<(String, Value)>>> = Arc::default();
        let (q, l) = (queue.clone(), last.clone());
        std::thread::Builder::new().name("audio-analysis".into()).spawn(move || worker(ff, events, q, l)).expect("spawn audio analysis");
        Self { queue, last }
    }

    /// The mix's loudness if it's already measured; otherwise starts measuring it (the
    /// result arrives as an `audio.loudness` event) and says so.
    pub fn loudness(&self, project: Arc<Project>) -> Value {
        let key = mix_key(&project);
        if let Some((k, v)) = self.last.lock().unwrap().as_ref() {
            if *k == key {
                return v.clone();
            }
        }
        let (m, cv) = &*self.queue;
        m.lock().unwrap().loudness = Some((key, project));
        cv.notify_one();
        json!({ "pending": true })
    }

    /// A cached file if it's there; otherwise queues it (an `audio.levels` or
    /// `audio.spectrogram` event follows).
    pub fn file(&self, what: &'static str, media_id: &str, src: &Path, cache: &Path, duration_us: Us) -> Value {
        // The spectrogram shows 75 dB below the loudest part (quiet room tone is black, as on the
        // canvas); "-2" so files cached with the old, brighter range are made again.
        let name = if what == "levels" { "levels.json" } else { "spectrogram-2.png" };
        let out = cache.join(media_id).join(name);
        if out.is_file() {
            return json!({ "mediaId": media_id, "path": out.to_string_lossy() });
        }
        let (m, cv) = &*self.queue;
        let mut q = m.lock().unwrap();
        if !q.pending.contains(&out) {
            q.pending.push(out.clone());
            q.files.push_back(Work::File { what, media_id: media_id.into(), src: src.into(), out, duration_us });
            cv.notify_one();
        }
        json!({ "mediaId": media_id, "pending": true })
    }
}

fn worker(ff: Arc<Ffmpeg>, events: Events, queue: Arc<(Mutex<Queue>, Condvar)>, last: Arc<Mutex<Option<(String, Value)>>>) {
    loop {
        let work = {
            let (m, cv) = &*queue;
            let mut q = m.lock().unwrap();
            loop {
                // The loudness first: it follows every edit, and only the newest counts.
                if let Some((key, project)) = q.loudness.take() {
                    break Work::Loudness { key, project };
                }
                if let Some(w) = q.files.pop_front() {
                    break w;
                }
                q = cv.wait(q).unwrap();
            }
        };
        match work {
            Work::Loudness { key, project } => match measure_mix(&ff, &project, true) {
                Ok(l) => {
                    let v = json!({ "integrated": l.integrated, "lra": l.lra, "truePeak": l.true_peak, "short": l.short, "stepUs": l.step_us, "durationUs": project.duration_us() });
                    *last.lock().unwrap() = Some((key, v.clone()));
                    events.emit("audio.loudness", v);
                }
                Err(e) => events.emit("audio.failed", json!({ "what": "loudness", "error": e.to_string() })),
            },
            Work::File { what, media_id, src, out, duration_us } => {
                if let Some(dir) = out.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let r = if what == "levels" { write_levels(&ff, &src, &out) } else { write_spectrogram(&ff, &src, &out, duration_us) };
                queue.0.lock().unwrap().pending.retain(|p| p != &out);
                match r {
                    Ok(()) => events.emit(&format!("audio.{what}"), json!({ "mediaId": media_id, "path": out.to_string_lossy() })),
                    Err(e) => events.emit("audio.failed", json!({ "what": what, "mediaId": media_id, "error": e.to_string() })),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::model::{Effects, EnvPoint, Media, MediaKind, SECOND, TrackChange};

    const LOG: &str = "[Parsed_ebur128_0 @ 0] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS
[Parsed_ebur128_0 @ 0] t: 3.99998    TARGET:-23 LUFS    M: -21.6 S: -24.7     I: -22.3 LUFS       LRA:   1.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS
[Parsed_ebur128_0 @ 0] t: 4.09998    TARGET:-23 LUFS    M: -21.6 S: -24.66     I: -22.3 LUFS       LRA:   1.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS
[Parsed_ebur128_0 @ 0] Summary:

  Integrated loudness:
    I:         -22.2 LUFS
    Threshold: -32.3 LUFS

  Loudness range:
    LRA:         1.0 LU
    Threshold: -44.5 LUFS
    LRA low:   -24.8 LUFS
    LRA high:  -23.7 LUFS

  True peak:
    Peak:      -18.1 dBFS
";

    #[test]
    fn reads_the_loudness_summary_and_series() {
        let l = parse_ebur128(LOG, 400).unwrap();
        assert_eq!((l.integrated, l.lra, l.true_peak), (Some(-22.2), Some(1.0), Some(-18.1)));
        assert_eq!(l.short, vec![-70.0, -24.7, -24.7]);
        assert_eq!(l.step_us, 100_000);
        let thin = parse_ebur128(LOG, 2).unwrap();
        assert_eq!((thin.short.len(), thin.step_us), (2, 200_000));
        assert!(parse_ebur128("no summary here", 10).is_none());
        let silent = parse_ebur128("Summary:\n    I:         -70.0 LUFS\n    Peak:       -inf dBFS\n", 10).unwrap();
        assert_eq!((silent.integrated, silent.true_peak), (None, None), "silence has no loudness");
    }

    #[test]
    fn finds_pauses_and_what_to_do_with_them() {
        let s = vec![(0, 600_000), (2 * SECOND, 3_500_000), (5_800_000, 6 * SECOND)];
        assert_eq!(cuts_for(&s, 500_000, 100_000), vec![(100_000, 500_000), (2_100_000, 3_400_000)], "0.1 s of air each side; the 0.2 s pause at the end stays");
        assert_eq!(cuts_for(&s, 500_000, 300_000), vec![(2_300_000, 3_200_000)], "too short for 0.3 s each side");
        assert_eq!(split_points(&s, 6 * SECOND), vec![2_750_000], "only pauses inside the clip");
        assert_eq!(sounds_between(&s, 6 * SECOND), vec![(600_000, 2 * SECOND), (3_500_000, 5_800_000)]);
    }

    #[test]
    fn pauses_are_found_in_the_cached_levels() {
        // Loud, quiet from 1.0 to 1.6 s and from 2.95 s to the end (3 s), at 100 peaks a second.
        let mut peaks = vec![200u8; 300];
        for p in peaks.iter_mut().take(160).skip(100) {
            *p = 1;
        }
        for p in peaks.iter_mut().skip(295) {
            *p = 0;
        }
        assert_eq!(silences_in_levels(&peaks, 0, 3 * SECOND, -40.0, 500_000), vec![(SECOND, 1_600_000)]);
        assert_eq!(silences_in_levels(&peaks, 0, 3 * SECOND, -40.0, 50_000), vec![(SECOND, 1_600_000), (2_950_000, 3 * SECOND)]);
        // From 1.2 s into the source for 1 s: the pause starts at its start.
        assert_eq!(silences_in_levels(&peaks, 1_200_000, SECOND, -40.0, 100_000), vec![(0, 400_000)]);
        assert!(silences_in_levels(&peaks, 0, 3 * SECOND, -60.0, 500_000).is_empty(), "at −60 dB a peak of 1 isn't silence");
        // A minute of levels reads fast enough for every slider move.
        let minute: Vec<u8> = (0..6000).map(|i| if i % 300 < 60 { 0 } else { 180 }).collect();
        let t = std::time::Instant::now();
        for _ in 0..10 {
            assert_eq!(silences_in_levels(&minute, 0, 60 * SECOND, -40.0, 500_000).len(), 20);
        }
        assert!(t.elapsed().as_millis() < 50, "{:?}", t.elapsed());
    }

    #[test]
    fn levels_are_on_the_files_own_scale() {
        let mut samples = vec![0i16; 80];
        samples.extend(std::iter::repeat_n(16384i16, 80));
        let (peak, rms) = levels_from(&samples);
        assert_eq!(peak, vec![0, 128]);
        assert_eq!(rms, vec![0, 128]);
    }

    /// The whole chain on real FFmpeg: every effect, the clip settings and the master stage
    /// make a graph FFmpeg accepts, and the mix measures. Skipped without FFmpeg.
    #[test]
    fn every_effect_runs_in_ffmpeg_and_the_mix_measures() {
        let Ok(ff) = Ffmpeg::detect() else { return };
        let dir = std::env::temp_dir().join(format!("studio-audio-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("tone.wav");
        let ok = ff.cmd().args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-af", "volume=12dB", "-y"]).arg(&tone).status().unwrap();
        assert!(ok.success());
        let mut p = Project::new("T", "9:16");
        p.media.push(Media { id: "m1".into(), path: tone.to_string_lossy().into(), name: "tone".into(), kind: MediaKind::Audio, duration_us: 3 * SECOND, has_audio: true, ..Default::default() });
        let c = p.insert("m1", 0).unwrap();
        let plain = measure_mix(&ff, &p, false).unwrap();
        let i = plain.integrated.unwrap();
        assert!((-14.0..-3.0).contains(&i), "a −6 dBFS tone in both channels measures about −7 LUFS, got {i}");

        // A −6 dB fader takes 6 LU off.
        let t = p.tracks[1].id.clone();
        p.set_track(&t, TrackChange { gain_db: Some(-6.0), ..Default::default() }).unwrap();
        let quieter = measure_mix(&ff, &p, false).unwrap().integrated.unwrap();
        assert!((quieter - (i - 6.0)).abs() < 0.3, "{quieter} vs {i}");

        let mut fx = Effects::default();
        fx.noise.on = true;
        fx.eq.on = true;
        fx.comp.on = true;
        fx.deess.on = true;
        fx.limiter.on = true;
        p.set_track(&t, TrackChange { effects: Some(fx), pan: Some(0.4), ..Default::default() }).unwrap();
        use studio_engine_core::model::ClipChange;
        p.set_clip(&c, ClipChange { fade_in_us: Some(SECOND / 2), fade_out_us: Some(SECOND / 2), fade_curve: Some("scurve".into()), pitch: Some(-2.0), declick: Some(true), envelope: Some(vec![EnvPoint { at_us: 0, gain: 1.0 }, EnvPoint { at_us: 2 * SECOND, gain: 0.25 }]), ..Default::default() }).unwrap();
        let processed = measure_mix(&ff, &p, false).unwrap();
        assert!(processed.integrated.is_some() && processed.short.len() >= 25, "{processed:?}");

        // The export's master stage runs too.
        let mut args = graph::build(&graph::timeline_from(&p, 0, false), None, true, true);
        args.extend(["-map", "[aout]", "-f", "null", "-"].map(String::from));
        assert!(ff.cmd().args(&args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());

        // Levels, spectrogram and the silence finder on the same file.
        write_levels(&ff, &tone, &dir.join("levels.json")).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("levels.json")).unwrap()).unwrap();
        assert_eq!(v["peak"].as_array().unwrap().len(), 300);
        assert!((120..=135).contains(&v["peak"][150].as_u64().unwrap()), "−6 dBFS is about half scale: {}", v["peak"][150]);
        write_spectrogram(&ff, &tone, &dir.join("spec.png"), 3 * SECOND).unwrap();
        assert!(dir.join("spec.png").metadata().unwrap().len() > 1000);
        assert!(silences_in_levels(&read_peaks(&dir.join("levels.json")).unwrap(), 0, 3 * SECOND, -40.0, 500_000).is_empty(), "a steady tone has no pauses");
        let peak = level_of(&ff, &tone, 0, 3 * SECOND, false).unwrap();
        assert!((peak + 6.0).abs() < 0.3, "{peak}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
