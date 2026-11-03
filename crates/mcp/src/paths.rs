//! Where things live: the app's user data folder (and its `engine.json`), the projects and
//! exports folders, and the engine binary. Every function takes the environment as a
//! lookup so the rules can be tested without touching the real environment.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Reads one environment variable (`std::env::var` in the binary, a map in tests).
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn real_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn home(env: EnvLookup) -> Option<PathBuf> {
    env(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).or_else(dirs::home_dir)
}

/// The folders that may hold `engine.json`, in the order they are tried.
///
/// `STUDIO_USER_DATA` wins outright. Otherwise the contract's folder (`%APPDATA%/Studio`,
/// `~/.config/Studio`) comes first, then the folder Electron picks for the app today
/// (`@studio/desktop`, from the package name), so the app is found either way.
pub fn user_data_dirs(env: EnvLookup) -> Vec<PathBuf> {
    if let Some(dir) = env("STUDIO_USER_DATA") {
        return vec![PathBuf::from(dir)];
    }
    let mut bases = vec![];
    if cfg!(windows) {
        if let Some(appdata) = env("APPDATA").map(PathBuf::from).or_else(dirs::config_dir) {
            bases.push(appdata);
        }
    } else {
        let config = env("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home(env).map(|h| h.join(".config")));
        bases.extend(config);
        if cfg!(target_os = "macos") {
            bases.extend(home(env).map(|h| h.join("Library").join("Application Support")));
        }
    }
    let mut out = vec![];
    for base in &bases {
        out.push(base.join("Studio"));
    }
    for base in &bases {
        out.push(base.join("@studio").join("desktop"));
    }
    out
}

/// What a running engine writes to `<user data>/engine.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineInfo {
    pub socket: String,
    pub pid: Option<u32>,
    pub projects_dir: Option<String>,
}

pub fn parse_engine_json(text: &str) -> Option<EngineInfo> {
    let v: Value = serde_json::from_str(text).ok()?;
    let socket = v.get("socket")?.as_str()?.to_string();
    if socket.is_empty() {
        return None;
    }
    Some(EngineInfo {
        socket,
        pid: v.get("pid").and_then(Value::as_u64).map(|p| p as u32),
        projects_dir: v.get("projectsDir").and_then(Value::as_str).map(str::to_string),
    })
}

/// Every `engine.json` that exists, with what it says.
pub fn engine_files(env: EnvLookup) -> Vec<(PathBuf, String, EngineInfo)> {
    user_data_dirs(env)
        .into_iter()
        .map(|d| d.join("engine.json"))
        .filter_map(|f| {
            let text = std::fs::read_to_string(&f).ok()?;
            let info = parse_engine_json(&text)?;
            Some((f, text, info))
        })
        .collect()
}

/// The projects folder for an engine studio-mcp starts itself: `STUDIO_PROJECTS_DIR`, the
/// folder the app last used (from a leftover `engine.json`), or `Documents/Studio Projects`.
pub fn projects_dir(env: EnvLookup, from_app: Option<&str>) -> PathBuf {
    if let Some(dir) = env("STUDIO_PROJECTS_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = from_app.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let docs = dirs::document_dir().or_else(|| home(env).map(|h| h.join("Documents"))).unwrap_or_else(std::env::temp_dir);
    docs.join("Studio Projects")
}

/// Where exports go when the agent names no folder: the Export dialog's default.
pub fn exports_dir(env: EnvLookup) -> PathBuf {
    let videos = dirs::video_dir().or_else(|| home(env).map(|h| h.join("Videos"))).unwrap_or_else(std::env::temp_dir);
    videos.join("Studio Exports")
}

pub fn engine_file_name() -> &'static str {
    if cfg!(windows) { "studio-engine.exe" } else { "studio-engine" }
}

/// The engine binary: `STUDIO_ENGINE`, next to this binary (the installed layout and
/// `target/<profile>`), or on PATH.
pub fn engine_exe(env: EnvLookup, this_exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = env("STUDIO_ENGINE") {
        return Some(PathBuf::from(p));
    }
    let name = engine_file_name();
    if let Some(dir) = this_exe.and_then(Path::parent) {
        let beside = dir.join(name);
        if beside.is_file() {
            return Some(beside);
        }
    }
    let path = env("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// The socket for an engine this process starts: a named pipe on Windows, a Unix socket in
/// its own temp folder elsewhere. Deterministic, so a test can talk to the same engine.
pub fn headless_socket(pid: u32, n: u32, run_dir: &Path) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\studio-mcp-{pid}-{n}")
    } else {
        run_dir.join(format!("engine-{n}.sock")).to_string_lossy().into_owned()
    }
}

/// `\\?\C:\x` → `C:\x`, so printed paths paste cleanly into a shell or JSON.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| s.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn user_data_override_wins() {
        let env = env_of(&[("STUDIO_USER_DATA", "/tmp/ud"), ("APPDATA", "/x")]);
        assert_eq!(user_data_dirs(&env), vec![PathBuf::from("/tmp/ud")]);
    }

    #[test]
    fn user_data_defaults_try_contract_folder_first() {
        let env = env_of(&[("APPDATA", "/appdata"), ("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/appdata")]);
        let dirs = user_data_dirs(&env);
        assert_eq!(dirs[0], PathBuf::from("/appdata").join("Studio"));
        assert!(dirs.contains(&PathBuf::from("/appdata").join("@studio").join("desktop")));
    }

    #[test]
    fn parses_engine_json() {
        let info = parse_engine_json(r#"{"socket":"\\\\.\\pipe\\studio-engine-12","pid":12,"projectsDir":"C:/P"}"#).unwrap();
        assert_eq!(info.socket, r"\\.\pipe\studio-engine-12");
        assert_eq!(info.pid, Some(12));
        assert_eq!(info.projects_dir.as_deref(), Some("C:/P"));
        assert!(parse_engine_json(r#"{"pid":1}"#).is_none());
        assert!(parse_engine_json("not json").is_none());
    }

    #[test]
    fn projects_dir_order() {
        let env = env_of(&[("STUDIO_PROJECTS_DIR", "/p")]);
        assert_eq!(projects_dir(&env, Some("/app")), PathBuf::from("/p"));
        let env = env_of(&[]);
        assert_eq!(projects_dir(&env, Some("/app")), PathBuf::from("/app"));
        assert!(projects_dir(&env, None).ends_with("Studio Projects"));
    }

    #[test]
    fn engine_from_env_first() {
        let env = env_of(&[("STUDIO_ENGINE", "/opt/engine")]);
        assert_eq!(engine_exe(&env, None), Some(PathBuf::from("/opt/engine")));
    }

    #[test]
    fn display_path_strips_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.exe")), r"C:\a\b.exe");
    }
}
