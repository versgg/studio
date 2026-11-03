//! Engine → interface notifications. Any thread can emit; every connected client gets it.

use serde_json::Value;
use studio_engine_core::protocol::notification;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct Events {
    tx: broadcast::Sender<String>,
}

impl Events {
    pub fn new() -> Self {
        Self { tx: broadcast::channel(1024).0 }
    }

    pub fn emit(&self, method: &str, params: Value) {
        let _ = self.tx.send(notification(method, params));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }
}
