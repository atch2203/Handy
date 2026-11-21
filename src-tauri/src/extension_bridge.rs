//! Localhost WebSocket server for the "Send to browser extension" paste method.
//!
//! The RadBridge browser extension connects as a client and inserts dictated
//! text into a web page without moving keyboard focus. Dictation is patient
//! information and any web page can open a WebSocket to localhost, so:
//!
//! - the server binds `127.0.0.1` only;
//! - the handshake is refused unless `Origin` is a browser extension;
//! - the first message must be `{"type":"hello","token":…,"version":1}` with
//!   the token from settings, or the connection is closed;
//! - dictated text is never logged.
//!
//! One authenticated client is active at a time; a newer one replaces it.
//!
//! Protocol (JSON text frames):
//! - client → Handy: `hello`, `ping`, `ack {id, ok, error?}`
//! - Handy → client: `hello_ok`, `pong`, `insert {id, text}`

use crate::settings::{get_settings, PasteMethod};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::AppHandle;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

pub const PROTOCOL_VERSION: u64 = 1;

/// A client that doesn't authenticate within this time is dropped.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// Origins of browser extensions: Chrome's, and the one Edge may use.
const ALLOWED_ORIGIN_PREFIXES: &[&str] = &["chrome-extension://", "extension://"];

#[derive(Clone, Debug, Serialize, Type)]
pub struct ExtensionBridgeStatus {
    pub listening: bool,
    pub connected: bool,
    pub port: u16,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello {
        token: String,
        version: u64,
    },
    Ping,
    Ack {
        id: String,
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage<'a> {
    HelloOk { version: u64 },
    Pong,
    Insert { id: &'a str, text: &'a str },
}

impl ServerMessage<'_> {
    fn to_message(&self) -> Message {
        Message::text(serde_json::to_string(self).expect("server messages serialize"))
    }
}

type AckResult = Result<(), String>;

struct Client {
    conn_id: u64,
    tx: mpsc::UnboundedSender<Message>,
}

struct Server {
    port: u16,
    /// Sending `true` (or dropping it) stops the listener and every connection.
    shutdown: watch::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    token: String,
    client: Option<Client>,
    next_conn_id: u64,
    /// Inserts waiting for an ack, by id, with the connection they went to.
    pending: HashMap<String, (u64, oneshot::Sender<AckResult>)>,
}

/// The bridge's state. The app uses the one in [`BRIDGE`]; tests make their own.
#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Inner>,
}

pub static BRIDGE: Lazy<Arc<Bridge>> = Lazy::new(|| Arc::new(Bridge::default()));

impl Bridge {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self) -> ExtensionBridgeStatus {
        let inner = self.lock();
        ExtensionBridgeStatus {
            listening: inner.server.is_some(),
            connected: inner.client.is_some(),
            port: inner.server.as_ref().map_or(0, |s| s.port),
        }
    }

    /// The port the server listens on, if it's running.
    pub fn port(&self) -> Option<u16> {
        self.lock().server.as_ref().map(|s| s.port)
    }

    /// Sets the token clients must send. A changed token disconnects the
    /// client that authenticated with the old one.
    pub fn set_token(&self, token: &str) {
        let mut inner = self.lock();
        if inner.token != token {
            inner.token = token.to_string();
            drop_client(&mut inner);
        }
    }

    /// Starts listening on `127.0.0.1:port`, stopping any server already
    /// running. Port 0 picks a free port; the one bound is returned.
    pub async fn start(self: &Arc<Self>, port: u16) -> std::io::Result<u16> {
        self.stop();
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = listener.local_addr()?.port();
        let (shutdown, shutdown_rx) = watch::channel(false);
        self.lock().server = Some(Server { port, shutdown });
        info!("Extension bridge listening on 127.0.0.1:{port}");

        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let mut shutdown = shutdown_rx.clone();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let bridge = Arc::clone(&bridge);
                            let shutdown = shutdown_rx.clone();
                            tokio::spawn(async move {
                                bridge.handle_connection(stream, shutdown).await;
                            });
                        }
                        Err(e) => warn!("Extension bridge accept failed: {e}"),
                    },
                }
            }
            debug!("Extension bridge listener on port {port} stopped");
        });
        Ok(port)
    }

    /// Stops the server and disconnects the client. Does nothing if stopped.
    pub fn stop(&self) {
        let mut inner = self.lock();
        if let Some(server) = inner.server.take() {
            let _ = server.shutdown.send(true);
            info!("Extension bridge stopped");
        }
        drop_client(&mut inner);
    }

    async fn handle_connection(
        self: Arc<Self>,
        stream: TcpStream,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let ws = match tokio_tungstenite::accept_hdr_async(stream, check_origin).await {
            Ok(ws) => ws,
            Err(e) => {
                debug!("Extension bridge handshake refused: {e}");
                return;
            }
        };
        let (mut sink, mut stream) = ws.split();

        // Authenticate: the first message must be a matching hello.
        let first = tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await;
        let authenticated = match first {
            Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str(&text) {
                Ok(ClientMessage::Hello { token, version }) => {
                    version == PROTOCOL_VERSION && self.token_matches(&token)
                }
                _ => false,
            },
            _ => false,
        };
        if !authenticated {
            warn!("Extension bridge rejected a client: bad or missing hello");
            let _ = sink.send(Message::Close(None)).await;
            return;
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let conn_id = {
            let mut inner = self.lock();
            drop_client(&mut inner);
            inner.next_conn_id += 1;
            let conn_id = inner.next_conn_id;
            inner.client = Some(Client {
                conn_id,
                tx: tx.clone(),
            });
            conn_id
        };
        info!("Extension connected");
        let _ = tx.send(
            ServerMessage::HelloOk {
                version: PROTOCOL_VERSION,
            }
            .to_message(),
        );

        // Writer: everything for this client goes through `tx`, so a
        // replaced client's writer ends when its last sender is dropped.
        let writer = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let close = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || close {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        drop(tx);

        loop {
            let message = tokio::select! {
                _ = shutdown.changed() => break,
                message = stream.next() => message,
            };
            let Some(Ok(message)) = message else { break };
            let text = match message {
                Message::Text(text) => text,
                Message::Close(_) => break,
                _ => continue,
            };
            match serde_json::from_str::<ClientMessage>(&text) {
                Ok(ClientMessage::Ping) => {
                    if !self.send_to(conn_id, ServerMessage::Pong.to_message()) {
                        break;
                    }
                }
                Ok(ClientMessage::Ack { id, ok, error }) => self.resolve(&id, ok, error),
                Ok(ClientMessage::Hello { .. }) => {}
                Err(e) => debug!("Extension bridge ignored a message it can't read: {e}"),
            }
        }

        let mut inner = self.lock();
        if inner.client.as_ref().is_some_and(|c| c.conn_id == conn_id) {
            drop_client(&mut inner);
            info!("Extension disconnected");
        }
        drop(inner);
        writer.abort();
    }

    fn token_matches(&self, token: &str) -> bool {
        let inner = self.lock();
        !inner.token.is_empty() && constant_time_eq(inner.token.as_bytes(), token.as_bytes())
    }

    /// Sends to the client if it's still connection `conn_id`.
    fn send_to(&self, conn_id: u64, message: Message) -> bool {
        let inner = self.lock();
        match &inner.client {
            Some(client) if client.conn_id == conn_id => client.tx.send(message).is_ok(),
            _ => false,
        }
    }

    fn resolve(&self, id: &str, ok: bool, error: Option<String>) {
        let Some((_, waiter)) = self.lock().pending.remove(id) else {
            return;
        };
        let result = if ok {
            Ok(())
        } else {
            Err(error.unwrap_or_else(|| "The extension couldn't insert the text".into()))
        };
        let _ = waiter.send(result);
    }

    /// Sends `text` to the connected extension and waits for its ack.
    pub async fn send(&self, text: &str, timeout: Duration) -> Result<(), String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (waiter, ack) = oneshot::channel();
        {
            let mut inner = self.lock();
            let Some(client) = &inner.client else {
                return Err("The browser extension isn't connected".into());
            };
            let conn_id = client.conn_id;
            let message = ServerMessage::Insert { id: &id, text }.to_message();
            if client.tx.send(message).is_err() {
                return Err("The browser extension isn't connected".into());
            }
            inner.pending.insert(id.clone(), (conn_id, waiter));
        }

        match tokio::time::timeout(timeout, ack).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The browser extension disconnected before confirming".into()),
            Err(_) => {
                self.lock().pending.remove(&id);
                Err(format!(
                    "The browser extension didn't confirm within {} ms",
                    timeout.as_millis()
                ))
            }
        }
    }
}

/// Disconnects the client and fails the inserts waiting on it.
fn drop_client(inner: &mut Inner) {
    if let Some(client) = inner.client.take() {
        let _ = client.tx.send(Message::Close(None));
        inner
            .pending
            .retain(|_, (conn_id, _)| *conn_id != client.conn_id);
    }
}

/// Handshake callback: only browser extensions may connect.
#[allow(clippy::result_large_err)] // The signature tungstenite requires.
fn check_origin(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok());
    if origin.is_some_and(origin_allowed) {
        return Ok(response);
    }
    let mut refusal = ErrorResponse::new(Some("Forbidden origin".into()));
    *refusal.status_mut() = StatusCode::FORBIDDEN;
    Err(refusal)
}

fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGIN_PREFIXES
        .iter()
        .any(|prefix| origin.len() > prefix.len() && origin.starts_with(prefix))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A new random token: 32 bytes as 64 hex characters.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random number generator is available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Starts, restarts or stops the server to match the settings: it runs only
/// while the paste method is "Send to browser extension".
pub fn sync_with_settings(app: &AppHandle) {
    let settings = get_settings(app);
    BRIDGE.set_token(&settings.extension_bridge_token);
    if settings.paste_method != PasteMethod::SendToExtension {
        BRIDGE.stop();
        return;
    }
    let port = settings.extension_bridge_port;
    if BRIDGE.port() == Some(port) {
        return;
    }
    let bridge = Arc::clone(&BRIDGE);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = bridge.start(port).await {
            warn!("Extension bridge couldn't listen on 127.0.0.1:{port}: {e}");
        }
    });
}

/// Sends `text` to the extension and waits for its ack, up to the timeout in
/// settings. Blocks, so call it from a plain thread, never async code.
pub fn send_text(app: &AppHandle, text: &str) -> Result<(), String> {
    let timeout = Duration::from_millis(get_settings(app).extension_bridge_timeout_ms);
    tauri::async_runtime::block_on(BRIDGE.send(text, timeout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::WebSocketStream;

    type Ws = WebSocketStream<TcpStream>;

    const TOKEN: &str = "test-token";

    async fn bridge() -> (Arc<Bridge>, u16) {
        let bridge = Arc::new(Bridge::default());
        bridge.set_token(TOKEN);
        let port = bridge.start(0).await.unwrap();
        (bridge, port)
    }

    async fn connect(port: u16, origin: Option<&str>) -> Result<Ws, String> {
        let mut request = format!("ws://127.0.0.1:{port}")
            .into_client_request()
            .unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio_tungstenite::client_async(request, stream)
            .await
            .map(|(ws, _)| ws)
            .map_err(|e| e.to_string())
    }

    async fn next_json(ws: &mut Ws) -> Option<serde_json::Value> {
        loop {
            match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).ok(),
                Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => {
                    return None
                }
                Ok(Some(Ok(_))) => continue,
            }
        }
    }

    async fn hello(ws: &mut Ws, token: &str) {
        let hello = serde_json::json!({"type": "hello", "token": token, "version": 1});
        ws.send(Message::text(hello.to_string())).await.unwrap();
    }

    async fn authenticated(port: u16) -> Ws {
        let mut ws = connect(port, Some("chrome-extension://abc")).await.unwrap();
        hello(&mut ws, TOKEN).await;
        assert_eq!(next_json(&mut ws).await.unwrap()["type"], "hello_ok");
        ws
    }

    #[test]
    fn origin_must_be_an_extension() {
        assert!(origin_allowed("chrome-extension://abcdef"));
        assert!(origin_allowed("extension://abcdef"));
        assert!(!origin_allowed("chrome-extension://"));
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://localhost:3000"));
        assert!(!origin_allowed("null"));
        assert!(!origin_allowed("https://chrome-extension://x"));
    }

    #[test]
    fn generated_tokens_are_64_hex_chars_and_differ() {
        let (a, b) = (generate_token(), generate_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn web_page_origin_is_refused_at_handshake() {
        let (bridge, port) = bridge().await;
        assert!(connect(port, Some("https://evil.example")).await.is_err());
        assert!(connect(port, None).await.is_err());
        assert!(!bridge.status().connected);
    }

    #[tokio::test]
    async fn wrong_token_is_closed() {
        let (bridge, port) = bridge().await;
        let mut ws = connect(port, Some("chrome-extension://abc")).await.unwrap();
        hello(&mut ws, "wrong").await;
        assert_eq!(next_json(&mut ws).await, None);
        assert!(!bridge.status().connected);
        assert!(bridge.send("x", Duration::from_millis(100)).await.is_err());
    }

    #[tokio::test]
    async fn first_message_must_be_hello() {
        let (bridge, port) = bridge().await;
        let mut ws = connect(port, Some("chrome-extension://abc")).await.unwrap();
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_json(&mut ws).await, None);
        assert!(!bridge.status().connected);
    }

    #[tokio::test]
    async fn insert_is_acked() {
        let (bridge, port) = bridge().await;
        let mut ws = authenticated(port).await;
        assert!(bridge.status().connected);

        let sender = Arc::clone(&bridge);
        let send = tokio::spawn(async move { sender.send("2.5 cm", Duration::from_secs(2)).await });
        let insert = next_json(&mut ws).await.unwrap();
        assert_eq!(insert["type"], "insert");
        assert_eq!(insert["text"], "2.5 cm");
        let ack = serde_json::json!({"type": "ack", "id": insert["id"], "ok": true});
        ws.send(Message::text(ack.to_string())).await.unwrap();
        assert_eq!(send.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn failed_ack_passes_the_error_through() {
        let (bridge, port) = bridge().await;
        let mut ws = authenticated(port).await;
        let sender = Arc::clone(&bridge);
        let send = tokio::spawn(async move { sender.send("x", Duration::from_secs(2)).await });
        let insert = next_json(&mut ws).await.unwrap();
        let ack = serde_json::json!({"type": "ack", "id": insert["id"], "ok": false, "error": "No target tab"});
        ws.send(Message::text(ack.to_string())).await.unwrap();
        assert_eq!(send.await.unwrap(), Err("No target tab".to_string()));
    }

    #[tokio::test]
    async fn missing_ack_times_out() {
        let (bridge, port) = bridge().await;
        let _ws = authenticated(port).await;
        let result = bridge.send("x", Duration::from_millis(100)).await;
        assert!(result.unwrap_err().contains("didn't confirm"));
        assert!(bridge.lock().pending.is_empty());
    }

    #[tokio::test]
    async fn no_client_is_an_error() {
        let (bridge, _) = bridge().await;
        assert!(bridge.send("x", Duration::from_millis(100)).await.is_err());
    }

    #[tokio::test]
    async fn ping_gets_pong() {
        let (_bridge, port) = bridge().await;
        let mut ws = authenticated(port).await;
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_json(&mut ws).await.unwrap()["type"], "pong");
    }

    #[tokio::test]
    async fn newer_client_replaces_older() {
        let (bridge, port) = bridge().await;
        let mut old = authenticated(port).await;
        let mut new = authenticated(port).await;
        assert_eq!(next_json(&mut old).await, None, "old client is closed");

        let sender = Arc::clone(&bridge);
        let send = tokio::spawn(async move { sender.send("x", Duration::from_secs(2)).await });
        let insert = next_json(&mut new).await.unwrap();
        let ack = serde_json::json!({"type": "ack", "id": insert["id"], "ok": true});
        new.send(Message::text(ack.to_string())).await.unwrap();
        assert_eq!(send.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn changed_token_disconnects_client() {
        let (bridge, port) = bridge().await;
        let mut ws = authenticated(port).await;
        bridge.set_token("new-token");
        assert_eq!(next_json(&mut ws).await, None);
        assert!(!bridge.status().connected);
    }

    #[tokio::test]
    async fn stop_closes_listener() {
        let (bridge, port) = bridge().await;
        bridge.stop();
        assert!(!bridge.status().listening);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }
}
