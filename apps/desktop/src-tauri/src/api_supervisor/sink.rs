use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const AGENT_EVENT: &str = "agent-event";
pub const SHELL_APPROVAL_REQUEST_EVENT: &str = "shell-approval-request";

pub trait EventSink: Send + Sync {
    fn emit_agent_event(&self, payload: Value);
    fn emit_shell_approval_request(&self, payload: Value);
}

pub struct AppEventSink {
    app: AppHandle,
}

impl AppEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for AppEventSink {
    fn emit_agent_event(&self, payload: Value) {
        let _ = self.app.emit(AGENT_EVENT, payload);
    }

    fn emit_shell_approval_request(&self, payload: Value) {
        let _ = self.app.emit(SHELL_APPROVAL_REQUEST_EVENT, payload);
    }
}

pub fn as_sink(app: AppHandle) -> Arc<dyn EventSink> {
    Arc::new(AppEventSink::new(app))
}
