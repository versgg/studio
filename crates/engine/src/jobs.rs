//! Background media work: poster, filmstrip and waveform peaks for the library, and the
//! proxy for smooth playback.
//!
//! A file's work is done in three passes, so hundreds of files show up quickly: every poster
//! first (what the library shows), then filmstrips and waveforms, then proxies, with what
//! the timeline uses ahead of the library (`rank`). The heavy passes run on a quarter of the
//! cores (2–4 at once, proxies on all but one of them while a filmstrip waits), and as many
//! workers again are free for posters, so a poster never waits behind a long proxy.
//!
//! Proxies are the slow part, so media from a linked folder only gets one when a clip
//! first uses it, and a video no bigger than a proxy never gets one (`wants_proxy`).
//!
//! What's made is also kept in a cache shared by every project (`SHARED`), by file: its
//! path, size and modified time. A file one project has met is ready at once in the next
//! (linked into the project's own cache, so each project still holds its files).

use crate::doc::Doc;
use crate::events::Events;
use serde_json::json;
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use studio_engine_core::model::{Media, MediaKind};
use studio_media::Ffmpeg;
use studio_media::derive::PROXY_SIZE;

pub struct Job {
    pub media_id: String,
    pub path: PathBuf,
    pub kind: MediaKind,
    pub duration_us: i64,
    pub has_audio: bool,
    pub cache: PathBuf,
    /// The poster (what the library draws).
    pub browse: bool,
    /// Filmstrip and waveform: only for media a timeline clip uses, as only the timeline draws
    /// them. A linked folder of 2,318 files used to get all three for every file, so the library
    /// counted "0 of 2318 ready" for minutes while FFmpeg made filmstrips nobody would see.
    pub look: bool,
    /// The every-frame-a-keyframe copy playback reads.
    pub proxy: bool,
}

/// A video bigger than a proxy. A smaller one already seeks fast from its own file, and its
/// proxy would only be a larger copy of it.
pub fn wants_proxy(media: &Media) -> bool {
    media.kind == MediaKind::Video && (media.width.max(media.height) > PROXY_SIZE || media.width == 0)
}

/// The cache every project shares, set once at startup; none (each project for itself) when unset, as in tests.
pub static SHARED: OnceLock<PathBuf> = OnceLock::new();

/// A file's folder in the shared cache: by its path, size and modified time (FNV-1a, so the
/// key stays the same from one build to the next). None if the file can't be read.
fn shared_dir(root: &Path, file: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(file).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let id = format!("{}|{}|{}", file.to_string_lossy().to_lowercase(), meta.len(), modified);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    Some(root.join(format!("{h:016x}")))
}

/// `name` from the shared cache into `out`, if it's there: a hard link (instant, no space),
/// else a copy (another drive).
fn fetch(shared: Option<&Path>, name: &str, out: &Path) -> bool {
    let Some(src) = shared.map(|d| d.join(name)).filter(|p| p.is_file()) else { return false };
    let _ = std::fs::remove_file(out);
    std::fs::hard_link(&src, out).is_ok() || std::fs::copy(&src, out).is_ok()
}

/// A file just made, kept in the shared cache for every other project.
fn keep(shared: Option<&Path>, name: &str, made: &Path) {
    let Some(dir) = shared else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let dst = dir.join(name);
    let _ = std::fs::remove_file(&dst);
    let _ = std::fs::hard_link(made, &dst).or_else(|_| std::fs::copy(made, &dst).map(|_| ()));
}

/// One pass over a file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pass {
    Poster,
    /// Filmstrip and waveform.
    Look,
    Proxy,
}

/// Which queue a pass waits in, lowest first.
fn rank(pass: Pass, urgent: bool) -> usize {
    match (pass, urgent) {
        // What the timeline shows.
        (Pass::Poster | Pass::Look, true) => 0,
        // Every poster in the library.
        (Pass::Poster, false) => 1,
        // Smooth playback of the timeline's clips.
        (Pass::Proxy, true) => 2,
        // The library's filmstrips and waveforms.
        (Pass::Look, false) => 3,
        (Pass::Proxy, false) => 4,
    }
}
const RANKS: usize = 5;

struct Task {
    job: Arc<Job>,
    pass: Pass,
}

#[derive(Default)]
struct Lanes {
    ranks: [VecDeque<Task>; RANKS],
    /// Heavy passes (filmstrips and waveforms, proxies) running now, and how many of them are proxies.
    heavy: usize,
    proxies: usize,
    /// Media whose proxy a worker is making right now, by project cache and media id.
    making: Vec<(PathBuf, String)>,
    /// Media whose filmstrip and waveform a worker is making right now, and ones that failed
    /// (asked again only when the project is opened again), by project cache and media id.
    looking: Vec<(PathBuf, String)>,
    looks_failed: Vec<(PathBuf, String)>,
}

impl Lanes {
    fn add(&mut self, tasks: Vec<Task>, urgent: bool) {
        if urgent {
            // Each to the front of its queue, keeping their order.
            for t in tasks.into_iter().rev() {
                self.ranks[rank(t.pass, true)].push_front(t);
            }
        } else {
            for t in tasks {
                self.ranks[rank(t.pass, false)].push_back(t);
            }
        }
    }

    /// The next pass to run, if one may start: at most `heavy_max` heavy ones at once, all
    /// but one of them proxies while a filmstrip or waveform waits.
    fn take(&mut self, heavy_max: usize) -> Option<Task> {
        let heavy_free = self.heavy < heavy_max;
        let look_waits = self.ranks.iter().flatten().any(|t| t.pass == Pass::Look);
        let proxy_free = heavy_free && (self.proxies < (heavy_max - 1).max(1) || !look_waits);
        let (r, i) = (0..RANKS).find_map(|r| {
            let i = self.ranks[r].iter().position(|t| match t.pass {
                Pass::Poster => true,
                Pass::Look => heavy_free,
                Pass::Proxy => proxy_free,
            })?;
            Some((r, i))
        })?;
        let t = self.ranks[r].remove(i)?;
        if t.pass != Pass::Poster {
            self.heavy += 1;
        }
        if t.pass == Pass::Proxy {
            self.proxies += 1;
            self.making.push((t.job.cache.clone(), t.job.media_id.clone()));
        }
        if t.pass == Pass::Look {
            self.looking.push((t.job.cache.clone(), t.job.media_id.clone()));
        }
        Some(t)
    }

    fn hurry(&mut self, media_id: &str) {
        let mut found = vec![];
        for q in &mut self.ranks {
            let (theirs, rest): (VecDeque<Task>, VecDeque<Task>) = std::mem::take(q).into_iter().partition(|t| t.job.media_id == media_id);
            *q = rest;
            found.extend(theirs);
        }
        found.sort_by_key(|t| t.pass as u8);
        self.add(found, true);
    }

    /// The posters of these media go first (the library is showing them).
    fn want(&mut self, ids: &[String]) {
        let mut found = vec![];
        for q in &mut self.ranks {
            let (theirs, rest): (VecDeque<Task>, VecDeque<Task>) = std::mem::take(q).into_iter().partition(|t| t.pass == Pass::Poster && ids.contains(&t.job.media_id));
            *q = rest;
            found.extend(theirs);
        }
        // In the order asked (the library's, top first).
        found.sort_by_key(|t| ids.iter().position(|id| id == &t.job.media_id));
        for t in found.into_iter().rev() {
            self.ranks[0].push_front(t);
        }
    }

    fn done(&mut self, t: &Task) {
        if t.pass != Pass::Poster {
            self.heavy -= 1;
        }
        if t.pass == Pass::Proxy {
            self.proxies -= 1;
            self.making.retain(|(cache, id)| !(cache == &t.job.cache && id == &t.job.media_id));
        }
        if t.pass == Pass::Look {
            self.looking.retain(|(cache, id)| !(cache == &t.job.cache && id == &t.job.media_id));
        }
    }

    /// Takes out what's queued for any project but the one whose cache is `cache` (another
    /// project was opened). Every project numbers its media from m1, so their work must not mix.
    fn keep_only(&mut self, cache: &Path) {
        for q in &mut self.ranks {
            q.retain(|t| t.job.cache == cache);
        }
        self.looks_failed.clear();
    }
}

/// True if a job's result belongs to this project and media: the job was made for this project
/// (its cache) and for this file. Media ids repeat across projects, so the id alone isn't enough.
fn belongs(job: &Job, cache: &Path, media: &Media) -> bool {
    job.cache == cache && job.media_id == media.id && Path::new(&media.path) == job.path
}

struct Queue {
    lanes: Mutex<Lanes>,
    ready: Condvar,
    heavy_max: usize,
    /// True while the engine wants the machine to itself (a play starting or playing): no new
    /// work starts until it's false again (checked every 250 ms).
    quiet: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Clone)]
pub struct Jobs {
    queue: Arc<Queue>,
    /// Media with work queued or running, and how many passes each has (the open project's).
    pub processing: Arc<Mutex<BTreeMap<String, usize>>>,
    /// The open project's cache folder: the project the queue and `processing` are for.
    current: Arc<Mutex<PathBuf>>,
}

impl Jobs {
    pub fn start(ff: Arc<Ffmpeg>, doc: Arc<Mutex<Option<Doc>>>, processing: Arc<Mutex<BTreeMap<String, usize>>>, events: Events, on_change: Arc<dyn Fn() + Send + Sync>, quiet: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        let heavy_max = std::thread::available_parallelism().map(|n| (n.get() / 4).clamp(2, 4)).unwrap_or(2);
        let queue = Arc::new(Queue { lanes: Mutex::default(), ready: Condvar::new(), heavy_max, quiet });
        for n in 0..heavy_max * 2 {
            let (queue, ff, doc, events, processing, on_change) = (queue.clone(), ff.clone(), doc.clone(), events.clone(), processing.clone(), on_change.clone());
            std::thread::Builder::new().name(format!("media-{n}")).spawn(move || worker(queue, ff, doc, events, processing, on_change)).expect("spawn media worker");
        }
        Self { queue, processing, current: Arc::default() }
    }

    /// Another project is open (its cache folder): the last one's queued work is dropped and
    /// its media no longer count as processing. Passes already running finish into their own
    /// project's cache and the shared cache, but are applied to no other project.
    pub fn switch_to(&self, cache: &Path) {
        let mut current = self.current.lock().unwrap();
        if *current == cache {
            return;
        }
        *current = cache.to_path_buf();
        self.queue.lanes.lock().unwrap().keep_only(cache);
        self.processing.lock().unwrap().clear();
    }

    pub fn submit(&self, job: Job) {
        self.push(job, false);
    }

    /// Ahead of everything queued in each pass (a clip just put on the timeline).
    pub fn submit_urgent(&self, job: Job) {
        self.push(job, true);
    }

    fn push(&self, job: Job, urgent: bool) {
        let tasks = passes(job);
        let Some(first) = tasks.first() else { return };
        *self.processing.lock().unwrap().entry(first.job.media_id.clone()).or_default() += tasks.len();
        self.queue.lanes.lock().unwrap().add(tasks, urgent);
        self.queue.ready.notify_all();
    }

    /// What's queued for this media goes ahead, as the timeline's own (a clip of it was just
    /// put on the timeline, so its filmstrip and waveform are wanted now).
    pub fn hurry(&self, media_id: &str) {
        self.queue.lanes.lock().unwrap().hurry(media_id);
    }

    /// The library is showing these media: their posters go first, in this order.
    pub fn want(&self, ids: &[String]) {
        self.queue.lanes.lock().unwrap().want(ids);
        self.queue.ready.notify_all();
    }

    /// True if a filmstrip and waveform for this media of this project (its cache) is queued,
    /// being made, or failed this time the project was opened (so it isn't asked for on every edit).
    pub fn look_pending(&self, cache: &Path, media_id: &str) -> bool {
        let l = self.queue.lanes.lock().unwrap();
        let mine = |(c, m): &(PathBuf, String)| c == cache && m == media_id;
        l.ranks.iter().flatten().any(|t| t.pass == Pass::Look && t.job.cache == cache && t.job.media_id == media_id) || l.looking.iter().any(mine) || l.looks_failed.iter().any(mine)
    }

    /// True if a proxy for this media of this project (its cache) is queued or being made.
    pub fn proxy_pending(&self, cache: &Path, media_id: &str) -> bool {
        let l = self.queue.lanes.lock().unwrap();
        l.ranks.iter().flatten().any(|t| t.pass == Pass::Proxy && t.job.cache == cache && t.job.media_id == media_id) || l.making.iter().any(|(c, m)| c == cache && m == media_id)
    }
}

/// The passes a job asks for, in order.
fn passes(job: Job) -> Vec<Task> {
    let visual = job.kind != MediaKind::Audio;
    let wanted = [(Pass::Poster, job.browse && visual), (Pass::Look, job.look && (visual || job.has_audio)), (Pass::Proxy, job.proxy && job.kind == MediaKind::Video)];
    let job = Arc::new(job);
    wanted.into_iter().filter(|(_, w)| *w).map(|(pass, _)| Task { job: job.clone(), pass }).collect()
}

fn worker(queue: Arc<Queue>, ff: Arc<Ffmpeg>, doc: Arc<Mutex<Option<Doc>>>, events: Events, processing: Arc<Mutex<BTreeMap<String, usize>>>, on_change: Arc<dyn Fn() + Send + Sync>) {
    loop {
        let task = {
            let mut l = queue.lanes.lock().unwrap();
            loop {
                if !(queue.quiet)() {
                    if let Some(t) = l.take(queue.heavy_max) {
                        break t;
                    }
                }
                // Woken by new work or a lane coming free; every 250 ms while playing, to resume.
                l = queue.ready.wait_timeout(l, std::time::Duration::from_millis(250)).unwrap().0;
            }
        };
        let job = &task.job;
        let dir = job.cache.join(&job.media_id);
        let _ = std::fs::create_dir_all(&dir);
        let set = |field: &str, path: PathBuf| {
            let value = path.to_string_lossy().into_owned();
            if let Some(doc) = doc.lock().unwrap().as_mut() {
                let cache = doc.cache_dir();
                doc.quiet_update(|p| {
                    if let Some(m) = p.media.iter_mut().find(|m| belongs(job, &cache, m)) {
                        match field {
                            "poster" => m.poster = Some(value),
                            "strip" => m.strip = Some(value),
                            "peaks" => m.peaks = Some(value),
                            _ => m.proxy = Some(value),
                        }
                    }
                });
            }
            on_change();
        };
        let fail = |what: &str, e: anyhow::Error| {
            if task.pass == Pass::Look {
                queue.lanes.lock().unwrap().looks_failed.push((job.cache.clone(), job.media_id.clone()));
            }
            events.emit("media.warning", json!({ "mediaId": job.media_id, "message": format!("{what}: {e}") }))
        };
        // Taken from the shared cache when another project made it already, else made and kept there.
        let shared = SHARED.get().and_then(|root| shared_dir(root, &job.path));
        let made = |name: &str, make: &dyn Fn(&Path) -> anyhow::Result<()>| -> anyhow::Result<PathBuf> {
            let out = dir.join(name);
            if !fetch(shared.as_deref(), name, &out) {
                make(&out)?;
                keep(shared.as_deref(), name, &out);
            }
            Ok(out)
        };

        match task.pass {
            Pass::Poster => match made("poster.jpg", &|out| ff.poster(&job.path, out, job.kind, job.duration_us)) {
                Ok(p) => set("poster", p),
                Err(e) => fail("Poster", e),
            },
            Pass::Look => {
                if job.kind != MediaKind::Audio {
                    match made("strip.jpg", &|out| ff.strip(&job.path, out, job.kind, job.duration_us)) {
                        Ok(p) => set("strip", p),
                        Err(e) => fail("Filmstrip", e),
                    }
                }
                if job.has_audio {
                    let write = |out: &Path| -> anyhow::Result<()> { Ok(std::fs::write(out, json!({ "rate": 100, "peaks": ff.peaks(&job.path)? }).to_string())?) };
                    match made("peaks.json", &write) {
                        Ok(p) => set("peaks", p),
                        Err(e) => fail("Waveform", e),
                    }
                }
            }
            Pass::Proxy => match made("proxy.mp4", &|out| ff.proxy(&job.path, out)) {
                Ok(p) => set("proxy", p),
                Err(e) => fail("Proxy", e),
            },
        }
        queue.lanes.lock().unwrap().done(&task);
        // A heavy pass ended, so one waiting for a free lane may start.
        queue.ready.notify_all();
        // Counted only while its project is open (opening another one starts the count afresh).
        let open = doc.lock().unwrap().as_ref().is_some_and(|d| d.cache_dir() == job.cache);
        if open {
            let mut p = processing.lock().unwrap();
            if let Some(n) = p.get_mut(&job.media_id) {
                *n -= 1;
                if *n == 0 {
                    p.remove(&job.media_id);
                }
            }
        }
        on_change();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_made_once_is_handed_to_the_next_project() {
        let dir = std::env::temp_dir().join(format!("studio-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("p1")).unwrap();
        std::fs::create_dir_all(dir.join("p2")).unwrap();
        let src = dir.join("clip.mp4");
        std::fs::write(&src, b"a clip").unwrap();
        let root = dir.join("shared");
        let key = shared_dir(&root, &src).unwrap();
        assert_eq!(Some(&key), shared_dir(&root, &src).as_ref(), "the same file, the same folder");
        // Project 1 makes a poster and keeps it; project 2 gets it without making it.
        std::fs::write(dir.join("p1/poster.jpg"), b"poster").unwrap();
        keep(Some(&key), "poster.jpg", &dir.join("p1/poster.jpg"));
        assert!(fetch(Some(&key), "poster.jpg", &dir.join("p2/poster.jpg")));
        assert_eq!(std::fs::read(dir.join("p2/poster.jpg")).unwrap(), b"poster");
        assert!(!fetch(Some(&key), "strip.jpg", &dir.join("p2/strip.jpg")), "nothing kept, nothing handed over");
        // A file changed since is another file.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&src, b"a longer clip").unwrap();
        assert_ne!(Some(key), shared_dir(&root, &src));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_result_goes_only_to_its_own_project_and_file() {
        // Every project numbers its media from m1: m4 in one isn't m4 in another.
        let job = Job { cache: PathBuf::from("/p/A.studio/cache"), path: PathBuf::from("/media/a.mp4"), ..job("m4", MediaKind::Video, false, true) };
        let media = |path: &str| Media { id: "m4".into(), path: path.into(), ..Default::default() };
        assert!(belongs(&job, Path::new("/p/A.studio/cache"), &media("/media/a.mp4")));
        assert!(!belongs(&job, Path::new("/p/B.studio/cache"), &media("/media/a.mp4")), "another project's m4");
        assert!(!belongs(&job, Path::new("/p/A.studio/cache"), &media("/media/b.mp4")), "m4 is another file now");
    }

    #[test]
    fn opening_another_project_drops_the_last_ones_queued_work() {
        let mut l = Lanes::default();
        let of = |cache: &str, id: &str| passes(Job { cache: PathBuf::from(cache), ..used(id, MediaKind::Video, true, true) });
        l.add(of("/p/A.studio/cache", "m1"), false);
        l.add(of("/p/B.studio/cache", "m1"), false);
        l.keep_only(Path::new("/p/B.studio/cache"));
        let left: Vec<_> = l.ranks.iter().flatten().map(|t| t.job.cache.clone()).collect();
        assert_eq!(left.len(), 3, "B's poster, filmstrip and proxy");
        assert!(left.iter().all(|c| c == Path::new("/p/B.studio/cache")));
        // A proxy being made is known by its project as well as its media id.
        let t = std::iter::from_fn(|| l.take(4)).find(|t| t.pass == Pass::Proxy).unwrap();
        assert_eq!(l.making, vec![(PathBuf::from("/p/B.studio/cache"), "m1".to_string())]);
        l.done(&t);
        assert!(l.making.is_empty());
    }

    /// A file in the library: its poster (and a proxy if asked). On the timeline: its filmstrip and waveform too.
    fn job(id: &str, kind: MediaKind, browse: bool, proxy: bool) -> Job {
        Job { media_id: id.into(), path: PathBuf::new(), kind, duration_us: 1_000_000, has_audio: true, cache: PathBuf::new(), browse, look: false, proxy }
    }
    fn used(id: &str, kind: MediaKind, browse: bool, proxy: bool) -> Job {
        Job { look: true, ..job(id, kind, browse, proxy) }
    }

    fn order(l: &mut Lanes, heavy_max: usize) -> Vec<String> {
        let mut out = vec![];
        while let Some(t) = l.take(heavy_max) {
            out.push(format!("{} {:?}", t.job.media_id, t.pass));
            l.done(&t);
        }
        out
    }

    #[test]
    fn every_poster_comes_before_filmstrips_and_proxies_and_the_timeline_goes_first() {
        let mut l = Lanes::default();
        // A loose file (everything), two library files, then the timeline's clip (urgent).
        l.add(passes(job("loose", MediaKind::Video, true, true)), false);
        l.add(passes(job("lib1", MediaKind::Video, true, false)), false);
        l.add(passes(job("song", MediaKind::Audio, true, true)), false);
        l.add(passes(used("used", MediaKind::Video, true, true)), true);
        assert_eq!(
            order(&mut l, 3),
            ["used Poster", "used Look", "loose Poster", "lib1 Poster", "used Proxy", "loose Proxy"],
            "the library gets posters only, and a sound file in it nothing"
        );
    }

    #[test]
    fn heavy_passes_leave_room_for_posters_and_filmstrips() {
        let mut l = Lanes::default();
        for n in 0..4 {
            l.add(passes(job(&format!("used{n}"), MediaKind::Video, false, true)), true);
        }
        l.add(passes(used("lib", MediaKind::Video, true, false)), false);
        // Two heavy lanes: one proxy at a time, the other lane for a filmstrip.
        assert_eq!(l.take(2).unwrap().pass, Pass::Poster);
        let proxy = l.take(2).unwrap();
        assert_eq!(proxy.pass, Pass::Proxy);
        let look = l.take(2).unwrap();
        assert_eq!((look.job.media_id.as_str(), look.pass), ("lib", Pass::Look), "a second proxy waits; the filmstrip goes");
        assert!(l.take(2).is_none(), "both heavy lanes busy");
        // A file linked meanwhile gets its poster at once.
        l.add(passes(job("new", MediaKind::Video, true, false)), false);
        let poster = l.take(2).unwrap();
        assert_eq!((poster.job.media_id.as_str(), poster.pass), ("new", Pass::Poster));
        assert!(l.take(2).is_none());
        l.done(&proxy);
        assert_eq!(l.take(2).unwrap().pass, Pass::Proxy);
        // With no filmstrip waiting, proxies take every heavy lane.
        let mut l = Lanes::default();
        for n in 0..3 {
            l.add(passes(job(&format!("used{n}"), MediaKind::Video, false, true)), true);
        }
        assert_eq!((l.take(2).unwrap().pass, l.take(2).unwrap().pass), (Pass::Proxy, Pass::Proxy));
        assert!(l.take(2).is_none());
    }

    #[test]
    fn a_clip_put_on_the_timeline_has_its_filmstrip_made_next() {
        let mut l = Lanes::default();
        for n in 0..3 {
            l.add(passes(job(&format!("lib{n}"), MediaKind::Video, true, false)), false);
        }
        l.hurry("lib2");
        // Put on the timeline, it's asked for its filmstrip and waveform (rpc.rs, `want_looks`), urgent.
        l.add(passes(used("lib2", MediaKind::Video, false, false)), true);
        assert_eq!(order(&mut l, 3), ["lib2 Look", "lib2 Poster", "lib0 Poster", "lib1 Poster"]);
    }

    #[test]
    fn the_posters_the_library_shows_go_first() {
        let mut l = Lanes::default();
        for n in 0..5 {
            l.add(passes(job(&format!("m{n}"), MediaKind::Video, true, false)), false);
        }
        l.want(&["m3".to_string(), "m1".to_string()]);
        assert_eq!(order(&mut l, 3), ["m3 Poster", "m1 Poster", "m0 Poster", "m2 Poster", "m4 Poster"]);
    }

    #[test]
    fn a_library_file_gets_only_its_poster() {
        let kinds = |j: Job| passes(j).into_iter().map(|t| t.pass).collect::<Vec<_>>();
        assert_eq!(kinds(job("v", MediaKind::Video, true, false)), [Pass::Poster]);
        assert_eq!(kinds(job("s", MediaKind::Audio, true, false)), [], "a sound file in the library: nothing to make");
        assert_eq!(kinds(used("v", MediaKind::Video, true, false)), [Pass::Poster, Pass::Look]);
        assert_eq!(kinds(used("s", MediaKind::Audio, false, false)), [Pass::Look], "its waveform, once it's on the timeline");
    }

    #[test]
    fn small_videos_get_no_proxy() {
        let media = |w, h| Media { kind: MediaKind::Video, width: w, height: h, ..Default::default() };
        assert!(!wants_proxy(&media(360, 640)), "smaller than a proxy");
        assert!(!wants_proxy(&media(540, 960)), "the size of a proxy");
        assert!(wants_proxy(&media(720, 1280)));
        assert!(wants_proxy(&media(1920, 1080)));
        assert!(wants_proxy(&media(0, 0)), "size unknown");
        assert!(!wants_proxy(&Media { kind: MediaKind::Image, width: 4000, height: 3000, ..Default::default() }));
    }
}
