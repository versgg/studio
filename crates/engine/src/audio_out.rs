//! Sound output. The output device's sample counter is the playback clock, so picture
//! follows sound and they can't drift. With no audio device, a wall clock stands in.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct Shared {
    buffer: Mutex<Arc<Vec<f32>>>,
    playing: AtomicBool,
    frames_played: AtomicU64,
    start_frame: AtomicU64,
    start_us: AtomicI64,
    /// STUDIO_SILENT=1 (the tests): the clock runs on the real device, but it plays silence.
    silent: bool,
}

#[derive(Clone)]
pub struct AudioOut {
    shared: Arc<Shared>,
    pub rate: u32,
    pub channels: u16,
    pub device: Option<String>,
    wall_start: Arc<Mutex<Option<Instant>>>,
}

impl AudioOut {
    /// Opens the default output device on a thread that owns the stream for good.
    pub fn open() -> Self {
        let shared = Arc::new(Shared {
            buffer: Mutex::new(Arc::new(vec![])),
            playing: AtomicBool::new(false),
            frames_played: AtomicU64::new(0),
            start_frame: AtomicU64::new(0),
            start_us: AtomicI64::new(0),
            silent: std::env::var_os("STUDIO_SILENT").is_some_and(|v| v != "0"),
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let s = shared.clone();
        std::thread::Builder::new()
            .name("audio-out".into())
            .spawn(move || {
                let result = (|| -> Option<(cpal::Stream, u32, u16, String)> {
                    let host = cpal::default_host();
                    let device = host.default_output_device()?;
                    let supported = device.default_output_config().ok()?;
                    let config = supported.config();
                    let (rate, channels) = (config.sample_rate, config.channels);
                    let name = device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "output".into());
                    let cb = s.clone();
                    let ch = channels as usize;
                    let stream = match supported.sample_format() {
                        cpal::SampleFormat::F32 => device.build_output_stream::<f32, _, _>(config, move |out, _| fill(&cb, out, ch, |x| x), |e| eprintln!("[engine] audio error: {e}"), None),
                        cpal::SampleFormat::I16 => device.build_output_stream::<i16, _, _>(config, move |out, _| fill(&cb, out, ch, |x| (x.clamp(-1.0, 1.0) * i16::MAX as f32) as i16), |e| eprintln!("[engine] audio error: {e}"), None),
                        _ => return None,
                    }
                    .ok()?;
                    stream.play().ok()?;
                    Some((stream, rate, channels, name))
                })();
                match result {
                    Some((stream, rate, channels, name)) => {
                        let _ = tx.send(Some((rate, channels, name)));
                        let _keep = stream;
                        loop {
                            std::thread::park();
                        }
                    }
                    None => {
                        let _ = tx.send(None);
                    }
                }
            })
            .expect("spawn audio thread");
        let (rate, channels, device) = match rx.recv().ok().flatten() {
            Some((r, c, n)) => (r, c, Some(n)),
            None => (48_000, 2, None),
        };
        println!("[engine] audio output: {} ({rate} Hz, {channels} ch)", device.as_deref().unwrap_or("none, using a wall clock"));
        Self { shared, rate, channels, device, wall_start: Arc::new(Mutex::new(None)) }
    }

    /// Interleaved samples at `rate` × `channels`, starting at timeline 0.
    pub fn load(&self, samples: Arc<Vec<f32>>) {
        *self.shared.buffer.lock().unwrap() = samples;
    }

    pub fn start(&self, from_us: i64) {
        let frame = (from_us.max(0) as f64 * self.rate as f64 / 1_000_000.0) as u64;
        self.shared.start_frame.store(frame, Ordering::Relaxed);
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.shared.start_us.store(from_us, Ordering::Relaxed);
        *self.wall_start.lock().unwrap() = Some(Instant::now());
        self.shared.playing.store(true, Ordering::Release);
    }

    pub fn stop(&self) {
        self.shared.playing.store(false, Ordering::Release);
        *self.wall_start.lock().unwrap() = None;
    }

    /// Where playback is now, in timeline microseconds.
    pub fn position_us(&self) -> i64 {
        let start = self.shared.start_us.load(Ordering::Relaxed);
        if self.device.is_none() {
            return start + self.wall_start.lock().unwrap().map_or(0, |t| t.elapsed().as_micros() as i64);
        }
        start + (self.shared.frames_played.load(Ordering::Relaxed) as f64 * 1_000_000.0 / self.rate as f64) as i64
    }
}

/// Fills one device buffer. The mix was rendered at the device's rate and channel
/// count, so samples copy straight across.
fn fill<T: Copy + Default>(s: &Shared, out: &mut [T], ch: usize, convert: impl Fn(f32) -> T) {
    let ch = ch.max(1);
    if !s.playing.load(Ordering::Acquire) {
        out.fill(T::default());
        return;
    }
    // Never block the audio thread: if the buffer is being swapped, play silence once.
    let Ok(buffer) = s.buffer.try_lock() else {
        out.fill(T::default());
        return;
    };
    let played = s.frames_played.load(Ordering::Relaxed);
    let first = ((s.start_frame.load(Ordering::Relaxed) + played) as usize) * ch;
    if s.silent {
        out.fill(T::default());
    } else {
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = buffer.get(first + i).copied().map_or(T::default(), &convert);
        }
    }
    drop(buffer);
    s.frames_played.fetch_add((out.len() / ch) as u64, Ordering::Relaxed);
}
