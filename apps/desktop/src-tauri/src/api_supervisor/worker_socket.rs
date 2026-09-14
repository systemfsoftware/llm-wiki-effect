use interprocess::local_socket::traits::Stream as _;
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use std::io;
use std::path::{Path, PathBuf};

pub use interprocess::local_socket::Stream;

pub struct SocketPaths {
    pub rpc: PathBuf,
    pub approval: PathBuf,
}

#[cfg(unix)]
const RPC_SOCKET_FILE: &str = "api-server.sock";
#[cfg(unix)]
const APPROVAL_SOCKET_FILE: &str = "shell-approval.sock";

#[cfg(windows)]
const PIPE_PREFIX: &str = r"\\.\pipe\";
#[cfg(windows)]
const RPC_PIPE_NAME: &str = "llm-wiki-api";
#[cfg(windows)]
const APPROVAL_PIPE_NAME: &str = "llm-wiki-approval";
#[cfg(windows)]
const PIPE_TOKEN_LEN: usize = 8;

#[cfg(unix)]
pub fn socket_paths(app_data: &Path) -> SocketPaths {
    SocketPaths {
        rpc: app_data.join(RPC_SOCKET_FILE),
        approval: app_data.join(APPROVAL_SOCKET_FILE),
    }
}

#[cfg(windows)]
pub fn socket_paths(_app_data: &Path) -> SocketPaths {
    let token = &uuid::Uuid::new_v4().to_string()[..PIPE_TOKEN_LEN];
    SocketPaths {
        rpc: PathBuf::from(format!("{PIPE_PREFIX}{RPC_PIPE_NAME}-{token}")),
        approval: PathBuf::from(format!("{PIPE_PREFIX}{APPROVAL_PIPE_NAME}-{token}")),
    }
}

#[cfg(unix)]
pub fn connect(path: &Path) -> io::Result<Stream> {
    Stream::connect(path.to_fs_name::<GenericFilePath>()?)
}

#[cfg(windows)]
pub fn connect(path: &Path) -> io::Result<Stream> {
    Stream::connect(namespaced(path)?.to_ns_name::<GenericNamespaced>()?)
}

#[cfg(windows)]
fn namespaced(path: &Path) -> io::Result<String> {
    path.to_str()
        .and_then(|name| name.strip_prefix(PIPE_PREFIX))
        .map(str::to_owned)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} is not a named-pipe path (expected a {} prefix)",
                    path.display(),
                    PIPE_PREFIX
                ),
            )
        })
}

#[cfg(unix)]
pub fn clear_stale_socket(path: &Path) -> io::Result<()> {
    std::fs::remove_file(path)
}

#[cfg(windows)]
pub fn clear_stale_socket(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub fn shutdown(stream: &Stream) -> io::Result<()> {
    let Stream::UdSocket(inner) = stream;
    inner.inner().shutdown(std::net::Shutdown::Both)
}

#[cfg(windows)]
pub fn shutdown(_stream: &Stream) -> io::Result<()> {
    Ok(())
}
