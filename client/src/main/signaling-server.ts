// Servidor de sinalização EMBUTIDO no app (roda no processo main do Electron).
// O host cria a sala e nem sabe que existe um servidor rodando na máquina dele.
//
// Usa HTTP + WebSocket no MESMO servidor (importante: o cloudflared precisa de um
// origin HTTP válido para o túnel funcionar — só WebSocket puro o proxy recusa).
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";

interface Peer {
  id: string;
  name: string;
  socket: WebSocket;
  room: string | null;
  /** Quem criou a sala (primeiro a entrar) é o host. */
  isHost: boolean;
}

export interface EmbeddedServer {
  port: number;
  close: () => Promise<void>;
}

const MAX_PEERS_PER_ROOM = 8;

export async function startSignalingServer(preferredPort = 0): Promise<EmbeddedServer> {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("WebSocket apenas neste endereço.");
  });

  const wss = new WebSocketServer({ server: httpServer });

  const peers = new Map<string, Peer>();
  const rooms = new Map<string, Set<string>>();
  let seq = 1;

  const send = (socket: WebSocket, msg: object): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const peersInRoom = (room: string): Peer[] =>
    [...(rooms.get(room) ?? [])]
      .map((id) => peers.get(id))
      .filter((p): p is Peer => !!p);

  wss.on("connection", (socket) => {
    const id = `p${seq++}`;
    const peer: Peer = { id, name: "Convidado", socket, room: null, isHost: false };
    peers.set(id, peer);

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: "error", message: "JSON inválido" });
      }

      switch (msg.type) {
        case "join": {
          const room = String(msg.room ?? "").trim().toUpperCase() || "GERAL";
          peer.name = String(msg.name ?? "Convidado").slice(0, 24);
          peer.room = room;

          const members = rooms.get(room) ?? new Set<string>();
          if (members.size >= MAX_PEERS_PER_ROOM) {
            return send(socket, { type: "error", message: "Sala cheia (limite: 8)." });
          }

          // Quem entra em uma sala vazia é o host (quem criou a sala).
          peer.isHost = members.size === 0;

          const existing = peersInRoom(room).map((p) => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost,
          }));
          members.add(id);
          rooms.set(room, members);

          send(socket, { type: "joined", self: id, isHost: peer.isHost, peers: existing });
          for (const other of peersInRoom(room)) {
            if (other.id !== id) {
              send(other.socket, {
                type: "peer-joined",
                peer: id,
                name: peer.name,
                isHost: false,
              });
            }
          }
          break;
        }
        case "relay": {
          const target = peers.get(String(msg.to));
          if (!target || target.room !== peer.room) {
            return send(socket, { type: "error", message: "Peer não encontrado." });
          }
          send(target.socket, { type: "relay", from: id, payload: msg.payload });
          break;
        }
        case "leave": {
          leaveRoom();
          break;
        }
        case "ping": {
          send(socket, { type: "pong" });
          break;
        }
      }
    });

    const leaveRoom = (): void => {
      if (!peer.room) return;
      const members = rooms.get(peer.room);
      members?.delete(id);
      const remaining = peersInRoom(peer.room);
      for (const other of remaining) {
        send(other.socket, { type: "peer-left", peer: id });
      }
      if (members && members.size === 0) rooms.delete(peer.room);
      peer.room = null;
    };

    socket.on("close", () => {
      leaveRoom();
      peers.delete(id);
    });
    socket.on("error", () => {
      leaveRoom();
      peers.delete(id);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(preferredPort, "0.0.0.0", () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : preferredPort;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const p of peers.values()) p.socket.terminate();
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
