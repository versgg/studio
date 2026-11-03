//! Wire protocol between the interface and the engine: newline-delimited JSON-RPC 2.0.
//! One JSON object per line. Requests carry an `id`; engine notifications don't.

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub const PARSE: i64 = -32700;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, message)
    }
}

pub fn parse_request(line: &str) -> Result<Request, RpcError> {
    serde_json::from_str(line).map_err(|e| RpcError::new(RpcError::PARSE, format!("bad request: {e}")))
}

/// Serialises a response line (without the trailing newline).
pub fn response(id: &Option<Value>, result: Result<Value, RpcError>) -> String {
    let id = id.clone().unwrap_or(Value::Null);
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } }).to_string(),
    }
}

/// Serialises an engine → client notification line.
pub fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_with_and_without_params() {
        let r = parse_request(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).unwrap();
        assert_eq!(r.method, "ping");
        assert_eq!(r.id, Some(json!(1)));
        assert!(r.params.is_null());
        let r = parse_request(r#"{"jsonrpc":"2.0","id":"a","method":"preview.start","params":{"fps":30}}"#).unwrap();
        assert_eq!(r.params["fps"], 30);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_request("not json").unwrap_err().code, RpcError::PARSE);
    }

    #[test]
    fn serialises_results_and_errors() {
        let ok: Value = serde_json::from_str(&response(&Some(json!(7)), Ok(json!({"pong": true})))).unwrap();
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["result"]["pong"], true);
        let err: Value = serde_json::from_str(&response(&None, Err(RpcError::new(-32601, "nope")))).unwrap();
        assert_eq!(err["error"]["code"], -32601);
        assert!(err["id"].is_null());
    }
}
