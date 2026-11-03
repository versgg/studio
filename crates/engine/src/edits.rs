//! The Audio page's sample drawing: a corrected copy of a clip's sound, written as a WAV under
//! `<project>.studio/edits/`, which the clip then plays instead (one undo step).

use std::io::{self, Read, Write};
use std::path::Path;
use std::process::Stdio;
use studio_media::Ffmpeg;

pub const RATE: u32 = 48_000;

/// A file's whole sound as 48 kHz stereo float samples, interleaved.
pub fn decode_stereo(ff: &Ffmpeg, src: &Path) -> anyhow::Result<Vec<f32>> {
    let mut child = ff.cmd().args(["-hide_banner", "-loglevel", "error"]).arg("-i").arg(src).args(["-vn", "-ac", "2", "-ar", &RATE.to_string(), "-f", "f32le", "pipe:1"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut raw = vec![];
    child.stdout.take().expect("piped").read_to_end(&mut raw)?;
    if !child.wait()?.success() {
        anyhow::bail!("FFmpeg couldn't read the clip's sound");
    }
    Ok(raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// Puts drawn samples (mono, `rate` a second) into interleaved 48 kHz stereo sound from
/// `at_s` seconds, resampled with straight lines between them, on both channels. `reverse`
/// draws them backwards from there (a clip that plays backwards). Returns how many frames
/// changed.
pub fn draw_into(sound: &mut [f32], at_s: f64, samples: &[f32], rate: f64, reverse: bool) -> usize {
    if samples.is_empty() || rate <= 0.0 {
        return 0;
    }
    let frames = sound.len() / 2;
    let n = ((samples.len() as f64 / rate) * RATE as f64).round() as usize;
    let start = (at_s * RATE as f64).round() as i64;
    let mut changed = 0;
    for i in 0..n {
        // Where the i-th output sample falls between the drawn ones.
        let x = i as f64 * rate / RATE as f64;
        let (k, f) = (x.floor() as usize, x.fract());
        let a = samples[k.min(samples.len() - 1)];
        let b = samples[(k + 1).min(samples.len() - 1)];
        let v = (a as f64 + (b as f64 - a as f64) * f).clamp(-1.0, 1.0) as f32;
        let at = if reverse { start - i as i64 } else { start + i as i64 };
        if at < 0 || at as usize >= frames {
            continue;
        }
        sound[at as usize * 2] = v;
        sound[at as usize * 2 + 1] = v;
        changed += 1;
    }
    changed
}

/// Writes interleaved 48 kHz stereo float samples as a WAV file (IEEE float, 32 bit).
pub fn write_wav(path: &Path, samples: &[f32]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let data = (samples.len() * 4) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 8).to_le_bytes());
    out.extend_from_slice(&8u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::File::create(path)?.write_all(&out)
}

/// Standard base64 (with padding), for raw samples sent over JSON.
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&1.0f32.to_le_bytes()), "AACAPw==");
    }

    #[test]
    fn drawn_samples_are_resampled_into_both_channels() {
        let mut sound = vec![0.5f32; 2 * 48_000];
        // Four drawn samples at 8 kHz cover half a millisecond: 24 frames at 48 kHz.
        let n = draw_into(&mut sound, 0.5, &[0.0, 0.6, 0.6, 0.0], 8000.0, false);
        assert_eq!(n, 24);
        assert_eq!((sound[24_000 * 2], sound[24_000 * 2 + 1]), (0.0, 0.0));
        assert!((sound[(24_000 + 6) * 2] - 0.6).abs() < 1e-6);
        assert_eq!(sound[(24_000 + 30) * 2], 0.5, "past the drawing nothing changes");
        let n = draw_into(&mut sound, 0.1, &[1.0, -1.0], 48_000.0, true);
        assert_eq!((n, sound[4800 * 2], sound[4799 * 2]), (2, 1.0, -1.0), "backwards from there");
        assert_eq!(draw_into(&mut sound, 5.0, &[1.0], 48_000.0, false), 0, "past the end");
    }

    #[test]
    fn wav_files_have_a_float_header() {
        let p = std::env::temp_dir().join(format!("studio-wav-{}.wav", std::process::id()));
        write_wav(&p, &[0.0, 0.25, -0.25, 1.0]).unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!((&b[0..4], &b[8..12], u16::from_le_bytes([b[20], b[21]]), u32::from_le_bytes([b[40], b[41], b[42], b[43]]), b.len()), (&b"RIFF"[..], &b"WAVE"[..], 3, 16, 60));
        let _ = std::fs::remove_file(p);
    }
}
