//! SDK transport proof; real installed-entrypoint Store joins are tested separately.
use ariadne_core::fake::ScriptedCoreService;
use ariadne_core::*;
use ariadne_domain::models::*;
use ariadne_mcp::{serve_io, AgentMcpService};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
struct Peer {
    write: WriteHalf<DuplexStream>,
    read: BufReader<ReadHalf<DuplexStream>>,
}
impl Peer {
    async fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.write.write_all(&bytes).await.unwrap();
    }
    async fn result(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), self.read.read_line(&mut line))
                .await
                .unwrap()
                .unwrap()
                > 0
        );
        serde_json::from_str(&line).expect("stdout contains only JSON-RPC")
    }
}
async fn connected() -> (
    Peer,
    tokio::task::JoinHandle<Result<(), ariadne_mcp::ServeError>>,
    Arc<ScriptedCoreService>,
) {
    let core = Arc::new(ScriptedCoreService::new([]));
    let service = AgentMcpService::from_trusted_startup(core.clone(), |b, g, _, _| {
        Ok(AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            b,
            g,
            AgentReadScope::Terminal {
                issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
            },
        ))
    })
    .unwrap();
    let (server, client) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(server);
    let task = tokio::spawn(serve_io(service, read, write));
    let (read, write) = tokio::io::split(client);
    let mut peer = Peer {
        write,
        read: BufReader::new(read),
    };
    peer.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"native-contract-test","version":"1"}}})).await;
    let response = peer.result().await;
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["serverInfo"]["name"], "ariadne");
    assert!(response["result"]["capabilities"]["tools"].is_object());
    assert!(response["result"]["capabilities"]
        .get("resources")
        .is_none());
    peer.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await;
    (peer, task, core)
}
#[tokio::test]
async fn actual_sdk_lists_only_generated_agent_tools_and_keeps_domain_errors_in_content() {
    let (mut peer, task, core) = connected().await;
    peer.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
        .await;
    let result = peer.result().await;
    let tools = result["result"]["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["session_read", "item_messages", "item_rounds", "apply"]
    );
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../contracts/generated/core/mcp-tools.json"
    ))
    .unwrap();
    for (tool, canonical) in tools.iter().zip(manifest["tools"].as_array().unwrap()) {
        assert_eq!(tool["inputSchema"], canonical["inputSchema"]);
        assert!(tool["outputSchema"].is_object());
    }
    peer.send(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"apply","arguments":{"binding_id":id(3),"generation":id(4),"request":{},"actor":"owner"}}})).await;
    let failure = peer.result().await;
    assert!(failure.get("error").is_none());
    assert_eq!(failure["result"]["isError"], true);
    assert_eq!(
        failure["result"]["structuredContent"]["error"]["code"],
        "invalid_argument"
    );
    assert_eq!(
        serde_json::from_str::<Value>(failure["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap(),
        failure["result"]["structuredContent"]
    );
    assert!(core.history().unwrap().is_empty());
    peer.send(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"preferences_patch","arguments":{}}})).await;
    assert!(peer.result().await["error"].is_object());
    peer.send(json!({"jsonrpc":"2.0","id":5,"method":"owner/execute","params":{}}))
        .await;
    assert_eq!(peer.result().await["error"]["code"], -32601);
    peer.write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn overlong_and_incomplete_input_close_without_calling_core_or_salvaging_suffix() {
    for overflow in [false, true] {
        let (mut peer, task, core) = connected().await;
        let mut frame = if overflow {
            vec![b' '; 1024 * 1024 + 1]
        } else {
            b"{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":".to_vec()
        };
        if overflow {
            frame.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"apply\",\"arguments\":{}}}\n");
        }
        // Transport may close while this bounded write is still in progress.
        let _ = peer.write.write_all(&frame).await;
        let _ = peer.write.shutdown().await;
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(core.history().unwrap().is_empty());
        let mut output = String::new();
        assert_eq!(peer.read.read_line(&mut output).await.unwrap(), 0);
    }
}
