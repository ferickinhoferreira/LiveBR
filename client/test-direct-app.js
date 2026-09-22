// Teste de INTEGRAÇÃO do modo direto usando DUAS janelas reais do app:
// uma cria o convite, a outra gera a resposta, a primeira conecta.
// Uso: npx electron test-direct-app.js
const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");
const fs = require("fs");

const LOG = path.join(__dirname, "test-direct-app.log");
fs.writeFileSync(LOG, "");
const say = (m) => {
  process.stdout.write(m + "\n");
  fs.appendFileSync(LOG, m + "\n");
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalIn(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(win, expr, timeout = 15000, label = "") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await evalIn(win, `(() => { try { return !!(${expr}); } catch(e) { return false; } })()`);
    if (ok) return true;
    await wait(300);
  }
  say(`❌ timeout esperando: ${label || expr}`);
  return false;
}

app.whenReady().then(async () => {
  // Stubs equivalentes aos do main.ts do app (o teste tem processo main próprio).
  ipcMain.handle("display:get-sources", async (_e, type = "all") => {
    const types = type === "all" ? ["screen", "window"] : [type];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 200, height: 112 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith("screen"),
    }));
  });
  ipcMain.on("display:options", () => undefined);
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      cb({ video: sources[0], audio: "loopback" });
    },
    { useSystemPicker: false }
  );

  let ok = true;
  const mkWindow = () =>
    new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "dist", "main", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

  const host = mkWindow();
  const guest = mkWindow();
  const index = path.join(__dirname, "src", "renderer", "index.html");
  await host.loadFile(index);
  await guest.loadFile(index);
  await wait(1200);

  // --- Host: nome + modo direto + criar convite ---
  await evalIn(host, `
    document.querySelector('#name-input').value = 'Erick';
    document.querySelector('[data-login-mode="direct"]').click();
    document.querySelector('#direct-host-btn').click();
    true;
  `);

  if (!(await waitFor(host, `document.querySelector('#direct-invite').value.length > 100`, 20000, "convite gerado"))) {
    ok = false;
  } else {
    say("✅ Host gerou o convite pela UI");
  }

  const invite = await evalIn(host, `document.querySelector('#direct-invite').value`);

  // --- Guest: nome + colar convite + gerar resposta ---
  await evalIn(guest, `
    document.querySelector('#name-input').value = 'Amigo';
    document.querySelector('[data-login-mode="direct"]').click();
    document.querySelector('#direct-invite-in').value = ${JSON.stringify(invite)};
    document.querySelector('#direct-answer-btn').click();
    true;
  `);

  if (!(await waitFor(guest, `document.querySelector('#direct-answer-out').value.length > 100`, 20000, "resposta gerada"))) {
    ok = false;
  } else {
    say("✅ Convidado gerou a resposta pela UI");
  }

  const answer = await evalIn(guest, `document.querySelector('#direct-answer-out').value`);

  // --- Host: colar resposta + conectar ---
  await evalIn(host, `
    document.querySelector('#direct-answer-in').value = ${JSON.stringify(answer)};
    document.querySelector('#direct-connect-btn').click();
    true;
  `);

  const connExpr = `document.querySelector('#conn-pill').textContent.includes('Direto')`;
  const connected = (await waitFor(host, connExpr, 20000, "host conectado (pill 'Direto (P2P)')"))
    && (await waitFor(guest, `document.querySelector('#conn-pill').textContent.includes('Direto')`, 20000, "guest conectado"));

  if (connected) say("✅ Conexão direta estabelecida nos DOIS apps (via UI, sem servidor)");
  else ok = false;

  // --- Verifica que cada um vê o outro na lista de participantes ---
  const hostPeers = await evalIn(host, `[...document.querySelectorAll('#peer-list .name')].map(e=>e.textContent).join(',')`);
  const guestPeers = await evalIn(guest, `[...document.querySelectorAll('#peer-list .name')].map(e=>e.textContent).join(',')`);
  say(`   host vê: ${hostPeers}`);
  say(`   guest vê: ${guestPeers}`);
  if (hostPeers.includes("Amigo") && guestPeers.includes("Erick")) {
    say("✅ Nomes trocados corretamente (dentro do convite/resposta)");
  } else {
    say("⚠️ nomes não conferem — verifique o handshake");
    ok = false;
  }

  // --- Estatísticas de conexão (prova que há rota de rede ativa) ---
  const rtt = await evalIn(host, `document.querySelector('#stat-rtt').textContent`);
  say(`   latência medida no host: ${rtt}`);

  say(ok ? "\n🎉 APP: MODO DIRETO FUNCIONANDO DE PONTA A PONTA" : "\n💥 FALHOU");
  app.exit(ok ? 0 : 1);
});

setTimeout(() => {
  say("⏱ timeout geral do teste");
  app.exit(3);
}, 120000);


