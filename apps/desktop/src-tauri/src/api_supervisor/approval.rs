use crate::api_supervisor::frame::{error_envelope, ok_envelope};
use crate::api_supervisor::sink::EventSink;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

pub const APPROVAL_RESULT_TYPE: &str = "approval_result";
pub const APPROVAL_REQUEST_TYPE: &str = "approval_request";

const MAX_PROBLEMS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub commands: Vec<String>,
}

impl ApprovalRequest {
    fn from_frame(frame: &Value) -> Option<Self> {
        let text = |key: &str| frame.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: text("id")?,
            project_id: text("projectId").unwrap_or_default(),
            session_id: text("sessionId").unwrap_or_default(),
            commands: frame
                .get("commands")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    fn matches(&self, project_id: &str, session_id: &str, commands: &[String]) -> bool {
        self.project_id == project_id
            && self.session_id == session_id
            && self.commands_match(commands)
    }

    fn commands_match(&self, commands: &[String]) -> bool {
        canonical(&self.commands) == canonical(commands)
    }
}

fn canonical(commands: &[String]) -> Vec<String> {
    let mut out: Vec<String> = commands.iter().map(|item| item.trim().to_string()).collect();
    out.sort();
    out
}

pub struct ApprovalClient {
    writer: Mutex<UnixStream>,
    pending: Mutex<VecDeque<ApprovalRequest>>,
    problems: Mutex<VecDeque<String>>,
}

impl ApprovalClient {
    pub fn connect(path: &Path, sink: Arc<dyn EventSink>) -> Result<Arc<Self>, String> {
        let stream = UnixStream::connect(path).map_err(|err| {
            format!(
                "cannot reach the worker approval socket {}: {err}",
                path.display()
            )
        })?;
        let reader = stream
            .try_clone()
            .map_err(|err| format!("cannot clone the approval socket: {err}"))?;
        let client = Arc::new(Self {
            writer: Mutex::new(stream),
            pending: Mutex::new(VecDeque::new()),
            problems: Mutex::new(VecDeque::new()),
        });
        let reader_client = Arc::clone(&client);
        thread::spawn(move || read_loop(reader, reader_client, sink));
        Ok(client)
    }

    pub fn approve(
        &self,
        request_id: Option<&str>,
        project_id: &str,
        session_id: &str,
        commands: &[String],
    ) -> Value {
        let index = {
            let pending = lock(&self.pending);
            match request_id {
                Some(id) => pending.iter().position(|request| request.id == id),
                None => pending
                    .iter()
                    .position(|request| request.matches(project_id, session_id, commands)),
            }
        };
        let Some(request) = index.and_then(|index| lock(&self.pending).remove(index)) else {
            return error_envelope(
                "NotFound",
                format!(
                    "No pending shell approval request for project '{project_id}', session '{session_id}'.{}",
                    self.problems_suffix()
                ),
            );
        };

        let frame = json!({
            "type": APPROVAL_RESULT_TYPE,
            "id": request.id,
            "approved": true,
        });
        let written = {
            let mut writer = lock(&self.writer);
            writer
                .write_all(format!("{frame}\n").as_bytes())
                .and_then(|()| writer.flush())
        };
        if let Err(err) = written {
            lock(&self.pending).push_front(request);
            return error_envelope(
                "Transport",
                format!("Failed to send the shell approval to the worker: {err}"),
            );
        }

        ok_envelope(json!({ "requestId": request.id, "approved": true }))
    }

    pub fn last_problem(&self) -> Option<String> {
        lock(&self.problems).back().cloned()
    }

    fn note_problem(&self, problem: String) {
        let mut problems = lock(&self.problems);
        if problems.len() == MAX_PROBLEMS {
            problems.pop_front();
        }
        problems.push_back(problem);
    }

    fn problems_suffix(&self) -> String {
        match self.last_problem() {
            Some(problem) => format!(" Last control-channel problem: {problem}"),
            None => String::new(),
        }
    }
}

fn read_loop(stream: UnixStream, client: Arc<ApprovalClient>, sink: Arc<dyn EventSink>) {
    for line in BufReader::new(stream).lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(err) => {
                client.note_problem(format!("malformed frame: {err}"));
                continue;
            }
        };
        match frame.get("type").and_then(Value::as_str) {
            Some(APPROVAL_REQUEST_TYPE) => match ApprovalRequest::from_frame(&frame) {
                Some(request) => {
                    lock(&client.pending).push_back(request);
                    sink.emit_shell_approval_request(frame);
                }
                None => client.note_problem(format!("approval_request missing fields: {frame}")),
            },
            other => client.note_problem(format!("unknown approval frame type: {other:?}")),
        }
    }
    lock(&client.pending).clear();
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matching_prefers_oldest_equal_tuple_and_accepts_explicit_ids() {
        let oldest = ApprovalRequest {
            id: "a".to_string(),
            project_id: "p".to_string(),
            session_id: "s".to_string(),
            commands: vec!["ls -la".to_string()],
        };
        let newer = ApprovalRequest {
            id: "b".to_string(),
            project_id: "p".to_string(),
            session_id: "s".to_string(),
            commands: vec!["ls -la".to_string()],
        };
        assert!(oldest.matches("p", "s", &["  ls -la ".to_string()]));
        assert!(!newer.matches("p", "other", &["ls -la".to_string()]));
        assert!(!newer.matches("p", "s", &["ls".to_string()]));
        assert!(!newer.matches("p", "s", &[]));
    }

    #[test]
    fn request_frames_require_an_id_and_tolerate_missing_optional_fields() {
        let parsed = ApprovalRequest::from_frame(&json!({
            "type": "approval_request",
            "id": "req-1",
            "commands": ["ls", 7]
        }));
        assert_eq!(
            parsed,
            Some(ApprovalRequest {
                id: "req-1".to_string(),
                project_id: String::new(),
                session_id: String::new(),
                commands: vec!["ls".to_string()],
            })
        );
        assert_eq!(
            ApprovalRequest::from_frame(&json!({ "type": "approval_request" })),
            None
        );
    }
}
