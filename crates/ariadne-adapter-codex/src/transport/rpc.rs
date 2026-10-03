use super::error;
use ariadne_agent_protocol::{AdapterError, AdapterErrorCode as Code};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    os::unix::{io::AsRawFd, net::UnixStream},
    time::Instant,
};
use tungstenite::{client::client_with_config, protocol::WebSocketConfig, Message, WebSocket};

pub(crate) const MAX_FRAME: usize = 8 * 1024 * 1024;

pub(crate) struct RpcClient {
    socket: WebSocket<DeadlineStream>,
    next_id: u64,
}
impl RpcClient {
    pub fn open(stream: UnixStream, deadline: Instant) -> Result<Self, AdapterError> {
        stream.set_nonblocking(true).map_err(|_| {
            error(
                Code::HostUnreachable,
                "Cannot configure bounded Codex transport.",
            )
        })?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME))
            .max_write_buffer_size(MAX_FRAME + 1024)
            .write_buffer_size(0);
        // Only HTTP Upgrade bytes cross this already-connected Unix socket; no TCP connection.
        let (socket, _) = client_with_config(
            "ws://localhost/",
            DeadlineStream { stream, deadline },
            Some(config),
        )
        .map_err(|_| error(Code::HostUnreachable, "Codex WebSocket handshake failed."))?;
        Ok(Self { socket, next_id: 1 })
    }
    pub fn notify_initialized(&mut self) -> Result<(), AdapterError> {
        self.socket
            .send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .map_err(|_| error(Code::HostUnreachable, "Cannot finish Codex initialization."))
    }
    pub fn request<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
        deadline: Instant,
    ) -> Result<R, AdapterError> {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or_else(|| {
            error(
                Code::ProtocolConflict,
                "Codex RPC request identity exhausted.",
            )
        })?;
        self.deadline(deadline)?;
        let request = json!({"id":id,"method":method,"params":params}).to_string();
        if request.len() > MAX_FRAME {
            return Err(error(
                Code::InvalidArgument,
                "Codex read request exceeds frame limit.",
            ));
        }
        self.socket
            .send(Message::Text(request.into()))
            .map_err(|_| error(Code::HostUnreachable, "Codex read request failed."))?;
        // Notifications are not lifecycle evidence. Bound work even if a peer floods them.
        for _ in 0..256 {
            self.deadline(deadline)?;
            let frame = self.socket.read().map_err(|err| match err {
                tungstenite::Error::Capacity(_)
                | tungstenite::Error::Protocol(_)
                | tungstenite::Error::Utf8(_) => error(
                    Code::IncompatibleAdapter,
                    "Codex sent an invalid or oversized WebSocket frame.",
                ),
                _ => error(
                    Code::HostUnreachable,
                    "Codex daemon read failed; reconnect and initialize again.",
                ),
            })?;
            match frame {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(|_| {
                        error(Code::IncompatibleAdapter, "Codex returned malformed JSON.")
                    })?;
                    let object = value.as_object().ok_or_else(|| {
                        error(
                            Code::IncompatibleAdapter,
                            "Codex RPC response is not an object.",
                        )
                    })?;
                    if object.contains_key("method") {
                        // Requests/approval messages are not answered or acted upon.
                        if object.contains_key("id") {
                            return Err(error(
                                Code::Unsupported,
                                "Codex requested a host action; check the original terminal.",
                            ));
                        }
                        continue;
                    }
                    if object.get("id") != Some(&json!(id)) {
                        return Err(error(
                            Code::ProtocolConflict,
                            "Codex returned a mismatched RPC response identity.",
                        ));
                    }
                    if let Some(server_error) = object.get("error") {
                        if object.contains_key("result") {
                            return Err(error(
                                Code::IncompatibleAdapter,
                                "Codex RPC response contains both result and error.",
                            ));
                        }
                        let code = server_error
                            .get("code")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| {
                                error(Code::IncompatibleAdapter, "Codex RPC error is malformed.")
                            })?;
                        return Err(if code == -32601 {
                            error(Code::Unsupported, "Codex read API is unsupported; manual binding may remain available.")
                        } else {
                            error(Code::HostUnreachable, "Codex read API failed; reconnect and initialize before further reads.")
                        });
                    }
                    let result = object.get("result").ok_or_else(|| {
                        error(
                            Code::IncompatibleAdapter,
                            "Codex RPC response is missing its result.",
                        )
                    })?;
                    return serde_json::from_value(result.clone()).map_err(|_| error(Code::UnsupportedHostVersion, "Codex history has unknown or malformed required wire data; dispatch remains disabled."));
                }
                Message::Ping(_) => {
                    self.socket.flush().map_err(|_| {
                        error(Code::HostUnreachable, "Codex WebSocket pong failed.")
                    })?;
                }
                Message::Pong(_) => {}
                Message::Close(_) => {
                    return Err(error(Code::HostUnreachable, "Codex daemon disconnected."))
                }
                _ => {
                    return Err(error(
                        Code::IncompatibleAdapter,
                        "Codex sent a non-text RPC frame.",
                    ))
                }
            }
        }
        Err(error(
            Code::HostUnreachable,
            "Codex notification traffic exceeded this bounded read.",
        ))
    }
    fn deadline(&mut self, deadline: Instant) -> Result<(), AdapterError> {
        self.socket.get_mut().deadline = deadline;
        self.socket
            .get_ref()
            .remaining()
            .map(|_| ())
            .map_err(|_| error(Code::HostUnreachable, "Codex read deadline expired."))
    }
}
// Readiness polling before retrying nonblocking IO keeps one absolute deadline
// across partial HTTP Upgrade traffic and fragmented WebSocket messages.
struct DeadlineStream {
    stream: UnixStream,
    deadline: Instant,
}
impl DeadlineStream {
    fn remaining(&self) -> io::Result<std::time::Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Codex read deadline"))
    }
    fn ready(&self, events: libc::c_short) -> io::Result<()> {
        loop {
            let remaining = self.remaining()?;
            let timeout = remaining.as_millis().max(1).min(i32::MAX as u128) as i32;
            let mut descriptor = libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events,
                revents: 0,
            };
            // SAFETY: one valid writable pollfd referencing our owned live socket.
            let result = unsafe { libc::poll(&mut descriptor, 1, timeout) };
            if result > 0 {
                return Ok(());
            }
            if result == 0 {
                continue;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            self.remaining()?;
            match self.stream.read(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.ready(libc::POLLIN)?
                }
                result => return result,
            }
        }
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        loop {
            self.remaining()?;
            match self.stream.write(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.ready(libc::POLLOUT)?
                }
                result => return result,
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

#[cfg(test)]
#[path = "../tests/transport.rs"]
mod tests;
