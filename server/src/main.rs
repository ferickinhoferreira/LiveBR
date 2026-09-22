use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{atomic::{AtomicU64, Ordering}, Arc},
};

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tracing_subscriber::EnvFilter;

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------

/// Mensagens enviadas pelo cliente -> servidor.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Join { room: String, name: String },
    Relay { to: String, payload: serde_json::Value },
    Leave,
    Ping,
}

/// Mensagens enviadas pelo servidor -> cliente.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Joined {
        #[serde(rename = "self")]
        self_id: String,
        #[serde(rename = "isHost")]
        is_host: bool,
        peers: Vec<PeerInfo>,
    },
    #[serde(rename = "peer-joined")]
    PeerJoined { peer: String, name: String },
    #[serde(rename = "peer-left")]
    PeerLeft { peer: String },
    Relay { from: String, payload: serde_json::Value },
    Error { message: String },
    Pong,
}

#[derive(Serialize, Clone)]
struct PeerInfo {
    id: String,
    name: String,
    #[serde(rename = "isHost")]
    is_host: bool,
}

struct Peer {
    info: PeerInfo,
    tx: mpsc::UnboundedSender<WsMessage>,
}

#[derive(Default)]
struct Room {
    peers: HashMap<String, Peer>,
}

#[derive(Default)]
struct AppState {
    rooms: Mutex<HashMap<String, Room>>,
}

/// IDs únicos de conexão.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn gen_id() -> String {
    format!("p{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn gen_room_code() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(|c| (c as char).to_ascii_uppercase())
        .collect()
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsMessage>();

    // Task que esvazia o canal de saída para o socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut peer_id: Option<String> = None;
    let mut room_code: Option<String> = None;

    while let Some(Ok(msg)) = ws_rx.next().await {
        let WsMessage::Text(text) = msg else {
            continue;
        };

        // Limite de tamanho de mensagem (evita abuso).
        if text.len() > 64_000 {
            let _ = out_tx.send(err_msg("Mensagem muito grande."));
            continue;
        }

        match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::Join { room, name }) => {
                let id = gen_id();
                let code = normalize_room(&room);

                let mut rooms = state.rooms.lock().await;
                let room_entry = rooms.entry(code.clone()).or_default();

                // Limite de segurança por sala (mesh P2P: até 8 peers).
                if room_entry.peers.len() >= 8 {
                    let _ = out_tx.send(err_msg("Sala cheia (limite: 8 pessoas)."));
                    continue;
                }

                let info = PeerInfo { id: id.clone(), name, is_host: room_entry.peers.is_empty() };
                let peers: Vec<PeerInfo> =
                    room_entry.peers.values().map(|p| p.info.clone()).collect();

                room_entry.peers.insert(
                    id.clone(),
                    Peer { info: info.clone(), tx: out_tx.clone() },
                );
                drop(rooms);

                // Notifica quem já estava na sala.
                broadcast_room(
                    &state,
                    &code,
                    &ServerMsg::PeerJoined { peer: id.clone(), name: info.name.clone() },
                    &id,
                )
                .await;

                tracing::info!(%id, %code, "peer entrou na sala");
                let _ = out_tx.send(serde_msg(&ServerMsg::Joined {
                    self_id: id.clone(),
                    is_host: info.is_host,
                    peers,
                }));

                peer_id = Some(id);
                room_code = Some(code);
            }
            Ok(ClientMsg::Ping) => {
                let _ = out_tx.send(serde_msg(&ServerMsg::Pong));
            }
            Ok(ClientMsg::Relay { to, payload }) => {
                let (Some(pid), Some(rc)) = (peer_id.as_ref(), room_code.as_ref()) else {
                    let _ = out_tx.send(err_msg("Você precisa entrar em uma sala primeiro (join)."));
                    continue;
                };
                let rooms = state.rooms.lock().await;
                if let Some(room) = rooms.get(rc) {
                    if let Some(peer) = room.peers.get(&to) {
                        let _ = peer.tx.send(serde_msg(&ServerMsg::Relay {
                            from: pid.clone(),
                            payload,
                        }));
                    } else {
                        let _ = out_tx.send(err_msg(format!("Peer {to} não encontrado.")));
                    }
                }
            }
            Ok(ClientMsg::Leave) => break,
            Err(e) => {
                let _ = out_tx.send(err_msg(format!("JSON inválido: {e}")));
            }
        }
    }

    // Cleanup: remove o peer da sala e avisa os demais.
    if let (Some(pid), Some(rc)) = (peer_id, room_code) {
        let mut rooms = state.rooms.lock().await;
        let mut empty = false;
        if let Some(room) = rooms.get_mut(&rc) {
            room.peers.remove(&pid);
            if room.peers.is_empty() {
                empty = true;
            }
        }
        if empty {
            rooms.remove(&rc);
            tracing::info!(%rc, "sala fechada (vazia)");
        }
        drop(rooms);

        broadcast_room(&state, &rc, &ServerMsg::PeerLeft { peer: pid.clone() }, "").await;
        tracing::info!(%pid, %rc, "peer saiu da sala");
    }

    writer.abort();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_room(room: &str) -> String {
    let code: String = room.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if code.is_empty() {
        gen_room_code()
    } else {
        code.to_uppercase()
    }
}

fn err_msg(msg: impl Into<String>) -> WsMessage {
    WsMessage::Text(serde_json::to_string(&ServerMsg::Error { message: msg.into() }).unwrap())
}

fn serde_msg(msg: &ServerMsg) -> WsMessage {
    WsMessage::Text(serde_json::to_string(msg).unwrap())
}

async fn broadcast_room(state: &AppState, room: &str, msg: &ServerMsg, skip: &str) {
    let rooms = state.rooms.lock().await;
    if let Some(room) = rooms.get(room) {
        let text = serde_msg(msg);
        for peer in room.peers.values() {
            if peer.info.id != skip {
                let _ = peer.tx.send(text.clone());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// TURN REST API — credenciais efêmeras (use-auth-secret do coturn)
// ---------------------------------------------------------------------------

fn turn_secret() -> String {
    std::env::var("TURN_STATIC_SECRET").unwrap_or_else(|_| "livebr-dev-secret".into())
}

async fn turn_creds_handler() -> axum::Json<serde_json::Value> {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let ttl: u64 = 3600; // 1 hora
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + ttl;
    let username = format!("{expiry}:livebr");

    let mut mac = Hmac::<Sha1>::new_from_slice(turn_secret().as_bytes()).unwrap();
    mac.update(username.as_bytes());
    let password = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    tracing::info!("credenciais TURN efêmeras emitidas (expira em {ttl}s)");
    axum::Json(serde_json::json!({
        "username": username,
        "password": password,
        "ttl": ttl,
    }))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "livebr_server=info".into()),
        )
        .init();

    let state = Arc::new(AppState::default());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .route("/turn-creds", get(turn_creds_handler))
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:3000".parse().unwrap();
    tracing::info!("servidor de sinalização ouvindo em ws://{addr}/ws");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
