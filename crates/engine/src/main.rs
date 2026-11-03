//! studio-engine: owns the project and does all heavy work. Step 0 scope:
//! answers JSON-RPC over a local socket and writes preview frames into the shared ring.

mod audio;
mod audio_out;
mod cpu;
mod discovery;
mod doc;
mod edits;
mod events;
mod export;
mod jobs;
mod pattern;
mod playback;
mod preview;
mod rpc;
mod server;
mod stab;

use std::io::Write as _;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

struct Args {
    socket: String,
    ring: PathBuf,
    max_width: u32,
    max_height: u32,
    exit_on_stdin_eof: bool,
    projects_dir: PathBuf,
    /// Where `engine.json` goes, for MCP clients to find the engine.
    user_data: PathBuf,
    user_data_given: bool,
}

/// ~/Documents/Studio Projects on every platform (the app passes the OS's own
/// Documents folder; this is the fallback for running the engine alone).
fn default_projects_dir() -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Documents").join("Studio Projects")
}

fn default_socket() -> String {
    if cfg!(windows) {
        r"\\.\pipe\studio-engine".to_string()
    } else {
        std::env::temp_dir().join("studio-engine.sock").to_string_lossy().into_owned()
    }
}

fn parse_args() -> anyhow::Result<Args> {
    let mut args = Args {
        socket: default_socket(),
        ring: std::env::temp_dir().join("studio-preview.ring"),
        max_width: 1080,
        max_height: 1920,
        exit_on_stdin_eof: false,
        projects_dir: default_projects_dir(),
        user_data: discovery::default_user_data(),
        user_data_given: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| anyhow::anyhow!("{flag} needs a value"));
        match flag.as_str() {
            "--socket" => args.socket = value()?,
            "--ring" => args.ring = PathBuf::from(value()?),
            "--max-width" => args.max_width = value()?.parse()?,
            "--max-height" => args.max_height = value()?.parse()?,
            "--exit-on-stdin-eof" => args.exit_on_stdin_eof = true,
            "--projects-dir" => args.projects_dir = PathBuf::from(value()?),
            "--user-data" => {
                args.user_data = PathBuf::from(value()?);
                args.user_data_given = true;
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    Ok(args)
}

/// Every process the engine starts (FFmpeg) ends when the engine ends, however it ends: a
/// clean exit, a crash or being killed. Windows otherwise keeps children running after their
/// parent is gone, and an FFmpeg left writing into a pipe nobody reads waits there for good.
/// The engine joins a job that kills its members when its last handle closes, which happens
/// only when the engine itself ends; the processes it starts join the job too.
#[cfg(windows)]
fn end_children_with_engine() {
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: plain Win32 calls on a job handle created here and kept open for the engine's life.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[engine] FFmpeg may outlive the engine: no job ({})", std::io::Error::last_os_error());
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        if set == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!("[engine] FFmpeg may outlive the engine: {}", std::io::Error::last_os_error());
        }
    }
}

/// Elsewhere nothing is left waiting: an FFmpeg writing to the engine stops at the broken pipe
/// when the engine ends, and one writing a file finishes it.
#[cfg(not(windows))]
fn end_children_with_engine() {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args()?;
    end_children_with_engine();

    // Windows sleeps in ~15.6 ms steps by default, which would wreck frame pacing.
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Media::timeBeginPeriod(1);
    }

    // Thumbnails, waveforms and proxies shared by every project: with the app's own data when
    // it's given (tests get their own), else the machine's local app data.
    let _ = jobs::SHARED.set(if args.user_data_given { args.user_data.join("media-cache") } else { discovery::default_media_cache() });
    let engine = Arc::new(rpc::Engine::new(&args.ring, args.max_width, args.max_height, args.projects_dir.clone())?);
    println!(
        "[engine] studio-engine {} pid {} socket {} ring {} ({}x{} max)",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        args.socket,
        args.ring.display(),
        args.max_width,
        args.max_height
    );

    if args.exit_on_stdin_eof {
        // The interface holds our stdin open; when it goes away, so do we.
        std::thread::spawn(|| {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 64];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // The parent may be gone with our stdout: println! would panic on the
                        // broken pipe and the engine would never exit, so the note may fail quietly.
                        let _ = writeln!(std::io::stdout(), "[engine] parent closed stdin, exiting");
                        discovery::remove();
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                }
            }
        });
    }

    // MCP clients find the engine through engine.json; it goes again when the engine does.
    if let Err(e) = discovery::write(&args.user_data, &args.socket, &args.projects_dir) {
        println!("[engine] couldn't write engine.json in {}: {e}", args.user_data.display());
    }
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            discovery::remove();
            std::process::exit(0);
        }
    });
    let served = server::serve(args.socket, engine).await;
    discovery::remove();
    served
}
