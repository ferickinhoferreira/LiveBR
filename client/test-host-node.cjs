// Teste rápido em Node puro (sem Electron): servidor embutido + túnel + cliente externo.
// Uso: node test-host-node.mjs
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const say = (m) => console.log(m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { startSignalingServer } = require("./dist/main/signaling-server.js");

  const server = await startSignalingServer(0);
  say(`✅ servidor embutido (HTTP+WS) na porta ${server.port}`);

  // Health local
  const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.text());
  say(`✅ health local: ${health}`);

  // Túnel
  const bin = path.join(__dirname, "resources", "cloudflared.exe");
  const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${server.port}`, "--no-autoupdate"], {
    windowsHide: true,
  });

  let out = "";
  const host = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout no túnel")), 45000);
    const onData = (c) => {
      out += c.toString();
      const m = out.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
  });
  say(`✅ túnel: wss://${host}/ws`);
  say("   aguardando o túnel ficar acessível pela internet…");

  let healthRemote = "sem resposta";
  for (let i = 0; i < 20; i++) {
    await wait(3000);
    healthRemote = await fetch(`https://${host}/health`)
      .then((r) => r.text())
      .catch((e) => "erro: " + (e.cause?.code ?? e.message));
    say(`   tentativa ${i + 1}: ${healthRemote}`);
    if (healthRemote === "ok") break;
  }

  if (healthRemote !== "ok") {
    say("❌ o túnel não alcançou o servidor embutido");
    proc.kill();
    await server.close();
    process.exit(1);
  }
  say("✅ servidor embutido acessível PELA INTERNET via túnel");

  // Host local
  const hostWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const hostMsgs = [];
  hostWs.on("message", (d) => hostMsgs.push(JSON.parse(d.toString())));
  await new Promise((r) => hostWs.on("open", r));
  hostWs.send(JSON.stringify({ type: "join", room: "TEST", name: "Host" }));
  await wait(600);

  // Convidado pela internet
  const guestWs = new WebSocket(`wss://${host}/ws`);
  const guestMsgs = [];
  guestWs.on("message", (d) => guestMsgs.push(JSON.parse(d.toString())));
  const guestOpen = await new Promise((r) => {
    guestWs.on("open", () => r(true));
    guestWs.on("error", () => r(false));
    setTimeout(() => r(false), 15000);
  });
  if (!guestOpen) {
    say("❌ convidado NÃO conseguiu conectar pelo túnel");
    proc.kill();
    await server.close();
    process.exit(1);
  }
  say("✅ convidado conectou pelo túnel público");

  guestWs.send(JSON.stringify({ type: "join", room: "TEST", name: "Convidado" }));
  await wait(1200);

  const joined = guestMsgs.find((m) => m.type === "joined");
  const hostSelf = hostMsgs.find((m) => m.type === "joined");
  const hostSaw = hostMsgs.find((m) => m.type === "peer-joined");
  say(joined ? `✅ convidado entrou na sala (vê: ${joined.peers.map((p) => p.name).join(", ") || "ninguém"})` : "❌ join falhou");
  say(hostSaw ? "✅ host notificado da entrada" : "❌ host não notificado");

  guestWs.send(
    JSON.stringify({
      type: "relay",
      to: hostSelf.self,
      payload: { description: { type: "offer", sdp: "v=0...VIA-TUNEL" } },
    })
  );
  await wait(1500);
  const relayed = hostMsgs.find((m) => m.type === "relay");
  say(relayed?.payload?.description?.sdp?.includes("VIA-TUNEL")
    ? "✅ relay de SDP do convidado → host funcionou PELA INTERNET"
    : "❌ relay falhou");

  hostWs.close();
  guestWs.close();
  proc.kill();
  await server.close();
  say("\n🎉 SALA HOSPEDADA PELO APP (servidor + túnel automáticos) VALIDADA");
  process.exit(0);
}

main().catch((e) => {
  say("❌ erro: " + e.message);
  process.exit(1);
});
