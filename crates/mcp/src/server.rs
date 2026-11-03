//! The MCP side: `tools/list` and `tools/call` (rmcp), the permission gate, and the tools
//! that need more than one engine call.

use crate::engine::{CallError, Link, TIMEOUT};
use crate::paths;
use crate::permissions::{self, Class, Decision, Settings};
use crate::summary;
use crate::tools::{self, Args, ToolDef};
use base64::Engine as _;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, InitializeRequestParams, InitializeResult, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const INSTRUCTIONS: &str = "Studio is a desktop video editor for short vertical ads. These tools drive its engine with the same commands as the app: with Studio open your edits appear live in its window (marked \"Claude · MCP\" in History); with it closed a headless engine runs.

Start with project_summary (or project_open_latest / project_new / project_list). It lists every track, clip (c…), media (m…) and track (t…) id the other tools take. Times are microseconds (1 s = 1000000).

Check your work: preview_frame returns the composited frame as an image; media_describe shows a file's frames. Text and captions are drawn by the Studio window; without a window they are saved but don't render yet (the tool result says so).

The user decides what Claude may do in each project (History tab: Allowed to look / edit / all, Ask before export). A refusal means ask the user; don't retry.";

pub struct Studio {
    link: Arc<Link>,
    defs: Vec<ToolDef>,
    listed: Vec<Tool>,
    /// The project folder open after Claude's last call. Ids (c5, m2) only mean something
    /// in one project, so an edit after the user (or a Studio restart) switched projects is
    /// stopped once, with a note, instead of landing in the wrong project.
    working_dir: std::sync::Mutex<Option<String>>,
}

/// The refusal for an edit whose project changed since Claude last looked, if it did.
fn project_switched(working: Option<&str>, snapshot: &Value) -> Option<String> {
    let now = snapshot.get("dir").and_then(Value::as_str);
    match (working, now) {
        (Some(was), Some(now)) if was != now => Some(format!(
            "Studio now has a different project open ({now}; Claude was working on {was}). Nothing was changed. Check it with project_summary, or project_open to go back."
        )),
        _ => None,
    }
}

fn destructive(d: &ToolDef) -> bool {
    d.class == Class::Remove || d.name.contains("delete") || d.name == "audio_remove_silences"
}

fn to_tool(d: &ToolDef) -> Tool {
    let schema = d.schema.as_object().cloned().unwrap_or_default();
    let annotations = ToolAnnotations::new().read_only(d.class == Class::Look).destructive(destructive(d)).open_world(false);
    Tool::new(d.name, d.description, Arc::new(schema)).with_title(d.title).with_annotations(annotations)
}

/// A tool's answer: content blocks, and whether it failed.
struct Out {
    blocks: Vec<ContentBlock>,
    error: bool,
}

impl Out {
    fn text(s: impl Into<String>) -> Out {
        Out { blocks: vec![ContentBlock::text(cap(s.into()))], error: false }
    }
    fn err(s: impl Into<String>) -> Out {
        Out { blocks: vec![ContentBlock::text(cap(s.into()))], error: true }
    }
    fn into_result(self) -> CallToolResult {
        if self.error { CallToolResult::error(self.blocks) } else { CallToolResult::success(self.blocks) }
    }
}

/// Keeps a result to a size a model can read.
fn cap(s: String) -> String {
    const MAX: usize = 80_000;
    if s.len() <= MAX {
        return s;
    }
    let mut end = MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (cut at {MAX} characters)", &s[..end])
}

fn engine_error(method: &str, e: &CallError) -> String {
    if e.missing() {
        format!("This Studio engine build doesn't have `{method}` yet (it comes with contract v2). Update Studio's engine and try again.")
    } else if e.message.contains("No project is open") {
        format!("{} Open one with project_open_latest, project_open or project_new.", e.message)
    } else if e.code == crate::engine::LOST || e.code == TIMEOUT {
        e.message.clone()
    } else {
        format!("Studio couldn't do that: {}", e.message)
    }
}

fn compact(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn find_clip<'a>(snapshot: &'a Value, clip_id: &str) -> Option<&'a Value> {
    snapshot.get("project")?.get("tracks")?.as_array()?.iter().flat_map(|t| t.get("clips").and_then(Value::as_array).into_iter().flatten()).find(|c| c.get("id").and_then(Value::as_str) == Some(clip_id))
}

fn find_media<'a>(snapshot: &'a Value, media_id: &str) -> Option<&'a Value> {
    snapshot.get("project")?.get("media")?.as_array()?.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(media_id))
}

fn png_of(clip: &Value) -> Option<String> {
    clip.get("text")?.get("png")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn aspect_of(snapshot: &Value) -> String {
    let p = &snapshot["project"];
    let size = (p["width"].as_u64().unwrap_or(1080), p["height"].as_u64().unwrap_or(1920));
    match size {
        (1080, 1350) => "4:5",
        (1080, 1080) => "1:1",
        (1920, 1080) => "16:9",
        _ => "9:16",
    }
    .to_string()
}

fn image_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

fn ago(t: SystemTime) -> String {
    let s = SystemTime::now().duration_since(t).map(|d| d.as_secs()).unwrap_or(0);
    match s {
        0..=89 => "just now".into(),
        90..=5399 => format!("{} min ago", (s + 30) / 60),
        5400..=172_799 => format!("{} h ago", (s + 1800) / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

impl Studio {
    pub fn new(link: Arc<Link>) -> Self {
        let defs = tools::all();
        let listed = defs.iter().map(to_tool).collect();
        Studio { link, defs, listed, working_dir: std::sync::Mutex::new(None) }
    }

    async fn snapshot(&self) -> Result<Value, Out> {
        self.link.call("project.current", json!({})).await.map_err(|e| Out::err(engine_error("project.current", &e)))
    }

    async fn project(&self) -> Result<Value, Out> {
        let snap = self.snapshot().await?;
        if snap.get("project").is_none_or(|p| !p.is_object()) {
            return Err(Out::err("No project is open. Open one with project_open_latest, project_open or project_new."));
        }
        Ok(snap)
    }

    /// Asks the user in Studio (`approval.request`, on a connection of its own).
    async fn approve(&self, what: &str, label: &str, detail: String) -> Result<(), String> {
        match self.link.call_alone("approval.request", json!({ "what": what, "detail": detail }), Duration::from_secs(300)).await {
            Ok(answer) => match permissions::refusal_from_answer(label, &answer) {
                None => Ok(()),
                Some(why) => Err(why),
            },
            Err(e) if e.missing() => Err(format!("{label} needs the user's OK in Studio, but this engine build can't ask yet (no approval.request), so it wasn't done.")),
            Err(e) if e.code == TIMEOUT => Err(format!("{label} needs the user's OK in Studio, and nobody answered within 5 minutes.")),
            Err(e) => Err(format!("Couldn't ask the user: {}", e.message)),
        }
    }

    async fn run(&self, def: &ToolDef, args: Args) -> Out {
        let ask = match def.class {
            Class::Look => false,
            class => {
                let snap = match self.snapshot().await {
                    Ok(s) => s,
                    Err(out) => return self.finish(out),
                };
                let switched = project_switched(self.working_dir.lock().unwrap().as_deref(), &snap);
                *self.working_dir.lock().unwrap() = snap.get("dir").and_then(Value::as_str).map(str::to_string);
                if let Some(why) = switched {
                    return self.finish(Out::err(why));
                }
                match permissions::decide(class, &Settings::from_snapshot(&snap)) {
                    Decision::Allow => false,
                    // Cancelling an export never needs the user's OK.
                    Decision::Ask => def.name != "export_cancel",
                    Decision::Refuse(why) => return self.finish(Out::err(why)),
                }
            }
        };
        let out = match def.name {
            "studio_status" => self.status().await,
            "project_list" => self.project_list().await,
            "project_summary" => self.summary().await,
            "project_state" => self.state(&args).await,
            "media_list" => self.media_list(&args).await,
            "media_describe" => self.media_describe(&args).await,
            "media_remove" => self.media_remove(&args, ask).await,
            "timeline_trim" => self.trim(&args).await,
            "history_list" => match self.link.call("history.list", json!({})).await {
                Ok(v) => Out::text(summary::history(&v)),
                Err(e) => Out::err(engine_error("history.list", &e)),
            },
            "effects_list" => self.effects_list().await,
            "text_add" => self.text_add(&args).await,
            "text_set" => self.text_set(&args).await,
            "captions_set" => self.captions_set(&args).await,
            "audio_loudness" => self.loudness().await,
            "export_start" => self.export(&args, ask).await,
            "export_status" => self.export_status(&args),
            "preview_frame" => self.preview_frame(&args).await,
            name => match tools::forward(name, &args) {
                Some(Ok((method, params))) => self.forward(name, method, params, &args).await,
                Some(Err(e)) => Out::err(e),
                None => Out::err(format!("{name} isn't wired up in this studio-mcp build.")),
            },
        };
        // Tools whose answer tells Claude which project is open (and edits, which may open
        // another) set the project the next edit is checked against.
        if def.class != Class::Look || ["project_open", "project_open_latest", "project_summary", "project_state", "studio_status"].contains(&def.name) {
            if let Some(dir) = self.link.shared.last_dir.lock().unwrap().clone() {
                *self.working_dir.lock().unwrap() = Some(dir);
            }
        }
        self.finish(out)
    }

    /// Every result: what happened between calls goes first.
    fn finish(&self, mut out: Out) -> Out {
        let notices = self.link.take_notices();
        if !notices.is_empty() {
            out.blocks.insert(0, ContentBlock::text(notices.join("\n")));
        }
        out
    }

    async fn forward(&self, name: &str, method: &str, params: Value, args: &Args) -> Out {
        let result = match self.link.call(method, params).await {
            Ok(v) => v,
            Err(e) => return Out::err(engine_error(method, &e)),
        };
        let mut text = match (name, &result) {
            ("edit_undo", r) if r.get("done") == Some(&json!(false)) => "Nothing to undo.".to_string(),
            ("edit_redo", r) if r.get("done") == Some(&json!(false)) => "Nothing to redo.".to_string(),
            (_, r) if r.get("project").is_some() && r.get("revision").is_some() => summary::headline(r),
            (_, Value::Null) | (_, Value::Bool(true)) => "Done.".to_string(),
            (_, Value::String(s)) => format!("Done: {s}"),
            (_, r) => format!("Done: {}", compact(r)),
        };
        if name == "clip_set" {
            let known: Vec<&str> = [&["clipId", "clipIds"][..], tools::CLIP_SET_KEYS].concat();
            let ignored = tools::unknown_keys(args, &known);
            if !ignored.is_empty() {
                text.push_str(&format!("\nIgnored (not clip settings): {}", ignored.join(", ")));
            }
        }
        if name == "media_import" {
            text.push_str("\nThumbnails, waveforms and proxies are made in the background; media_describe waits for them.");
        }
        Out::text(text)
    }

    async fn status(&self) -> Out {
        if let Err(e) = self.link.conn().await {
            return Out::err(e);
        }
        let info = self.link.info().await;
        let quick = Duration::from_secs(10);
        let ping = self.link.call_timeout("ping", json!({}), quick).await.unwrap_or(Value::Null);
        let caps = self.link.call_timeout("engine.capabilities", json!({}), quick).await.unwrap_or(Value::Null);
        let mcp = match self.link.call_timeout("mcp.status", json!({}), quick).await {
            Ok(v) => v,
            Err(e) if e.missing() => json!("not in this engine build"),
            Err(e) => json!(e.message),
        };
        let window = match self.link.window_open().await {
            Some(true) => "open",
            Some(false) => "none (headless engine)",
            None => "probably open (the engine can't say)",
        };
        let snap = self.link.call("project.current", json!({})).await.unwrap_or(Value::Null);
        let settings = Settings::from_snapshot(&snap);
        let status = json!({
            "engine": {
                "socket": info.as_ref().map(|i| i.socket.clone()),
                "pid": info.as_ref().and_then(|i| i.pid),
                "startedByStudioMcp": info.as_ref().map(|i| i.headless),
                "version": ping.get("version"),
                "ffmpeg": caps.get("ffmpeg"),
                "nvenc": caps.get("nvenc"),
                "projectsDir": caps.get("projectsDir"),
            },
            "window": window,
            "project": summary::headline(&snap),
            "claudeMay": settings.allowed_name(),
            "askBeforeExport": settings.ask_before_export,
            "mcpStatus": mcp,
            "studioMcp": crate::engine::VERSION,
        });
        Out::text(serde_json::to_string_pretty(&status).unwrap_or_default())
    }

    async fn project_list(&self) -> Out {
        let caps = self.link.call_timeout("engine.capabilities", json!({}), Duration::from_secs(10)).await.unwrap_or(Value::Null);
        let dir = match caps.get("projectsDir").and_then(Value::as_str) {
            Some(d) => std::path::PathBuf::from(d),
            None => paths::projects_dir(&paths::real_env, None),
        };
        let mut found: Vec<(SystemTime, std::path::PathBuf)> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "studio"))
                    .filter_map(|p| Some((p.join("project.json").metadata().ok()?.modified().ok()?, p)))
                    .collect()
            })
            .unwrap_or_default();
        found.sort_by(|a, b| b.0.cmp(&a.0));
        if found.is_empty() {
            return Out::text(format!("No projects in {} yet. project_new makes one.", dir.display()));
        }
        let lines: Vec<String> = found.iter().map(|(t, p)| format!("- {} — saved {} — {}", p.file_stem().unwrap_or_default().to_string_lossy(), ago(*t), p.display())).collect();
        Out::text(format!("Projects in {} (newest first):\n{}", dir.display(), lines.join("\n")))
    }

    async fn summary(&self) -> Out {
        let snap = match self.snapshot().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        if snap.get("project").is_none_or(|p| !p.is_object()) {
            return Out::text(summary::render(&snap));
        }
        match self.link.call("project.summary", json!({})).await {
            Ok(v) => {
                let text = v.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| v.as_str().map(str::to_string).unwrap_or_else(|| compact(&v)));
                // The other tools need ids; if the engine's text leaves them out, use ours.
                let first_clip = snap["project"]["tracks"].as_array().and_then(|t| t.iter().find_map(|t| t["clips"].as_array()?.first()?.get("id")?.as_str().map(str::to_string)));
                match first_clip {
                    Some(id) if !text.contains(&id) => Out::text(summary::render(&snap)),
                    _ => Out::text(text),
                }
            }
            Err(e) if e.missing() => Out::text(summary::render(&snap)),
            Err(e) => Out::err(engine_error("project.summary", &e)),
        }
    }

    async fn state(&self, args: &Args) -> Out {
        let mut snap = match self.project().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        if args.get("includeMedia").and_then(Value::as_bool) != Some(true) {
            let n = snap["project"]["media"].as_array().map_or(0, Vec::len);
            snap["project"]["media"] = json!(format!("{n} items (includeMedia: true lists them; media_list is shorter)"));
        }
        Out::text(compact(&snap))
    }

    async fn media_list(&self, args: &Args) -> Out {
        let snap = match self.project().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        let query = args.get("query").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
        let all = snap["project"]["media"].as_array().cloned().unwrap_or_default();
        let hits: Vec<&Value> = all
            .iter()
            .filter(|m| query.is_empty() || ["name", "path"].iter().any(|k| m.get(*k).and_then(Value::as_str).is_some_and(|s| s.to_lowercase().contains(&query))))
            .collect();
        if hits.is_empty() {
            return Out::text(if all.is_empty() { "The library is empty. media_import adds files.".to_string() } else { format!("Nothing in the library matches \"{query}\".") });
        }
        let mut lines: Vec<String> = hits.iter().take(limit).map(|m| format!("- {}", summary::media_line(m))).collect();
        if hits.len() > limit {
            lines.push(format!("… and {} more", hits.len() - limit));
        }
        Out::text(format!("{} of {} library items:\n{}", hits.len().min(limit), all.len(), lines.join("\n")))
    }

    async fn media_describe(&self, args: &Args) -> Out {
        let Some(id) = args.get("mediaId").and_then(Value::as_str) else { return Out::err("\"mediaId\" is required") };
        // Thumbnails are made in the background after an import: wait for them a while.
        let deadline = Instant::now() + Duration::from_secs(30);
        let (media, busy) = loop {
            let snap = match self.project().await {
                Ok(s) => s,
                Err(out) => return out,
            };
            let Some(media) = find_media(&snap, id).cloned() else { return Out::err(format!("No media {id} in the library (media_list shows the ids).")) };
            let busy = snap["processing"].as_array().is_some_and(|p| p.iter().any(|x| x.as_str() == Some(id)));
            let pictured = media["kind"] == "audio" || media.get("strip").and_then(Value::as_str).is_some();
            if !busy || pictured || Instant::now() > deadline {
                break (media, busy);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        let mut text = summary::media_line(&media);
        if let Some(f) = media.get("dir").and_then(Value::as_str) {
            text.push_str(&format!("\nIn linked folder {}, subfolder \"{f}\".", media.get("folder").and_then(Value::as_str).unwrap_or("")));
        }
        let mut out = Out::text(String::new());
        let mut images = vec![];
        for (key, what) in [("poster", "Poster frame (40 % in)"), ("strip", "Filmstrip: 10 frames evenly across the file")] {
            let Some(path) = media.get(key).and_then(Value::as_str) else { continue };
            match tokio::fs::read(path).await {
                Ok(bytes) => {
                    images.push(ContentBlock::text(what));
                    images.push(ContentBlock::image(base64::engine::general_purpose::STANDARD.encode(bytes), image_mime(path)));
                }
                Err(e) => text.push_str(&format!("\n({what} unreadable: {e})")),
            }
        }
        if images.is_empty() && media["kind"] != "audio" {
            text.push_str(if busy { "\nThumbnails are still being made; ask again in a moment." } else { "\nNo thumbnails for this file." });
        }
        out.blocks = vec![ContentBlock::text(text)];
        out.blocks.extend(images);
        out
    }

    async fn media_remove(&self, args: &Args, ask: bool) -> Out {
        let ids: Vec<String> = args.get("mediaIds").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if ids.is_empty() {
            return Out::err("\"mediaIds\" must list at least one media id");
        }
        let snap = match self.project().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        let mut names = vec![];
        for id in &ids {
            match find_media(&snap, id) {
                Some(m) => names.push(format!("\"{}\"", m["name"].as_str().unwrap_or(id))),
                None => return Out::err(format!("No media {id} in the library.")),
            }
        }
        if ask {
            let detail = format!("Claude wants to remove {} from the library ({}), with their clips on the timeline. The files on disk are kept.", if ids.len() == 1 { "1 file".to_string() } else { format!("{} files", ids.len()) }, names.join(", "));
            if let Err(why) = self.approve("remove media", "Removing media", detail).await {
                return Out::err(why);
            }
        }
        match self.link.call("media.remove", json!({ "mediaIds": ids })).await {
            Ok(r) => Out::text(format!("Removed {} from the library and {} clip(s) from the timeline. Undo brings them back.", r["media"].as_u64().map_or_else(|| names.join(", "), |n| format!("{n} item(s)")), r["clips"].as_u64().unwrap_or(0))),
            Err(e) => Out::err(engine_error("media.remove", &e)),
        }
    }

    async fn trim(&self, args: &Args) -> Out {
        let Some(id) = args.get("clipId").and_then(Value::as_str) else { return Out::err("\"clipId\" is required") };
        let snap = match self.project().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        let Some(clip) = find_clip(&snap, id) else { return Out::err(format!("No clip {id} on the timeline.")) };
        let params = match tools::trim_params(args, clip) {
            Ok(p) => p,
            Err(e) => return Out::err(e),
        };
        self.forward("timeline_trim", "timeline.trim", params, args).await
    }

    async fn effects_list(&self) -> Out {
        let list = |v: Result<Value, CallError>, fallback: &[&str]| -> (Vec<String>, bool) {
            match v.ok().and_then(|v| v.as_array().cloned()) {
                Some(a) => (a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(), true),
                None => (fallback.iter().map(|s| s.to_string()).collect(), false),
            }
        };
        let (effects, e_live) = list(self.link.call("engine.effects", json!({})).await, &tools::EFFECTS);
        let (transitions, t_live) = list(self.link.call("engine.transitions", json!({})).await, &tools::TRANSITIONS);
        let note = if e_live && t_live { "" } else { "\n(This engine build can't list its names yet; these are contract v2's.)" };
        Out::text(format!(
            "Clip effects (clip_set effects: [{{ name, amount 0–100 }}]): {}\nTransitions (transition_set): {}\nAnimations in/out (clip_set anim): {}\nLoop animations: {}\nBlend modes (overlay clips): {}{note}",
            effects.join(", "),
            transitions.join(", "),
            tools::ANIMS.join(", "),
            tools::LOOPS.join(", "),
            tools::BLENDS.join(", ")
        ))
    }

    /// After text was added or changed: whether Studio's window has drawn it (the engine
    /// can only composite a picture the window made).
    async fn drawn_report(&self, clip_ids: &[String], before: Option<String>) -> String {
        let window = self.link.window_open().await;
        if window == Some(false) {
            return "No Studio window is open, so nothing has drawn this text yet: Studio draws text in its window and the engine composites the picture. It's saved in the project, but it won't show in preview_frame or exports until the project is opened in Studio.".into();
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if let Ok(snap) = self.link.call("project.current", json!({})).await {
                let drawn = clip_ids.iter().all(|id| find_clip(&snap, id).and_then(png_of).is_some_and(|p| Some(&p) != before.as_ref()));
                if drawn {
                    return "Studio's window drew it; preview_frame shows it.".into();
                }
            }
            if Instant::now() > deadline {
                return match window {
                    Some(true) => "Studio's window hasn't drawn it yet; check with preview_frame in a moment.".into(),
                    _ => "It hasn't been drawn yet. If a Studio window has this project open it will draw it; with no window, text stays invisible in frames and exports until the project is opened in Studio.".into(),
                };
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    async fn text_add(&self, args: &Args) -> Out {
        let params = match tools::text_add_params(args) {
            Ok(p) => p,
            Err(e) => return Out::err(e),
        };
        let r = match self.link.call("text.add", params).await {
            Ok(r) => r,
            Err(e) => return Out::err(engine_error("text.add", &e)),
        };
        let Some(clip) = r.get("clipId").and_then(Value::as_str).map(str::to_string) else { return Out::text(format!("Done: {}", compact(&r))) };
        let report = self.drawn_report(std::slice::from_ref(&clip), None).await;
        Out::text(format!("Added text clip {clip} on track {}.\n{report}", r["trackId"].as_str().unwrap_or("?")))
    }

    async fn text_set(&self, args: &Args) -> Out {
        let params = match tools::text_set_params(args) {
            Ok(p) => p,
            Err(e) => return Out::err(e),
        };
        let id = params["clipId"].as_str().unwrap_or_default().to_string();
        let before = self.snapshot().await.ok().and_then(|s| find_clip(&s, &id).and_then(png_of));
        if let Err(e) = self.link.call("text.set", params).await {
            return Out::err(engine_error("text.set", &e));
        }
        let report = self.drawn_report(std::slice::from_ref(&id), before).await;
        Out::text(format!("Changed text clip {id}.\n{report}"))
    }

    async fn captions_set(&self, args: &Args) -> Out {
        let params = match tools::captions_params(args) {
            Ok(p) => p,
            Err(e) => return Out::err(e),
        };
        let n = params["lines"].as_array().map_or(0, Vec::len);
        let r = match self.link.call("captions.set", params).await {
            Ok(r) => r,
            Err(e) => return Out::err(engine_error("captions.set", &e)),
        };
        let ids: Vec<String> = r["clipIds"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let report = if ids.is_empty() { String::new() } else { self.drawn_report(&ids, None).await };
        Out::text(format!("Set {n} caption line(s) on track {} ({}).\n{report}", r["trackId"].as_str().unwrap_or("?"), ids.join(", ")))
    }

    async fn loudness(&self) -> Out {
        let mut events = self.link.shared.events.subscribe();
        let first = match self.link.call("audio.loudness", json!({})).await {
            Ok(v) => v,
            Err(e) => return Out::err(engine_error("audio.loudness", &e)),
        };
        let result = if first.get("pending").and_then(Value::as_bool) == Some(true) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
            loop {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(Ok((m, p))) if m == "audio.loudness" => break p,
                    Ok(Ok((m, p))) if m == "audio.failed" && p["what"] == "loudness" => return Out::err(format!("Measuring failed: {}", p["error"].as_str().unwrap_or("unknown error"))),
                    Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                    Ok(Err(_)) => return Out::err("Lost the connection while measuring."),
                    Err(_) => return Out::err("Measuring the mix took more than 3 minutes."),
                }
            }
        } else {
            first
        };
        Out::text(format!("Mix loudness: {}", compact(&result)))
    }

    async fn export(&self, args: &Args, ask: bool) -> Out {
        let snap = match self.project().await {
            Ok(s) => s,
            Err(out) => return out,
        };
        let folder = paths::display_path(&paths::exports_dir(&paths::real_env));
        let plan = match tools::export_plan(args, &folder, &aspect_of(&snap)) {
            Ok(p) => p,
            Err(e) => return Out::err(e),
        };
        let formats: Vec<String> = plan.params["formats"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if ask {
            let what = if plan.params.get("clipIds").is_some() { "a selection of" } else { "" };
            let detail = format!("Claude wants to export {what} \"{}\" as {} to {}.", snap["project"]["name"].as_str().unwrap_or("the project"), formats.join(", "), plan.params["folder"].as_str().unwrap_or(&folder)).replace("  ", " ");
            if let Err(why) = self.approve("export", "Export", detail).await {
                return Out::err(why);
            }
        }
        let mut events = self.link.shared.events.subscribe();
        let started = match self.link.call("export.start", plan.params.clone()).await {
            Ok(v) => v,
            Err(e) => return Out::err(engine_error("export.start", &e)),
        };
        self.link.shared.add_jobs(&started, &formats);
        let ids: Vec<String> = started["jobs"].as_array().map(|a| a.iter().filter_map(|j| j["jobId"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        if !plan.wait {
            return Out::text(format!("Export started: {}. export_status follows it.", self.jobs_text(&ids)));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(plan.timeout_s);
        loop {
            let all_done = {
                let jobs = self.link.shared.exports.lock().unwrap();
                ids.iter().all(|id| jobs.get(id).is_some_and(|j| j.finished()))
            };
            if all_done {
                break;
            }
            match tokio::time::timeout_at(deadline, events.recv()).await {
                Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(_)) => break,
                Err(_) => return Out::text(format!("Still exporting after {} s: {}. export_status follows it.", plan.timeout_s, self.jobs_text(&ids))),
            }
        }
        let failed = self.link.shared.exports.lock().unwrap().iter().any(|(id, j)| ids.contains(id) && j.state != "done");
        let text = format!("Export {}:\n{}", if failed { "finished with problems" } else { "done" }, self.jobs_text(&ids));
        if failed { Out::err(text) } else { Out::text(text) }
    }

    fn jobs_text(&self, ids: &[String]) -> String {
        let jobs = self.link.shared.exports.lock().unwrap();
        let lines: Vec<String> = jobs
            .values()
            .filter(|j| ids.is_empty() || ids.contains(&j.job_id))
            .map(|j| {
                let mut s = format!("- {} {}{}: {}", j.job_id, j.format, if j.ours { "" } else { " (not Claude's)" }, j.state);
                match j.state.as_str() {
                    "running" | "queued" => s.push_str(&format!(" {:.0} %", j.fraction * 100.0)),
                    "done" => s.push_str(&format!(" — {} ({:.1} MB in {:.1} s, {})", j.path, j.bytes.unwrap_or(0) as f64 / 1e6, j.seconds.unwrap_or(0.0), j.encoder)),
                    _ => {}
                }
                if let Some(e) = &j.error {
                    s.push_str(&format!(" — {e}"));
                }
                if j.state != "done" && !j.path.is_empty() {
                    s.push_str(&format!(" → {}", j.path));
                }
                s
            })
            .collect();
        if lines.is_empty() { "no export jobs".into() } else { lines.join("\n") }
    }

    fn export_status(&self, args: &Args) -> Out {
        let ids: Vec<String> = args.get("jobId").and_then(Value::as_str).map(|s| vec![s.to_string()]).unwrap_or_default();
        let text = self.jobs_text(&ids);
        if text == "no export jobs" { Out::text("No exports in this session yet.") } else { Out::text(text) }
    }

    async fn preview_frame(&self, args: &Args) -> Out {
        let Some(at) = args.get("atUs").filter(|v| v.is_number()) else { return Out::err("\"atUs\" is required (microseconds)") };
        let params = Value::Object(tools::pick(args, &["atUs", "width"]));
        let r = match self.link.call("preview.frame", params).await {
            Ok(r) => r,
            Err(e) => return Out::err(engine_error("preview.frame", &e)),
        };
        let (bytes, where_) = if let Some(path) = r.get("path").and_then(Value::as_str) {
            match tokio::fs::read(path).await {
                Ok(b) => (b, path.to_string()),
                Err(e) => return Out::err(format!("The engine rendered {path}, but it can't be read: {e}")),
            }
        } else if let Some(data) = r.get("png").or_else(|| r.get("data")).and_then(Value::as_str) {
            match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(b) => (b, "inline".to_string()),
                Err(e) => return Out::err(format!("The engine's frame isn't valid base64: {e}")),
            }
        } else {
            return Out::err(format!("The engine answered preview.frame without a picture: {}", compact(&r)));
        };
        if bytes.len() < 8 || &bytes[1..4] != b"PNG" {
            return Out::err(format!("{where_} isn't a PNG."));
        }
        let size = if bytes.len() >= 24 { format!("{}×{}", u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]), u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]])) } else { "?".into() };
        let mut out = Out::text(format!("Frame at {} ({size} PNG, {where_})", summary::secs(at.as_f64().unwrap_or(0.0))));
        out.blocks.push(ContentBlock::image(base64::engine::general_purpose::STANDARD.encode(&bytes), "image/png"));
        out
    }
}

impl ServerHandler for Studio {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("studio", crate::engine::VERSION).with_title("Studio video editor"))
            .with_instructions(INSTRUCTIONS)
    }

    async fn initialize(&self, request: InitializeRequestParams, context: RequestContext<RoleServer>) -> Result<InitializeResult, McpError> {
        self.link.set_client(request.client_info.name.clone());
        context.peer.set_peer_info(request.clone());
        self.negotiate_initialize(&request)
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.listed.clone()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.listed.iter().find(|t| t.name == name).cloned()
    }

    async fn call_tool(&self, request: CallToolRequestParams, _context: RequestContext<RoleServer>) -> Result<CallToolResponse, McpError> {
        let Some(def) = self.defs.iter().find(|d| d.name == request.name) else {
            return Err(McpError::invalid_params(format!("unknown tool {}", request.name), None));
        };
        let args = request.arguments.unwrap_or_default();
        Ok(self.run(def, args).await.into_result().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listed_tools_carry_hints() {
        let s = Studio::new(Arc::new(Link::new()));
        let frame = s.listed.iter().find(|t| t.name == "preview_frame").unwrap();
        assert_eq!(frame.annotations.as_ref().unwrap().read_only_hint, Some(true));
        let remove = s.listed.iter().find(|t| t.name == "media_remove").unwrap();
        assert_eq!(remove.annotations.as_ref().unwrap().destructive_hint, Some(true));
        let set = s.listed.iter().find(|t| t.name == "clip_set").unwrap();
        assert_eq!(set.annotations.as_ref().unwrap().read_only_hint, Some(false));
        assert_eq!(set.input_schema.get("type"), Some(&json!("object")));
    }

    #[test]
    fn engine_errors_read_well() {
        let missing = CallError { code: -32601, message: "unknown method preview.frame".into() };
        assert!(engine_error("preview.frame", &missing).contains("doesn't have `preview.frame` yet"));
        let none = CallError { code: 1, message: "No project is open.".into() };
        assert!(engine_error("clip.set", &none).contains("project_open_latest"));
    }

    #[test]
    fn edits_stop_once_when_the_project_changed() {
        let snap = json!({ "dir": "C:/P/B.studio", "project": {} });
        assert!(project_switched(Some("C:/P/A.studio"), &snap).unwrap().contains("Nothing was changed"));
        assert_eq!(project_switched(Some("C:/P/B.studio"), &snap), None);
        assert_eq!(project_switched(None, &snap), None);
        assert_eq!(project_switched(Some("C:/P/A.studio"), &Value::Null), None);
    }

    #[test]
    fn helpers() {
        assert_eq!(aspect_of(&json!({ "project": { "width": 1080, "height": 1350 } })), "4:5");
        assert_eq!(aspect_of(&json!({ "project": { "width": 1080, "height": 1920 } })), "9:16");
        assert_eq!(image_mime("a/poster.JPG"), "image/jpeg");
        assert_eq!(image_mime("a/f.png"), "image/png");
        let snap = json!({ "project": { "tracks": [{ "clips": [{ "id": "c1", "text": { "png": "x.png" } }] }], "media": [{ "id": "m1" }] } });
        assert_eq!(find_clip(&snap, "c1").and_then(png_of), Some("x.png".into()));
        assert!(find_clip(&snap, "c2").is_none());
        assert!(find_media(&snap, "m1").is_some());
        assert!(cap("x".repeat(100_000)).ends_with("characters)"));
    }
}
