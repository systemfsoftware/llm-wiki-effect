use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SURFACE_HEADER: &str = "x-llm-wiki-surface";
pub const SURFACE_VALUE: &str = "supervisor";

pub const WORKER_NOT_RUNNING: &str = "WorkerNotRunning";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Text(String),
    Number(i64),
}

impl RequestId {
    pub fn key(&self) -> String {
        match self {
            RequestId::Text(value) => value.clone(),
            RequestId::Number(value) => value.to_string(),
        }
    }

    fn to_value(&self) -> Value {
        match self {
            RequestId::Text(value) => Value::String(value.clone()),
            RequestId::Number(value) => json!(value),
        }
    }
}

#[derive(Debug, Serialize)]
struct RequestFrame<'a> {
    #[serde(rename = "_tag")]
    kind: &'static str,
    id: &'a str,
    tag: &'a str,
    payload: &'a Value,
    headers: &'a [(String, String)],
}

#[derive(Debug, Deserialize)]
#[cfg(test)]
pub struct RequestFrameOwned {
    #[serde(rename = "_tag")]
    pub kind: String,
    pub id: RequestId,
    pub tag: String,
    pub payload: Value,
    pub headers: Vec<(String, String)>,
}

pub fn encode_request(id: &str, tag: &str, payload: &Value, headers: &[(String, String)]) -> String {
    let frame = RequestFrame {
        kind: "Request",
        id,
        tag,
        payload,
        headers,
    };
    let mut encoded =
        serde_json::to_string(&frame).unwrap_or_else(|_| String::from("{\"_tag\":\"Request\"}"));
    encoded.push('\n');
    encoded
}

pub fn encode_proxied_request(id: &str, tag: &str, payload: &Value) -> String {
    let headers = vec![(SURFACE_HEADER.to_string(), SURFACE_VALUE.to_string())];
    encode_request(id, tag, payload, &headers)
}

pub fn encode_ack(request_id: &RequestId) -> String {
    let frame = json!({ "_tag": "Ack", "requestId": request_id.to_value() });
    format!("{frame}\n")
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerFrame {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: ExitFrame,
    },
    Defect {
        defect: Value,
    },
    ClientProtocolError {
        error: Value,
    },
    Pong,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ExitFrame {
    Success {
        #[serde(default)]
        value: Value,
    },
    Failure {
        cause: Vec<CauseEntry>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum CauseEntry {
    Fail { error: Value },
    Die { defect: Value },
    Interrupt {
        #[serde(rename = "fiberId", default)]
        fiber_id: Value,
    },
}

#[cfg(test)]
pub fn decode_request(line: &str) -> Result<RequestFrameOwned, String> {
    serde_json::from_str::<RequestFrameOwned>(line).map_err(|err| format!("malformed frame: {err}"))
}

pub fn decode_server_frame(line: &str) -> Result<ServerFrame, String> {
    serde_json::from_str::<ServerFrame>(line).map_err(|err| format!("malformed frame: {err}"))
}

pub fn ok_envelope(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

pub fn error_envelope(tag: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": { "_tag": tag, "message": message.into() } })
}

pub fn exit_envelope(exit: &ExitFrame) -> Value {
    match exit {
        ExitFrame::Success { value } => ok_envelope(value.clone()),
        ExitFrame::Failure { cause } => {
            let (tag, message) = cause_error(cause);
            error_envelope(&tag, message)
        }
    }
}

pub fn cause_error(cause: &[CauseEntry]) -> (String, String) {
    for entry in cause {
        if let CauseEntry::Fail { error } = entry {
            let tag = error
                .get("_tag")
                .and_then(Value::as_str)
                .unwrap_or("Defect")
                .to_string();
            let message = match error.get("message").and_then(Value::as_str) {
                Some(message) => message.to_string(),
                None => error.to_string(),
            };
            return (tag, message);
        }
    }
    for entry in cause {
        match entry {
            CauseEntry::Die { defect } => {
                let message = defect
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| defect.to_string());
                return ("Defect".to_string(), message);
            }
            CauseEntry::Interrupt { fiber_id } => {
                return (
                    "Interrupt".to_string(),
                    format!("request interrupted ({fiber_id})"),
                );
            }
            CauseEntry::Fail { .. } => {}
        }
    }
    (
        "Defect".to_string(),
        "request failed without a cause".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST_FIXTURE: &str =
        include_str!("../../../../../packages/protocol/src/fixtures/request.ndjson");
    const EMBED_TEXTS_FIXTURE: &str =
        include_str!("../../../../../packages/protocol/src/fixtures/embed-texts.ndjson");
    const CHUNK_FIXTURE: &str =
        include_str!("../../../../../packages/protocol/src/fixtures/chunk.ndjson");
    const EXIT_FIXTURE: &str =
        include_str!("../../../../../packages/protocol/src/fixtures/exit.ndjson");
    const DEFECT_FIXTURE: &str =
        include_str!("../../../../../packages/protocol/src/fixtures/defect.ndjson");

    #[test]
    fn request_fixtures_round_trip_byte_identically() {
        for fixture in [REQUEST_FIXTURE, EMBED_TEXTS_FIXTURE] {
            let decoded = decode_request(fixture).expect("fixture must decode");
            assert_eq!(decoded.kind, "Request");
            let encoded = encode_request(
                &decoded.id.key(),
                &decoded.tag,
                &decoded.payload,
                &decoded.headers,
            );
            assert_eq!(encoded, fixture, "encode∘decode must be byte-identical");
            assert!(encoded.ends_with('\n'), "frames are newline-terminated");
        }
    }

    #[test]
    fn proxied_requests_carry_the_supervisor_surface_header() {
        let payload = json!({ "projectId": "current", "query": "attention", "topK": 10 });
        let line = encode_proxied_request("7", "search", &payload);
        let decoded = decode_request(&line).expect("proxied frame must decode");

        assert_eq!(decoded.tag, "search");
        assert_eq!(decoded.id.key(), "7");
        assert_eq!(decoded.payload, payload);
        assert_eq!(
            decoded.headers,
            vec![(SURFACE_HEADER.to_string(), SURFACE_VALUE.to_string())]
        );
    }

    #[test]
    fn chunk_and_exit_fixtures_decode_into_typed_frames() {
        match decode_server_frame(CHUNK_FIXTURE).expect("chunk fixture") {
            ServerFrame::Chunk { request_id, values } => {
                assert_eq!(request_id.key(), "2");
                assert_eq!(values.len(), 1);
                assert_eq!(values[0]["type"], "meta");
                assert_eq!(
                    encode_ack(&request_id),
                    "{\"_tag\":\"Ack\",\"requestId\":\"2\"}\n"
                );
            }
            other => panic!("expected Chunk, got {other:?}"),
        }

        match decode_server_frame(EXIT_FIXTURE).expect("exit fixture") {
            ServerFrame::Exit { request_id, exit } => {
                assert_eq!(request_id.key(), "2");
                let (tag, message) = match &exit {
                    ExitFrame::Failure { cause } => cause_error(cause),
                    ExitFrame::Success { .. } => panic!("fixture is a failure exit"),
                };
                assert_eq!(tag, "ChatCancelled");
                assert_eq!(message, "Agent turn cancelled");
                let envelope = exit_envelope(&exit);
                assert_eq!(envelope["ok"], json!(false));
                assert_eq!(envelope["error"]["_tag"], json!("ChatCancelled"));
            }
            other => panic!("expected Exit, got {other:?}"),
        }
    }

    #[test]
    fn success_exits_and_defects_map_to_well_formed_envelopes() {
        let success = decode_server_frame(
            "{\"_tag\":\"Exit\",\"requestId\":\"9\",\"exit\":{\"_tag\":\"Success\",\"value\":{\"ok\":true}}}\n",
        )
        .expect("success exit");
        match success {
            ServerFrame::Exit { exit, .. } => {
                let envelope = exit_envelope(&exit);
                assert_eq!(envelope, json!({ "ok": true, "value": { "ok": true } }));
            }
            other => panic!("expected Exit, got {other:?}"),
        }

        match decode_server_frame(DEFECT_FIXTURE).expect("defect fixture") {
            ServerFrame::Defect { defect } => {
                assert_eq!(defect["message"], "stream interrupted");
            }
            other => panic!("expected Defect, got {other:?}"),
        }
    }

    #[test]
    fn bodyless_success_and_defect_causes_still_produce_tag_and_message() {
        let exit =
            decode_server_frame("{\"_tag\":\"Exit\",\"requestId\":1,\"exit\":{\"_tag\":\"Success\"}}\n")
                .expect("bodyless success");
        match exit {
            ServerFrame::Exit { request_id, exit } => {
                assert_eq!(request_id.key(), "1");
                assert_eq!(exit_envelope(&exit), json!({ "ok": true, "value": null }));
            }
            other => panic!("expected Exit, got {other:?}"),
        }

        let defect_exit = decode_server_frame(
            "{\"_tag\":\"Exit\",\"requestId\":\"3\",\"exit\":{\"_tag\":\"Failure\",\"cause\":[{\"_tag\":\"Die\",\"defect\":{\"message\":\"boom\"}}]}}\n",
        )
        .expect("die exit");
        match defect_exit {
            ServerFrame::Exit { exit, .. } => {
                let envelope = exit_envelope(&exit);
                assert_eq!(envelope["error"]["_tag"], json!("Defect"));
                assert_eq!(envelope["error"]["message"], json!("boom"));
            }
            other => panic!("expected Exit, got {other:?}"),
        }
    }

    #[test]
    fn unknown_tags_and_malformed_lines_are_reported_not_panicked() {
        assert!(matches!(
            decode_server_frame("{\"_tag\":\"SomethingNew\",\"x\":1}\n").expect("unknown tag"),
            ServerFrame::Unknown
        ));
        assert!(matches!(
            decode_server_frame("{\"_tag\":\"Pong\"}\n").expect("pong"),
            ServerFrame::Pong
        ));
        assert!(decode_server_frame("not json").is_err());
        assert!(decode_request("{\"_tag\":\"Request\"}").is_err());
    }

    #[test]
    fn envelopes_always_carry_both_error_fields() {
        let envelope = error_envelope(WORKER_NOT_RUNNING, "worker not running");
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["_tag"], json!(WORKER_NOT_RUNNING));
        assert_eq!(envelope["error"]["message"], json!("worker not running"));
    }
}
