//! Command handlers. Every call from the interface (and later from MCP) lands here.

use crate::audio::Analysis;
use crate::doc::Doc;
use crate::events::Events;
use crate::export::{ExportOptions, Exports};
use crate::jobs::{Job, Jobs, wants_proxy};
use crate::playback::{Hidden, Playback};
use crate::preview::{Preview, PreviewConfig};
use crate::stab::{Stabilizer, Work};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use studio_engine_core::look::{EFFECTS, TRANSITIONS};
use studio_engine_core::model::{Brand, CaptionDrawing, CaptionLine, ClipChange, Crop, EditError, Effects, EnvPoint, Fit, IMAGE_DEFAULT, Keyframes, MasterChange, McpOptions, Media, MediaKind, PasteItem, Project, TextSpec, TrackChange, Us};
use studio_engine_core::protocol::RpcError;
use studio_engine_core::ring::RingWriter;
use studio_media::Ffmpeg;
use studio_media::graph::{self, Quality};

const EDIT_FAILED: i64 = -32000;

thread_local! {
    /// Who the request being handled on this thread comes from: "you" (the app) or an MCP
    /// client's `_actor`. Edits are logged in the history under it.
    static ACTOR: RefCell<String> = RefCell::new("you".into());
}

fn actor() -> String {
    ACTOR.with(|a| a.borrow().clone())
}

struct Services {
    ff: Arc<Ffmpeg>,
    jobs: Jobs,
    playback: Arc<Playback>,
    exports: Exports,
    analysis: Analysis,
    stab: Stabilizer,
}

/// One open connection: the app's window, or an MCP client once it said `mcp.hello`.
#[derive(Default)]
struct Conn {
    mcp: bool,
    name: String,
}

pub struct Engine {
    started: Instant,
    pub events: Events,
    pub preview: Preview,
    doc: Arc<Mutex<Option<Doc>>>,
    processing: Arc<Mutex<BTreeMap<String, usize>>>,
    services: Result<Services, String>,
    projects_dir: PathBuf,
    /// One import or folder rescan at a time: the same folder dropped twice while it's
    /// still loading then finds its files already there instead of adding them again.
    imports: Mutex<()>,
    /// A library clip shown on its own in the player (click a thumbnail), with its mix key.
    source: Mutex<Option<(Arc<Project>, u64)>>,
    /// Where the timeline's playhead was when a preview started, to go back to.
    timeline_pos: Mutex<Us>,
    /// Open connections by id (see `server`).
    conns: Mutex<BTreeMap<u64, Conn>>,
    /// When an MCP client last sent anything (milliseconds since 1970).
    mcp_seen: Mutex<Option<u64>>,
    /// Questions waiting for the user's answer in the app, by id.
    approvals: Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>,
    next_approval: AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn snapshot(doc: &Mutex<Option<Doc>>, processing: &Mutex<BTreeMap<String, usize>>) -> Value {
    let ids: Vec<String> = processing.lock().unwrap().keys().cloned().collect();
    doc.lock().unwrap().as_ref().map_or(Value::Null, |d| d.snapshot(&ids))
}

impl Engine {
    pub fn new(ring_path: &Path, max_width: u32, max_height: u32, projects_dir: PathBuf) -> std::io::Result<Self> {
        let ring = Arc::new(Mutex::new(RingWriter::create(ring_path, max_width, max_height)?));
        let events = Events::new();
        let doc: Arc<Mutex<Option<Doc>>> = Arc::new(Mutex::new(None));
        let processing = Arc::new(Mutex::new(BTreeMap::new()));
        let services = Ffmpeg::detect().map_err(|e| e.to_string()).map(|ff| {
            let ff = Arc::new(ff);
            let on_change = batched_changes(doc.clone(), processing.clone(), events.clone());
            let playback: Arc<Playback> = Arc::new_cyclic(|me| Playback::new(ff.clone(), ring.clone(), events.clone(), me.clone()));
            // Stabilising transforms arriving: the paused frame is drawn again with them.
            let (pb, d) = (playback.clone(), doc.clone());
            let stab = Stabilizer::start(
                ff.clone(),
                events.clone(),
                Arc::new(move || {
                    let project = d.lock().unwrap().as_ref().map(|d| Arc::new(d.project.clone()));
                    if let Some(p) = project.filter(|_| !pb.is_playing() && pb.context() == "timeline") {
                        pb.show_frame(p);
                    }
                }),
            );
            Services {
                // Thumbnails and proxies wait while playing, so the sound and picture get the machine.
                jobs: Jobs::start(ff.clone(), doc.clone(), processing.clone(), events.clone(), on_change, {
                    let pb = playback.clone();
                    Arc::new(move || pb.is_busy())
                }),
                playback,
                exports: Exports::new(ff.clone(), events.clone()),
                analysis: Analysis::start(ff.clone(), events.clone()),
                stab,
                ff,
            }
        });
        if let Err(e) = &services {
            println!("[engine] {e}");
        }
        Ok(Self {
            started: Instant::now(),
            preview: Preview::new(ring, ring_path, max_width, max_height),
            events,
            doc,
            processing,
            services,
            projects_dir,
            imports: Mutex::new(()),
            source: Mutex::new(None),
            timeline_pos: Mutex::new(0),
            conns: Mutex::new(BTreeMap::new()),
            mcp_seen: Mutex::new(None),
            approvals: Mutex::new(HashMap::new()),
            next_approval: AtomicU64::new(1),
        })
    }

    /// A connection opened (see `server`).
    pub fn connect(&self, id: u64) {
        self.conns.lock().unwrap().insert(id, Conn::default());
    }

    /// A connection closed. With no window left, questions waiting for an answer get "no".
    pub fn disconnect(&self, id: u64) {
        let (was_mcp, windows) = {
            let mut c = self.conns.lock().unwrap();
            let was = c.remove(&id).is_some_and(|x| x.mcp);
            (was, c.values().filter(|x| !x.mcp).count())
        };
        if windows == 0 {
            self.approvals.lock().unwrap().clear();
        }
        if was_mcp {
            self.events.emit("mcp.status", self.mcp_status());
        }
    }

    /// Notes when an MCP client last sent something.
    fn seen(&self, conn: u64) {
        if self.conns.lock().unwrap().get(&conn).is_some_and(|c| c.mcp) {
            *self.mcp_seen.lock().unwrap() = Some(now_ms());
        }
    }

    fn mcp_status(&self) -> Value {
        let c = self.conns.lock().unwrap();
        let names: Vec<&str> = c.values().filter(|x| x.mcp).map(|x| x.name.as_str()).collect();
        json!({ "clients": names.len(), "names": names, "lastSeen": *self.mcp_seen.lock().unwrap() })
    }

    /// Asks the user in the app and waits for the answer (up to ten minutes).
    fn ask(&self, what: &str, detail: &str) -> Value {
        if self.conns.lock().unwrap().values().all(|c| c.mcp) {
            return json!({ "ok": false, "reason": "no window open" });
        }
        let id = format!("ap{}", self.next_approval.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = std::sync::mpsc::channel();
        self.approvals.lock().unwrap().insert(id.clone(), tx);
        self.events.emit("approval.requested", json!({ "id": id, "what": what, "detail": detail }));
        let answer = rx.recv_timeout(Duration::from_secs(600));
        self.approvals.lock().unwrap().remove(&id);
        match answer {
            Ok(ok) => json!({ "ok": ok }),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => json!({ "ok": false, "reason": "no answer in ten minutes" }),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => json!({ "ok": false, "reason": "no window open" }),
        }
    }

    fn services(&self) -> Result<&Services, RpcError> {
        self.services.as_ref().map_err(|e| RpcError::new(EDIT_FAILED, e.clone()))
    }

    fn snapshot(&self) -> Value {
        snapshot(&self.doc, &self.processing)
    }

    fn project(&self) -> Result<(Arc<Project>, u64), RpcError> {
        let g = self.doc.lock().unwrap();
        let d = g.as_ref().ok_or_else(no_project)?;
        Ok((Arc::new(d.project.clone()), d.edits))
    }

    /// After anything changes the project: tell the UI, refresh the frame, pre-mix sound.
    fn changed(&self) {
        self.events.emit("project.changed", self.snapshot());
        let (Ok(m), Ok((project, revision))) = (self.services(), self.project()) else { return };
        // Stabilised clips whose transforms aren't made yet get them made in the background, and
        // so do pictures that turn or change size (rendered once at the preview's size).
        self.want_looks(&project);
        let (w, h) = crate::playback::preview_size(&project);
        let mut work: Vec<Work> = graph::stab_jobs(&project, true).into_iter().map(Work::Stab).collect();
        work.extend(studio_media::motion::motion_jobs(&project, w, h, project.fps.max(1)).into_iter().map(Work::Motion));
        m.stab.submit(work);
        if m.playback.context() == "source" {
            // The player shows a library clip; the timeline's frame waits until it's back.
            return;
        }
        if m.playback.is_playing() {
            let _ = m.playback.play(project, revision, m.playback.position());
        } else {
            m.playback.show_frame(project.clone());
            m.playback.prepare(project.clone());
            m.playback.premix(project, revision);
        }
    }

    /// Every file a clip uses gets its filmstrip and waveform, ahead of the library's posters,
    /// however the clip got there (put on, pasted, undone back, a dub, MCP).
    fn want_looks(&self, project: &Project) {
        let Ok(m) = self.services() else { return };
        let cache = self.cache_dir();
        let used: std::collections::BTreeSet<&str> = project.tracks.iter().flat_map(|t| &t.clips).map(|c| c.media_id.as_str()).collect();
        for media in project.media.iter().filter(|x| used.contains(x.id.as_str()) && wants_look(x)) {
            if !m.jobs.look_pending(&cache, &media.id) {
                m.jobs.submit_urgent(job_for(media, &cache, false, true, false));
            }
        }
    }

    fn edit<T: serde::Serialize>(&self, label: &str, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<Value, RpcError> {
        self.edit_merging(label, None, f)
    }

    /// `edit`, joining the step before when it had the same `merge` key (see `Doc::edit_merging`).
    fn edit_merging<T: serde::Serialize>(&self, label: &str, merge: Option<&str>, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<Value, RpcError> {
        let result = {
            let mut g = self.doc.lock().unwrap();
            let doc = g.as_mut().ok_or_else(no_project)?;
            doc.edit_merging(&actor(), label, merge, f).map_err(|e| RpcError::new(EDIT_FAILED, e.0))?
        };
        self.changed();
        Ok(json!(result))
    }

    fn set_doc(&self, doc: Doc) -> Value {
        if let Ok(m) = self.services() {
            m.playback.stop();
            // Its sound is mixed afresh: mixes and previews are known by revision and clip id,
            // which every project numbers from the start.
            m.playback.forget_mixes();
            *self.source.lock().unwrap() = None;
            // Rebuild anything missing from the cache (new machine, cleared cache).
            let cache = doc.cache_dir();
            // The last project's queued work is dropped: media ids repeat across projects.
            m.jobs.switch_to(&cache);
            m.stab.clear();
            // Motion files the project no longer uses (left by edits) go.
            let (w, h) = crate::playback::preview_size(&doc.project);
            studio_media::motion::prune_motion(&doc.project, w, h, doc.project.fps.max(1));
            let mut used = vec![];
            for media in doc.project.media.iter().filter(|x| !x.missing) {
                let gone = |p: &Option<String>| p.as_ref().is_none_or(|p| !Path::new(p).is_file());
                let browse = gone(&media.poster) && media.kind != MediaKind::Audio;
                // Filmstrips, waveforms and proxies only for what the timeline uses (a linked
                // folder can hold thousands of files, and the library shows only posters).
                let on_timeline = doc.project.is_used(&media.id);
                let look = on_timeline && wants_look(media);
                let proxy = gone(&media.proxy) && wants_proxy(media) && (media.folder.is_none() || on_timeline);
                if browse || look || proxy {
                    let job = job_for(media, &cache, browse, look, proxy);
                    if on_timeline { used.push(job) } else { m.jobs.submit(job) }
                }
            }
            // What the timeline shows goes first: its filmstrips and waveforms before the library's.
            for job in used.into_iter().rev() {
                m.jobs.submit_urgent(job);
            }
        }
        *self.doc.lock().unwrap() = Some(doc);
        self.changed();
        self.snapshot()
    }

    /// Files are added as they are; folders are linked (see `link_or_sync`). `step`: the undo
    /// step's label and merge key, when the files are part of a bigger edit (a dub's new take).
    fn import(&self, paths: Vec<String>, step: Option<(&str, &str)>) -> Result<Value, RpcError> {
        let _one_at_a_time = self.imports.lock().unwrap_or_else(|e| e.into_inner());
        let m = self.services()?;
        let (dirs, files): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| Path::new(p).is_dir());
        let mut imported = vec![];
        let mut failed = vec![];
        let mut folders = vec![];

        // Files already in the project aren't added twice; their ids come back as imported.
        let known = self.known_paths();
        let (old, new): (Vec<String>, Vec<String>) = files.into_iter().partition(|p| known.contains_key(p));
        imported.extend(old.iter().map(|p| known[p].clone()));
        let probes = m.ff.probe_many(&new.iter().map(PathBuf::from).collect::<Vec<_>>(), 8);
        let mut probed = vec![];
        for (path, probe) in new.into_iter().zip(probes) {
            match probe {
                Ok(p) => probed.push(media_from(&path, p, None)),
                Err(e) => failed.push(json!({ "path": path, "error": e.to_string() })),
            }
        }
        if !probed.is_empty() {
            let count = probed.len();
            let label = step.map_or_else(|| format!("Import {count} file{}", if count == 1 { "" } else { "s" }), |(l, _)| l.to_string());
            let added: Vec<Media> = self.edit_inner_merging(&label, step.map(|(_, merge)| merge), |project| {
                Ok(probed
                    .into_iter()
                    .map(|mut media| {
                        media.id = project.make_id("m");
                        project.media.push(media.clone());
                        media
                    })
                    .collect())
            })?;
            let cache = self.cache_dir();
            for media in &added {
                m.jobs.submit(job_for(media, &cache, true, false, true));
            }
            imported.extend(added.into_iter().map(|x| x.id));
        }
        for dir in dirs {
            match self.link_or_sync(&dir) {
                Ok(r) => folders.push(r),
                Err(e) => failed.push(json!({ "path": dir, "error": e.message })),
            }
        }
        if imported.is_empty() && folders.is_empty() {
            return Err(RpcError::new(EDIT_FAILED, "None of those files could be imported."));
        }
        self.changed();
        Ok(json!({ "imported": imported, "failed": failed, "folders": folders }))
    }

    /// Links a folder and mirrors its tree in the library, or rescans it if it (or a folder
    /// around it) is already linked. New files get thumbnails and waveforms now; proxies
    /// wait until a clip uses them. Files that have gone are flagged, not removed.
    fn link_or_sync(&self, dir: &str) -> Result<Value, RpcError> {
        let m = self.services()?;
        let trimmed = dir.trim_end_matches(['/', '\\']);
        let root = PathBuf::from(if trimmed.is_empty() || trimmed.ends_with(':') { dir } else { trimmed });
        let (existing, known) = {
            let g = self.doc.lock().unwrap();
            let d = g.as_ref().ok_or_else(no_project)?;
            let existing = d.project.folders.iter().find(|f| root.starts_with(&f.path)).map(|f| (f.id.clone(), PathBuf::from(&f.path), f.name.clone()));
            (existing, d.project.media.iter().map(|x| (x.path.clone(), x.folder.clone())).collect::<BTreeMap<_, _>>())
        };
        let (root, name) = match &existing {
            Some((_, path, name)) => (path.clone(), name.clone()),
            None => (root.clone(), root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned())),
        };
        let hidden: Vec<String> = {
            let g = self.doc.lock().unwrap();
            existing.as_ref().and_then(|(id, _, _)| g.as_ref()?.project.folders.iter().find(|f| &f.id == id).map(|f| f.hidden.clone())).unwrap_or_default()
        };
        let mut found = studio_media::scan_folder(&root).map_err(io_err)?;
        // Files removed from the library by hand stay out.
        found.retain(|(p, _)| !hidden.contains(&p.to_string_lossy().into_owned()));
        let present: Vec<String> = found.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
        let dir_of: BTreeMap<String, String> = found.iter().map(|(p, d)| (p.to_string_lossy().into_owned(), d.clone())).collect();
        let fresh: Vec<&(PathBuf, String)> = found.iter().filter(|(p, _)| !known.contains_key(p.to_string_lossy().as_ref())).collect();
        let probes = m.ff.probe_many(&fresh.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(), 8);
        let mut added = vec![];
        let mut failed = vec![];
        for ((path, sub), probe) in fresh.into_iter().zip(probes) {
            let path = path.to_string_lossy().into_owned();
            match probe {
                Ok(p) => added.push(media_from(&path, p, Some(sub.clone()))),
                Err(e) => failed.push(json!({ "path": path, "error": e.to_string() })),
            }
        }
        // Loose files that turn out to live in this folder join its tree.
        let adopt: Vec<String> = known.iter().filter(|(p, f)| f.is_none() && dir_of.contains_key(*p)).map(|(p, _)| p.clone()).collect();
        if let Some((id, _, _)) = &existing {
            let g = self.doc.lock().unwrap();
            let d = g.as_ref().ok_or_else(no_project)?;
            let ours = || d.project.media.iter().filter(|x| x.folder.as_deref() == Some(id.as_str()));
            let flags_change = ours().any(|x| x.missing == present.contains(&x.path));
            if added.is_empty() && adopt.is_empty() && !flags_change {
                return Ok(json!({ "folderId": id, "name": name, "added": 0, "missing": ours().filter(|x| x.missing).count(), "failed": failed }));
            }
        }
        let label = if existing.is_some() { format!("Rescan {name}") } else { format!("Link folder {name}") };
        let root_str = root.to_string_lossy().into_owned();
        let (folder_id, (count, missing), new_ids) = self.edit_inner(&label, |p| {
            let id = existing.as_ref().map(|(id, _, _)| id.clone()).unwrap_or_else(|| p.link_folder(&root_str, &name));
            for x in p.media.iter_mut().filter(|x| adopt.contains(&x.path)) {
                x.folder = Some(id.clone());
                x.dir = dir_of.get(&x.path).cloned();
            }
            let before = p.media.len();
            let r = p.sync_folder(&id, &present, added)?;
            Ok((id, r, p.media[before..].iter().map(|x| x.id.clone()).collect::<Vec<_>>()))
        })?;
        let cache = self.cache_dir();
        if let Some(d) = self.doc.lock().unwrap().as_ref() {
            for media in d.project.media.iter().filter(|x| new_ids.contains(&x.id)) {
                m.jobs.submit(job_for(media, &cache, true, false, false));
            }
        }
        self.changed();
        Ok(json!({ "folderId": folder_id, "name": name, "added": count, "missing": missing, "failed": failed }))
    }

    /// Renders the selected clips to one file in the project's `compounds` folder and puts
    /// it on the timeline in their place, as a compound clip that remembers its parts.
    fn compound(&self, ids: &[String]) -> Result<Value, RpcError> {
        let m = self.services()?;
        let (project, _) = self.project()?;
        let (sub, _, _) = project.sub_project(ids).map_err(|e| RpcError::new(EDIT_FAILED, e.0))?;
        let picture = !sub.main_track().clips.is_empty();
        let dir = self.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.dir.join("compounds");
        std::fs::create_dir_all(&dir).map_err(io_err)?;
        let ext = if picture { "mp4" } else { "m4a" };
        let n = (1..).find(|n| !dir.join(format!("compound-{n}.mp4")).exists() && !dir.join(format!("compound-{n}.m4a")).exists()).unwrap_or(1);
        let out = dir.join(format!("compound-{n}.{ext}"));
        crate::export::render_file(&m.ff, &sub, &out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        let probe = m.ff.probe(&out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        let mut media = media_from(&out.to_string_lossy(), probe, None);
        media.name = format!("Compound {n}");
        let clip = self.edit_inner("Create compound clip", |p| p.make_compound(ids, media))?;
        let cache = self.cache_dir();
        let job = self.doc.lock().unwrap().as_ref().and_then(|d| d.project.clip(&clip).and_then(|c| d.project.media(&c.media_id)).map(|x| job_for(x, &cache, true, true, true)));
        if let Some(job) = job {
            m.jobs.submit_urgent(job);
        }
        self.changed();
        Ok(json!({ "clipId": clip }))
    }

    /// Freeze frame: the main-track clip under `at` (the selected one, if it's there) has the
    /// frame shown at that moment saved from its original file, at the file's own size and
    /// through the clip's crop, turns and mirror, to `<project>.studio/freeze/`. That image is
    /// held for 3 s between the clip's halves, in one undo step. Returns the new clip.
    fn freeze_frame(&self, at: Us, selected: &[String]) -> Result<Value, RpcError> {
        let m = self.services()?;
        let (project, _) = self.project()?;
        let main = project.main_track();
        let under = main.clips.iter().filter(|c| at >= c.start_us && at < c.end_us());
        let clip = under.clone().find(|c| selected.contains(&c.id)).or_else(|| under.clone().next()).cloned();
        let clip = clip.ok_or_else(|| RpcError::new(EDIT_FAILED, "Put the playhead on a clip on the main track to freeze its frame"))?;
        let media = project.media(&clip.media_id).filter(|x| x.kind != MediaKind::Audio).cloned().ok_or_else(|| RpcError::new(EDIT_FAILED, "That clip has no picture to freeze"))?;
        let still = media.kind == MediaKind::Image;
        // The frame on screen there (speed and direction count), inside the clip's source range.
        let frame = 1_000_000 / project.fps.max(1) as Us;
        let offset = (at - clip.start_us).clamp(0, (clip.duration_us - 1).max(0));
        let source = clip.source_at(offset).clamp(clip.in_us, (clip.in_us + clip.span_us() - frame).max(clip.in_us)).min((media.duration_us - frame).max(0));
        let dir = self.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.dir.join("freeze");
        std::fs::create_dir_all(&dir).map_err(io_err)?;
        let out = dir.join(format!("{}-{at}.png", clip.id));
        crate::export::frame_png(&m.ff, Path::new(&media.path), still, source, &studio_media::graph::picture_filter(&clip), &out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        let probe = m.ff.probe(&out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        let mut frozen = media_from(&out.to_string_lossy(), probe, None);
        frozen.name = format!("Freeze frame {}", project.media.iter().filter(|x| x.name.starts_with("Freeze frame")).count() + 1);
        let id = self.edit_inner("Freeze frame", |p| p.freeze_frame(&clip.id, at, frozen, IMAGE_DEFAULT))?;
        // Its thumbnail for the library and the timeline.
        let cache = self.cache_dir();
        let job = self.doc.lock().unwrap().as_ref().and_then(|d| d.project.clip(&id).and_then(|c| d.project.media(&c.media_id)).map(|x| job_for(x, &cache, true, true, false)));
        if let Some(job) = job {
            m.jobs.submit_urgent(job);
        }
        self.changed();
        Ok(json!({ "clipId": id }))
    }

    /// What playback acts on: the library clip being previewed (`source`), or the timeline,
    /// which also ends any preview.
    fn play_target(&self, source: bool) -> Result<(Arc<Project>, u64), RpcError> {
        let m = self.services()?;
        if source {
            let s = self.source.lock().unwrap().clone().ok_or_else(|| RpcError::new(EDIT_FAILED, "Click a clip in the library to preview it"))?;
            m.playback.set_context("source");
            return Ok(s);
        }
        let leaving = self.source.lock().unwrap().take().is_some();
        m.playback.set_context("timeline");
        let (project, rev) = self.project()?;
        if leaving {
            m.playback.pause();
            let _ = m.playback.seek(project.clone(), rev, *self.timeline_pos.lock().unwrap());
        }
        Ok((project, rev))
    }

    /// Shows a library clip on its own in the player at `at`, playing it if asked.
    fn preview_source(&self, media_id: &str, at: Us, play: bool) -> Result<Value, RpcError> {
        let m = self.services()?;
        let (project, _) = self.project()?;
        let media = project.media(media_id).cloned().ok_or_else(|| RpcError::invalid_params(format!("no media {media_id}")))?;
        let mut p = Project::new(&media.name, "9:16");
        (p.width, p.height, p.fps) = (project.width, project.height, project.fps);
        p.media = vec![media];
        p.insert(media_id, 0).map_err(|e| RpcError::new(EDIT_FAILED, e.0))?;
        // Its own key for the sound-mix cache, well clear of the timeline's edit counter.
        let key = (1u64 << 62) | media_id.bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)) >> 2;
        let p = Arc::new(p);
        if m.playback.context() == "timeline" {
            *self.timeline_pos.lock().unwrap() = m.playback.position();
        }
        *self.source.lock().unwrap() = Some((p.clone(), key));
        m.playback.set_context("source");
        let at = at.clamp(0, (p.duration_us() - 1).max(0));
        if play {
            m.playback.play(p, key, at).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
        } else {
            m.playback.pause();
            m.playback.seek(p, key, at).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
        }
        Ok(m.playback.status())
    }

    /// A clip now uses this media: what's still queued for it (its filmstrip and waveform)
    /// goes to the front, and so does a proxy if it needs one and has none.
    fn ensure_proxy(&self, media_id: &str) {
        let Ok(m) = self.services() else { return };
        m.jobs.hurry(media_id);
        let job = {
            let g = self.doc.lock().unwrap();
            let Some(d) = g.as_ref() else { return };
            let Some(media) = d.project.media(media_id) else { return };
            let has = media.proxy.as_ref().is_some_and(|p| Path::new(p).is_file());
            if !wants_proxy(media) || has || m.jobs.proxy_pending(&d.cache_dir(), media_id) {
                return;
            }
            job_for(media, &d.cache_dir(), false, false, true)
        };
        m.jobs.submit_urgent(job);
    }

    /// Sample drawing: the clip's sound with the drawn samples in it (`samples`, mono, at
    /// `rate` a second (48 kHz unless given), from `atUs` in the source file), saved as a WAV
    /// in the project's `edits` folder, and the clip pointed at that copy in one undo step.
    fn draw_samples(&self, params: &Value) -> Result<Value, RpcError> {
        let m = self.services()?;
        let id = s(params, "clipId")?;
        let samples: Vec<f32> = field(params, "samples")?.unwrap_or_default();
        let rate = params.get("rate").and_then(Value::as_f64).unwrap_or(48_000.0);
        if samples.is_empty() || !(rate > 0.0 && rate.is_finite()) {
            return Err(RpcError::invalid_params("draw some samples at a rate above 0"));
        }
        let (project, _) = self.project()?;
        let c = project.clip(&id).cloned().ok_or_else(|| RpcError::invalid_params(format!("no clip {id}")))?;
        let media = project.media(&c.media_id).filter(|x| x.has_audio).cloned().ok_or_else(|| RpcError::new(EDIT_FAILED, "That clip has no sound"))?;
        // `atUs` is the source file's own time (the Audio page draws on the source's samples).
        let src = us(params, "atUs").unwrap_or(c.in_us).max(0);
        let mut sound = crate::edits::decode_stereo(&m.ff, Path::new(&media.path)).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        if crate::edits::draw_into(&mut sound, src as f64 / 1e6, &samples, rate, false) == 0 {
            return Err(RpcError::new(EDIT_FAILED, "Draw inside the clip's sound"));
        }
        let dir = self.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.dir.join("edits");
        let n = (1..).find(|n| !dir.join(format!("{id}-{n}.wav")).exists()).unwrap_or(1);
        let out = dir.join(format!("{id}-{n}.wav"));
        crate::edits::write_wav(&out, &sound).map_err(io_err)?;
        let probe = m.ff.probe(&out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        let mut copy = media_from(&out.to_string_lossy(), probe, None);
        copy.name = format!("{} (drawn {n})", media.name.rsplit_once('.').map_or(media.name.as_str(), |(stem, _)| stem));
        let media_id = self.edit_inner("Draw samples", |p| p.repoint_sound(&id, copy))?;
        let cache = self.cache_dir();
        let job = self.doc.lock().unwrap().as_ref().and_then(|d| d.project.media(&media_id).map(|x| job_for(x, &cache, true, true, false)));
        if let Some(job) = job {
            m.jobs.submit_urgent(job);
        }
        self.changed();
        Ok(json!({ "clipId": id, "mediaId": media_id, "path": out.to_string_lossy() }))
    }

    fn known_paths(&self) -> BTreeMap<String, String> {
        self.doc.lock().unwrap().as_ref().map(|d| d.project.media.iter().map(|m| (m.path.clone(), m.id.clone())).collect()).unwrap_or_default()
    }

    fn cache_dir(&self) -> PathBuf {
        self.doc.lock().unwrap().as_ref().map(Doc::cache_dir).unwrap_or_default()
    }

    fn edit_inner<T>(&self, label: &str, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<T, RpcError> {
        self.edit_inner_merging(label, None, f)
    }

    /// `edit_inner`, joining the step before when it had the same `merge` key.
    fn edit_inner_merging<T>(&self, label: &str, merge: Option<&str>, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<T, RpcError> {
        let mut g = self.doc.lock().unwrap();
        let doc = g.as_mut().ok_or_else(no_project)?;
        doc.edit_merging(&actor(), label, merge, f).map_err(|e| RpcError::new(EDIT_FAILED, e.0))
    }

    /// The clips a "Fix and tidy" tool works on, each with its file and the part of it the
    /// clip plays.
    fn sound_clips(&self, ids: &[String]) -> Result<Vec<SoundClip>, RpcError> {
        let (project, _) = self.project()?;
        let mut out = vec![];
        for id in ids {
            let Some(c) = project.clip(id) else { continue };
            let Some(m) = project.media(&c.media_id).filter(|m| m.has_audio && !c.detached) else { continue };
            out.push(SoundClip { id: c.id.clone(), media_id: m.id.clone(), path: PathBuf::from(&m.path), in_us: c.in_us, span_us: c.span_us(), dur_us: c.duration_us, start_us: c.start_us, speed: c.speed, reverse: c.reverse });
        }
        if out.is_empty() {
            return Err(RpcError::new(EDIT_FAILED, "Select a clip with sound first"));
        }
        Ok(out)
    }

    /// A file's levels (peak every 10 ms), from the cache; made first if they aren't there.
    fn peaks_of(&self, media_id: &str, path: &Path) -> Result<Vec<u8>, RpcError> {
        let file = self.cache_dir().join(media_id).join("levels.json");
        if !file.is_file() {
            let m = self.services()?;
            std::fs::create_dir_all(file.parent().unwrap_or(Path::new("."))).map_err(io_err)?;
            crate::audio::write_levels(&m.ff, path, &file).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
        }
        crate::audio::read_peaks(&file).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))
    }

    /// Pauses in each clip (from its start on the timeline), louder than `thresholdDb` (−40)
    /// counting as sound, found in the files' cached levels. The clips are `clipIds`, or those
    /// on `trackId`, where `startUs`/`endUs` (a time selection) keep only what's inside it.
    /// Returns (clip, length, start, pauses).
    fn clip_silences(&self, params: &Value, min_default: Us) -> Result<Vec<(String, Us, Us, Vec<(Us, Us)>)>, RpcError> {
        let noise = params.get("thresholdDb").and_then(Value::as_f64).unwrap_or(-40.0) as f32;
        let min = us(params, "minUs").unwrap_or(min_default).max(50_000);
        let (sel_a, sel_b) = (us(params, "startUs").unwrap_or(Us::MIN), us(params, "endUs").unwrap_or(Us::MAX));
        let mut ids = strings(params, "clipIds");
        if ids.is_empty() {
            if let Some(track) = params.get("trackId").and_then(Value::as_str) {
                let (project, _) = self.project()?;
                let t = project.track(track).ok_or_else(|| RpcError::invalid_params(format!("no track {track}")))?;
                ids = t.clips.iter().filter(|c| c.end_us() > sel_a && c.start_us < sel_b).map(|c| c.id.clone()).collect();
            }
        }
        let mut out = vec![];
        for c in self.sound_clips(&ids)? {
            let peaks = self.peaks_of(&c.media_id, &c.path)?;
            // Measured in the source, so a pause at speed 2 must last twice as long there.
            let found = crate::audio::silences_in_levels(&peaks, c.in_us, c.span_us, noise, (min as f64 * c.speed) as Us);
            // Inside the time selection only.
            let (a, b) = ((sel_a.max(c.start_us) - c.start_us).max(0), sel_b.min(c.end()).saturating_sub(c.start_us).min(c.dur_us));
            let found: Vec<(Us, Us)> = c.to_timeline(found).into_iter().map(|(x, y)| (x.max(a), y.min(b))).filter(|(x, y)| y > x).collect();
            out.push((c.id.clone(), c.dur_us, c.start_us, found));
        }
        Ok(out)
    }
}

/// A clip with sound, as the "Fix and tidy" tools measure it: its file, the source range it
/// plays, and its length, start, speed and direction on the timeline.
struct SoundClip {
    id: String,
    media_id: String,
    path: PathBuf,
    in_us: Us,
    span_us: Us,
    dur_us: Us,
    start_us: Us,
    speed: f64,
    reverse: bool,
}

impl SoundClip {
    fn end(&self) -> Us {
        self.start_us + self.dur_us
    }

    /// Stretches measured from the in point in the source, as stretches from the clip's start
    /// on the timeline (mirrored when it plays backwards), in time order.
    fn to_timeline(&self, source: Vec<(Us, Us)>) -> Vec<(Us, Us)> {
        let at = |x: Us| ((x as f64 / self.speed).round() as Us).clamp(0, self.dur_us);
        let mut out: Vec<(Us, Us)> = source.into_iter().map(|(a, b)| if self.reverse { (at(self.span_us - b), at(self.span_us - a)) } else { (at(a), at(b)) }).collect();
        out.sort();
        out
    }
}

/// Merges a partial JSON object into another (for effect settings sent one at a time).
fn merge(into: &mut Value, patch: &Value) {
    match (into, patch) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (slot, v) => *slot = v.clone(),
    }
}

fn f32_of(params: &Value, key: &str) -> Option<f32> {
    params.get(key).and_then(Value::as_f64).map(|v| v as f32)
}

/// A file's work: its poster (`browse`), its filmstrip and waveform (`look`, only for what the
/// timeline uses) and its proxy.
fn job_for(media: &Media, cache: &Path, browse: bool, look: bool, proxy: bool) -> Job {
    Job { media_id: media.id.clone(), path: PathBuf::from(&media.path), kind: media.kind, duration_us: media.duration_us, has_audio: media.has_audio, cache: cache.to_path_buf(), browse, look, proxy: proxy && wants_proxy(media) }
}

/// A file a clip uses with no filmstrip or waveform yet (made only for the timeline's files).
fn wants_look(media: &Media) -> bool {
    let gone = |p: &Option<String>| p.as_ref().is_none_or(|p| !Path::new(p).is_file());
    !media.missing && (media.kind != MediaKind::Audio && gone(&media.strip) || media.has_audio && gone(&media.peaks))
}

fn media_from(path: &str, p: studio_media::Probe, dir: Option<String>) -> Media {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    Media { path: path.to_string(), name, kind: p.kind, duration_us: p.duration_us, width: p.width, height: p.height, fps: p.fps, has_audio: p.has_audio, dir, codec: p.codec, sample_rate: p.sample_rate, ..Default::default() }
}

/// Background changes (thumbnails, waveforms, proxies arriving) are batched: at most one
/// save and one `project.changed` every 250 ms, however many files are being worked on.
fn batched_changes(doc: Arc<Mutex<Option<Doc>>>, processing: Arc<Mutex<BTreeMap<String, usize>>>, events: Events) -> Arc<dyn Fn() + Send + Sync> {
    let signal = Arc::new((Mutex::new(false), Condvar::new()));
    let s = signal.clone();
    std::thread::Builder::new()
        .name("changes".into())
        .spawn(move || {
            loop {
                {
                    let (flag, cv) = &*s;
                    let mut pending = flag.lock().unwrap();
                    while !*pending {
                        pending = cv.wait(pending).unwrap();
                    }
                }
                // A big project (thousands of linked files: a 3 MB project.json) is saved and sent
                // less often while its thumbnails arrive: 250 ms, plus 250 ms a thousand files, at
                // most 2 s.
                let files = doc.lock().unwrap().as_ref().map_or(0, |d| d.project.media.len()) as u64;
                std::thread::sleep(std::time::Duration::from_millis((250 + files / 4).min(2000)));
                *s.0.lock().unwrap() = false;
                if let Some(d) = doc.lock().unwrap().as_mut() {
                    d.flush();
                }
                events.emit("project.changed", snapshot(&doc, &processing));
            }
        })
        .expect("spawn change batcher");
    Arc::new(move || {
        *signal.0.lock().unwrap() = true;
        signal.1.notify_one();
    })
}

fn no_project() -> RpcError {
    RpcError::new(EDIT_FAILED, "No project is open.")
}

/// Refuses what only the app itself may do, never an MCP client.
fn only_the_app(what: &str) -> Result<(), RpcError> {
    if actor() == "you" { Ok(()) } else { Err(RpcError::new(EDIT_FAILED, format!("Only the app can {what}"))) }
}

fn s(params: &Value, key: &str) -> Result<String, RpcError> {
    params.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| RpcError::invalid_params(format!("missing \"{key}\"")))
}
fn us(params: &Value, key: &str) -> Option<Us> {
    params.get(key).and_then(Value::as_f64).map(|v| v as Us)
}
fn strings(params: &Value, key: &str) -> Vec<String> {
    params.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}
/// The merge key of an edit sent with `gesture`: edits that share one (whatever their command:
/// captions set and drawn, a clip's file swapped with its captions) are one undo step.
fn gesture(params: &Value) -> Option<String> {
    params.get("gesture").and_then(Value::as_str).map(|g| format!("gesture {g}"))
}
fn io_err(e: std::io::Error) -> RpcError {
    RpcError::new(EDIT_FAILED, e.to_string())
}

/// A setting that `null` takes away: missing is `None`, `null` is `Some(None)`.
fn nullable<T: DeserializeOwned>(params: &Value, key: &str) -> Result<Option<Option<T>>, RpcError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => serde_json::from_value(v.clone()).map(|x| Some(Some(x))).map_err(|e| RpcError::invalid_params(format!("{key}: {e}"))),
    }
}

/// A setting given as a whole (missing or `null` leaves it).
fn field<T: DeserializeOwned>(params: &Value, key: &str) -> Result<Option<T>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| RpcError::invalid_params(format!("{key}: {e}"))),
    }
}

/// Every setting `clip.set` takes, from its parameters (camelCase, as in the snapshot).
fn clip_change(params: &Value) -> Result<ClipChange, RpcError> {
    Ok(ClipChange {
        volume: f32_of(params, "volume"),
        fit: params.get("fit").and_then(Value::as_str).map(|f| if f == "fit" { Fit::Fit } else { Fit::Fill }),
        detached: params.get("detached").and_then(Value::as_bool),
        // "crop": null removes it; a missing key leaves it.
        crop: params.get("crop").map(|c| serde_json::from_value::<Crop>(c.clone()).ok()),
        flip: params.get("flip").and_then(Value::as_bool),
        rotate: params.get("rotate").and_then(Value::as_u64).map(|r| r as u16),
        fade_in_us: us(params, "fadeInUs"),
        fade_out_us: us(params, "fadeOutUs"),
        fade_curve: params.get("fadeCurve").and_then(Value::as_str).map(str::to_string),
        pitch: f32_of(params, "pitch"),
        declick: params.get("declick").and_then(Value::as_bool),
        envelope: field::<Vec<EnvPoint>>(params, "envelope")?,
        scale: f32_of(params, "scale"),
        pos_x: f32_of(params, "posX"),
        pos_y: f32_of(params, "posY"),
        rotation: f32_of(params, "rotation"),
        opacity: f32_of(params, "opacity"),
        temperature: f32_of(params, "temperature"),
        tint: f32_of(params, "tint"),
        saturation: f32_of(params, "saturation"),
        brightness: f32_of(params, "brightness"),
        contrast: f32_of(params, "contrast"),
        highlights: f32_of(params, "highlights"),
        shadows: f32_of(params, "shadows"),
        sharpen: f32_of(params, "sharpen"),
        vignette: f32_of(params, "vignette"),
        speed: params.get("speed").and_then(Value::as_f64),
        reverse: params.get("reverse").and_then(Value::as_bool),
        keyframes: field::<Keyframes>(params, "keyframes")?,
        flip_v: params.get("flipV").and_then(Value::as_bool),
        transform_on: params.get("transformOn").and_then(Value::as_bool),
        blend: params.get("blend").and_then(Value::as_str).map(str::to_string),
        effects: field(params, "effects")?,
        transition: nullable(params, "transition")?,
        hsl: field(params, "hsl")?,
        curves: field(params, "curves")?,
        wheels: field(params, "wheels")?,
        lut: nullable(params, "lut")?,
        stabilize: nullable(params, "stabilize")?,
        smooth: nullable(params, "smooth")?,
        keep_pitch: params.get("keepPitch").and_then(Value::as_bool),
        speed_curve: nullable(params, "speedCurve")?,
        mask: nullable(params, "mask")?,
        mask_png: nullable(params, "maskPng")?,
        matte: nullable(params, "matte")?,
        anim: field(params, "anim")?,
        text: field::<TextSpec>(params, "text")?,
        caption: params.get("caption").and_then(Value::as_bool),
        spectral: field(params, "spectral")?,
    })
}

/// The history's name for a clip change: what it mostly changes.
fn clip_label(c: &ClipChange) -> &'static str {
    match (&c.crop, c.flip, c.rotate) {
        (Some(_), _, _) => "Crop",
        (_, Some(_), _) => "Mirror",
        (_, _, Some(_)) => "Rotate",
        _ if c.fade_in_us.is_some() => "Fade in",
        _ if c.fade_out_us.is_some() => "Fade out",
        _ if c.pitch.is_some() => "Pitch",
        _ if c.declick.is_some() => "Click removal",
        _ if c.envelope.is_some() => "Volume envelope",
        _ if c.speed_curve.is_some() => "Speed curve",
        _ if c.speed.is_some() => "Speed",
        _ if c.reverse == Some(true) => "Reverse",
        _ if c.reverse == Some(false) => "Play forwards",
        _ if c.keyframes.is_some() => "Keyframes",
        _ if c.text.is_some() => "Text",
        _ if c.effects.is_some() => "Effects",
        _ if c.transition.is_some() => "Transition",
        _ if c.anim.is_some() => "Animation",
        _ if c.mask.is_some() || c.mask_png.is_some() => "Mask",
        _ if c.matte.is_some() => "Remove background",
        _ if c.stabilize.is_some() => "Stabilise",
        _ if c.smooth.is_some() => "Smooth slow motion",
        _ if c.keep_pitch.is_some() => "Keep pitch",
        _ if c.blend.is_some() => "Blend",
        _ if c.flip_v.is_some() => "Flip",
        _ if c.transform_on.is_some() => "Transform on/off",
        _ if c.hsl.is_some() => "HSL",
        _ if c.curves.is_some() => "Curves",
        _ if c.wheels.is_some() => "Colour wheels",
        _ if c.lut.is_some() => "LUT",
        _ if c.spectral.is_some() => "Spectral edit",
        _ if [c.scale, c.pos_x, c.pos_y, c.rotation].iter().any(Option::is_some) => "Transform",
        _ if c.opacity.is_some() => "Opacity",
        _ if [c.temperature, c.tint, c.saturation, c.brightness, c.contrast, c.highlights, c.shadows, c.sharpen, c.vignette].iter().any(Option::is_some) => "Colour",
        _ => "Clip settings",
    }
}

/// `dispatch` for a request on connection `conn`: its `_actor` (if any) is who the edits are
/// logged as, and an MCP client's request counts as it being seen.
pub fn dispatch_on(engine: &Engine, conn: u64, method: &str, params: Value) -> Result<Value, RpcError> {
    let who = params.get("_actor").and_then(Value::as_str).map(str::trim).filter(|a| !a.is_empty()).unwrap_or("you").to_string();
    ACTOR.with(|a| *a.borrow_mut() = who);
    engine.seen(conn);
    match method {
        "mcp.hello" => {
            if let Some(c) = engine.conns.lock().unwrap().get_mut(&conn) {
                c.mcp = true;
                c.name = params.get("name").and_then(Value::as_str).unwrap_or("MCP").to_string();
            }
            *engine.mcp_seen.lock().unwrap() = Some(now_ms());
            let status = engine.mcp_status();
            engine.events.emit("mcp.status", status.clone());
            Ok(status)
        }
        "mcp.bye" => {
            if let Some(c) = engine.conns.lock().unwrap().get_mut(&conn) {
                c.mcp = false;
            }
            let status = engine.mcp_status();
            engine.events.emit("mcp.status", status.clone());
            Ok(status)
        }
        _ => dispatch(engine, method, params),
    }
}

pub fn dispatch(engine: &Engine, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "engine.effects" => Ok(json!(EFFECTS)),
        "engine.transitions" => Ok(json!(TRANSITIONS.iter().map(|(n, _)| *n).collect::<Vec<_>>())),
        "mcp.status" => Ok(engine.mcp_status()),
        "approval.request" => {
            let what = params.get("what").and_then(Value::as_str).unwrap_or("").to_string();
            let detail = params.get("detail").and_then(Value::as_str).unwrap_or("").to_string();
            Ok(engine.ask(&what, &detail))
        }
        "approval.answer" => {
            let id = s(&params, "id")?;
            let ok = params.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let tx = engine.approvals.lock().unwrap().remove(&id).ok_or_else(|| RpcError::invalid_params(format!("no question {id} is waiting")))?;
            Ok(json!({ "answered": tx.send(ok).is_ok() }))
        }
        "project.summary" => Ok(json!({ "text": engine.project()?.0.summary() })),
        "preview.frame" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let at = us(&params, "atUs").unwrap_or(0).clamp(0, project.duration_us());
            let w = ((params.get("width").and_then(Value::as_u64).unwrap_or(540) as u32).clamp(16, 4096) / 2 * 2).max(16);
            let h = (((w as f64 * project.height as f64 / project.width.max(1) as f64).round() as u32) / 2 * 2).max(2);
            let dir = engine.cache_dir().join("frames");
            std::fs::create_dir_all(&dir).map_err(io_err)?;
            let out = dir.join(format!("frame-{at}-{w}.png"));
            crate::export::still_png(&m.ff, &project, at, w, h, &out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
            Ok(json!({ "path": out.to_string_lossy(), "width": w, "height": h, "atUs": at }))
        }
        "overlay.add" | "text.add" | "adjust.add" => {
            let role = match method {
                "text.add" => "text".to_string(),
                "adjust.add" => "adjust".to_string(),
                _ => params.get("role").and_then(Value::as_str).unwrap_or("overlay").to_string(),
            };
            let media = params.get("mediaId").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string);
            let text = field::<TextSpec>(&params, "text")?;
            let at = us(&params, "atUs").unwrap_or(0);
            let duration = us(&params, "durationUs").filter(|d| *d > 0);
            let track = params.get("trackId").and_then(Value::as_str).map(str::to_string);
            let new_at = params.get("newTrackAt").and_then(Value::as_u64).map(|i| i as usize);
            let label = match role.as_str() {
                "text" => "Add text",
                "captions" => "Add caption",
                "adjust" => "Add adjustment layer",
                "sticker" => "Add sticker",
                _ => "Add overlay",
            };
            let (clip, track) = engine.edit_inner(label, |p| {
                let (clip, track) = p.add_overlay(media.as_deref(), text, at, duration, &role, track.as_deref())?;
                // Dropped between two rows (dragged in from the library): on a new track made there.
                let Some(i) = new_at else { return Ok((clip, track)) };
                let track = p.move_to_new_track(&clip, at, i)?;
                Ok((clip, track))
            })?;
            engine.changed();
            if let Some(m) = &media {
                engine.ensure_proxy(m);
            }
            Ok(json!({ "clipId": clip, "trackId": track }))
        }
        "text.set" => {
            let id = s(&params, "clipId")?;
            let text = field::<TextSpec>(&params, "text")?.ok_or_else(|| RpcError::invalid_params("missing \"text\""))?;
            // One gesture (a slider dragged, words typed) is one undo step however often it's sent;
            // with `together` (Apply to all text) one step across every text clip it reaches.
            let together = params.get("together").and_then(Value::as_bool) == Some(true);
            let merge = params.get("gesture").and_then(Value::as_str).map(|g| if together { format!("text.set * {g}") } else { format!("text.set {id} {g}") });
            engine.edit_merging(if together { "Apply to all text" } else { "Text" }, merge.as_deref(), |p| p.set_clip(&id, ClipChange { text: Some(text), ..Default::default() }))
        }
        "transition.set" => {
            let id = s(&params, "clipId")?;
            let name = params.get("name").and_then(Value::as_str).map(str::to_string);
            let d = us(&params, "durationUs");
            engine.edit(if name.is_some() { "Transition" } else { "Remove transition" }, |p| p.set_transition(&id, name.as_deref(), d))
        }
        "transition.setAll" => {
            let name = params.get("name").and_then(Value::as_str).map(str::to_string);
            let d = us(&params, "durationUs").unwrap_or(500_000);
            engine.edit(if name.is_some() { "Transitions on every cut" } else { "Remove all transitions" }, |p| p.set_all_transitions(name.as_deref(), d))
        }
        "captions.set" => {
            let lines: Vec<CaptionLine> = field(&params, "lines")?.unwrap_or_default();
            let style = field::<TextSpec>(&params, "style")?.unwrap_or_default();
            let track = params.get("trackId").and_then(Value::as_str).map(str::to_string);
            let above = params.get("aboveTrackId").and_then(Value::as_str).map(str::to_string);
            // Lines set at once and their drawings sent after (`captions.draw`) are one undo step.
            let (track, ids) = engine.edit_inner_merging("Captions", gesture(&params).as_deref(), |p| p.set_captions(track.as_deref(), above.as_deref(), lines, style))?;
            engine.changed();
            Ok(json!({ "trackId": track, "clipIds": ids }))
        }
        "captions.draw" => {
            let drawings: Vec<CaptionDrawing> = field(&params, "drawings")?.unwrap_or_default();
            engine.edit_merging("Captions", gesture(&params).as_deref(), |p| Ok(p.set_caption_drawings(&drawings)))
        }
        "audio.crossfade" => {
            let ids = strings(&params, "clipIds");
            let [a, b] = ids.as_slice() else { return Err(RpcError::invalid_params("crossfade takes two clipIds")) };
            let d = us(&params, "durationUs").unwrap_or(500_000);
            engine.edit("Crossfade", |p| p.crossfade(a, b, d))
        }
        "audio.spectralDelete" => {
            let id = s(&params, "clipId")?;
            let (a, b) = (us(&params, "startUs").unwrap_or(0), us(&params, "endUs").unwrap_or(0));
            let (lo, hi) = (f32_of(&params, "lowHz").unwrap_or(0.0), f32_of(&params, "highHz").unwrap_or(0.0));
            engine.edit("Spectral delete", |p| p.spectral_delete(&id, a, b, lo, hi))
        }
        "audio.drawSamples" => engine.draw_samples(&params),

        "ping" => Ok(json!({
            "pong": true,
            "engine": "studio-engine",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "platform": std::env::consts::OS,
            "uptimeMs": engine.started.elapsed().as_millis() as u64,
        })),
        "engine.capabilities" => Ok(match &engine.services {
            Ok(m) => json!({ "ffmpeg": m.ff.version, "nvenc": m.ff.has("h264_nvenc"), "mp3": m.ff.has("libmp3lame"), "encoders": m.ff.encoders.iter().filter(|e| e.contains("264") || e.contains("265") || e.contains("av1") || e.contains("hevc")).collect::<Vec<_>>(), "audioDevice": m.playback.audio.device, "projectsDir": engine.projects_dir.to_string_lossy() }),
            Err(e) => json!({ "ffmpeg": null, "error": e, "projectsDir": engine.projects_dir.to_string_lossy() }),
        }),

        // Projects
        "project.current" => Ok(engine.snapshot()),
        "project.openLatest" => {
            if engine.doc.lock().unwrap().is_some() {
                return Ok(engine.snapshot());
            }
            std::fs::create_dir_all(&engine.projects_dir).map_err(io_err)?;
            let doc = match Doc::open_latest(&engine.projects_dir) {
                Some(d) => d,
                None => Doc::create(&engine.projects_dir, "My first project", "9:16").map_err(io_err)?,
            };
            Ok(engine.set_doc(doc))
        }
        "project.new" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("Untitled");
            let aspect = params.get("aspect").and_then(Value::as_str).unwrap_or("9:16");
            std::fs::create_dir_all(&engine.projects_dir).map_err(io_err)?;
            Ok(engine.set_doc(Doc::create(&engine.projects_dir, name, aspect).map_err(io_err)?))
        }
        "project.open" => Ok(engine.set_doc(Doc::open(Path::new(&s(&params, "path")?)).map_err(io_err)?)),
        "project.setFormat" => {
            let aspect = s(&params, "aspect")?;
            engine.edit(&format!("Format {aspect}"), |p| p.set_format(&aspect))
        }

        // Media and timeline edits
        "media.import" => {
            // With `gesture`: part of a bigger edit, one undo step with it (under `label`).
            let merge = gesture(&params);
            let label = params.get("label").and_then(Value::as_str).unwrap_or("Import");
            engine.import(strings(&params, "paths"), merge.as_deref().map(|m| (label, m)))
        }
        // The library shows these media: their posters first.
        "media.want" => {
            let ids: Vec<String> = params.get("mediaIds").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if let Ok(m) = engine.services() {
                m.jobs.want(&ids);
            }
            Ok(json!({}))
        }
        "media.syncFolder" => {
            let _one_at_a_time = engine.imports.lock().unwrap_or_else(|e| e.into_inner());
            let id = s(&params, "folderId")?;
            let path = engine.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.project.folders.iter().find(|f| f.id == id).map(|f| f.path.clone());
            engine.link_or_sync(&path.ok_or_else(|| RpcError::invalid_params(format!("no folder {id}")))?)
        }
        "media.syncFolders" => {
            let _one_at_a_time = engine.imports.lock().unwrap_or_else(|e| e.into_inner());
            let paths: Vec<String> = engine.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.project.folders.iter().map(|f| f.path.clone()).collect();
            Ok(json!({ "folders": paths.iter().map(|p| engine.link_or_sync(p).unwrap_or_else(|e| json!({ "path": p, "error": e.message }))).collect::<Vec<_>>() }))
        }
        "media.unlinkFolder" => {
            let id = s(&params, "folderId")?;
            engine.edit("Remove folder", |p| p.unlink_folder(&id))
        }
        "timeline.insert" => {
            let media_id = s(&params, "mediaId")?;
            let at = us(&params, "atUs");
            let r = engine.edit_merging("Add to timeline", gesture(&params).as_deref(), |p| {
                let at = at.unwrap_or_else(|| p.duration_us());
                p.insert(&media_id, at)
            })?;
            engine.ensure_proxy(&media_id);
            Ok(r)
        }
        "timeline.move" => {
            let clip = s(&params, "clipId")?;
            let start = us(&params, "startUs").unwrap_or(0);
            let track = params.get("trackId").and_then(Value::as_str).map(str::to_string);
            // `newTrackAt`: onto a new track made at that index in `project.tracks` (between two rows).
            match params.get("newTrackAt").and_then(Value::as_u64) {
                Some(i) => engine.edit("Move clip", |p| p.move_to_new_track(&clip, start, i as usize).map(|t| json!({ "trackId": t }))),
                None => engine.edit("Move clip", |p| p.move_clip(&clip, start, track.as_deref())),
            }
        }
        "timeline.liftMany" => {
            // A selection dragged up off the main track: `moves` [{ clipId, startUs }], all on one
            // track (`trackId`, or a new one at `newTrackAt`), one undo step.
            let moves: Vec<(String, Us)> = params
                .get("moves")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|m| Some((m.get("clipId")?.as_str()?.to_string(), m.get("startUs")?.as_i64()?))).collect())
                .unwrap_or_default();
            let track = params.get("trackId").and_then(Value::as_str).map(str::to_string);
            let at = params.get("newTrackAt").and_then(Value::as_u64).map(|i| i as usize);
            engine.edit("Move clips", |p| p.lift_many(&moves, track.as_deref(), at).map(|t| json!({ "trackId": t })))
        }
        "timeline.moveMany" => {
            // A selection dragged together: `moves` [{ clipId, startUs }], each on its own track, one undo step.
            let moves: Vec<(String, Us)> = params
                .get("moves")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|m| Some((m.get("clipId")?.as_str()?.to_string(), m.get("startUs")?.as_i64()?))).collect())
                .unwrap_or_default();
            if moves.is_empty() {
                return Err(RpcError::invalid_params("moveMany takes moves: [{ clipId, startUs }]"));
            }
            engine.edit("Move clips", |p| p.move_many(&moves))
        }
        "timeline.trim" => {
            let clip = s(&params, "clipId")?;
            let (in_us, dur) = (us(&params, "inUs").unwrap_or(0), us(&params, "durationUs").unwrap_or(0));
            let start = us(&params, "startUs");
            engine.edit("Trim clip", |p| p.trim(&clip, in_us, dur, start))
        }
        "timeline.split" => {
            let at = us(&params, "atUs").ok_or_else(|| RpcError::invalid_params("missing \"atUs\""))?;
            let mut ids = strings(&params, "clipIds");
            ids.extend(params.get("clipId").and_then(Value::as_str).map(str::to_string));
            engine.edit("Split", |p| p.split(at, &ids))
        }
        "timeline.delete" => {
            let ids = strings(&params, "clipIds");
            engine.edit("Delete", |p| p.delete(&ids))
        }
        "clip.set" => {
            // `clipId`, `clipIds` or both: the change goes to each of them.
            let mut ids = strings(&params, "clipIds");
            if let Some(first) = params.get("clipId").and_then(Value::as_str) {
                ids.retain(|x| x != first);
                ids.insert(0, first.to_string());
            }
            if ids.is_empty() {
                return Err(RpcError::invalid_params("missing \"clipId\""));
            }
            let change = clip_change(&params)?;
            let label = clip_label(&change);
            let label = params.get("label").and_then(Value::as_str).unwrap_or(label).to_string();
            engine.edit(&label, |p| {
                for id in &ids {
                    p.set_clip(id, change.clone())?;
                }
                Ok(())
            })
        }
        "timeline.freezeFrame" => {
            let at = us(&params, "atUs").ok_or_else(|| RpcError::invalid_params("missing \"atUs\""))?;
            engine.freeze_frame(at, &strings(&params, "clipIds"))
        }
        "history.list" => Ok(engine.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.history()),
        "history.goto" => {
            let index = params.get("index").and_then(Value::as_i64).ok_or_else(|| RpcError::invalid_params("missing \"index\""))?;
            let (moved, stuck) = {
                let mut g = engine.doc.lock().unwrap();
                let d = g.as_mut().ok_or_else(no_project)?;
                d.actor = actor();
                let moved = d.goto(index);
                let current = d.history()["current"].as_i64().unwrap_or(-1);
                (moved, if current == index { None } else { d.blocked(current < index) })
            };
            if moved > 0 {
                engine.changed();
            }
            // It goes as far as it can; a step that would change a busy clip stops it there.
            if let Some(why) = stuck {
                return Err(RpcError::new(EDIT_FAILED, why));
            }
            Ok(json!({ "moved": moved, "history": engine.doc.lock().unwrap().as_ref().ok_or_else(no_project)?.history() }))
        }
        "clips.paste" => {
            let items: Vec<PasteItem> = serde_json::from_value(params.get("items").cloned().unwrap_or_default()).map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let at = us(&params, "atUs").unwrap_or(0);
            // With a track, onto that track (on a sound track, opening a gap for what is pasted).
            let track = params.get("trackId").and_then(Value::as_str).map(str::to_string);
            let ids = engine.edit_inner("Paste", |p| match &track {
                Some(t) => p.paste_onto(items, at, t),
                None => p.paste(items, at),
            })?;
            engine.changed();
            let used: Vec<String> = {
                let g = engine.doc.lock().unwrap();
                g.as_ref().map(|d| ids.iter().filter_map(|id| d.project.clip(id).map(|c| c.media_id.clone())).collect()).unwrap_or_default()
            };
            for media in used {
                engine.ensure_proxy(&media);
            }
            Ok(json!({ "clipIds": ids }))
        }
        "media.remove" => {
            let ids = strings(&params, "mediaIds");
            let (media, clips) = engine.edit_inner("Remove from library", |p| p.remove_media(&ids))?;
            engine.changed();
            Ok(json!({ "media": media, "clips": clips }))
        }
        "media.restore" => {
            let media: Vec<Media> = serde_json::from_value(params.get("media").cloned().unwrap_or_default()).map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let ids = engine.edit_inner("Paste into library", |p| p.restore_media(media))?;
            engine.changed();
            Ok(json!({ "mediaIds": ids }))
        }
        "media.extractRange" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let media = project.media(&s(&params, "mediaId")?).cloned().ok_or_else(|| RpcError::invalid_params("no such media"))?;
            let out = PathBuf::from(s(&params, "out")?);
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir).map_err(io_err)?;
            }
            let (in_us, dur) = (us(&params, "inUs").unwrap_or(0), us(&params, "durationUs").unwrap_or(media.duration_us));
            crate::export::cut_range(&m.ff, Path::new(&media.path), in_us, dur, &out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
            Ok(json!({ "out": out.to_string_lossy() }))
        }
        "media.toAudio" => {
            // Only recordings saved in a project's recordings folder.
            let (input, out) = (PathBuf::from(s(&params, "input")?), PathBuf::from(s(&params, "out")?));
            let in_recordings = |p: &Path| p.parent().and_then(Path::file_name).is_some_and(|d| d == "recordings");
            if !in_recordings(&input) || !in_recordings(&out) {
                return Err(RpcError::invalid_params("only recordings can be converted"));
            }
            crate::export::to_audio(&engine.services()?.ff, &input, &out).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
            let _ = std::fs::remove_file(&input);
            Ok(json!({ "out": out.to_string_lossy() }))
        }
        "clip.replaceMedia" => {
            let (clip, media) = (s(&params, "clipId")?, s(&params, "mediaId")?);
            let label = params.get("label").and_then(Value::as_str).unwrap_or("Replace clip media").to_string();
            let whole = params.get("whole").and_then(Value::as_bool).unwrap_or(false);
            // With `job`: the result of the work the clip is busy with, which ends its busy state.
            let r = match params.get("job").and_then(Value::as_str) {
                Some(job) => {
                    only_the_app("finish a busy clip")?;
                    let r = {
                        let mut g = engine.doc.lock().unwrap();
                        let d = g.as_mut().ok_or_else(no_project)?;
                        d.release(&actor(), &label, &clip, job, |p| p.replace_media(&clip, &media, false)).map_err(|e| RpcError::new(EDIT_FAILED, e.0))?
                    };
                    engine.changed();
                    json!(r)
                }
                None => engine.edit_merging(&label, gesture(&params).as_deref(), |p| p.replace_media(&clip, &media, whole))?,
            };
            engine.ensure_proxy(&media);
            Ok(r)
        }
        // A clip outside work is making a new file for (Vmake text removal): nothing may change
        // it until `clip.release` (or `clip.replaceMedia` with the job) ends it. Not undo steps.
        "clip.busy" | "clip.release" => {
            only_the_app("mark clips busy")?;
            let (clip, job) = (s(&params, "clipId")?, s(&params, "job")?);
            let released = {
                let mut g = engine.doc.lock().unwrap();
                let d = g.as_mut().ok_or_else(no_project)?;
                let mine = d.project.clip(&clip).is_some_and(|c| c.busy.as_deref() == Some(job.as_str()));
                match method {
                    "clip.busy" => d.set_busy(&clip, Some(&job)).map(|()| false),
                    // Only its own job ends it; a release for another (or a clip gone) changes nothing.
                    _ if mine => d.set_busy(&clip, None).map(|()| true),
                    _ => Ok(false),
                }
                .map_err(|e| RpcError::new(EDIT_FAILED, e.0))?
            };
            engine.events.emit("project.changed", engine.snapshot());
            Ok(json!({ "released": released }))
        }
        "timeline.compound" => engine.compound(&strings(&params, "clipIds")),
        "timeline.breakCompound" => {
            let clip = s(&params, "clipId")?;
            engine.edit("Break compound clip", |p| p.break_compound(&clip))
        }
        "clip.extractAudio" => {
            // Returns the new audio clips, so "Edit in Audio" can open the one it made.
            let ids = strings(&params, "clipIds");
            let made = engine.edit_inner("Extract audio", |p| p.extract_audio(&ids))?;
            engine.changed();
            Ok(json!({ "clipIds": made }))
        }
        "timeline.trimAt" => {
            let at = us(&params, "atUs").ok_or_else(|| RpcError::invalid_params("missing \"atUs\""))?;
            let ids = strings(&params, "clipIds");
            let keep_right = params.get("keep").and_then(Value::as_str) == Some("right");
            engine.edit(if keep_right { "Delete left" } else { "Delete right" }, |p| p.trim_at(at, &ids, keep_right))
        }
        "project.setOptions" => {
            let magnet = params.get("magnet").and_then(Value::as_bool);
            let linkage = params.get("linkage").and_then(Value::as_bool);
            if let Some(at) = us(&params, "coverUs") {
                engine.edit("Set cover", |p| {
                    p.cover_us = Some(at.clamp(0, p.duration_us()));
                    Ok(())
                })?;
            }
            if let Some(on) = magnet {
                engine.edit(if on { "Main track magnet on" } else { "Main track magnet off" }, |p| {
                    p.set_magnet(on);
                    Ok(())
                })?;
            }
            if let Some(on) = linkage {
                // A preference, not an edit: no undo step.
                if let Some(d) = engine.doc.lock().unwrap().as_mut() {
                    d.quiet_update(|p| p.linkage = on);
                    d.flush();
                }
                engine.changed();
            }
            if let Some(brand) = field::<Brand>(&params, "brand")? {
                engine.edit("Brand kit", |p| {
                    p.brand = brand;
                    Ok(())
                })?;
            }
            if let Some(patch) = params.get("mcp").filter(|v| v.is_object()) {
                // What MCP clients may do is the user's to say, never a client's own.
                if actor() != "you" {
                    return Err(RpcError::new(EDIT_FAILED, "Only you can change what MCP clients may do"));
                }
                let mut current = serde_json::to_value(engine.project()?.0.mcp.clone()).unwrap_or_default();
                merge(&mut current, patch);
                let mut mcp: McpOptions = serde_json::from_value(current).map_err(|e| RpcError::invalid_params(format!("mcp: {e}")))?;
                if !matches!(mcp.allowed.as_str(), "all" | "edit" | "look") {
                    mcp.allowed = "all".into();
                }
                // A setting, saved with the project but not an undo step.
                if let Some(d) = engine.doc.lock().unwrap().as_mut() {
                    d.quiet_update(|p| p.mcp = mcp);
                    d.flush();
                }
                engine.changed();
            }
            if let Some(name) = params.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
                // Its name, as renaming it on Home: saved with the project but not an undo step.
                if let Some(d) = engine.doc.lock().unwrap().as_mut() {
                    d.quiet_update(|p| p.name = name.chars().take(120).collect());
                    d.flush();
                }
                engine.changed();
            }
            Ok(engine.snapshot())
        }
        "edit.undo" | "edit.redo" => {
            let done = {
                let mut g = engine.doc.lock().unwrap();
                let d = g.as_mut().ok_or_else(no_project)?;
                d.actor = actor();
                // A step that would change a busy clip waits until its work is done.
                if let Some(why) = d.blocked(method == "edit.redo") {
                    return Err(RpcError::new(EDIT_FAILED, why));
                }
                if method == "edit.undo" { d.undo() } else { d.redo() }
            };
            if done {
                engine.changed();
            }
            Ok(json!({ "done": done }))
        }

        // The Audio page: track mix, effects, master, analysis and "Fix and tidy"
        "track.set" => {
            let id = s(&params, "trackId")?;
            let (project, _) = engine.project()?;
            let track = project.track(&id).ok_or_else(|| RpcError::invalid_params(format!("no track {id}")))?;
            let effects = match params.get("effects") {
                Some(patch) => {
                    let mut current = serde_json::to_value(&track.effects).unwrap_or_default();
                    merge(&mut current, patch);
                    Some(serde_json::from_value::<Effects>(current).map_err(|e| RpcError::invalid_params(e.to_string()))?)
                }
                None => None,
            };
            let change = TrackChange { gain_db: f32_of(&params, "gainDb"), pan: f32_of(&params, "pan"), mute: params.get("mute").and_then(Value::as_bool), solo: params.get("solo").and_then(Value::as_bool), effects, role: params.get("role").and_then(Value::as_str).map(str::to_string), locked: params.get("locked").and_then(Value::as_bool), hidden: params.get("hidden").and_then(Value::as_bool) };
            let label = match &change {
                c if c.effects.is_some() => "Track effects",
                c if c.mute.is_some() => "Mute",
                c if c.solo.is_some() => "Solo",
                c if c.locked == Some(true) => "Lock track",
                c if c.locked == Some(false) => "Unlock track",
                c if c.hidden == Some(true) => "Hide track",
                c if c.hidden == Some(false) => "Show track",
                c if c.pan.is_some() => "Pan",
                c if c.gain_db.is_some() => "Track volume",
                _ => "Track settings",
            };
            let label = params.get("label").and_then(Value::as_str).unwrap_or(label).to_string();
            engine.edit(&label, |p| p.set_track(&id, change))
        }
        "project.setMaster" => {
            let change = MasterChange { normalize: params.get("normalize").and_then(Value::as_bool), target_lufs: f32_of(&params, "targetLufs"), limiter: params.get("limiter").and_then(Value::as_bool), ceiling_db: f32_of(&params, "ceilingDb"), gain_db: f32_of(&params, "gainDb") };
            engine.edit("Master", |p| p.set_master(change))?;
            Ok(engine.snapshot()["project"]["master"].clone())
        }
        "audio.loudness" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            Ok(m.analysis.loudness(project))
        }
        "audio.levels" | "audio.spectrogram" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let id = s(&params, "mediaId")?;
            let media = project.media(&id).filter(|x| x.has_audio).ok_or_else(|| RpcError::invalid_params(format!("no media with sound {id}")))?;
            let what = if method == "audio.levels" { "levels" } else { "spectrogram" };
            Ok(m.analysis.file(what, &id, Path::new(&media.path), &engine.cache_dir(), media.duration_us))
        }
        "audio.normalizeMix" => {
            // Sets the mix gain so playback (and the export before its master stage) sits at the target.
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let target = f32_of(&params, "targetLufs").unwrap_or(project.master.target_lufs) as f64;
            let l = crate::audio::measure_mix(&m.ff, &project, false).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
            let measured = l.integrated.ok_or_else(|| RpcError::new(EDIT_FAILED, "The mix is silent"))?;
            let gain = (project.master.gain_db as f64 + target - measured) as f32;
            engine.edit(&format!("Normalise the mix to {target} LUFS"), |p| p.set_master(MasterChange { gain_db: Some(gain), ..Default::default() }))?;
            let applied = (engine.project()?.0.master.gain_db as f64 * 10.0).round() / 10.0;
            Ok(json!({ "measured": measured, "gainDb": applied }))
        }
        "audio.normalize" => {
            let m = engine.services()?;
            let loudness = params.get("mode").and_then(Value::as_str) == Some("loudness");
            let target = params.get("targetDb").and_then(Value::as_f64).unwrap_or(if loudness { -14.0 } else { -1.0 });
            let mut set = vec![];
            for c in engine.sound_clips(&strings(&params, "clipIds"))? {
                let level = crate::audio::level_of(&m.ff, &c.path, c.in_us, c.span_us, loudness).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
                let volume = 10f64.powf((target - level) / 20.0).clamp(0.0, 4.0) as f32;
                set.push((c.id, level, volume));
            }
            engine.edit(if loudness { "Normalise loudness" } else { "Normalise peak" }, |p| {
                for (id, _, v) in &set {
                    p.set_clip(id, ClipChange { volume: Some(*v), ..Default::default() })?;
                }
                Ok(())
            })?;
            Ok(json!({ "clips": set.iter().map(|(id, level, v)| json!({ "clipId": id, "measured": level, "volume": v })).collect::<Vec<_>>() }))
        }
        "audio.removeSilences" => {
            // Pauses of at least `minUs`, leaving `keepUs` of air on each side; `dryRun` only
            // says which ranges would go (fast: the cached levels, no FFmpeg), and the real run
            // removes exactly those.
            let min = us(&params, "minUs").unwrap_or(500_000).max(50_000);
            let keep = us(&params, "keepUs").unwrap_or(100_000).clamp(0, min);
            let found = engine.clip_silences(&params, min)?;
            let plan: Vec<(String, Us, Vec<(Us, Us)>)> = found.into_iter().map(|(id, _, start, s)| (id, start, crate::audio::cuts_for(&s, min, keep))).filter(|(_, _, c)| !c.is_empty()).collect();
            let ranges: Vec<Value> = plan.iter().flat_map(|(_, start, cuts)| cuts.iter().map(move |(a, b)| json!({ "startUs": start + a, "endUs": start + b }))).collect();
            let removed: Us = plan.iter().flat_map(|(_, _, c)| c.iter().map(|(a, b)| b - a)).sum();
            if params.get("dryRun").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(json!({ "ranges": ranges, "removedUs": removed }));
            }
            if plan.is_empty() {
                return Err(RpcError::new(EDIT_FAILED, format!("No pauses longer than {:.1} s in the selected sound", min as f64 / 1e6)));
            }
            let ids = engine.edit_inner("Remove silences", |p| {
                let mut ids = vec![];
                for (id, _, cuts) in &plan {
                    ids.extend(p.remove_ranges(id, cuts)?);
                }
                Ok(ids)
            })?;
            engine.changed();
            Ok(json!({ "clipIds": ids, "removedUs": removed, "ranges": ranges }))
        }
        "audio.removeRange" => {
            let track = s(&params, "trackId")?;
            let (a, b) = (us(&params, "startUs").unwrap_or(0), us(&params, "endUs").unwrap_or(0));
            let label = format!("Cut {:.2} s", (b - a).abs() as f64 / 1e6);
            let removed = engine.edit_inner(&label, |p| p.remove_range(&track, a, b))?;
            engine.changed();
            Ok(json!({ "removedUs": removed }))
        }
        "audio.samples" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let id = s(&params, "mediaId")?;
            let media = project.media(&id).filter(|x| x.has_audio).cloned().ok_or_else(|| RpcError::invalid_params(format!("no media with sound {id}")))?;
            let (a, b) = (us(&params, "startUs").unwrap_or(0).max(0), us(&params, "endUs").unwrap_or(0));
            if b <= a {
                return Err(RpcError::invalid_params("endUs must come after startUs"));
            }
            if b - a > 2_000_000 {
                return Err(RpcError::invalid_params("At most 2 s of samples at a time; wider views use the levels"));
            }
            let path = Path::new(&media.path);
            let rate = match media.sample_rate {
                Some(r) => r,
                None => m.ff.sample_rate(path).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?,
            };
            let raw = crate::audio::samples(&m.ff, path, a, b - a).map_err(|e| RpcError::new(EDIT_FAILED, e.to_string()))?;
            Ok(json!({ "rate": rate, "startUs": a, "count": raw.len() / 4, "data": crate::edits::base64(&raw) }))
        }
        "audio.splitAtSilences" => {
            let found = engine.clip_silences(&params, 300_000)?;
            let plan: Vec<(String, Vec<Us>)> = found.into_iter().map(|(id, dur, _, s)| (id, crate::audio::split_points(&s, dur))).filter(|(_, t)| !t.is_empty()).collect();
            if plan.is_empty() {
                return Err(RpcError::new(EDIT_FAILED, "No pauses inside the selected sound to split at"));
            }
            let ids = engine.edit_inner("Split at silences", |p| {
                let mut ids = vec![];
                for (id, offsets) in &plan {
                    let start = p.clip(id).map_or(0, |c| c.start_us);
                    ids.extend(p.split_at_times(id, &offsets.iter().map(|t| start + t).collect::<Vec<_>>())?);
                }
                Ok(ids)
            })?;
            engine.changed();
            Ok(json!({ "clipIds": ids }))
        }
        "audio.labelSounds" => {
            let found = engine.clip_silences(&params, 300_000)?;
            let (project, _) = engine.project()?;
            let first = project.labels.iter().filter(|l| l.text.starts_with("Sound ")).count() + 1;
            let items: Vec<(Us, Us, String)> = found
                .iter()
                .flat_map(|(_, dur, start, s)| crate::audio::sounds_between(s, *dur).into_iter().map(move |(a, b)| (start + a, start + b)))
                .enumerate()
                .map(|(n, (a, b))| (a, b, format!("Sound {}", first + n)))
                .collect();
            engine.edit("Label sounds", |p| p.add_labels(items))
        }
        "timeline.insertNewTrack" => {
            let media_id = s(&params, "mediaId")?;
            let at = us(&params, "atUs").unwrap_or(0);
            engine.edit("Add track", |p| p.insert_on_new_track(&media_id, at))
        }
        // Stems of a clip's sound (files starting at `fromUs` in its source) on new sound tracks
        // under it, in sync; with `replace` its own sound goes off. One undo step.
        "timeline.addStems" => {
            let clip = s(&params, "clipId")?;
            let items: Vec<studio_engine_core::stems::StemItem> = serde_json::from_value(params.get("stems").cloned().unwrap_or_default()).map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let from = us(&params, "fromUs").unwrap_or(0);
            let replace = params.get("replace").and_then(Value::as_bool).unwrap_or(false);
            let label = if replace { "Use only these stems" } else if items.len() == 1 { "Add stem" } else { "Add stems" };
            let ids = engine.edit_inner(label, |p| p.add_stems(&clip, &items, from, replace))?;
            engine.changed();
            Ok(json!({ "clipIds": ids }))
        }
        "labels.add" => {
            let items: Vec<(Us, Us, String)> = params.get("items").and_then(Value::as_array).map(|a| a.iter().map(|x| (us(x, "startUs").unwrap_or(0), us(x, "endUs").unwrap_or(0), x.get("text").and_then(Value::as_str).unwrap_or("Label").to_string())).collect()).unwrap_or_default();
            engine.edit("Add label", |p| p.add_labels(items))
        }
        "labels.set" => {
            let id = s(&params, "labelId")?;
            let text = params.get("text").and_then(Value::as_str).map(str::to_string);
            let (start, end) = (us(&params, "startUs"), us(&params, "endUs"));
            engine.edit(if text.is_some() { "Rename label" } else { "Move label" }, |p| p.set_label(&id, text, start, end))
        }
        "labels.delete" => {
            let ids = strings(&params, "labelIds");
            engine.edit("Delete label", |p| p.delete_labels(&ids))
        }
        "playback.setLoop" => {
            let m = engine.services()?;
            let range = us(&params, "startUs").zip(us(&params, "endUs"));
            m.playback.set_loop(range);
            // A run already playing picks the loop up from where it is.
            if m.playback.is_playing() && m.playback.context() == "timeline" {
                let (project, rev) = engine.project()?;
                m.playback.play(project, rev, m.playback.position()).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
            }
            Ok(m.playback.status())
        }

        // Playback
        "playback.status" => Ok(engine.services()?.playback.status()),
        "preview.hide" => {
            // Clips the player draws itself while they're edited: paused frames leave them out
            // until they're shown again (an empty list). The ticket is the frame's `preview.shown`.
            let m = engine.services()?;
            let hidden = Hidden { clips: strings(&params, "clipIds"), tracks: strings(&params, "trackIds") };
            let (project, _) = engine.project()?;
            Ok(json!({ "ticket": m.playback.set_hidden(hidden, project) }))
        }
        "preview.source" => {
            let id = s(&params, "mediaId")?;
            let play = params.get("play").and_then(Value::as_bool).unwrap_or(false);
            engine.preview_source(&id, us(&params, "atUs").unwrap_or(0), play)
        }
        "playback.play" => {
            let m = engine.services()?;
            let (project, rev) = engine.play_target(params.get("source").and_then(Value::as_bool).unwrap_or(false))?;
            let from = us(&params, "fromUs").unwrap_or_else(|| m.playback.position());
            m.playback.play(project, rev, from).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
            Ok(m.playback.status())
        }
        "playback.pause" => {
            let m = engine.services()?;
            m.playback.pause();
            Ok(m.playback.status())
        }
        "playback.toggle" => {
            let m = engine.services()?;
            let target = engine.play_target(params.get("source").and_then(Value::as_bool).unwrap_or(false))?;
            if m.playback.is_playing() {
                m.playback.pause();
            } else {
                let (project, rev) = target;
                m.playback.play(project, rev, m.playback.position()).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
            }
            Ok(m.playback.status())
        }
        "playback.seek" => {
            let m = engine.services()?;
            let (project, rev) = engine.play_target(params.get("source").and_then(Value::as_bool).unwrap_or(false))?;
            m.playback.seek(project, rev, us(&params, "positionUs").unwrap_or(0)).map_err(|e| RpcError::new(EDIT_FAILED, e))?;
            Ok(m.playback.status())
        }

        // Export
        "export.start" => {
            let m = engine.services()?;
            let (project, _) = engine.project()?;
            let mut formats = strings(&params, "formats");
            if formats.is_empty() {
                formats.push(project_aspect(&project));
            }
            let quality = params.get("quality").and_then(Value::as_str).and_then(Quality::parse).unwrap_or(Quality::Balanced);
            let folder = PathBuf::from(s(&params, "folder")?);
            let base = params.get("baseName").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| project.name.clone());
            // With clip ids, only those clips (from the first one's start to the last one's end).
            let ids = strings(&params, "clipIds");
            let mut project = if ids.is_empty() { (*project).clone() } else { project.sub_project(&ids).map_err(|e| RpcError::new(EDIT_FAILED, e.0))?.0 };
            // Captions as an .srt file only: the lead writes the file, and the captions tracks
            // stay out of the picture. "Burned in" (the default) and "Both" keep them.
            if params.get("captions").and_then(Value::as_str) == Some(".srt file") {
                project.tracks.retain(|t| t.main || t.role != "captions");
            }
            // Exact file names per format, a target bitrate and a frame rate.
            let options = ExportOptions {
                names: params.get("names").and_then(Value::as_object).map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default(),
                bitrate_mbps: params.get("bitrateMbps").and_then(Value::as_f64).filter(|m| *m > 0.0),
                fps: params.get("fps").and_then(Value::as_f64).filter(|f| *f >= 1.0).map(|f| f.round() as u32),
            };
            m.exports.start(project, &formats, quality, &folder, &base, options).map_err(|e| RpcError::new(EDIT_FAILED, e))
        }
        "export.cancel" => Ok(json!({ "cancelled": engine.services()?.exports.cancel(&s(&params, "jobId")?) })),

        // Step 0 frame-transport test
        "preview.start" => {
            let num = |key: &str, default: f64| params.get(key).and_then(Value::as_f64).unwrap_or(default);
            let config = PreviewConfig { width: num("width", 1080.0) as u32, height: num("height", 1920.0) as u32, fps: num("fps", 30.0) };
            if let Ok(m) = engine.services() {
                m.playback.pause();
            }
            engine.preview.start(config).map_err(RpcError::invalid_params)?;
            Ok(engine.preview.status())
        }
        "preview.stop" => {
            engine.preview.stop();
            Ok(engine.preview.status())
        }
        "preview.status" => {
            let mut status = engine.preview.status();
            status["cpuMs"] = json!(crate::cpu::process_cpu_ms());
            Ok(status)
        }
        "engine.shutdown" => {
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(100));
                println!("[engine] shutdown requested");
                crate::discovery::remove();
                std::process::exit(0);
            });
            Ok(json!({ "ok": true }))
        }
        _ => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {method}"))),
    }
}

fn project_aspect(p: &Project) -> String {
    ["9:16", "4:5", "1:1", "16:9"].iter().find(|a| studio_engine_core::model::format_size(a) == Some((p.width, p.height))).unwrap_or(&"9:16").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(name: &str) -> (Engine, PathBuf) {
        let dir = std::env::temp_dir().join(format!("studio-rpc-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Engine::new(&dir.join("ring"), 64, 64, dir.join("projects")).unwrap(), dir)
    }

    #[test]
    fn ping_answers() {
        let (e, dir) = engine("ping");
        let r = dispatch(&e, "ping", Value::Null).unwrap();
        assert_eq!(r["pong"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_method_is_an_error() {
        let (e, dir) = engine("unknown");
        assert_eq!(dispatch(&e, "nope", Value::Null).unwrap_err().code, RpcError::METHOD_NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preview_rejects_frames_bigger_than_the_ring() {
        let (e, dir) = engine("too-big");
        let err = dispatch(&e, "preview.start", json!({ "width": 4096, "height": 4096 })).unwrap_err();
        assert_eq!(err.code, RpcError::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preview_starts_writes_frames_and_stops() {
        let (e, dir) = engine("runs");
        let s = dispatch(&e, "preview.start", json!({ "width": 32, "height": 64, "fps": 120 })).unwrap();
        assert_eq!(s["running"], true);
        std::thread::sleep(std::time::Duration::from_millis(150));
        let s = dispatch(&e, "preview.stop", Value::Null).unwrap();
        assert_eq!(s["running"], false);
        assert!(s["framesWritten"].as_u64().unwrap() > 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn edits_need_a_project_and_then_work() {
        let (e, dir) = engine("edits");
        assert_eq!(dispatch(&e, "timeline.split", json!({ "atUs": 0 })).unwrap_err().code, EDIT_FAILED);
        let snap = dispatch(&e, "project.openLatest", Value::Null).unwrap();
        assert_eq!(snap["project"]["name"], "My first project");
        assert!(dir.join("projects").join("My first project.studio").join("project.json").is_file());
        let snap = dispatch(&e, "project.setFormat", json!({ "aspect": "4:5" }));
        assert!(snap.is_ok());
        assert_eq!(e.snapshot()["project"]["height"], 1350);
        assert_eq!(dispatch(&e, "edit.undo", Value::Null).unwrap()["done"], true);
        assert_eq!(e.snapshot()["project"]["height"], 1920);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clip_look_speed_history_and_locks_over_rpc() {
        let (e, dir) = engine("look");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let video = Media { id: "m1".into(), path: "x.mp4".into(), name: "x.mp4".into(), kind: MediaKind::Video, duration_us: 4_000_000, width: 1080, height: 1920, fps: 30.0, has_audio: true, ..Default::default() };
        let id = e
            .edit_inner("Import", |p| {
                p.media.push(video);
                p.insert("m1", 0)
            })
            .unwrap();
        // `clipIds` alone is enough; every new setting comes back in the snapshot, in camelCase.
        let set = json!({ "clipIds": [id], "reverse": true, "speed": 2, "scale": 120, "posX": -30, "keyframes": { "posX": [{ "atUs": 0, "value": 10 }], "hsl-Orange-h": [{ "atUs": 0, "value": 3 }] } });
        dispatch(&e, "clip.set", set).unwrap();
        let c = e.snapshot()["project"]["tracks"][0]["clips"][0].clone();
        assert_eq!((c["reverse"].as_bool(), c["speed"].as_f64(), c["scale"].as_f64(), c["posX"].as_f64(), c["durationUs"].as_i64()), (Some(true), Some(2.0), Some(120.0), Some(-30.0), Some(2_000_000)));
        assert_eq!((c["keyframes"]["hsl-Orange-h"][0]["value"].as_f64(), c["opacity"].as_f64(), c["vignette"].as_f64()), (Some(3.0), Some(100.0), Some(0.0)));
        let h = dispatch(&e, "history.list", Value::Null).unwrap();
        let n = h["steps"].as_array().unwrap().len();
        assert_eq!((h["steps"][n - 1]["label"].as_str(), h["current"].as_i64()), (Some("Speed"), Some(n as i64 - 1)));
        // The same value again, or a setting the engine doesn't know: no new step.
        dispatch(&e, "clip.set", json!({ "clipId": id, "scale": 120, "glow": 4 })).unwrap();
        assert_eq!(dispatch(&e, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len(), n);
        assert_eq!(dispatch(&e, "clip.set", json!({ "scale": 1 })).unwrap_err().code, RpcError::INVALID_PARAMS);
        let back = dispatch(&e, "history.goto", json!({ "index": n as i64 - 2 })).unwrap();
        assert_eq!((back["moved"].as_u64(), back["history"]["current"].as_i64()), (Some(1), Some(n as i64 - 2)));
        assert_eq!(e.snapshot()["project"]["tracks"][0]["clips"][0]["speed"], 1.0);

        // A locked track refuses edits; undo still works.
        let main = e.snapshot()["project"]["tracks"][0]["id"].as_str().unwrap().to_string();
        dispatch(&e, "track.set", json!({ "trackId": main, "locked": true })).unwrap();
        assert_eq!(dispatch(&e, "timeline.delete", json!({ "clipIds": [id] })).unwrap_err().message, "The main track is locked");
        assert!(dispatch(&e, "timeline.split", json!({ "atUs": 1_000_000 })).is_err());
        dispatch(&e, "edit.undo", Value::Null).unwrap();
        dispatch(&e, "timeline.delete", json!({ "clipIds": [id] })).unwrap();
        assert!(e.snapshot()["project"]["tracks"][0]["clips"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_busy_clip_holds_against_the_app_mcp_and_undo() {
        let (e, dir) = engine("busy");
        e.connect(1);
        dispatch_on(&e, 1, "project.openLatest", Value::Null).unwrap();
        let video = |id: &str, path: &str| Media { id: id.into(), path: path.into(), name: path.into(), kind: MediaKind::Video, duration_us: 4_000_000, width: 1080, height: 1920, fps: 30.0, has_audio: true, ..Default::default() };
        let id = e
            .edit_inner("Import", |p| {
                p.media.push(video("m1", "x.mp4"));
                p.media.push(video("m2", "x (no text).mp4"));
                p.insert("m1", 0)
            })
            .unwrap();
        dispatch_on(&e, 1, "clip.set", json!({ "clipId": id, "opacity": 80 })).unwrap();
        dispatch_on(&e, 1, "clip.busy", json!({ "clipId": id, "job": "j1" })).unwrap();
        let clip = || e.snapshot()["project"]["tracks"][0]["clips"][0].clone();
        assert_eq!(clip()["busy"], "j1");
        let busy = "Text is still being removed from x.mp4. Wait for it, or cancel it from the clip's right-click menu";
        let as_mcp = |method: &str, params: Value| {
            let mut p = params;
            p["_actor"] = json!("claude");
            dispatch_on(&e, 1, method, p).unwrap_err().message
        };
        assert_eq!(as_mcp("clip.set", json!({ "clipId": id, "scale": 150 })), busy);
        assert_eq!(as_mcp("timeline.delete", json!({ "clipIds": [id] })), busy);
        assert_eq!(as_mcp("timeline.move", json!({ "clipId": id, "startUs": 1_000_000 })), busy);
        assert_eq!(as_mcp("clip.replaceMedia", json!({ "clipId": id, "mediaId": "m2" })), busy);
        assert_eq!(as_mcp("edit.undo", json!({})), busy, "undo would take the opacity back");
        assert_eq!(as_mcp("clip.release", json!({ "clipId": id, "job": "j1" })), "Only the app can mark clips busy");
        assert_eq!(as_mcp("clip.replaceMedia", json!({ "clipId": id, "mediaId": "m2", "job": "j1" })), "Only the app can finish a busy clip");
        assert!(dispatch_on(&e, 1, "project.summary", Value::Null).unwrap()["text"].as_str().unwrap().contains("busy: text is being removed"));
        assert_eq!(dispatch_on(&e, 1, "history.goto", json!({ "index": 0 })).unwrap_err().message, busy);
        assert_eq!((clip()["opacity"].as_f64(), clip()["mediaId"].as_str()), (Some(80.0), Some("m1")));

        // Another job's release changes nothing; its own result ends it, as one undo step.
        assert_eq!(dispatch_on(&e, 1, "clip.release", json!({ "clipId": id, "job": "j0" })).unwrap()["released"], false);
        dispatch_on(&e, 1, "clip.replaceMedia", json!({ "clipId": id, "mediaId": "m2", "job": "j1", "label": "Remove text" })).unwrap();
        assert_eq!((clip()["mediaId"].as_str(), clip().get("busy").is_none()), (Some("m2"), true));
        dispatch_on(&e, 1, "edit.undo", Value::Null).unwrap();
        assert_eq!((clip()["mediaId"].as_str(), clip().get("busy").is_none()), (Some("m1"), true));
        // Cancelled: `clip.release` frees it with no undo step.
        dispatch_on(&e, 1, "clip.busy", json!({ "clipId": id, "job": "j2" })).unwrap();
        let steps = dispatch_on(&e, 1, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len();
        assert_eq!(dispatch_on(&e, 1, "clip.release", json!({ "clipId": id, "job": "j2" })).unwrap()["released"], true);
        assert_eq!(dispatch_on(&e, 1, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len(), steps);
        dispatch_on(&e, 1, "clip.set", json!({ "clipId": id, "scale": 150 })).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sentence_said_again_takes_its_whole_length_and_one_undo_step_with_its_captions() {
        let (e, dir) = engine("reroll");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let sound = |id: &str, secs: i64| Media { id: id.into(), path: format!("line-{id}.wav"), name: format!("line-{id}.wav"), kind: MediaKind::Audio, duration_us: secs * 1_000_000, has_audio: true, ..Default::default() };
        let id = e
            .edit_inner("Import", |p| {
                p.media.extend([sound("m1", 2), sound("m2", 3), sound("m3", 1)]);
                p.insert("m1", 1_000_000)
            })
            .unwrap();
        dispatch(&e, "clip.set", json!({ "clipId": id, "volume": 0.5, "fadeInUs": 100_000 })).unwrap();
        let clip = || e.snapshot()["project"]["tracks"].as_array().unwrap().iter().flat_map(|t| t["clips"].as_array().unwrap().clone()).find(|c| c["id"] == id).unwrap();
        let captions = || e.snapshot()["project"]["tracks"].as_array().unwrap().iter().filter(|t| t["role"] == "captions").flat_map(|t| t["clips"].as_array().unwrap().clone()).map(|c| c["text"]["content"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
        let steps = || dispatch(&e, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len();
        dispatch(&e, "captions.set", json!({ "lines": [{ "startUs": 1_000_000, "endUs": 3_000_000, "text": "old words", "png": "a.png" }], "style": {} })).unwrap();
        let before = steps();

        // A longer take: the whole of it plays, from the same place, with the clip's settings.
        dispatch(&e, "clip.replaceMedia", json!({ "clipId": id, "mediaId": "m2", "whole": true, "gesture": "g1", "label": "Reroll voice" })).unwrap();
        dispatch(&e, "captions.set", json!({ "trackId": e.snapshot()["project"]["tracks"].as_array().unwrap().iter().find(|t| t["role"] == "captions").unwrap()["id"], "lines": [{ "startUs": 1_000_000, "endUs": 4_000_000, "text": "new words", "png": "b.png" }], "style": {}, "gesture": "g1" })).unwrap();
        assert_eq!((clip()["mediaId"].as_str(), clip()["startUs"].as_i64(), clip()["durationUs"].as_i64(), clip()["volume"].as_f64(), clip()["fadeInUs"].as_i64()), (Some("m2"), Some(1_000_000), Some(3_000_000), Some(0.5), Some(100_000)));
        assert_eq!(captions(), ["new words"]);
        assert_eq!(steps(), before + 1, "the swap and its captions are one step");
        dispatch(&e, "edit.undo", Value::Null).unwrap();
        assert_eq!((clip()["mediaId"].as_str(), clip()["durationUs"].as_i64()), (Some("m1"), Some(2_000_000)));
        assert_eq!(captions(), ["old words"]);
        dispatch(&e, "edit.redo", Value::Null).unwrap();

        // A shorter take is shorter; without `whole` a clip keeps its length, at most the file's.
        dispatch(&e, "clip.replaceMedia", json!({ "clipId": id, "mediaId": "m3", "whole": true, "gesture": "g2" })).unwrap();
        assert_eq!(clip()["durationUs"].as_i64(), Some(1_000_000));
        dispatch(&e, "clip.replaceMedia", json!({ "clipId": id, "mediaId": "m2" })).unwrap();
        assert_eq!(clip()["durationUs"].as_i64(), Some(1_000_000));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn contract_v2_methods_over_rpc() {
        let (e, dir) = engine("v2");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        assert_eq!(dispatch(&e, "engine.effects", Value::Null).unwrap().as_array().unwrap().len(), 18);
        assert_eq!(dispatch(&e, "engine.transitions", Value::Null).unwrap()[0], "Dissolve");
        let m = |id: &str, kind| Media { id: id.into(), path: format!("{id}.mp4"), name: format!("{id}.mp4"), kind, duration_us: 4_000_000, width: 1080, height: 1920, fps: 30.0, has_audio: kind != MediaKind::Image, ..Default::default() };
        let (a, b) = e
            .edit_inner("Import", |p| {
                p.media.extend([m("m1", MediaKind::Video), m("m2", MediaKind::Video), m("img", MediaKind::Image), m("vo", MediaKind::Audio)]);
                Ok((p.insert("m1", 0)?, p.insert("m2", 9_000_000)?))
            })
            .unwrap();

        // Text, stickers and adjustment layers each on a track of their own, on top.
        let t = dispatch(&e, "text.add", json!({ "atUs": 0, "text": { "content": "Hi", "png": "x.png" } })).unwrap();
        let st = dispatch(&e, "overlay.add", json!({ "mediaId": "img", "atUs": 500_000, "role": "sticker" })).unwrap();
        let adj = dispatch(&e, "adjust.add", json!({ "atUs": 1_000_000, "durationUs": 2_000_000 })).unwrap();
        let tracks = e.snapshot()["project"]["tracks"].clone();
        let roles: Vec<&str> = tracks.as_array().unwrap().iter().map(|t| t["role"].as_str().unwrap_or("")).collect();
        assert_eq!(roles, ["", "text", "sticker", "adjust"]);
        assert_ne!(t["trackId"], st["trackId"]);
        assert_eq!(tracks[3]["clips"][0]["durationUs"], 2_000_000);
        assert!(dispatch(&e, "overlay.add", json!({ "mediaId": "img", "atUs": 0, "role": "banner" })).is_err());
        dispatch(&e, "text.set", json!({ "clipId": t["clipId"], "text": { "content": "Hello" } })).unwrap();
        let tc = &e.snapshot()["project"]["tracks"][1]["clips"][0];
        assert_eq!((tc["text"]["content"].as_str(), tc["text"]["png"].as_str(), tc["mediaId"].as_str()), (Some("Hello"), Some("x.png"), Some("")));

        // Every new clip field through clip.set, back in camelCase; unknown names refused.
        let set = json!({ "clipId": adj["clipId"], "effects": [{ "name": "Glow", "amount": 40 }], "hsl": { "Red": { "h": 10, "s": 0, "l": 0 } }, "curves": { "master": [[0, 0.1], [1, 1]] }, "wheels": { "gain": { "x": 0.2, "y": 0, "lum": 0 } }, "lut": { "path": "a.cube", "strength": 50 }, "flipV": true, "transformOn": false, "blend": "screen", "anim": { "in": { "name": "Fade", "durationUs": 300000 } } });
        dispatch(&e, "clip.set", set).unwrap();
        let c = e.snapshot()["project"]["tracks"][3]["clips"][0].clone();
        assert_eq!((c["effects"][0]["name"].as_str(), c["hsl"]["Red"]["h"].as_f64(), c["lut"]["strength"].as_f64(), c["flipV"].as_bool(), c["transformOn"].as_bool(), c["anim"]["in"]["name"].as_str()), (Some("Glow"), Some(10.0), Some(50.0), Some(true), Some(false), Some("Fade")));
        let bad = dispatch(&e, "clip.set", json!({ "clipId": adj["clipId"], "effects": [{ "name": "Sparkles", "amount": 40 }] })).unwrap_err();
        assert!(bad.message.contains("Sparkles"), "{}", bad.message);
        dispatch(&e, "clip.set", json!({ "clipId": adj["clipId"], "lut": null })).unwrap();
        assert!(e.snapshot()["project"]["tracks"][3]["clips"][0]["lut"].is_null(), "null takes it off");
        dispatch(&e, "clip.set", json!({ "clipId": a, "speedCurve": { "name": "Ramp", "points": [[0, 1], [1, 3]] }, "keepPitch": false, "stabilize": { "strength": 50 }, "smooth": { "quality": "Best" }, "maskPng": "m.png", "matte": { "path": "mt.mp4" } })).unwrap();
        let c = e.snapshot()["project"]["tracks"][0]["clips"][0].clone();
        assert_eq!((c["speed"].as_f64(), c["keepPitch"].as_bool(), c["stabilize"]["strength"].as_f64(), c["maskPng"].as_str(), c["matte"]["path"].as_str()), (Some(2.0), Some(false), Some(50.0), Some("m.png"), Some("mt.mp4")));
        let h = dispatch(&e, "history.list", Value::Null).unwrap();
        assert_eq!(h["steps"].as_array().unwrap().last().unwrap()["label"], "Speed curve");

        // Transitions.
        dispatch(&e, "transition.set", json!({ "clipId": b, "name": "Circle", "durationUs": 400000 })).unwrap();
        assert_eq!(e.snapshot()["project"]["tracks"][0]["clips"][1]["transition"]["name"], "Circle");
        assert!(dispatch(&e, "transition.set", json!({ "clipId": a, "name": "Circle" })).is_err(), "nothing before the first clip");
        dispatch(&e, "transition.setAll", json!({ "name": null, "durationUs": 0 })).unwrap();
        assert!(e.snapshot()["project"]["tracks"][0]["clips"][1]["transition"].is_null());

        // Captions replace their track's lines.
        let cap = dispatch(&e, "captions.set", json!({ "lines": [{ "startUs": 0, "endUs": 1000000, "text": "one", "png": "1.png" }, { "startUs": 1000000, "endUs": 2000000, "text": "two", "png": "2.png" }], "style": { "font": "Inter", "size": 64 } })).unwrap();
        assert_eq!(cap["clipIds"].as_array().unwrap().len(), 2);
        let again = dispatch(&e, "captions.set", json!({ "trackId": cap["trackId"], "lines": [{ "startUs": 0, "endUs": 500000, "text": "only" }], "style": {} })).unwrap();
        assert_eq!((again["trackId"].clone(), again["clipIds"].as_array().unwrap().len()), (cap["trackId"].clone(), 1));

        // Sound: crossfade and spectral delete.
        let (v1, v2) = e.edit_inner("Add", |p| Ok((p.insert("vo", 0)?, p.insert("vo", 6_000_000)?))).unwrap();
        dispatch(&e, "audio.crossfade", json!({ "clipIds": [v1, v2], "durationUs": 1000000 })).unwrap();
        let p = e.project().unwrap().0;
        assert_eq!((p.clip(&v2).unwrap().start_us, p.find_clip(&v1).unwrap().0), (3_000_000, p.find_clip(&v2).unwrap().0));
        dispatch(&e, "audio.spectralDelete", json!({ "clipId": v1, "startUs": 500000, "endUs": 1500000, "lowHz": 200, "highHz": 900 })).unwrap();
        assert_eq!(e.project().unwrap().0.clip(&v1).unwrap().spectral.len(), 1);

        // Tracks hide; the summary reads it all; the brand kit saves.
        let tid = t["trackId"].as_str().unwrap().to_string();
        dispatch(&e, "track.set", json!({ "trackId": tid, "hidden": true })).unwrap();
        assert_eq!(dispatch(&e, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().last().unwrap()["label"], "Hide track");
        let text = dispatch(&e, "project.summary", Value::Null).unwrap()["text"].as_str().unwrap().to_string();
        assert!(text.contains("text \"Hello\"") && text.contains("Captions track") && text.contains("hidden") && text.contains("speed ramp \"Ramp\""), "{text}");
        dispatch(&e, "project.setOptions", json!({ "brand": { "colors": ["#E8C050"], "fonts": ["Inter"] }, "mcp": { "allowed": "look" } })).unwrap();
        let p = e.snapshot()["project"].clone();
        assert_eq!((p["brand"]["fonts"][0].as_str(), p["mcp"]["allowed"].as_str(), p["mcp"]["askBeforeExport"].as_bool()), (Some("Inter"), Some("look"), Some(true)));
        // Renamed from the title bar: saved in project.json, no undo step; a blank name is ignored.
        let steps = dispatch(&e, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len();
        dispatch(&e, "project.setOptions", json!({ "name": "  Spring promo  " })).unwrap();
        dispatch(&e, "project.setOptions", json!({ "name": "   " })).unwrap();
        assert_eq!(e.snapshot()["project"]["name"], "Spring promo");
        assert_eq!(dispatch(&e, "history.list", Value::Null).unwrap()["steps"].as_array().unwrap().len(), steps);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(e.snapshot()["dir"].as_str().unwrap().to_string() + "/project.json").unwrap()).unwrap();
        assert_eq!(saved["name"], "Spring promo");
        dispatch(&e, "edit.undo", Value::Null).unwrap();
        assert_eq!(e.snapshot()["project"]["name"], "Spring promo", "undo keeps the name");
        assert_eq!(e.snapshot()["project"]["mcp"]["allowed"], "look", "and what MCP clients may do");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The timeline's drags between rows: `newTrackAt` makes a track at that index, for a clip
    /// moved there or a text clip dragged in from the library. Each is one undo step.
    #[test]
    fn moves_and_new_text_can_make_a_track_between_rows() {
        let (e, dir) = engine("rows");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let a = dispatch(&e, "text.add", json!({ "atUs": 0, "text": { "content": "A", "png": "a.png" } })).unwrap();
        let b = dispatch(&e, "text.add", json!({ "atUs": 0, "text": { "content": "B", "png": "b.png" } })).unwrap();
        let ids = || e.snapshot()["project"]["tracks"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        // Between A's row and B's: a new text track at index 2, holding the new clip at 1 s.
        let c = dispatch(&e, "text.add", json!({ "atUs": 1_000_000, "newTrackAt": 2, "text": { "content": "C", "png": "c.png" } })).unwrap();
        assert_eq!(ids(), [ids()[0].clone(), a["trackId"].as_str().unwrap().into(), c["trackId"].as_str().unwrap().into(), b["trackId"].as_str().unwrap().into()]);
        let tracks = e.snapshot()["project"]["tracks"].clone();
        assert_eq!((tracks[2]["role"].as_str(), tracks[2]["clips"][0]["startUs"].as_i64()), (Some("text"), Some(1_000_000)));
        // B moved to a new track under A's (just above the main track); B's old track goes.
        let r = dispatch(&e, "timeline.move", json!({ "clipId": b["clipId"], "startUs": 500_000, "newTrackAt": 1 })).unwrap();
        assert_eq!(ids().len(), 4);
        assert_eq!((ids()[1].as_str(), e.snapshot()["project"]["tracks"][1]["clips"][0]["id"].clone()), (r["trackId"].as_str().unwrap(), b["clipId"].clone()));
        dispatch(&e, "edit.undo", Value::Null).unwrap();
        assert_eq!(e.snapshot()["project"]["tracks"][3]["id"], b["trackId"], "undone in one step");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// preview.hide: the paused frame in the ring leaves the text out (its ticket says when),
    /// export's still keeps it, showing it again puts it back, and play clears the list.
    /// Skipped without FFmpeg.
    #[test]
    fn hidden_text_leaves_the_paused_frame_only() {
        let dir = std::env::temp_dir().join(format!("studio-rpc-test-{}-hide", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let e = Engine::new(&dir.join("ring"), 1080, 1920, dir.join("projects")).unwrap();
        let Ok(m) = e.services() else { return };
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let ff = |args: &[&str], out: &Path| assert!(m.ff.cmd().args(["-hide_banner", "-loglevel", "error"]).args(args).arg("-y").arg(out).status().unwrap().success());
        let red = dir.join("red.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=red:s=108x192:r=30:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], &red);
        // A text drawing: see-through, with a white block in the middle.
        let png = dir.join("text.png");
        ff(&["-f", "lavfi", "-i", "color=c=black@0:s=1080x1920,format=rgba,drawbox=x=340:y=760:w=400:h=400:color=white:t=fill:replace=1", "-frames:v", "1"], &png);
        let media = dispatch(&e, "media.import", json!({ "paths": [red.to_string_lossy()] })).unwrap()["imported"][0].as_str().unwrap().to_string();
        dispatch(&e, "timeline.insert", json!({ "mediaId": media })).unwrap();
        let text = dispatch(&e, "text.add", json!({ "atUs": 0, "durationUs": 2_000_000, "text": { "content": "Hi", "png": png.to_string_lossy() } })).unwrap();
        let mut events = e.events.subscribe();
        let ring = studio_engine_core::ring::RingReader::open(&dir.join("ring")).unwrap();
        // The frame with `ticket` (or a later one), and its centre pixel.
        let mut shown = |ticket: u64| -> [u8; 3] {
            let t0 = Instant::now();
            loop {
                match events.try_recv() {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        if v["method"] == "preview.shown" && v["params"]["ticket"].as_u64().unwrap() >= ticket {
                            break;
                        }
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
                assert!(t0.elapsed() < Duration::from_secs(20), "no frame with ticket {ticket}");
            }
            let mut buf = vec![0u8; ring.slot_bytes()];
            let f = ring.read_latest(&mut buf, 0).unwrap();
            let o = (f.height / 2 * f.stride + f.width / 2 * 4) as usize;
            [buf[o], buf[o + 1], buf[o + 2]]
        };
        let white = |px: [u8; 3]| px.iter().all(|&c| c > 220);
        let red_px = |px: [u8; 3]| px[0] > 200 && px[1] < 60 && px[2] < 60;
        let hide = |v: Value| dispatch(&e, "preview.hide", v).unwrap()["ticket"].as_u64();

        // Shown with the text first.
        dispatch(&e, "playback.seek", json!({ "positionUs": 1_000_000 })).unwrap();
        let all = hide(json!({})).expect("paused: a frame");
        let px = shown(all);
        assert!(white(px), "the text is drawn: {px:?}");
        // Hidden by id, then by track: the video shows through.
        let t = hide(json!({ "clipIds": [text["clipId"]] })).unwrap();
        assert!(red_px(shown(t)), "the clip is left out");
        assert_eq!(m.playback.hidden().clips, [text["clipId"].as_str().unwrap()]);
        let still = dispatch(&e, "preview.frame", json!({ "atUs": 1_000_000, "width": 270 })).unwrap();
        let out = m.ff.cmd().args(["-hide_banner", "-loglevel", "error", "-i", still["path"].as_str().unwrap(), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).output().unwrap();
        let o = (240 * 270 + 135) * 3;
        assert!(white([out.stdout[o], out.stdout[o + 1], out.stdout[o + 2]]), "export's frames keep it");
        // An edit while hidden draws the frame again, still without it.
        dispatch(&e, "clip.set", json!({ "clipId": text["clipId"], "opacity": 90 })).unwrap();
        let t = hide(json!({ "trackIds": [text["trackId"]] })).unwrap();
        assert!(red_px(shown(t)), "the track is left out");
        let t = hide(json!({ "clipIds": [] })).unwrap();
        assert!(!red_px(shown(t)), "shown again");
        // Play clears the list; playing, nothing can be hidden.
        hide(json!({ "clipIds": [text["clipId"]] })).unwrap();
        dispatch(&e, "playback.play", json!({ "fromUs": 0 })).unwrap();
        assert!(m.playback.hidden().is_empty());
        let t0 = Instant::now();
        while !m.playback.is_playing() && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(hide(json!({ "clipIds": [text["clipId"]] })), None);
        assert!(m.playback.hidden().is_empty());
        dispatch(&e, "playback.pause", Value::Null).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// preview.frame renders the composite (here under an adjustment layer and a text clip) to
    /// a PNG, and audio.samples hands back a sine's own samples. Skipped without FFmpeg.
    #[test]
    fn preview_frames_and_raw_samples_on_real_files() {
        // A ring big enough for the preview frames the edits draw.
        let dir = std::env::temp_dir().join(format!("studio-rpc-test-{}-frame", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let e = Engine::new(&dir.join("ring"), 1080, 1920, dir.join("projects")).unwrap();
        let Ok(m) = e.services() else { return };
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let red = dir.join("red.mov");
        let ok = m.ff.cmd().args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=108x192:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100:duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-y"]).arg(&red).status().unwrap();
        assert!(ok.success());
        let imported = dispatch(&e, "media.import", json!({ "paths": [red.to_string_lossy()] })).unwrap();
        let media = imported["imported"][0].as_str().unwrap().to_string();
        dispatch(&e, "timeline.insert", json!({ "mediaId": media })).unwrap();
        let pixel = |path: &str, x: f64, y: f64| -> [u8; 3] {
            let out = m.ff.cmd().args(["-hide_banner", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).output().unwrap();
            let (w, h) = (270usize, 480usize);
            let o = ((y * h as f64) as usize * w + (x * w as f64) as usize) * 3;
            [out.stdout[o], out.stdout[o + 1], out.stdout[o + 2]]
        };
        let plain = dispatch(&e, "preview.frame", json!({ "atUs": 1_000_000, "width": 270 })).unwrap();
        let px = pixel(plain["path"].as_str().unwrap(), 0.5, 0.5);
        assert!(px[0] > 200 && px[1] < 40, "red: {px:?}");
        let adj = dispatch(&e, "adjust.add", json!({ "atUs": 0, "durationUs": 2_000_000 })).unwrap();
        dispatch(&e, "clip.set", json!({ "clipId": adj["clipId"], "saturation": -100 })).unwrap();
        let grey = dispatch(&e, "preview.frame", json!({ "atUs": 1_000_000, "width": 270 })).unwrap();
        let px = pixel(grey["path"].as_str().unwrap(), 0.5, 0.5);
        assert!((px[0] as i32 - px[1] as i32).abs() < 20 && (px[1] as i32 - px[2] as i32).abs() < 20, "grey under the adjustment layer: {px:?}");
        // Nothing there: a black frame, not an error.
        let empty = dispatch(&e, "preview.frame", json!({ "atUs": 9_000_000, "width": 270 })).unwrap();
        assert!(Path::new(empty["path"].as_str().unwrap()).is_file());

        // Raw samples: 10 ms of a 1 kHz sine at the file's own 44.1 kHz is 441 samples, 10 cycles.
        let s = dispatch(&e, "audio.samples", json!({ "mediaId": media, "startUs": 500_000, "endUs": 510_000 })).unwrap();
        assert_eq!((s["rate"].as_u64(), s["startUs"].as_i64()), (Some(44_100), Some(500_000)));
        let n = s["count"].as_u64().unwrap() as usize;
        assert!((440..=442).contains(&n), "{n}");
        let raw = s["data"].as_str().unwrap();
        assert_eq!(raw.len(), (n * 4).div_ceil(3) * 4, "base64 of {n} floats");
        let wave: Vec<f32> = crate::audio::samples(&m.ff, &red, 500_000, 10_000).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let crossings = wave.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!((19..=21).contains(&crossings), "10 cycles of 1 kHz in 10 ms: {crossings} crossings");
        assert!(dispatch(&e, "audio.samples", json!({ "mediaId": media, "startUs": 0, "endUs": 2_500_000 })).is_err(), "no more than 2 s");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mcp_clients_are_counted_tagged_and_asked_through_the_app() {
        let (e, dir) = engine("mcp");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        e.connect(1);
        e.connect(2);
        assert_eq!(dispatch_on(&e, 2, "mcp.hello", json!({ "name": "Claude" })).unwrap()["clients"], 1);
        let s = dispatch(&e, "mcp.status", Value::Null).unwrap();
        assert!(s["lastSeen"].as_u64().is_some() && s["names"][0] == "Claude");
        // Edits carry the client's actor into the history.
        dispatch_on(&e, 2, "project.setFormat", json!({ "aspect": "4:5", "_actor": "claude" })).unwrap();
        let h = dispatch(&e, "history.list", Value::Null).unwrap();
        assert_eq!(h["steps"][0]["actor"], "claude");
        dispatch_on(&e, 2, "edit.undo", json!({ "_actor": "claude" })).unwrap();
        let log = std::fs::read_to_string(e.doc.lock().unwrap().as_ref().unwrap().dir.join("history.jsonl")).unwrap();
        assert!(log.lines().last().unwrap().contains("\"actor\":\"claude\""), "{log}");
        // A client can't change its own permissions.
        assert!(dispatch_on(&e, 2, "project.setOptions", json!({ "mcp": { "allowed": "all" }, "_actor": "claude" })).is_err());
        // Approvals: the app answers; with no window, it's no.
        let ask = std::thread::scope(|sc| {
            let waiting = sc.spawn(|| dispatch_on(&e, 2, "approval.request", json!({ "what": "Export", "detail": "9:16" })).unwrap());
            let id = loop {
                if let Some(id) = e.approvals.lock().unwrap().keys().next().cloned() {
                    break id;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            dispatch_on(&e, 1, "approval.answer", json!({ "id": id, "ok": true })).unwrap();
            waiting.join().unwrap()
        });
        assert_eq!(ask, json!({ "ok": true }));
        assert!(dispatch(&e, "approval.answer", json!({ "id": "ap99", "ok": true })).is_err());
        e.disconnect(1);
        assert_eq!(dispatch_on(&e, 2, "approval.request", json!({ "what": "Export" })).unwrap(), json!({ "ok": false, "reason": "no window open" }));
        dispatch_on(&e, 2, "mcp.bye", Value::Null).unwrap();
        assert_eq!(dispatch(&e, "mcp.status", Value::Null).unwrap()["clients"], 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn track_mix_effects_master_and_labels_are_undoable_edits() {
        let (e, dir) = engine("mix");
        dispatch(&e, "project.openLatest", Value::Null).unwrap();
        let main = e.snapshot()["project"]["tracks"][0]["id"].as_str().unwrap().to_string();
        dispatch(&e, "track.set", json!({ "trackId": main, "gainDb": -6.5, "pan": 0.25, "mute": true })).unwrap();
        dispatch(&e, "track.set", json!({ "trackId": main, "effects": { "comp": { "on": true, "ratio": 4 } } })).unwrap();
        let t = e.snapshot()["project"]["tracks"][0].clone();
        assert_eq!((t["gainDb"].as_f64(), t["pan"].as_f64(), t["mute"].as_bool()), (Some(-6.5), Some(0.25), Some(true)));
        assert_eq!((t["effects"]["comp"]["on"].as_bool(), t["effects"]["comp"]["ratio"].as_f64(), t["effects"]["comp"]["thresholdDb"].as_f64()), (Some(true), Some(4.0), Some(-18.0)), "one setting changes, the rest stay");
        dispatch(&e, "edit.undo", Value::Null).unwrap();
        assert_eq!(e.snapshot()["project"]["tracks"][0]["effects"]["comp"]["on"], false);
        assert_eq!(dispatch(&e, "track.set", json!({ "trackId": "nope", "mute": true })).unwrap_err().code, RpcError::INVALID_PARAMS);

        dispatch(&e, "track.set", json!({ "trackId": main, "locked": true })).unwrap();
        assert_eq!(e.snapshot()["project"]["tracks"][0]["locked"], true);
        dispatch(&e, "project.setOptions", json!({ "coverUs": 5_000_000 })).unwrap();
        assert_eq!(e.snapshot()["project"]["coverUs"], 0, "the cover stays inside the (empty) timeline");

        let master = dispatch(&e, "project.setMaster", json!({ "normalize": false, "ceilingDb": -2 })).unwrap();
        assert_eq!((master["normalize"].as_bool(), master["limiter"].as_bool(), master["ceilingDb"].as_f64()), (Some(false), Some(true), Some(-2.0)));

        let ids = dispatch(&e, "labels.add", json!({ "items": [{ "startUs": 0, "endUs": 1_000_000, "text": "Hook" }] })).unwrap();
        let id = ids[0].as_str().unwrap().to_string();
        dispatch(&e, "labels.set", json!({ "labelId": id, "text": "Offer" })).unwrap();
        assert_eq!(e.snapshot()["project"]["labels"][0]["text"], "Offer");
        dispatch(&e, "labels.delete", json!({ "labelIds": [id] })).unwrap();
        assert!(e.snapshot()["project"].get("labels").is_none());

        if e.services().is_ok() {
            let s = dispatch(&e, "playback.setLoop", json!({ "startUs": 2_000_000, "endUs": 1_000_000 })).unwrap();
            assert_eq!((s["loop"]["startUs"].as_i64(), s["loop"]["endUs"].as_i64()), (Some(1_000_000), Some(2_000_000)));
            let s = dispatch(&e, "playback.setLoop", json!({})).unwrap();
            assert!(s["loop"].is_null());
            assert!(dispatch(&e, "audio.normalize", json!({ "clipIds": [] })).is_err(), "no clip, nothing to measure");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
