//! How an MCP client finds the running engine: `<user data>/engine.json` with the socket,
//! the process id and the projects folder, written on start and removed on exit.

use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static WRITTEN: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The app's user data folder when none is passed: `%APPDATA%/Studio` on Windows,
/// `~/.config/Studio` elsewhere.
pub fn default_user_data() -> PathBuf {
    if cfg!(windows) {
        if let Some(app) = std::env::var_os("APPDATA") {
            return PathBuf::from(app).join("Studio");
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".config").join("Studio")
}

/// The cache of thumbnails, waveforms and proxies every project shares: the machine's local
/// app data (not the roaming profile), as it can always be made again.
pub fn default_media_cache() -> PathBuf {
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join("Studio").join("media-cache");
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".cache").join("studio").join("media-cache")
}

/// Writes `engine.json` in `user_data` (written whole, then moved into place).
pub fn write(user_data: &Path, socket: &str, projects_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(user_data)?;
    let path = user_data.join("engine.json");
    let tmp = user_data.join("engine.json.tmp");
    let body = json!({ "socket": socket, "pid": std::process::id(), "projectsDir": projects_dir.to_string_lossy() });
    std::fs::write(&tmp, serde_json::to_vec_pretty(&body)?)?;
    std::fs::rename(&tmp, &path)?;
    *WRITTEN.lock().unwrap() = Some(path);
    Ok(())
}

/// Removes `engine.json` if it still names this process (another engine may have started
/// since and written its own).
pub fn remove() {
    let Some(path) = WRITTEN.lock().unwrap().take() else { return };
    let ours = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).is_some_and(|v| v["pid"].as_u64() == Some(std::process::id() as u64));
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_json_is_written_and_removed_only_if_ours() {
        let dir = std::env::temp_dir().join(format!("studio-discovery-{}", std::process::id()));
        write(&dir, r"\\.\pipe\studio-test", Path::new("C:/Projects")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("engine.json")).unwrap()).unwrap();
        assert_eq!((v["socket"].as_str(), v["pid"].as_u64(), v["projectsDir"].as_str()), (Some(r"\\.\pipe\studio-test"), Some(std::process::id() as u64), Some("C:/Projects")));
        remove();
        assert!(!dir.join("engine.json").exists());
        // Another engine's file stays.
        write(&dir, "x", Path::new("y")).unwrap();
        std::fs::write(dir.join("engine.json"), r#"{ "pid": 1 }"#).unwrap();
        remove();
        assert!(dir.join("engine.json").exists());
        let _ = std::fs::remove_dir_all(dir);
        assert!(default_user_data().ends_with("Studio"));
    }
}
