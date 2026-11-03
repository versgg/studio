//! studio-mcp: lets Claude Code or Claude Desktop build and edit Studio projects.
//!
//! It speaks MCP over stdio and forwards each tool call to Studio's engine over the engine's
//! local socket, tagged `_actor: "claude"`. With the app open, edits land in it live; with it
//! closed, studio-mcp starts the engine headless. See docs/MCP.md.

// The tool schemas are large `json!` literals.
#![recursion_limit = "512"]

mod engine;
mod paths;
mod permissions;
mod server;
mod summary;
mod tools;

use rmcp::ServiceExt;
use std::sync::Arc;

const HELP: &str = "studio-mcp: Studio's MCP server (stdio)

Usage:
  studio-mcp                 Run as an MCP server on stdin/stdout (what Claude starts)
  studio-mcp --print-config  Print the commands to connect Claude Code and Claude Desktop
  studio-mcp --version

Environment:
  STUDIO_USER_DATA     Studio's user data folder (where the app's engine.json is)
  STUDIO_ENGINE        Path of studio-engine, for running headless (default: next to this binary)
  STUDIO_PROJECTS_DIR  Projects folder for a headless engine (default: Documents/Studio Projects)
";

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn print_config() {
    let exe = std::env::current_exe().map(|p| p.canonicalize().unwrap_or(p)).map(|p| paths::display_path(&p)).unwrap_or_else(|_| "studio-mcp".into());
    let this = std::path::PathBuf::from(&exe);
    let engine_env = paths::real_env("STUDIO_ENGINE");
    let beside = this.parent().map(|d| d.join(paths::engine_file_name())).filter(|p| p.is_file());
    let engine = paths::engine_exe(&paths::real_env, Some(&this));
    let quoted = if exe.contains(' ') || cfg!(windows) { format!("\"{exe}\"") } else { exe.clone() };
    let env_flag = engine_env.as_ref().map(|e| format!(" -e STUDIO_ENGINE=\"{e}\"")).unwrap_or_default();
    let env_json = engine_env.as_ref().map(|e| format!(",\n      \"env\": {{ \"STUDIO_ENGINE\": {} }}", json_string(e))).unwrap_or_default();
    let desktop_config = if cfg!(windows) {
        r"%APPDATA%\Claude\claude_desktop_config.json"
    } else if cfg!(target_os = "macos") {
        "~/Library/Application Support/Claude/claude_desktop_config.json"
    } else {
        "~/.config/Claude/claude_desktop_config.json"
    };
    println!("# Claude Code (add --scope user to have it in every project)");
    println!("claude mcp add studio{env_flag} -- {quoted}");
    println!();
    println!("# Claude Desktop: add this to {desktop_config}, then restart Claude Desktop");
    println!("{{\n  \"mcpServers\": {{\n    \"studio\": {{\n      \"command\": {}{env_json}\n    }}\n  }}\n}}", json_string(&exe));
    println!();
    match (&beside, &engine) {
        (Some(_), _) => println!("# With Studio closed, Claude runs the engine next to it headless."),
        (None, Some(e)) => println!("# With Studio closed, Claude runs {} headless.", paths::display_path(e)),
        (None, None) => println!("# Note: no studio-engine next to studio-mcp, so with Studio closed there is nothing to run headless. Put studio-mcp beside studio-engine, or set STUDIO_ENGINE."),
    }
}

async fn serve() -> anyhow::Result<()> {
    let link = Arc::new(engine::Link::new());
    {
        // If Studio is already open, say hello now so its title bar shows Claude.
        let link = link.clone();
        tokio::spawn(async move { link.attach_if_running().await });
    }
    let result = match server::Studio::new(link.clone()).serve(rmcp::transport::stdio()).await {
        Ok(service) => {
            tokio::select! {
                r = service.waiting() => r.map(|_| ()).map_err(anyhow::Error::from),
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
        Err(e) => Err(anyhow::anyhow!("MCP start failed: {e}")),
    };
    link.shutdown().await;
    result
}

fn main() -> std::process::ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--print-config") => {
            print_config();
            return std::process::ExitCode::SUCCESS;
        }
        Some("--version" | "-V") => {
            println!("studio-mcp {}", engine::VERSION);
            return std::process::ExitCode::SUCCESS;
        }
        Some("--help" | "-h") => {
            print!("{HELP}");
            return std::process::ExitCode::SUCCESS;
        }
        Some(other) => {
            eprint!("Unknown argument {other}\n\n{HELP}");
            return std::process::ExitCode::from(2);
        }
        None => {}
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("studio-mcp: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match runtime.block_on(serve()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("studio-mcp: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
