mod approval;
mod frame;
mod sink;
mod worker_socket;

pub use frame::WORKER_NOT_RUNNING;
pub use sink::EventSink;

use approval::ApprovalClient;
use frame::{
    decode_server_frame, encode_ack, encode_proxied_request, error_envelope, exit_envelope,
    ExitFrame, ServerFrame,
};
use interprocess::TryClone;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const EXPECTED_PROTOCOL_VERSION: u64 = 1;
const READY_PREFIX: &str = "ready ";
const READY_DEADLINE: Duration = Duration::from_secs(30);
const CALL_IDLE_DEADLINE: Duration = Duration::from_secs(300);
const EXIT_DEADLINE: Duration = Duration::from_secs(5);
const MAX_RESTARTS: u32 = 3;
const MAX_WORKER_LOG_LINES: usize = 40;
const SOCKET_ENV: &str = "LLM_WIKI_SOCKET_PATH";
const APP_STATE_FLAG: &str = "--app-state";
const APPROVAL_SOCKET_FLAG: &str = "--approval-socket";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStatus {
    Starting,
    Running,
    Restarting,
    Failed,
    MissingRuntime,
}

impl WorkerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkerStatus::Starting => "starting",
            WorkerStatus::Running => "running",
            WorkerStatus::Restarting => "restarting",
            WorkerStatus::Failed => "failed",
            WorkerStatus::MissingRuntime => "missing-runtime",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyHandshake {
    protocol_version: u64,
    mode: String,
    socket_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub app_state: PathBuf,
    pub rpc_socket: PathBuf,
    pub approval_socket: PathBuf,
    pub extra_env: Vec<(String, String)>,
}

#[derive(Debug)]
struct SpawnFailure {
    status: WorkerStatus,
    message: String,
}

enum Incoming {
    Chunk(Vec<Value>),
    Exit(ExitFrame),
    Defect(Value),
    Closed(String),
}

pub struct Supervisor {
    writer: Mutex<worker_socket::Stream>,
    pending: Mutex<HashMap<String, SyncSender<Incoming>>>,
    approvals: Mutex<Option<Arc<ApprovalClient>>>,
    approval_socket: PathBuf,
    approval_error: Mutex<Option<String>>,
    socket_path: String,
    sink: Arc<dyn EventSink>,
    next_id: AtomicU64,
    child: Mutex<Child>,
    exit_rx: Mutex<Receiver<()>>,
    shutting_down: AtomicBool,
}

impl Supervisor {
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn request(
        &self,
        op: &str,
        payload: Value,
        mut on_chunk: Option<&mut dyn FnMut(Value)>,
    ) -> Value {
        if self.shutting_down.load(Ordering::SeqCst) {
            return error_envelope(WORKER_NOT_RUNNING, "The LLM Wiki worker is shutting down.");
        }
        let id = format!("{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = mpsc::sync_channel::<Incoming>(8);
        lock(&self.pending).insert(id.clone(), sender);
        if let Err(err) = self.write_line(&encode_proxied_request(&id, op, &payload)) {
            lock(&self.pending).remove(&id);
            return error_envelope(WORKER_NOT_RUNNING, err);
        }
        loop {
            match receiver.recv_timeout(CALL_IDLE_DEADLINE) {
                Ok(Incoming::Chunk(values)) => {
                    if let Some(callback) = on_chunk.as_mut() {
                        for value in values {
                            callback(value)
                        }
                    }
                }
                Ok(Incoming::Exit(exit)) => return exit_envelope(&exit),
                Ok(Incoming::Defect(defect)) => {
                    lock(&self.pending).remove(&id);
                    return error_envelope("Defect", defect_message(&defect));
                }
                Ok(Incoming::Closed(reason)) => return error_envelope(WORKER_NOT_RUNNING, reason),
                Err(RecvTimeoutError::Timeout) => {
                    lock(&self.pending).remove(&id);
                    return error_envelope(
                        "Timeout",
                        format!(
                            "The worker did not answer '{op}' within {}s.",
                            CALL_IDLE_DEADLINE.as_secs()
                        ),
                    );
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return error_envelope(
                        WORKER_NOT_RUNNING,
                        "The worker connection closed before the request completed.",
                    )
                }
            }
        }
    }

    pub fn approve(
        &self,
        request_id: Option<&str>,
        project_id: &str,
        session_id: &str,
        commands: &[String],
    ) -> Value {
        match self.approvals() {
            Ok(client) => client.approve(request_id, project_id, session_id, commands),
            Err(message) => error_envelope("Transport", message),
        }
    }

    pub fn wait_for_exit(&self) {
        let _ = lock(&self.exit_rx).recv();
    }

    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = worker_socket::shutdown(&lock(&self.writer));
        let _ = lock(&self.exit_rx).recv_timeout(EXIT_DEADLINE);
    }

    fn approvals(&self) -> Result<Arc<ApprovalClient>, String> {
        if let Some(client) = lock(&self.approvals).clone() {
            return Ok(client);
        }
        let client = ApprovalClient::connect(&self.approval_socket, Arc::clone(&self.sink))
            .map_err(|err| {
                *lock(&self.approval_error) = Some(err.clone());
                err
            })?;
        *lock(&self.approvals) = Some(Arc::clone(&client));
        Ok(client)
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut writer = lock(&self.writer);
        writer
            .write_all(line.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|err| format!("Failed to write to the worker socket: {err}"))
    }

    fn take_pending(&self, id: &str) -> Option<SyncSender<Incoming>> {
        lock(&self.pending).remove(id)
    }

    fn fail_pending(&self, build: impl Fn() -> Incoming) {
        let drained: Vec<SyncSender<Incoming>> =
            lock(&self.pending).drain().map(|(_, sink)| sink).collect();
        for sink in drained {
            let _ = sink.send(build());
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn defect_message(defect: &Value) -> String {
    defect
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| defect.to_string())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn next_restart(restarts_done: u32) -> Option<u32> {
    let next = restarts_done + 1;
    (next <= MAX_RESTARTS).then_some(next)
}

fn push_worker_log(lines: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let mut lines = lock(lines);
    if lines.len() == MAX_WORKER_LOG_LINES {
        lines.pop_front();
    }
    lines.push_back(line);
}

fn worker_log_suffix(lines: &Arc<Mutex<VecDeque<String>>>) -> String {
    let lines = lock(lines);
    if lines.is_empty() {
        return String::new();
    }
    format!(
        " Worker output: {}",
        lines.iter().cloned().collect::<Vec<String>>().join(" | ")
    )
}

fn parse_ready(line: &str) -> Result<ReadyHandshake, String> {
    let body = line
        .strip_prefix(READY_PREFIX)
        .ok_or_else(|| format!("worker ready line is malformed: {line}"))?;
    serde_json::from_str::<ReadyHandshake>(body)
        .map_err(|err| format!("worker ready handshake is malformed: {err}"))
}

fn spawn_worker(
    spec: &WorkerSpec,
    sink: Arc<dyn EventSink>,
) -> Result<Arc<Supervisor>, SpawnFailure> {
    if let Err(err) = worker_socket::clear_stale_socket(&spec.rpc_socket) {
        if err.kind() != std::io::ErrorKind::NotFound {
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!(
                    "Cannot clear the stale worker socket {}: {err}",
                    spec.rpc_socket.display()
                ),
            });
        }
    }
    if let Err(err) = worker_socket::clear_stale_socket(&spec.approval_socket) {
        if err.kind() != std::io::ErrorKind::NotFound {
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!(
                    "Cannot clear the stale approval socket {}: {err}",
                    spec.approval_socket.display()
                ),
            });
        }
    }

    let mut command = Command::new(&spec.node);
    command
        .arg(&spec.entry)
        .arg(APP_STATE_FLAG)
        .arg(&spec.app_state)
        .arg(APPROVAL_SOCKET_FLAG)
        .arg(&spec.approval_socket)
        .env(SOCKET_ENV, &spec.rpc_socket)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &spec.extra_env {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|err| SpawnFailure {
        status: WorkerStatus::MissingRuntime,
        message: format!(
            "Cannot start the LLM Wiki worker with {}: {err}",
            spec.node.display()
        ),
    })?;

    let worker_log = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let (ready_tx, ready_rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        let worker_log = Arc::clone(&worker_log);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.starts_with(READY_PREFIX) {
                    let _ = ready_tx.send(line);
                } else {
                    push_worker_log(&worker_log, format!("stdout: {line}"));
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let worker_log = Arc::clone(&worker_log);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                push_worker_log(&worker_log, format!("stderr: {line}"));
            }
        });
    }

    let handshake = match ready_rx.recv_timeout(READY_DEADLINE) {
        Ok(line) => match parse_ready(&line) {
            Ok(handshake) => handshake,
            Err(message) => {
                let _ = child.kill();
                return Err(SpawnFailure {
                    status: WorkerStatus::Failed,
                    message: format!("{message}{}", worker_log_suffix(&worker_log)),
                });
            }
        },
        Err(RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!(
                    "The worker did not report ready within {}s.{}",
                    READY_DEADLINE.as_secs(),
                    worker_log_suffix(&worker_log)
                ),
            });
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!(
                    "The worker exited before reporting ready.{}",
                    worker_log_suffix(&worker_log)
                ),
            });
        }
    };

    if handshake.mode != "worker" {
        let _ = child.kill();
        return Err(SpawnFailure {
            status: WorkerStatus::Failed,
            message: format!(
                "The worker reported mode '{}' instead of 'worker'.",
                handshake.mode
            ),
        });
    }
    if handshake.protocol_version != EXPECTED_PROTOCOL_VERSION {
        let _ = child.kill();
        return Err(SpawnFailure {
            status: WorkerStatus::Failed,
            message: format!(
                "Worker protocol version {} does not match the app's version {}. Rebuild the desktop bundle (`pnpm api:build`) and reopen the app.",
                handshake.protocol_version, EXPECTED_PROTOCOL_VERSION
            ),
        });
    }
    let socket_path = match handshake.socket_path {
        Some(socket_path) => socket_path,
        None => {
            let _ = child.kill();
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: "The worker ready handshake carried no socket path.".to_string(),
            });
        }
    };

    let stream = match worker_socket::connect(Path::new(&socket_path)) {
        Ok(stream) => stream,
        Err(err) => {
            let _ = child.kill();
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!(
                    "Cannot reach the worker socket {socket_path}: {err}.{}",
                    worker_log_suffix(&worker_log)
                ),
            });
        }
    };
    let reader = match stream.try_clone() {
        Ok(reader) => reader,
        Err(err) => {
            let _ = child.kill();
            return Err(SpawnFailure {
                status: WorkerStatus::Failed,
                message: format!("Cannot use the worker socket {socket_path}: {err}"),
            });
        }
    };

    let approvals = ApprovalClient::connect(&spec.approval_socket, Arc::clone(&sink)).ok();
    let approval_error = approvals.is_none().then(|| {
        format!(
            "The shell approval control socket {} is unreachable.",
            spec.approval_socket.display()
        )
    });

    let (exit_tx, exit_rx) = mpsc::channel::<()>();
    let supervisor = Arc::new(Supervisor {
        writer: Mutex::new(stream),
        pending: Mutex::new(HashMap::new()),
        approvals: Mutex::new(approvals),
        approval_socket: spec.approval_socket.clone(),
        approval_error: Mutex::new(approval_error),
        socket_path,
        sink,
        next_id: AtomicU64::new(0),
        child: Mutex::new(child),
        exit_rx: Mutex::new(exit_rx),
        shutting_down: AtomicBool::new(false),
    });
    let reader_supervisor = Arc::clone(&supervisor);
    thread::spawn(move || read_loop(BufReader::new(reader), reader_supervisor, exit_tx));
    Ok(supervisor)
}

fn read_loop(
    reader: BufReader<worker_socket::Stream>,
    supervisor: Arc<Supervisor>,
    exit: mpsc::Sender<()>,
) {
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        match decode_server_frame(&line) {
            Ok(ServerFrame::Chunk { request_id, values }) => {
                let deliverable = match lock(&supervisor.pending).get(&request_id.key()).cloned() {
                    Some(sender) => sender.send(Incoming::Chunk(values)).is_ok(),
                    None => false,
                };
                if deliverable {
                    let _ = supervisor.write_line(&encode_ack(&request_id));
                }
            }
            Ok(ServerFrame::Exit { request_id, exit }) => {
                if let Some(sender) = supervisor.take_pending(&request_id.key()) {
                    let _ = sender.send(Incoming::Exit(exit));
                }
            }
            Ok(ServerFrame::Defect { defect }) => {
                supervisor.fail_pending(|| Incoming::Defect(defect.clone()))
            }
            Ok(ServerFrame::ClientProtocolError { error }) => supervisor
                .fail_pending(|| Incoming::Closed(format!("worker protocol error: {error}"))),
            Ok(ServerFrame::Pong) | Ok(ServerFrame::Unknown) => {}
            Err(_) => {}
        }
    }
    supervisor.fail_pending(|| {
        Incoming::Closed("The worker connection closed before the request completed.".to_string())
    });
    let _ = exit.send(());
}

pub struct SupervisorState {
    supervisor: Mutex<Option<Arc<Supervisor>>>,
    status: Mutex<WorkerStatus>,
    remediation: Mutex<Option<String>>,
    sink: Mutex<Option<Arc<dyn EventSink>>>,
    shutting_down: AtomicBool,
}

impl Default for SupervisorState {
    fn default() -> Self {
        Self {
            supervisor: Mutex::new(None),
            status: Mutex::new(WorkerStatus::Starting),
            remediation: Mutex::new(None),
            sink: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }
}

impl SupervisorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> WorkerStatus {
        *lock(&self.status)
    }

    pub fn socket_path(&self) -> String {
        self.supervisor()
            .map(|supervisor| supervisor.socket_path().to_string())
            .unwrap_or_default()
    }

    pub fn call(&self, op: &str, payload: Value) -> Value {
        match self.supervisor() {
            Some(supervisor) => supervisor.request(op, payload, None),
            None => self.unavailable_envelope(),
        }
    }

    pub fn call_stream(&self, op: &str, payload: Value) -> Value {
        let Some(supervisor) = self.supervisor() else {
            return self.unavailable_envelope();
        };
        let Some(sink) = lock(&self.sink).clone() else {
            return supervisor.request(op, payload, None);
        };
        let mut session_id = String::new();
        let mut run_id = String::new();
        let mut relay = |frame: Value| {
            match frame.get("type").and_then(Value::as_str) {
                Some("meta") => {
                    session_id = frame
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    run_id = frame
                        .get("runId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
                Some("agentEvent") => {
                    if let Some(event) = frame.get("event") {
                        let payload = if run_id.is_empty() {
                            json!({ "sessionId": session_id, "event": event })
                        } else {
                            json!({ "sessionId": session_id, "runId": run_id, "event": event })
                        };
                        sink.emit_agent_event(payload);
                    }
                }
                _ => {}
            }
        };
        supervisor.request(op, payload, Some(&mut relay))
    }

    pub fn approve(
        &self,
        request_id: Option<String>,
        project_id: &str,
        session_id: &str,
        commands: Vec<String>,
    ) -> Value {
        match self.supervisor() {
            Some(supervisor) => {
                supervisor.approve(request_id.as_deref(), project_id, session_id, &commands)
            }
            None => self.unavailable_envelope(),
        }
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(supervisor) = self.supervisor() {
            supervisor.shutdown();
        }
        *lock(&self.supervisor) = None;
        *lock(&self.status) = WorkerStatus::Failed;
        *lock(&self.remediation) = Some("The LLM Wiki worker was stopped.".to_string());
    }

    fn supervisor(&self) -> Option<Arc<Supervisor>> {
        lock(&self.supervisor).clone()
    }

    fn install(&self, supervisor: Arc<Supervisor>) {
        *lock(&self.supervisor) = Some(supervisor);
    }

    fn unavailable_envelope(&self) -> Value {
        error_envelope(WORKER_NOT_RUNNING, self.unavailable_message())
    }

    fn unavailable_message(&self) -> String {
        let mut message = format!(
            "The LLM Wiki worker is not running ({}).",
            self.status().as_str()
        );
        if let Some(remediation) = lock(&self.remediation).clone() {
            message.push(' ');
            message.push_str(&remediation);
        }
        message
    }

    fn set_status(&self, status: WorkerStatus, remediation: Option<String>) {
        *lock(&self.status) = status;
        *lock(&self.remediation) = remediation;
    }

    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }
}

pub fn start(app: AppHandle) {
    let sink = sink::as_sink(app.clone());
    {
        let state = app.state::<SupervisorState>();
        *lock(&state.sink) = Some(Arc::clone(&sink));
        state.set_status(WorkerStatus::Starting, None);
    }
    thread::spawn(move || supervise_loop(app, sink));
}

fn supervise_loop(app: AppHandle, sink: Arc<dyn EventSink>) {
    let mut restarts = 0u32;
    loop {
        if app.state::<SupervisorState>().is_shutting_down() {
            return;
        }
        app.state::<SupervisorState>()
            .set_status(WorkerStatus::Starting, None);
        let spec = match worker_spec(&app) {
            Ok(spec) => spec,
            Err(failure) => {
                app.state::<SupervisorState>()
                    .set_status(failure.status, Some(failure.message));
                return;
            }
        };
        match spawn_worker(&spec, Arc::clone(&sink)) {
            Ok(supervisor) => {
                let state = app.state::<SupervisorState>();
                if state.is_shutting_down() {
                    supervisor.shutdown();
                    return;
                }
                state.install(Arc::clone(&supervisor));
                state.set_status(WorkerStatus::Running, None);
                drop(state);

                supervisor.wait_for_exit();

                let state = app.state::<SupervisorState>();
                *lock(&state.supervisor) = None;
                if state.is_shutting_down() {
                    supervisor.shutdown();
                    return;
                }
                match next_restart(restarts) {
                    Some(next) => {
                        restarts = next;
                        state.set_status(
                            WorkerStatus::Restarting,
                            Some(format!(
                                "The worker stopped; restarting ({restarts} of {MAX_RESTARTS})."
                            )),
                        );
                    }
                    None => {
                        state.set_status(
                            WorkerStatus::Failed,
                            Some(format!(
                                "The worker stopped {restarts} times and was not restarted again."
                            )),
                        );
                        return;
                    }
                }
            }
            Err(failure) => {
                app.state::<SupervisorState>()
                    .set_status(failure.status, Some(failure.message));
                return;
            }
        }
    }
}

fn worker_spec(app: &AppHandle) -> Result<WorkerSpec, SpawnFailure> {
    let app_data = app.path().app_data_dir().map_err(|err| SpawnFailure {
        status: WorkerStatus::Failed,
        message: format!("Cannot resolve the app data directory: {err}"),
    })?;
    let entry = resolve_worker_entry(app).ok_or_else(|| SpawnFailure {
        status: WorkerStatus::Failed,
        message: "The LLM Wiki worker bundle was not found. Run `pnpm api:build` from the LLM Wiki repository, then reopen the app.".to_string(),
    })?;
    let node = resolve_node(app).ok_or_else(|| SpawnFailure {
        status: WorkerStatus::MissingRuntime,
        message:
            "No Node runtime was found for the LLM Wiki worker. Install Node 20+ on PATH or reinstall the desktop app so its bundled runtime is present."
                .to_string(),
    })?;
    let sockets = worker_socket::socket_paths(&app_data);
    Ok(WorkerSpec {
        node,
        entry,
        app_state: app_data.join("app-state.json"),
        rpc_socket: sockets.rpc,
        approval_socket: sockets.approval,
        extra_env: Vec::new(),
    })
}

fn repo_relative_candidates(base: &Path, relative: &Path) -> [PathBuf; 3] {
    [
        base.join(relative),
        base.join("..").join(relative),
        base.join("..").join("..").join(relative),
    ]
}

fn resolve_worker_entry(app: &AppHandle) -> Option<PathBuf> {
    let relative = Path::new("api-server")
        .join("dist")
        .join("src")
        .join("entries")
        .join("worker.js");
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.extend(repo_relative_candidates(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &relative,
    ));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(repo_relative_candidates(&cwd, &relative));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&relative));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(&relative));
            candidates.push(exe_dir.join("..").join("Resources").join(&relative));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        bases.push(resource_dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            bases.push(exe_dir.to_path_buf());
            bases.push(exe_dir.join("..").join("Resources"));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for base in &bases {
        candidates.push(base.join("node").join("bin").join("node"));
        candidates.push(base.join("node").join("node"));
        candidates.push(base.join("nodejs").join("bin").join("node"));
        candidates.push(base.join("node.exe"));
    }
    if let Some(bundled) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Some(bundled);
    }
    which::which("node").ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Condvar;
    use std::time::Instant;

    const WAIT_DEADLINE: Duration = Duration::from_secs(20);

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(String, Value)>>,
        signal: Condvar,
    }

    impl RecordingSink {
        fn record(&self, event: &str, payload: Value) {
            lock(&self.events).push((event.to_string(), payload));
            self.signal.notify_all();
        }

        fn named(&self, event: &str) -> Vec<Value> {
            lock(&self.events)
                .iter()
                .filter(|(name, _)| name == event)
                .map(|(_, payload)| payload.clone())
                .collect()
        }

        fn wait_for(&self, predicate: impl Fn(&[(String, Value)]) -> bool) -> bool {
            let deadline = Instant::now() + WAIT_DEADLINE;
            let mut events = lock(&self.events);
            loop {
                if predicate(&events) {
                    return true;
                }
                let remaining = match deadline.checked_duration_since(Instant::now()) {
                    Some(remaining) => remaining,
                    None => return false,
                };
                let (guard, _) = self
                    .signal
                    .wait_timeout(events, remaining)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                events = guard;
            }
        }
    }

    impl EventSink for RecordingSink {
        fn emit_agent_event(&self, payload: Value) {
            self.record(sink::AGENT_EVENT, payload);
        }

        fn emit_shell_approval_request(&self, payload: Value) {
            self.record(sink::SHELL_APPROVAL_REQUEST_EVENT, payload);
        }
    }

    struct Harness {
        root: PathBuf,
        spec: WorkerSpec,
        sink: Arc<RecordingSink>,
        supervisor: Arc<Supervisor>,
    }

    impl Harness {
        fn start() -> Self {
            let node = which::which("node")
                .expect("the supervisor composition test needs node on PATH");
            let short = &uuid::Uuid::new_v4().to_string()[..8];
            let root = std::env::temp_dir().join(format!("u16-{short}"));
            std::fs::create_dir_all(&root).expect("scratch directory");
            let entry = root.join("fake_worker.mjs");
            std::fs::write(&entry, include_str!("testdata/fake_worker.mjs")).expect("fake worker");
            let app_state = root.join("app-state.json");
            std::fs::write(&app_state, "{}").expect("app state");
            let sockets = worker_socket::socket_paths(&root);
            let spec = WorkerSpec {
                node,
                entry,
                app_state,
                rpc_socket: sockets.rpc,
                approval_socket: sockets.approval,
                extra_env: vec![(
                    "LLM_WIKI_FAKE_TRACE".to_string(),
                    root.join("launch.json").to_string_lossy().into_owned(),
                )],
            };
            let sink = Arc::new(RecordingSink::default());
            let supervisor = spawn_worker(&spec, Arc::clone(&sink) as Arc<dyn EventSink>)
                .expect("the fake worker must reach ready");
            Self {
                root,
                spec,
                sink,
                supervisor,
            }
        }

        fn launch_trace(&self) -> Value {
            let raw = std::fs::read_to_string(self.root.join("launch.json"))
                .expect("the fake worker must have recorded its launch");
            serde_json::from_str(&raw).expect("launch trace must be JSON")
        }

        fn state(&self) -> SupervisorState {
            let state = SupervisorState::new();
            state.install(Arc::clone(&self.supervisor));
            *lock(&state.sink) = Some(Arc::clone(&self.sink) as Arc<dyn EventSink>);
            state
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn supervisor_spawns_calls_streams_approves_and_shuts_down() {
        let harness = Harness::start();
        let launch = harness.launch_trace();
        let argv: Vec<String> = launch["argv"]
            .as_array()
            .expect("argv must be recorded")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        assert_eq!(
            argv,
            [
                "--app-state".to_string(),
                harness.spec.app_state.to_string_lossy().into_owned(),
                "--approval-socket".to_string(),
                harness.spec.approval_socket.to_string_lossy().into_owned(),
            ],
            "the worker must receive the app-state and approval-socket spawn arguments"
        );
        assert_eq!(
            launch["socketEnv"],
            json!(harness.spec.rpc_socket.to_string_lossy()),
            "the worker must receive the RPC socket path in LLM_WIKI_SOCKET_PATH"
        );
        assert_eq!(
            harness.supervisor.socket_path(),
            harness.spec.rpc_socket.to_string_lossy()
        );

        let state = harness.state();
        let health = state.call("health", json!({}));
        assert_eq!(health["ok"], json!(true));
        assert_eq!(health["value"]["status"], json!("running"));

        let streamed = state.call_stream(
            "chatStream",
            json!({ "message": "hello", "sessionId": "s1", "runId": "r1" }),
        );
        assert_eq!(streamed["ok"], json!(true));
        let relayed = harness.sink.named(sink::AGENT_EVENT);
        assert_eq!(
            relayed.len(),
            2,
            "every acked chunk must reach the event sink: {relayed:?}"
        );
        assert_eq!(relayed[0]["event"]["text"], json!("one"));
        assert_eq!(relayed[1]["event"]["text"], json!("two"));
        assert_eq!(relayed[0]["sessionId"], json!("s1"));
        assert_eq!(relayed[0]["runId"], json!("r1"));

        let cancelled = state.call("chatCancel", json!({ "projectId": "p1", "sessionId": "s1" }));
        assert_eq!(cancelled["value"]["cancelled"], json!(true));

        assert!(
            harness.sink.wait_for(|events| {
                events
                    .iter()
                    .filter(|(name, _)| name == sink::SHELL_APPROVAL_REQUEST_EVENT)
                    .count()
                    >= 1
            }),
            "the worker's approval request must reach the event sink"
        );
        assert_eq!(
            harness.sink.named(sink::SHELL_APPROVAL_REQUEST_EVENT)[0]["id"],
            json!("req-1")
        );

        let approved = state.approve(None, "p1", "s1", vec!["ls -la".to_string()]);
        assert_eq!(approved["ok"], json!(true), "{approved:?}");
        assert_eq!(approved["value"]["approved"], json!(true));
        assert!(
            harness.sink.wait_for(|events| {
                events
                    .iter()
                    .filter(|(name, _)| name == sink::SHELL_APPROVAL_REQUEST_EVENT)
                    .count()
                    >= 2
            }),
            "an accepted approval must be answered by the worker"
        );
        assert_eq!(
            harness.sink.named(sink::SHELL_APPROVAL_REQUEST_EVENT)[1]["id"],
            json!("req-2")
        );

        let unmatched = state.approve(None, "p1", "s1", vec!["ls -la".to_string()]);
        assert_eq!(unmatched["ok"], json!(false));
        assert_eq!(unmatched["error"]["_tag"], json!("NotFound"));

        state.shutdown();
        let after = state.call("health", json!({}));
        assert_eq!(after["ok"], json!(false));
        assert_eq!(after["error"]["_tag"], json!(WORKER_NOT_RUNNING));
        assert!(
            worker_socket::connect(&harness.spec.rpc_socket).is_err(),
            "the worker socket must stop accepting connections after shutdown"
        );
    }

    #[test]
    fn worker_failures_map_to_typed_envelopes() {
        let harness = Harness::start();
        let state = harness.state();

        let unknown = state.call("noSuchOperation", json!({}));
        assert_eq!(unknown["ok"], json!(false));
        assert_eq!(unknown["error"]["_tag"], json!("Defect"));
        assert!(unknown["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Unknown request tag"));

        let unsupported = state.approve(Some("missing-req".to_string()), "p1", "s1", vec![]);
        assert_eq!(unsupported["ok"], json!(false));
        assert_eq!(unsupported["error"]["_tag"], json!("NotFound"));

        state.shutdown();
    }

    #[test]
    fn unavailable_worker_reports_the_state_and_remediation() {
        let state = SupervisorState::new();
        state.set_status(
            WorkerStatus::MissingRuntime,
            Some("Install Node 20+.".to_string()),
        );
        let envelope = state.call("health", json!({}));
        assert_eq!(envelope["ok"], json!(false));
        assert_eq!(envelope["error"]["_tag"], json!(WORKER_NOT_RUNNING));
        let message = envelope["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("missing-runtime"), "{message}");
        assert!(message.contains("Install Node 20+."), "{message}");
        assert_eq!(state.socket_path(), "");
        assert_eq!(state.status(), WorkerStatus::MissingRuntime);
    }

    #[test]
    fn restart_budget_is_bounded_and_exhausts() {
        let mut restarts = 0;
        for expected in 1..=MAX_RESTARTS {
            restarts = next_restart(restarts).expect("within budget");
            assert_eq!(restarts, expected);
        }
        assert_eq!(next_restart(restarts), None);
    }
}
