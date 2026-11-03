//! Preview producer: a dedicated thread that renders frames on a steady clock and
//! writes them into the shared ring. Step 0 renders a test pattern; later steps swap
//! in the real compositor without changing the hand-off.

use crate::pattern;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use studio_engine_core::ring::RingWriter;

#[derive(Debug, Clone, Copy)]
pub struct PreviewConfig {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Default)]
struct Stats {
    frames: AtomicU64,
    late: AtomicU64,
    write_us_total: AtomicU64,
}

struct Running {
    config: PreviewConfig,
    stop: Arc<AtomicBool>,
    stats: Arc<Stats>,
    join: JoinHandle<()>,
}

pub struct Preview {
    ring: Arc<Mutex<RingWriter>>,
    ring_path: PathBuf,
    max: (u32, u32),
    running: Mutex<Option<Running>>,
    last: Mutex<Option<(PreviewConfig, Arc<Stats>)>>,
}

impl Preview {
    pub fn new(ring: Arc<Mutex<RingWriter>>, ring_path: &Path, max_width: u32, max_height: u32) -> Self {
        Self { ring, ring_path: ring_path.to_path_buf(), max: (max_width, max_height), running: Mutex::new(None), last: Mutex::new(None) }
    }

    pub fn start(&self, config: PreviewConfig) -> Result<(), String> {
        if config.width == 0 || config.height == 0 || config.width > self.max.0 || config.height > self.max.1 {
            return Err(format!("frame size must be within {}x{}", self.max.0, self.max.1));
        }
        if !(1.0..=240.0).contains(&config.fps) {
            return Err("fps must be between 1 and 240".into());
        }
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(Stats::default());
        let join = {
            let (stop, stats, ring) = (stop.clone(), stats.clone(), self.ring.clone());
            std::thread::Builder::new().name("preview".into()).spawn(move || produce(config, &ring, &stop, &stats)).map_err(|e| e.to_string())?
        };
        *self.running.lock().unwrap() = Some(Running { config, stop, stats, join });
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::Relaxed);
            let _ = r.join.join();
            *self.last.lock().unwrap() = Some((r.config, r.stats));
        }
    }

    pub fn status(&self) -> Value {
        let running = self.running.lock().unwrap();
        let last = self.last.lock().unwrap();
        let (is_running, config, stats) = match (&*running, &*last) {
            (Some(r), _) => (true, Some(r.config), Some(r.stats.clone())),
            (None, Some((c, s))) => (false, Some(*c), Some(s.clone())),
            (None, None) => (false, None, None),
        };
        let frames = stats.as_ref().map_or(0, |s| s.frames.load(Ordering::Relaxed));
        let write_total = stats.as_ref().map_or(0, |s| s.write_us_total.load(Ordering::Relaxed));
        json!({
            "running": is_running,
            "width": config.map(|c| c.width),
            "height": config.map(|c| c.height),
            "fps": config.map(|c| c.fps),
            "framesWritten": frames,
            "lateFrames": stats.as_ref().map_or(0, |s| s.late.load(Ordering::Relaxed)),
            "avgWriteUs": if frames > 0 { write_total / frames } else { 0 },
            "maxWidth": self.max.0,
            "maxHeight": self.max.1,
            "ringPath": self.ring_path.to_string_lossy(),
        })
    }
}

/// Sleeps coarsely, then spins for the last stretch, so frames land on time.
fn wait_until(target: Instant) {
    loop {
        let now = Instant::now();
        if now >= target {
            return;
        }
        let left = target - now;
        if left > Duration::from_millis(2) {
            std::thread::sleep(left - Duration::from_millis(1));
        } else {
            std::hint::spin_loop();
        }
    }
}

fn produce(config: PreviewConfig, ring: &Mutex<RingWriter>, stop: &AtomicBool, stats: &Stats) {
    let period = Duration::from_secs_f64(1.0 / config.fps);
    let start = Instant::now();
    let mut n: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        let due = start + period.mul_f64(n as f64);
        wait_until(due);
        let t0 = Instant::now();
        let pts_us = (n as f64 * 1_000_000.0 / config.fps) as u64;
        ring.lock().unwrap().write_frame(config.width, config.height, pts_us, |px, stride| pattern::draw(px, config.width, config.height, stride, n));
        let done = Instant::now();
        stats.frames.fetch_add(1, Ordering::Relaxed);
        stats.write_us_total.fetch_add((done - t0).as_micros() as u64, Ordering::Relaxed);
        if done > due + period {
            stats.late.fetch_add(1, Ordering::Relaxed);
        }
        n += 1;
    }
}
