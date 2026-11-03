//! The open project: its folder on disk, undo/redo, autosave and the history log.
//!
//! A project is a `<Name>.studio` folder holding `project.json`, `history.jsonl`
//! (every edit, with who made it) and `cache/` (proxies, thumbnails, waveforms).

use serde_json::{Value, json};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use studio_engine_core::model::{EditError, Project};

const UNDO_LIMIT: usize = 200;

pub struct Doc {
    pub project: Project,
    pub dir: PathBuf,
    /// Goes up on every change, including background ones (a new thumbnail).
    pub revision: u64,
    /// Goes up only on edits, undo and redo: what playback and the sound mix depend on.
    pub edits: u64,
    /// Background changes not yet written to disk (see `flush`).
    dirty: bool,
    /// The project before each undoable step, with the step's history record.
    undo: Vec<(Project, Step)>,
    redo: Vec<(Project, Step)>,
    /// Who undo, redo and history jumps are logged as ("you", or an MCP client's name).
    pub actor: String,
    /// The merge key of the last step, while edits with the same key may still join it.
    merge: Option<String>,
}

/// One edit as `history.jsonl` records it.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub time: String,
    pub actor: String,
    pub label: String,
    pub revision: u64,
}

fn unique_dir(parent: &Path, name: &str) -> PathBuf {
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c }).collect();
    let clean = clean.trim();
    let clean = if clean.is_empty() { "Untitled" } else { clean };
    let mut n = 1;
    loop {
        let candidate = parent.join(if n == 1 { format!("{clean}.studio") } else { format!("{clean} {n}.studio") });
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

impl Doc {
    pub fn create(projects_dir: &Path, name: &str, aspect: &str) -> io::Result<Self> {
        let dir = unique_dir(projects_dir, name);
        fs::create_dir_all(dir.join("cache"))?;
        let stem = dir.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.into());
        let mut project = Project::new(&stem, aspect);
        project.cache_dir = Some(dir.join("cache").to_string_lossy().into_owned());
        let mut doc = Self { project, dir, revision: 1, edits: 1, dirty: false, undo: vec![], redo: vec![], actor: "you".into(), merge: None };
        doc.save()?;
        Ok(doc)
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
        let text = fs::read_to_string(dir.join("project.json"))?;
        let mut project: Project = serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::create_dir_all(dir.join("cache"))?;
        project.cache_dir = Some(dir.join("cache").to_string_lossy().into_owned());
        Ok(Self { project, dir, revision: 1, edits: 1, dirty: false, undo: vec![], redo: vec![], actor: "you".into(), merge: None })
    }

    /// The most recently saved project in `projects_dir`, if any.
    pub fn open_latest(projects_dir: &Path) -> Option<Self> {
        let newest = fs::read_dir(projects_dir)
            .ok()?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "studio"))
            .filter_map(|e| Some((e.path().join("project.json").metadata().ok()?.modified().ok()?, e.path())))
            .max_by_key(|(t, _)| *t)?;
        Self::open(&newest.1).ok()
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.dir.join("cache")
    }

    pub fn save(&mut self) -> io::Result<()> {
        self.dirty = false;
        let tmp = self.dir.join("project.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&self.project)?)?;
        fs::rename(tmp, self.dir.join("project.json"))
    }

    fn log(&self, actor: &str, label: &str) -> Step {
        let step = Step { time: chrono_now(), actor: actor.into(), label: label.into(), revision: self.revision };
        let line = json!({ "time": step.time, "actor": actor, "edit": label, "revision": self.revision });
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(self.dir.join("history.jsonl")) {
            let _ = writeln!(f, "{line}");
        }
        step
    }

    /// Runs one undoable edit. On error the project is left untouched; an edit that changes
    /// nothing (a value already set) leaves no undo step and no history line.
    pub fn edit<T>(&mut self, actor: &str, label: &str, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<T, EditError> {
        self.edit_merging(actor, label, None, f)
    }

    /// `edit`, where edits with the same `merge` key one after another (a slider dragged, words
    /// typed, sent a few times a second) are one undo step: undo goes back to before the first.
    /// No edit may change a busy clip, whoever sends it (see `Project::busy_kept`).
    pub fn edit_merging<T>(&mut self, actor: &str, label: &str, merge: Option<&str>, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<T, EditError> {
        let before = self.project.clone();
        match f(&mut self.project).and_then(|v| self.project.busy_kept(&before).map(|()| v)) {
            Ok(v) if self.project == before => Ok(v),
            Ok(v) => {
                self.redo.clear();
                self.revision += 1;
                self.edits += 1;
                let _ = self.save();
                let joins = merge.is_some() && self.merge.as_deref() == merge && !self.undo.is_empty();
                if !joins {
                    let step = self.log(actor, label);
                    self.undo.push((before, step));
                    if self.undo.len() > UNDO_LIMIT {
                        self.undo.remove(0);
                    }
                }
                self.merge = merge.map(str::to_string);
                Ok(v)
            }
            Err(e) => {
                self.project = before;
                Err(e)
            }
        }
    }

    /// Changes that are not edits (derived files appearing): no undo step.
    pub fn quiet_update(&mut self, f: impl FnOnce(&mut Project)) {
        f(&mut self.project);
        self.revision += 1;
        self.dirty = true;
    }

    /// Writes background changes, if any. Called a few times a second, so hundreds of
    /// thumbnails arriving don't mean hundreds of saves.
    pub fn flush(&mut self) {
        if self.dirty {
            let _ = self.save();
        }
    }

    /// Keeps cached derived files when stepping through history, and the busy marks as they
    /// are now: they aren't part of the history (a clip whose job finished never goes busy
    /// again, one still busy stays so).
    fn carry_media(&self, mut target: Project) -> Project {
        for m in &mut target.media {
            if let Some(cur) = self.project.media(&m.id) {
                m.proxy = cur.proxy.clone();
                m.poster = cur.poster.clone();
                m.strip = cur.strip.clone();
                m.peaks = cur.peaks.clone();
                m.missing = cur.missing;
            }
        }
        let busy: Vec<(&str, &String)> = self.project.tracks.iter().flat_map(|t| &t.clips).filter_map(|c| Some((c.id.as_str(), c.busy.as_ref()?))).collect();
        for c in target.tracks.iter_mut().flat_map(|t| &mut t.clips) {
            c.busy = busy.iter().find(|(id, _)| *id == c.id).map(|(_, j)| (*j).clone());
        }
        target
    }

    /// Why undo (or redo) can't go now, if it can't: the step would change or remove a busy clip.
    pub fn blocked(&self, redo: bool) -> Option<String> {
        if !self.project.tracks.iter().flat_map(|t| &t.clips).any(|c| c.busy.is_some()) {
            return None;
        }
        let (target, _) = if redo { self.redo.last()? } else { self.undo.last()? };
        self.carry_media(target.clone()).busy_kept(&self.project).err().map(|e| e.0)
    }

    /// Marks a clip busy with outside work (`job`), or clears the mark. Not an edit: no undo
    /// step, and saved at once, so the mark is there if the app closes before the job ends.
    pub fn set_busy(&mut self, clip_id: &str, job: Option<&str>) -> Result<(), EditError> {
        self.project.set_busy(clip_id, job)?;
        self.revision += 1;
        let _ = self.save();
        Ok(())
    }

    /// Ends `job` on a busy clip and runs the edit that brings its result in (one undo step,
    /// which takes the result out again but never makes the clip busy again).
    pub fn release<T>(&mut self, actor: &str, label: &str, clip_id: &str, job: &str, f: impl FnOnce(&mut Project) -> Result<T, EditError>) -> Result<T, EditError> {
        if self.project.clip(clip_id).and_then(|c| c.busy.as_deref()) != Some(job) {
            return Err(EditError(format!("Clip {clip_id} isn't waiting for that job")));
        }
        self.set_busy(clip_id, None)?;
        self.edit(actor, label, f)
    }

    /// Undoes the last step, unless it would change a busy clip (`blocked` says why).
    pub fn undo(&mut self) -> bool {
        self.merge = None;
        if self.blocked(false).is_some() {
            return false;
        }
        let Some((prev, step)) = self.undo.pop() else { return false };
        let prev = self.carry_media(prev);
        self.redo.push((std::mem::replace(&mut self.project, prev), step));
        self.revision += 1;
        self.edits += 1;
        let _ = self.save();
        self.log(&self.actor.clone(), "Undo");
        true
    }

    pub fn redo(&mut self) -> bool {
        self.merge = None;
        if self.blocked(true).is_some() {
            return false;
        }
        let Some((next, step)) = self.redo.pop() else { return false };
        let next = self.carry_media(next);
        self.undo.push((std::mem::replace(&mut self.project, next), step));
        self.revision += 1;
        self.edits += 1;
        let _ = self.save();
        self.log(&self.actor.clone(), "Redo");
        true
    }

    /// The undoable steps of this session, oldest first: the ones done, then the ones undone
    /// (which redo brings back, next first). `current` is the index of the last step done,
    /// −1 when every step is undone.
    pub fn history(&self) -> Value {
        let steps: Vec<Value> = self
            .undo
            .iter()
            .map(|(_, s)| s)
            .chain(self.redo.iter().rev().map(|(_, s)| s))
            .enumerate()
            .map(|(index, s)| json!({ "index": index, "label": s.label, "actor": s.actor, "time": s.time, "revision": s.revision }))
            .collect();
        json!({ "steps": steps, "current": self.undo.len() as i64 - 1 })
    }

    /// Undoes or redoes until step `index` is the last one done (−1 undoes them all).
    /// Returns how many steps it moved.
    pub fn goto(&mut self, index: i64) -> usize {
        let mut moved = 0;
        while (self.undo.len() as i64 - 1) > index && self.undo() {
            moved += 1;
        }
        while (self.undo.len() as i64 - 1) < index && self.redo() {
            moved += 1;
        }
        moved
    }

    pub fn snapshot(&self, processing: &[String]) -> Value {
        json!({
            "revision": self.revision,
            "dir": self.dir.to_string_lossy(),
            "canUndo": !self.undo.is_empty(),
            "canRedo": !self.redo.is_empty(),
            "durationUs": self.project.duration_us(),
            "processing": processing,
            "project": self.project,
        })
    }
}

/// ISO-ish UTC timestamp without pulling in a date crate.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::model::{ClipChange, Media, MediaKind, SECOND};

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("studio-doc-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn media() -> Media {
        Media { id: "m1".into(), path: "x.mp4".into(), name: "x".into(), kind: MediaKind::Video, duration_us: 2_000_000, width: 1080, height: 1920, fps: 30.0, has_audio: true, ..Default::default() }
    }

    #[test]
    fn edits_save_undo_and_redo() {
        let root = temp_dir("undo");
        let mut doc = Doc::create(&root, "Ad: test/1", "9:16").unwrap();
        assert!(doc.dir.ends_with("Ad- test-1.studio"));
        doc.edit("you", "Import", |p| {
            p.media.push(media());
            Ok(())
        })
        .unwrap();
        doc.edit("you", "Insert", |p| p.insert("m1", 0)).unwrap();
        assert_eq!(doc.project.main_track().clips.len(), 1);
        assert!(doc.edit("you", "Bad", |p| p.split(0, &[])).is_err());
        assert_eq!(doc.project.main_track().clips.len(), 1, "failed edit leaves the project alone");

        doc.quiet_update(|p| p.media[0].proxy = Some("proxy.mp4".into()));
        assert!(doc.undo());
        assert!(doc.project.main_track().clips.is_empty());
        assert_eq!(doc.project.media[0].proxy.as_deref(), Some("proxy.mp4"), "undo keeps cached files");
        assert!(doc.redo());
        assert_eq!(doc.project.main_track().clips.len(), 1);

        let reopened = Doc::open(&doc.dir).unwrap();
        assert_eq!(reopened.project, doc.project);
        let latest = Doc::open_latest(&root).unwrap();
        assert_eq!(latest.dir, doc.dir);
        let history = fs::read_to_string(doc.dir.join("history.jsonl")).unwrap();
        assert_eq!(history.lines().count(), 4, "{history}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_edit_that_changes_nothing_leaves_no_step() {
        let root = temp_dir("noop");
        let mut doc = Doc::create(&root, "Noop", "9:16").unwrap();
        doc.edit("you", "Import", |p| {
            p.media.push(media());
            Ok(())
        })
        .unwrap();
        let clip = doc.edit("you", "Insert", |p| p.insert("m1", 0)).unwrap();
        let (revision, edits) = (doc.revision, doc.edits);
        doc.edit("you", "Clip settings", |p| p.set_clip(&clip, ClipChange { scale: Some(100.0), speed: Some(1.0), ..Default::default() })).unwrap();
        assert_eq!((doc.revision, doc.edits, doc.undo.len()), (revision, edits, 2), "the values were already set");
        assert_eq!(fs::read_to_string(doc.dir.join("history.jsonl")).unwrap().lines().count(), 2);
        doc.edit("you", "Clip settings", |p| p.set_clip(&clip, ClipChange { scale: Some(110.0), ..Default::default() })).unwrap();
        assert_eq!(doc.undo.len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn history_lists_the_steps_and_goes_to_any_of_them() {
        let root = temp_dir("history");
        let mut doc = Doc::create(&root, "History", "9:16").unwrap();
        doc.edit("you", "Import", |p| {
            p.media.push(media());
            Ok(())
        })
        .unwrap();
        doc.edit("you", "Add to timeline", |p| p.insert("m1", 0)).unwrap();
        doc.edit("mcp", "Format 4:5", |p| p.set_format("4:5")).unwrap();
        let h = doc.history();
        let labels: Vec<&str> = h["steps"].as_array().unwrap().iter().map(|s| s["label"].as_str().unwrap()).collect();
        assert_eq!((labels, h["current"].as_i64()), (vec!["Import", "Add to timeline", "Format 4:5"], Some(2)));
        let last = &h["steps"][2];
        assert_eq!((last["index"].as_u64(), last["actor"].as_str(), last["revision"].as_u64()), (Some(2), Some("mcp"), Some(doc.revision)));
        assert!(last["time"].as_str().unwrap().ends_with('Z'));

        assert_eq!(doc.goto(0), 2);
        assert_eq!((doc.history()["current"].as_i64(), doc.history()["steps"].as_array().unwrap().len()), (Some(0), 3), "undone steps stay listed for redo");
        assert!(doc.project.main_track().clips.is_empty() && doc.project.height == 1920);
        assert_eq!(doc.goto(2), 2);
        assert_eq!((doc.project.main_track().clips.len(), doc.project.height), (1, 1350));
        assert_eq!(doc.goto(-1), 3);
        assert!(doc.project.media.is_empty());
        assert_eq!((doc.goto(9), doc.history()["current"].as_i64()), (3, Some(2)), "past the end stops at the last step");
        doc.goto(0);
        doc.edit("you", "Format 1:1", |p| p.set_format("1:1")).unwrap();
        assert_eq!(doc.history()["steps"].as_array().unwrap().len(), 2, "a new edit drops the undone steps");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn edits_with_the_same_merge_key_are_one_step() {
        let root = temp_dir("merge");
        let mut doc = Doc::create(&root, "Merge", "9:16").unwrap();
        doc.edit("you", "Import", |p| {
            p.media.push(media());
            Ok(())
        })
        .unwrap();
        let clip = doc.edit("you", "Insert", |p| p.insert("m1", 0)).unwrap();
        let scale = |doc: &mut Doc, v: f32, key: Option<&str>| doc.edit_merging("you", "Scale", key, |p| p.set_clip(&clip, ClipChange { scale: Some(v), ..Default::default() })).unwrap();
        for v in [110.0, 120.0, 130.0] {
            scale(&mut doc, v, Some("drag 1"));
        }
        assert_eq!((doc.undo.len(), doc.project.main_track().clips[0].scale), (3, 130.0), "one step for the drag");
        // Another gesture, or any other edit in between, starts a step of its own.
        scale(&mut doc, 140.0, Some("drag 2"));
        doc.edit("you", "Mirror", |p| p.set_clip(&clip, ClipChange { flip: Some(true), ..Default::default() })).unwrap();
        scale(&mut doc, 150.0, Some("drag 2"));
        assert_eq!(doc.undo.len(), 6);
        assert!(doc.undo() && doc.undo() && doc.undo());
        assert_eq!(doc.project.main_track().clips[0].scale, 130.0);
        // Undo ends a gesture too: the same key after it is a new step, and undoing it goes back one.
        scale(&mut doc, 160.0, Some("drag 1"));
        assert!(doc.undo());
        assert_eq!(doc.project.main_track().clips[0].scale, 130.0);
        assert!(doc.undo());
        assert_eq!(doc.project.main_track().clips[0].scale, 100.0, "the whole first drag in one undo");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_busy_clip_is_kept_from_edits_and_history_and_saved() {
        let root = temp_dir("busy");
        let mut doc = Doc::create(&root, "Busy", "9:16").unwrap();
        doc.edit("you", "Import", |p| {
            p.media.push(media());
            p.media.push(Media { id: "m2".into(), path: "clean.mp4".into(), name: "clean".into(), ..media() });
            Ok(())
        })
        .unwrap();
        let clip = doc.edit("you", "Insert", |p| p.insert("m1", 0)).unwrap();
        doc.edit("you", "Brighter", |p| p.set_clip(&clip, ClipChange { brightness: Some(20.0), ..Default::default() })).unwrap();
        let (steps, edits) = (doc.undo.len(), doc.edits);
        doc.set_busy(&clip, Some("j1")).unwrap();
        assert_eq!((doc.undo.len(), doc.edits), (steps, edits), "not an undo step, nor an edit");
        assert_eq!(Doc::open(&doc.dir).unwrap().project.clip(&clip).unwrap().busy.as_deref(), Some("j1"), "saved at once");

        // Every kind of edit, whoever sends it, leaves it alone.
        let busy = "Text is still being removed from x. Wait for it, or cancel it from the clip's right-click menu";
        let refused = |doc: &mut Doc, f: &dyn Fn(&mut Project) -> Result<(), EditError>| doc.edit("mcp", "Edit", |p| f(p)).unwrap_err().0;
        assert_eq!(refused(&mut doc, &|p| p.set_clip(&clip, ClipChange { scale: Some(150.0), ..Default::default() })), busy);
        assert_eq!(refused(&mut doc, &|p| p.move_clip(&clip, SECOND, None)), busy);
        assert_eq!(refused(&mut doc, &|p| p.delete(std::slice::from_ref(&clip))), busy);
        assert_eq!(refused(&mut doc, &|p| p.remove_media(&["m1".into()]).map(|_| ())), busy);
        assert_eq!(refused(&mut doc, &|p| p.replace_media(&clip, "m2")), busy);
        assert_eq!(doc.project.clip(&clip).unwrap().scale, 100.0, "refused edits change nothing");
        // Undo would take the brightness back: refused too, and redo after an edit elsewhere.
        assert!(doc.blocked(false).unwrap().starts_with("Text is still being removed"));
        assert!(!doc.undo());
        assert_eq!(doc.project.clip(&clip).unwrap().brightness, 20.0);
        doc.edit("you", "Format 4:5", |p| p.set_format("4:5")).unwrap();
        assert!(doc.undo(), "undoing an edit that left the clip alone is fine");
        assert!(doc.redo());
        assert_eq!(doc.project.clip(&clip).unwrap().busy.as_deref(), Some("j1"), "undo and redo keep the mark");

        // Its job ends: the result comes in as one undo step, which never brings the mark back.
        assert!(doc.release("you", "Remove text", &clip, "j2", |p| p.replace_media(&clip, "m2")).is_err(), "only its own job");
        doc.release("you", "Remove text", &clip, "j1", |p| p.replace_media(&clip, "m2")).unwrap();
        assert_eq!((doc.project.clip(&clip).unwrap().media_id.as_str(), doc.project.clip(&clip).unwrap().busy.as_ref()), ("m2", None));
        assert!(doc.undo());
        assert_eq!((doc.project.clip(&clip).unwrap().media_id.as_str(), doc.project.clip(&clip).unwrap().busy.as_ref()), ("m1", None), "the old file, and free");
        assert!(doc.undo() && doc.undo(), "free again, so the brightness can go");
        assert_eq!(doc.project.clip(&clip).unwrap().brightness, 0.0);
        assert_eq!(Doc::open(&doc.dir).unwrap().project.clip(&clip).unwrap().busy, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_names_never_collide() {
        let root = temp_dir("names");
        let a = Doc::create(&root, "Promo", "9:16").unwrap();
        let b = Doc::create(&root, "Promo", "9:16").unwrap();
        assert_ne!(a.dir, b.dir);
        assert_eq!(b.project.name, "Promo 2");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dates_are_formatted() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_752), (2026, 10, 26));
    }
}
