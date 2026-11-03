//! The link to Studio's engine: newline-delimited JSON-RPC 2.0 over the engine's local
//! socket (a named pipe on Windows, a Unix socket elsewhere), the same wire the app uses.
//!
//! With Studio open, `engine.json` in the user data folder names the app's engine and every
//! edit lands there (the window shows it live). With Studio closed, this starts an engine of
//! its own, headless and silent, and keeps its stdin open: the engine exits when we do.

use crate::paths::{self, real_env};
use crate::tools::with_actor;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const METHOD_NOT_FOUND: i64 = -32601;
/// Not a JSON-RPC code: the connection failed or closed.
pub const LOST: i64 = -1;
/// Not a JSON-RPC code: no answer in time.
pub const TIMEOUT: i64 = -2;
/// The default wait for an engine call. Imports of big folders and compound renders block
/// the call while they run.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq)]
pub struct CallError {
    pub code: i64,
    pub message: String,
}

impl CallError {
    pub fn missing(&self) -> bool {
        self.code == METHOD_NOT_FOUND
    }
    fn lost(why: impl std::fmt::Display) -> Self {
        CallError { code: LOST, message: format!("Lost the connection to Studio's engine ({why}).") }
    }
}

pub trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

#[cfg(windows)]
pub async fn connect(socket: &str) -> std::io::Result<Box<dyn Duplex>> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    loop {
        match ClientOptions::new().open(socket) {
            Ok(c) => return Ok(Box::new(c)),
            // The engine makes the next pipe instance right after each connect.
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 40 => tries += 1,
            Err(e) => return Err(e),
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(unix)]
pub async fn connect(socket: &str) -> std::io::Result<Box<dyn Duplex>> {
    Ok(Box::new(tokio::net::UnixStream::connect(socket).await?))
}

/// One export job as the engine's events describe it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExportJob {
    pub job_id: String,
    /// queued, running, done, failed, cancelled or lost.
    pub state: String,
    pub fraction: f64,
    pub path: String,
    pub format: String,
    pub encoder: String,
    pub error: Option<String>,
    pub bytes: Option<u64>,
    pub seconds: Option<f64>,
    /// Started by this session.
    pub ours: bool,
}

impl ExportJob {
    pub fn finished(&self) -> bool {
        matches!(self.state.as_str(), "done" | "failed" | "cancelled" | "lost")
    }
}

/// What the engine's notifications tell us, shared by every connection.
pub struct Shared {
    pub events: broadcast::Sender<(String, Value)>,
    pub exports: Mutex<BTreeMap<String, ExportJob>>,
    /// The project folder last seen open, to carry on with after a reconnect.
    pub last_dir: Mutex<Option<String>>,
}

impl Shared {
    fn new() -> Self {
        Shared { events: broadcast::channel(256).0, exports: Mutex::new(BTreeMap::new()), last_dir: Mutex::new(None) }
    }

    pub fn note_snapshot(&self, snapshot: &Value) {
        if let Some(d) = snapshot.get("dir").and_then(Value::as_str) {
            *self.last_dir.lock().unwrap() = Some(d.to_string());
        }
    }

    pub fn on_event(&self, method: &str, params: Value) {
        match method {
            "playback.position" => return,
            "project.changed" => self.note_snapshot(&params),
            m if m.starts_with("export.") => self.on_export(m, &params),
            _ => {}
        }
        let _ = self.events.send((method.to_string(), params));
    }

    fn on_export(&self, method: &str, p: &Value) {
        let Some(id) = p.get("jobId").and_then(Value::as_str) else { return };
        let mut jobs = self.exports.lock().unwrap();
        let job = jobs.entry(id.to_string()).or_insert_with(|| ExportJob { job_id: id.to_string(), state: "queued".into(), ..Default::default() });
        let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string);
        match method {
            "export.started" => {
                job.state = "running".into();
                job.encoder = text("encoder").unwrap_or_else(|| job.encoder.clone());
            }
            "export.progress" => {
                job.state = "running".into();
                job.fraction = p.get("fraction").and_then(Value::as_f64).unwrap_or(job.fraction);
            }
            "export.done" => {
                job.state = "done".into();
                job.fraction = 1.0;
                job.path = text("path").unwrap_or_else(|| job.path.clone());
                job.encoder = text("encoder").unwrap_or_else(|| job.encoder.clone());
                job.bytes = p.get("bytes").and_then(Value::as_u64);
                job.seconds = p.get("seconds").and_then(Value::as_f64);
            }
            "export.failed" => {
                job.state = "failed".into();
                job.error = text("error");
            }
            "export.cancelled" => job.state = "cancelled".into(),
            _ => {}
        }
    }

    /// Records the jobs `export.start` answered with.
    pub fn add_jobs(&self, started: &Value, formats: &[String]) {
        let mut jobs = self.exports.lock().unwrap();
        for (i, j) in started.get("jobs").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(id) = j.get("jobId").and_then(Value::as_str) else { continue };
            let job = jobs.entry(id.to_string()).or_insert_with(|| ExportJob { job_id: id.to_string(), state: "queued".into(), ..Default::default() });
            job.ours = true;
            job.path = j.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
            job.format = formats.get(i).cloned().unwrap_or_default();
            if job.encoder.is_empty() {
                job.encoder = j.get("encoder").and_then(Value::as_str).unwrap_or_default().to_string();
            }
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CallError>>>>>;

/// One connection to an engine.
pub struct Conn {
    pub socket: String,
    pub pid: Option<u32>,
    /// The headless engine this process started (so no Studio window is attached to it).
    pub ours: bool,
    writer: tokio::sync::Mutex<tokio::io::WriteHalf<Box<dyn Duplex>>>,
    pending: Pending,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        // Drops the read half too, so the pipe closes and the engine sees us leave.
        self.reader.abort();
    }
}

fn response(msg: &Value) -> Result<Value, CallError> {
    match msg.get("error").filter(|e| !e.is_null()) {
        Some(e) => Err(CallError { code: e.get("code").and_then(Value::as_i64).unwrap_or(-32603), message: e.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_string() }),
        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    }
}

impl Conn {
    pub async fn open(socket: &str, pid: Option<u32>, ours: bool, shared: Option<Arc<Shared>>) -> std::io::Result<Arc<Conn>> {
        let stream = connect(socket).await?;
        let (read, write) = tokio::io::split(stream);
        let pending: Pending = Default::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (p, a) = (pending.clone(), alive.clone());
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                match (msg.get("method").and_then(Value::as_str), msg.get("id").and_then(Value::as_u64)) {
                    (None, Some(id)) => {
                        if let Some(tx) = p.lock().unwrap().remove(&id) {
                            let _ = tx.send(response(&msg));
                        }
                    }
                    (Some(method), None) => {
                        if let Some(s) = &shared {
                            s.on_event(method, msg.get("params").cloned().unwrap_or(Value::Null));
                        }
                    }
                    _ => {}
                }
            }
            a.store(false, Ordering::Release);
            for (_, tx) in p.lock().unwrap().drain() {
                let _ = tx.send(Err(CallError::lost("it closed the connection")));
            }
        });
        Ok(Arc::new(Conn { socket: socket.to_string(), pid, ours, writer: tokio::sync::Mutex::new(write), pending, next: AtomicU64::new(1), alive, reader }))
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
        if !self.alive() {
            return Err(CallError::lost("it closed the connection"));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string() + "\n";
        let written = {
            let mut w = self.writer.lock().await;
            match w.write_all(line.as_bytes()).await {
                Ok(()) => w.flush().await,
                Err(e) => Err(e),
            }
        };
        if let Err(e) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(CallError::lost(e));
        }
        if !self.alive() && self.pending.lock().unwrap().remove(&id).is_some() {
            return Err(CallError::lost("it closed the connection"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(CallError::lost("it closed the connection")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(CallError { code: TIMEOUT, message: format!("Studio's engine didn't answer {method} within {} s.", timeout.as_secs()) })
            }
        }
    }
}

/// The engine this process started itself.
struct Spawned {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    socket: String,
    run_dir: PathBuf,
}

/// Which engine Claude is talking to, for `studio_status`.
#[derive(Clone, Debug)]
pub struct LinkInfo {
    pub socket: String,
    pub pid: Option<u32>,
    pub headless: bool,
}

pub struct Link {
    pub shared: Arc<Shared>,
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    child: tokio::sync::Mutex<Option<Spawned>>,
    spawns: AtomicU32,
    client: Mutex<Option<String>>,
    notices: Mutex<Vec<String>>,
}

const NO_ENGINE: &str = "Studio isn't open, and studio-engine wasn't found next to studio-mcp or on PATH, so there's no engine to run headless. Open Studio, or set STUDIO_ENGINE to the engine's path in the MCP server's environment.";

/// Removes the temp folders (a 25 MB preview ring each) of studio-mcp processes that were
/// killed before they could clean up. On Windows the folder holds only the ring (the pipe
/// lives elsewhere), and a live engine keeps its mapping even if the file goes; on Linux the
/// process is checked first, since its socket is in there; elsewhere nothing is touched.
fn clean_stale_run_dirs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    let me = std::process::id();
    for e in entries.filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix("studio-mcp-").and_then(|p| p.parse::<u32>().ok()) else { continue };
        let gone = pid != me && if cfg!(windows) { true } else if cfg!(target_os = "linux") { !std::path::Path::new("/proc").join(pid.to_string()).exists() } else { false };
        if gone {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

impl Default for Link {
    fn default() -> Self {
        Self::new()
    }
}

impl Link {
    pub fn new() -> Self {
        Link { shared: Arc::new(Shared::new()), conn: Default::default(), child: Default::default(), spawns: AtomicU32::new(1), client: Mutex::new(None), notices: Mutex::new(vec![]) }
    }

    /// The MCP client's name (from `initialize`), passed on in `mcp.hello`.
    pub fn set_client(&self, name: String) {
        *self.client.lock().unwrap() = Some(name);
    }

    fn notice(&self, text: String) {
        eprintln!("[studio-mcp] {text}");
        self.notices.lock().unwrap().push(text);
    }

    /// Things that happened between calls (Studio opened or closed), for the next result.
    pub fn take_notices(&self) -> Vec<String> {
        std::mem::take(&mut *self.notices.lock().unwrap())
    }

    pub async fn info(&self) -> Option<LinkInfo> {
        self.conn.lock().await.as_ref().filter(|c| c.alive()).map(|c| LinkInfo { socket: c.socket.clone(), pid: c.pid, headless: c.ours })
    }

    /// Connects to a running engine if `engine.json` names one; never starts one. Run at
    /// startup, so Studio's title bar shows Claude as soon as a session begins.
    pub async fn attach_if_running(&self) {
        let mut g = self.conn.lock().await;
        if g.as_ref().is_some_and(|c| c.alive()) {
            return;
        }
        if let Some(c) = self.find_running(None).await {
            self.adopt(&mut g, c, false).await;
        }
    }

    async fn find_running(&self, skip: Option<&str>) -> Option<Arc<Conn>> {
        let ours = self.child.lock().await.as_ref().map(|s| s.socket.clone());
        for (_, _, info) in paths::engine_files(&real_env) {
            if Some(info.socket.as_str()) == skip {
                continue;
            }
            let is_ours = ours.as_deref() == Some(info.socket.as_str());
            if let Ok(c) = Conn::open(&info.socket, info.pid, is_ours, Some(self.shared.clone())).await {
                return Some(c);
            }
        }
        None
    }

    fn our_exports_running(&self) -> bool {
        self.shared.exports.lock().unwrap().values().any(|j| j.ours && !j.finished())
    }

    /// The connection to use now: the current one, Studio's engine if it has appeared since
    /// we went headless, or a new one (Studio's, else a headless engine of our own).
    pub async fn conn(&self) -> Result<Arc<Conn>, String> {
        let mut g = self.conn.lock().await;
        if let Some(c) = g.as_ref().filter(|c| c.alive()).cloned() {
            if c.ours && !self.our_exports_running() {
                if let Some(app) = self.find_running(Some(&c.socket)).await {
                    let _ = c.call("mcp.bye", with_actor(json!({})), Duration::from_secs(2)).await;
                    drop(c);
                    *g = None;
                    self.stop_child().await;
                    self.adopt(&mut g, app, true).await;
                    self.notice("Studio's engine is running now, so Claude moved from its own headless engine to it.".into());
                }
            }
            return g.as_ref().cloned().ok_or_else(|| "no connection".into());
        }
        let reconnect = g.is_some() || self.shared.last_dir.lock().unwrap().is_some();
        *g = None;
        let c = match self.find_running(None).await {
            Some(c) => c,
            None => self.spawn().await?,
        };
        if reconnect && c.ours {
            self.notice("Studio isn't open, so Claude started a headless engine to carry on.".into());
        }
        self.adopt(&mut g, c, reconnect).await;
        g.as_ref().cloned().ok_or_else(|| "no connection".into())
    }

    async fn adopt(&self, slot: &mut Option<Arc<Conn>>, c: Arc<Conn>, reconnect: bool) {
        if reconnect {
            // Jobs on the old engine can't be followed any more.
            for j in self.shared.exports.lock().unwrap().values_mut().filter(|j| !j.finished()) {
                j.state = "lost".into();
                j.error = Some("Studio's engine changed while it ran".into());
            }
        }
        let client = self.client.lock().unwrap().clone();
        let hello = json!({ "name": "studio-mcp", "version": VERSION, "pid": std::process::id(), "client": client });
        if let Err(e) = c.call("mcp.hello", with_actor(hello), Duration::from_secs(5)).await {
            eprintln!("[studio-mcp] mcp.hello: {}", e.message);
        }
        // Carry on with the project Claude was working on.
        let last = self.shared.last_dir.lock().unwrap().clone();
        if let (Some(dir), true) = (last, reconnect) {
            if let Ok(snap) = c.call("project.current", with_actor(json!({})), Duration::from_secs(30)).await {
                match snap.get("dir").and_then(Value::as_str) {
                    None => {
                        if c.call("project.open", with_actor(json!({ "path": dir })), Duration::from_secs(60)).await.is_ok() {
                            self.notice(format!("Reopened {dir}."));
                        }
                    }
                    Some(open) if open != dir => self.notice(format!("Studio has {open} open now (Claude was working on {dir}).")),
                    Some(_) => {}
                }
            }
        }
        eprintln!("[studio-mcp] connected to {} engine at {}", if c.ours { "a headless" } else { "Studio's" }, c.socket);
        *slot = Some(c);
    }

    async fn spawn(&self) -> Result<Arc<Conn>, String> {
        self.stop_child().await;
        clean_stale_run_dirs();
        let this = std::env::current_exe().ok();
        let exe = paths::engine_exe(&real_env, this.as_deref()).ok_or(NO_ENGINE)?;
        if !exe.is_file() {
            return Err(format!("STUDIO_ENGINE is {}, but there's no file there.", exe.display()));
        }
        let n = self.spawns.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let run_dir = std::env::temp_dir().join(format!("studio-mcp-{pid}"));
        std::fs::create_dir_all(&run_dir).map_err(|e| format!("Can't make {}: {e}", run_dir.display()))?;
        let socket = paths::headless_socket(pid, n, &run_dir);
        let leftover = paths::engine_files(&real_env).into_iter().find_map(|(_, _, i)| i.projects_dir);
        let projects = paths::projects_dir(&real_env, leftover.as_deref());
        let user_data = paths::user_data_dirs(&real_env).into_iter().next();
        // `--user-data` lets the engine write engine.json, so other sessions share it. An
        // engine from before contract v2 refuses the flag; then it runs without.
        for with_user_data in [true, false] {
            if with_user_data && user_data.is_none() {
                continue;
            }
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.arg("--socket").arg(&socket).arg("--ring").arg(run_dir.join(format!("preview-{n}.ring"))).arg("--projects-dir").arg(&projects).arg("--exit-on-stdin-eof");
            if let (true, Some(dir)) = (with_user_data, &user_data) {
                cmd.arg("--user-data").arg(dir);
            }
            // Headless: never through the speakers, never a console window. Its output goes
            // to a file, not a pipe to us: if we're killed, a broken stdout pipe must not stop
            // it from noticing its stdin closed and exiting.
            let log_path = run_dir.join(format!("engine-{n}.log"));
            let log = std::fs::File::create(&log_path).map_err(|e| format!("Can't write {}: {e}", log_path.display()))?;
            let log2 = log.try_clone().map_err(|e| e.to_string())?;
            cmd.env("STUDIO_SILENT", "1").stdin(Stdio::piped()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
            #[cfg(windows)]
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", exe.display()))?;
            let stdin = child.stdin.take();
            let child_pid = child.id();
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if let Ok(Some(status)) = child.try_wait() {
                    let said = std::fs::read_to_string(&log_path).unwrap_or_default();
                    eprintln!("[studio-mcp] the engine exited at once ({status}): {}{}", said.trim(), if with_user_data { "\n[studio-mcp] trying again without --user-data" } else { "" });
                    break;
                }
                if let Ok(c) = Conn::open(&socket, child_pid, true, Some(self.shared.clone())).await {
                    eprintln!("[studio-mcp] started {} headless (pid {}); its log is {}", exe.display(), child_pid.unwrap_or(0), log_path.display());
                    *self.child.lock().await = Some(Spawned { child, stdin, socket: socket.clone(), run_dir: run_dir.clone() });
                    return Ok(c);
                }
                if Instant::now() > deadline {
                    drop(stdin); // it exits by itself
                    return Err("Started Studio's engine, but it never opened its socket.".into());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        Err(format!("Studio's engine ({}) exited right after starting; see {}.", exe.display(), run_dir.display()))
    }

    /// Stops the engine we started: closing its stdin makes it exit. If its exit takes
    /// another engine's `engine.json` with it (the app's), that file is put back.
    async fn stop_child(&self) {
        let Some(mut s) = self.child.lock().await.take() else { return };
        let others: Vec<(PathBuf, String)> = paths::engine_files(&real_env).into_iter().filter(|(_, _, i)| i.socket != s.socket).map(|(p, t, _)| (p, t)).collect();
        drop(s.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(5), s.child.wait()).await;
        for (path, text) in others {
            if !path.exists() {
                let _ = std::fs::write(&path, text);
            }
        }
        let _ = std::fs::remove_dir_all(&s.run_dir);
    }

    /// A call with `_actor: "claude"`, on the current connection.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
        self.call_timeout(method, params, CALL_TIMEOUT).await
    }

    pub async fn call_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
        let c = self.conn().await.map_err(|m| CallError { code: LOST, message: m })?;
        let r = c.call(method, with_actor(params), timeout).await;
        if let Ok(v) = &r {
            if v.get("project").is_some() {
                self.shared.note_snapshot(v);
            }
        }
        r
    }

    /// One call on a connection of its own, so a long wait (an approval the user hasn't
    /// answered yet) doesn't hold up everything else: the engine answers one request per
    /// connection at a time.
    pub async fn call_alone(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
        let c = self.conn().await.map_err(|m| CallError { code: LOST, message: m })?;
        let side = Conn::open(&c.socket, c.pid, c.ours, None).await.map_err(CallError::lost)?;
        // The engine counts every connection that hasn't said hello as a Studio window, and
        // only asks the user when a window is open: this one must not look like a window.
        let hello = json!({ "name": "studio-mcp", "version": VERSION, "pid": std::process::id(), "client": self.client.lock().unwrap().clone() });
        let _ = side.call("mcp.hello", with_actor(hello), Duration::from_secs(5)).await;
        side.call(method, with_actor(params), timeout).await
    }

    /// Whether a Studio window is attached to the engine: `Some(false)` for our own headless
    /// engine, the engine's word if `mcp.status` says, else `None`.
    pub async fn window_open(&self) -> Option<bool> {
        let c = self.conn().await.ok()?;
        if c.ours {
            return Some(false);
        }
        let st = c.call("mcp.status", with_actor(json!({})), Duration::from_secs(5)).await.ok()?;
        for key in ["windows", "uiClients", "ui", "window"] {
            match st.get(key) {
                Some(Value::Number(n)) => return Some(n.as_u64().unwrap_or(0) > 0),
                Some(Value::Bool(b)) => return Some(*b),
                _ => {}
            }
        }
        None
    }

    /// Before exiting: let this session's exports on its own engine finish (up to 15 min),
    /// say goodbye, and stop the headless engine.
    pub async fn shutdown(&self) {
        let deadline = Instant::now() + Duration::from_secs(15 * 60);
        while self.our_exports_running() && Instant::now() < deadline && self.conn.lock().await.as_ref().is_some_and(|c| c.ours && c.alive()) {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let c = self.conn.lock().await.take();
        if let Some(c) = c.filter(|c| c.alive()) {
            let _ = c.call("mcp.bye", with_actor(json!({})), Duration::from_secs(2)).await;
        }
        self.stop_child().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_events_update_jobs() {
        let s = Shared::new();
        s.add_jobs(&json!({ "jobs": [{ "jobId": "e1", "path": "C:/x/Ad-1080x1920.mp4", "encoder": "libx264" }] }), &["9:16".into()]);
        s.on_event("export.started", json!({ "jobId": "e1", "encoder": "h264_nvenc" }));
        s.on_event("export.progress", json!({ "jobId": "e1", "fraction": 0.5 }));
        {
            let jobs = s.exports.lock().unwrap();
            let j = &jobs["e1"];
            assert_eq!((j.state.as_str(), j.fraction, j.encoder.as_str(), j.format.as_str(), j.ours), ("running", 0.5, "h264_nvenc", "9:16", true));
        }
        s.on_event("export.done", json!({ "jobId": "e1", "path": "C:/x/Ad-1080x1920.mp4", "bytes": 1000, "seconds": 2.5, "encoder": "h264_nvenc" }));
        let j = s.exports.lock().unwrap()["e1"].clone();
        assert!(j.finished());
        assert_eq!((j.bytes, j.seconds), (Some(1000), Some(2.5)));
        // Someone else's export (the user's) is followed too, but isn't ours.
        s.on_event("export.failed", json!({ "jobId": "e7", "error": "disk full" }));
        let j = s.exports.lock().unwrap()["e7"].clone();
        assert_eq!((j.state.as_str(), j.error.as_deref(), j.ours), ("failed", Some("disk full"), false));
    }

    #[test]
    fn snapshots_remember_the_project() {
        let s = Shared::new();
        s.on_event("project.changed", json!({ "dir": "C:/P/Ad.studio", "project": {} }));
        assert_eq!(s.last_dir.lock().unwrap().as_deref(), Some("C:/P/Ad.studio"));
        s.on_event("project.changed", Value::Null);
        assert_eq!(s.last_dir.lock().unwrap().as_deref(), Some("C:/P/Ad.studio"));
    }

    #[test]
    fn responses_and_errors() {
        assert_eq!(response(&json!({ "id": 1, "result": { "a": 1 } })), Ok(json!({ "a": 1 })));
        assert_eq!(response(&json!({ "id": 1, "result": null })), Ok(Value::Null));
        let e = response(&json!({ "id": 1, "error": { "code": -32601, "message": "unknown method x" } })).unwrap_err();
        assert!(e.missing());
        assert_eq!(e.message, "unknown method x");
    }
}
