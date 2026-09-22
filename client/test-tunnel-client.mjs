// Teste rápido: conecta no túnel público com o WebSocket do Node e faz join.
const url = process.argv[2];
if (!url) {
  console.error("uso: node test-tunnel-client.mjs wss://host/ws");
  process.exit(1);
}

const ws = new WebSocket(url);
const timeout = setTimeout(() => {
  console.log("❌ timeout: nada recebido em 15s (túnel não alcançou o servidor)");
  process.exit(1);
}, 15000);

ws.onopen = () => {
  console.log("✅ conectado ao túnel:", url);
  ws.send(JSON.stringify({ type: "join", room: "TEST", name: "ClienteExterno" }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log("   recebido:", JSON.stringify(msg).slice(0, 120));
  if (msg.type === "joined") {
    clearTimeout(timeout);
    console.log("✅ join pela internet funcionou (convidado entrou na sala via túnel)");
    process.exit(0);
  }
};

ws.onerror = () => {
  console.log("❌ erro de WebSocket ao conectar no túnel");
  process.exit(1);
};