// Testa o servidor de sinalização EMBUTIDO + o túnel automático:
// - sobe o servidor local
// - abre o túnel público (cloudflared empacotado)
// - conecta um "convidado" pela internet (wss://...) e o "host" local
// - valida join, presença e relay de SDP
// Uso: npx electron test-host.js
const { app } = require("electron");
const path = require("path");
const WebSocket = require("ws");

const say = (m) => process.stdout.write(m + "\n");

async function main() {
  const { startSignalingServer } = require("./dist/main/signaling-server.js");
  const { startTunnel } = require("./dist/main/tunnel.js");

  say("1) subindo servidor embutido…");
  const server = await startSignalingServer(0);
  say(`   ✅ servidor embutido na porta ${server.port}`);

  say("2) abrindo túnel público (cloudflared)…");
  const tunnel = await startTunnel(server.port, 45000);
  say(`   ✅ túnel: wss://${tunnel.host}/ws`);

  // "Host" conecta local; "Convidado" conecta pelo túnel (simula outra rede).
  const mk = (url, name) => {
    const ws = new WebSocket(url);
    const st = { ws, name, received: [] };
    ws.on("message", (d) => st.received.push(JSON.parse(d.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", room: "TEST", name })));
    return st;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const last = (s, type) => [...s.received].reverse().find((m) => m.type === type);

  const host = mk(`ws://127.0.0.1:${server.port}/ws`, "Host");
  await wait(1200);
  const guest = mk(`wss://${tunnel.host}/ws`, "Convidado");
  await wait(2500);

  const joinedGuest = last(guest, "joined");
  const joinedHost = last(host, "joined");

  if (!joinedGuest) {
    say("   ❌ convidado não conseguiu entrar pelo túnel");
    process.exitCode = 1;
    return;
  }
  say(`   ✅ convidado entrou pelo túnel (id ${joinedGuest.self})`);
  say(`   ✅ convidado vê: ${joinedGuest.peers.map((p) => p.name).join(", ") || "ninguém"}`);
  say(
    last(host, "peer-joined")
      ? "   ✅ host foi notificado da entrada do convidado"
      : "   ❌ host não foi notificado"
  );

  // Relay de SDP do convidado (via internet) para o host (local)
  guest.ws.send(
    JSON.stringify({
      type: "relay",
      to: joinedHost.self,
      payload: { description: { type: "offer", sdp: "v=0...TUNNEL-OFFER" } },
    })
  );
  await wait(1500);
  const relayed = last(host, "relay");
  if (relayed && relayed.payload.description.sdp.includes("TUNNEL-OFFER")) {
    say("   ✅ relay de oferta SDP do convidado → host funcionou PELA INTERNET");
  } else {
    say("   ❌ relay não funcionou");
    process.exitCode = 1;
  }

  host.ws.close();
  guest.ws.close();
  await wait(500);
  tunnel.stop();
  await server.close();
  say("\n🎉 SALA HOSPEDADA PELO PRÓPRIO APP FUNCIONANDO (servidor + túnel automáticos)");
}

app.whenReady().then(() =>
  main()
    .catch((e) => {
      say("❌ erro: " + e.message);
      process.exitCode = 1;
    })
    .finally(() => setTimeout(() => app.exit(process.exitCode || 0), 800))
);
