//! Files the timeline needs made in the background, one at a time: stabilising's first pass
//! (vidstabdetect) and pictures that turn or change size rendered once (studio_media::motion).
//! Until one is ready the preview does without it (the clip unstabilised, the picture turned
//! and sized as it plays); when it arrives the paused frame is drawn again with it. Export
//! runs any missing stabilising pass itself first, and never reads a motion file.

use crate::events::Events;
use serde_json::json;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use studio_media::Ffmpeg;
use studio_media::graph::StabJob;
use studio_media::motion::MotionJob;

/// One file to make.
pub enum Work {
    Stab(StabJob),
    Motion(MotionJob),
}

impl Work {
    /// The file it makes, which names it.
    fn out(&self) -> &str {
        match self {
            Work::Stab(j) => &j.trf,
            Work::Motion(j) => &j.out,
        }
    }
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Work>,
    /// Files queued or being made, so asking twice doesn't make them twice.
    pending: Vec<String>,
    /// Ones that failed (a missing file): not tried again on every edit.
    failed: Vec<String>,
}

pub struct Stabilizer {
    queue: Arc<(Mutex<Queue>, Condvar)>,
}

impl Stabilizer {
    /// Starts the worker; `ready` runs after each file is written.
    pub fn start(ff: Arc<Ffmpeg>, events: Events, ready: Arc<dyn Fn() + Send + Sync>) -> Self {
        let queue: Arc<(Mutex<Queue>, Condvar)> = Arc::default();
        let q = queue.clone();
        std::thread::Builder::new().name("stabilize".into()).spawn(move || worker(ff, events, q, ready)).expect("spawn stabilizer");
        Self { queue }
    }

    /// Queues the files not already queued or being made.
    pub fn submit(&self, jobs: Vec<Work>) {
        let (m, cv) = &*self.queue;
        let mut q = m.lock().unwrap();
        for j in jobs {
            let out = j.out().to_string();
            if !q.pending.contains(&out) && !q.failed.contains(&out) {
                q.pending.push(out);
                q.jobs.push_back(j);
            }
        }
        cv.notify_one();
    }

    /// Drops what's queued and not started (another project was opened).
    pub fn clear(&self) {
        let mut q = self.queue.0.lock().unwrap();
        let dropped: Vec<String> = q.jobs.drain(..).map(|j| j.out().to_string()).collect();
        q.pending.retain(|p| !dropped.contains(p));
    }
}

fn worker(ff: Arc<Ffmpeg>, events: Events, queue: Arc<(Mutex<Queue>, Condvar)>, ready: Arc<dyn Fn() + Send + Sync>) {
    loop {
        let job = {
            let (m, cv) = &*queue;
            let mut q = m.lock().unwrap();
            loop {
                if let Some(j) = q.jobs.pop_front() {
                    break j;
                }
                q = cv.wait(q).unwrap();
            }
        };
        // Background priority: playback and export come first.
        let r = match &job {
            Work::Stab(j) => ff.stabilize_detect(Path::new(&j.path), j.in_us, j.span_us, Path::new(&j.trf), true),
            Work::Motion(j) => ff.render_motion(j, true),
        };
        let out = job.out().to_string();
        {
            let mut q = queue.0.lock().unwrap();
            q.pending.retain(|t| t != &out);
            if r.is_err() {
                q.failed.push(out.clone());
            }
        }
        match (&job, r) {
            (Work::Stab(_), Ok(())) => {
                events.emit("stabilize.ready", json!({ "trf": out }));
                ready();
            }
            (Work::Stab(_), Err(e)) => events.emit("stabilize.failed", json!({ "trf": out, "error": e.to_string() })),
            (Work::Motion(_), Ok(())) => ready(),
            (Work::Motion(_), Err(e)) => eprintln!("[engine] motion file {out}: {e}"),
        }
    }
}
