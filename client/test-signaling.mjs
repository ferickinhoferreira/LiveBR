// Teste ponta a ponta da sinalização: dois peers, mesma sala, relay de SDP.
// Node 24 tem WebSocket global.
const assert = (cond, label) => {
  if (!cond) { console.error("❌ FALHOU:", label); process.exit(1); }
  console.log("✅", label);
};

function makePeer(name, room) {
  const ws = new WebSocket("ws://localhost:3000/ws");
  const state = { ws, name, received: [], self: null, peers: [] };
  ws.onmessage = (ev) => state.received.push(JSON.parse(ev.data));
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", room, name }));
  return state;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (s, type) => [...s.received].reverse().find((m) => m.type === type);

const A = makePeer("Alice", "TEST01");
await wait(800);
assert(last(A, "joined")?.self?.startsWith("p"), "peer A recebeu 'joined' com id");

const B = makePeer("Bob", "TEST01");
await wait(800);
console.log("A recebeu:", JSON.stringify(A.received));
console.log("B recebeu:", JSON.stringify(B.received));

const joinedA = last(A, "joined");
const joinedB = last(B, "joined");
assert(joinedB && joinedB.peers.length === 1 && joinedB.peers[0].name === "Alice", "B entrou e vê Alice na sala");
assert(last(A, "peer-joined")?.peer === joinedB.self, "A foi notificado da entrada de B");

// Relay: A envia "offer" para B; B responde "answer" para A.
A.ws.send(JSON.stringify({
  type: "relay", to: joinedB.self,
  payload: { description: { type: "offer", sdp: "v=0...MOCK-OFFER" } },
}));
await wait(500);
const offerAtB = last(B, "relay");
assert(offerAtB?.from === joinedA.self && offerAtB.payload.description.sdp.includes("MOCK-OFFER"), "offer de A chegou em B via relay");

B.ws.send(JSON.stringify({
  type: "relay", to: joinedA.self,
  payload: { description: { type: "answer", sdp: "v=0...MOCK-ANSWER" } },
}));
await wait(500);
const answerAtA = last(A, "relay");
assert(answerAtA?.payload.description.sdp.includes("MOCK-ANSWER"), "answer de B chegou em A via relay");

// ICE candidates bidirecionais.
B.ws.send(JSON.stringify({ type: "relay", to: joinedA.self, payload: { description: null, candidate: { candidate: "candidate:1 1 UDP 1 192.168.0.5 50000 typ host" } } }));
await wait(400);
assert(last(A, "relay")?.payload?.candidate?.candidate?.includes("typ host"), "ICE candidate chegou em A");

// Ping/pong.
A.ws.send(JSON.stringify({ type: "ping" }));
await wait(400);
assert(A.received[A.received.length - 1]?.type === "pong", "ping/pong OK");

// Credenciais TURN efêmeras.
const creds = await (await fetch("http://localhost:3000/turn-creds")).json();
assert(creds.username?.includes(":") && creds.password.length === 28, `turn-creds OK (user=${creds.username.split(":")[0]})`);

// B sai; A deve receber peer-left.
B.ws.close();
await wait(800);
assert(last(A, "peer-left")?.peer === joinedB.self, "A foi notificado da saída de B");

console.log("\n🎉 TODOS OS TESTES DE SINALIZAÇÃO PASSARAM");
process.exit(0);
