//! Out-of-line transport boundary tests; no external host is involved.
use super::{DeadlineStream, RpcClient};
use ariadne_agent_protocol::AdapterErrorCode;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    thread,
    time::{Duration, Instant},
};

#[test]
fn readiness_wait_and_partial_messages_share_one_absolute_deadline() {
    let (stream, mut peer) = UnixStream::pair().unwrap();
    stream.set_nonblocking(true).unwrap();
    let producer = thread::spawn(move || {
        for _ in 0..30 {
            if peer.write_all(b"x").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    });
    let started = Instant::now();
    let mut bounded = DeadlineStream {
        stream,
        deadline: started + Duration::from_millis(40),
    };
    let mut bytes = [0; 30];
    let error = bounded.read_exact(&mut bytes).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(bounded);
    producer.join().unwrap();
}
#[test]
fn http_upgrade_rejects_invalid_websocket_accept() {
    let (stream, mut peer) = UnixStream::pair().unwrap();
    let server = thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        peer.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n").unwrap();
    });
    let error = RpcClient::open(stream, Instant::now() + Duration::from_secs(1))
        .err()
        .unwrap();
    assert_eq!(error.code, AdapterErrorCode::HostUnreachable);
    server.join().unwrap();
}
