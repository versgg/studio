//! Local socket server: a named pipe on Windows, a Unix domain socket elsewhere.
//! Each connection speaks newline-delimited JSON-RPC (see engine-core::protocol).

use crate::rpc::{self, Engine};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use studio_engine_core::protocol::{parse_request, response};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

#[cfg(windows)]
pub async fn serve(path: String, engine: Arc<Engine>) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&path)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(&path)?;
        spawn_connection(connected, engine.clone());
    }
}

#[cfg(unix)]
pub async fn serve(path: String, engine: Arc<Engine>) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    loop {
        let (stream, _) = listener.accept().await?;
        spawn_connection(stream, engine.clone());
    }
}

/// Numbers connections, so the engine can tell the app's window from MCP clients.
static NEXT: AtomicU64 = AtomicU64::new(1);

fn spawn_connection<S>(stream: S, engine: Arc<Engine>)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    tokio::spawn(async move {
        let conn = NEXT.fetch_add(1, Ordering::Relaxed);
        println!("[engine] client {conn} connected");
        engine.connect(conn);
        if let Err(e) = handle(stream, engine.clone(), conn).await {
            println!("[engine] connection error: {e}");
        }
        engine.disconnect(conn);
        println!("[engine] client {conn} disconnected");
    });
}

async fn handle<S: AsyncRead + AsyncWrite>(stream: S, engine: Arc<Engine>, conn: u64) -> anyhow::Result<()> {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();
    let mut events = engine.events.subscribe();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                if line.trim().is_empty() {
                    continue;
                }
                let reply = match parse_request(&line) {
                    Ok(req) => {
                        // Handlers can block (probing, mixing), so keep them off the I/O threads.
                        let engine = engine.clone();
                        let (method, params) = (req.method.clone(), req.params);
                        let result = tokio::task::spawn_blocking(move || rpc::dispatch_on(&engine, conn, &method, params)).await?;
                        if req.id.is_none() {
                            continue; // a notification from the client: no reply
                        }
                        response(&req.id, result)
                    }
                    Err(e) => response(&None, Err(e)),
                };
                writer.write_all(reply.as_bytes()).await?;
                writer.write_all(b"\n").await?;
            }
            event = events.recv() => {
                match event {
                    Ok(line) => {
                        writer.write_all(line.as_bytes()).await?;
                        writer.write_all(b"\n").await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
                }
            }
        }
    }
}
