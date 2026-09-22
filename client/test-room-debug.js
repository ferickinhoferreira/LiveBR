// Diagnostico: captura todas as mensagens de sinalizacao trocadas nos dois apps.
// Uso: npx electron test-room-debug.js
const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");
const fs = require("fs");

const LOG = path.join(__dirname, "test-room-debug-result.log");
fs.writeFileSync(LOG, "");
const say = (m) => {
  process.stdout.write(m + "\n");
  fs.appendFileSync(LOG, m + "\n");
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = (w, code) => w.webContents.executeJavaScript(code, true);

async function waitFor(win, expr, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalIn(win, `(() => { try { return !!(${expr}); } catch(e) { return false; } })()`)) return true;
    await wait(400);
  }
  say(`FALHOU: timeout esperando ${label}`);
  return false;
}

// Injeta um espião no WebSocket do renderer para gravar tudo que chega/parte.
const SPY = `
  window.__msgs = [];
  const NativeWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = new NativeWS(url, protocols);
    window.__wsUrl = url;
    ws.addEventListener('message', (e) => { try { window.__msgs.push(JSON.parse(e.data)); } catch(_) {} });
    const origSend = ws.send.bind(ws);
    ws.send = (d) => { try { window.__msgs.push({ __sent: true, ...JSON.parse(d) }); } catch(_) {} return origSend(d); };
    return ws;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  true;
`;

app.whenReady().then(async () => {
  const { startSignalingServer } = require("./dist/main/signaling-server.js");
  const { startTunnel } = require("./dist/main/tunnel.js");
  let embeddedServer = null;
  let activeTunnel = null;

  ipcMain.handle("display:get-sources", async () => []);
  ipcMain.on("display:options", () => undefined);
  session.defaultSession.setDisplayMediaRequestHandler(async (_r, cb) => cb({}), { useSystemPicker: false });
  ipcMain.handle("room:create", async () => {
    if (!embeddedServer) embeddedServer = await startSignalingServer(0);
    if (!activeTunnel) activeTunnel = await startTunnel(embeddedServer.port);
    const room = Math.random().toString(36).slice(2, 6).toUpperCase();
    return { ok: true, code: `livebr://${activeTunnel.host}/${room}`, localUrl: `ws://127.0.0.1:${embeddedServer.port}/ws`, room };
  });
  ipcMain.handle("room:stop", async () => {
    activeTunnel?.stop();
    activeTunnel = null;
    await embeddedServer?.close();
    embeddedServer = null;
    return { ok: true };
  });

  const mk = () =>
    new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "dist", "main", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

  const host = mk();
  const guest = mk();
  const index = path.join(__dirname, "src", "renderer", "index.html");
  await host.loadFile(index);
  await guest.loadFile(index);
  await wait(1000);

  await evalIn(host, SPY);
  await evalIn(guest, SPY);

  await evalIn(host, `document.querySelector('#name-input').value='Erick';
    document.querySelector('#create-room-btn').click(); true;`);

  const gotCode = await waitFor(host, `document.querySelector('#share-room-btn').title.startsWith('livebr://')`, 90000, "codigo");
  const code = await evalIn(host, `document.querySelector('#share-room-btn').title`);
  say(`codigo: ${code}`);

  // Espera o host realmente entrar na sala antes do convidado
  await waitFor(host, `document.querySelector('#conn-pill').textContent.includes('Conectado')`, 30000, "host conectado");
  say("host conectado ao proprio servidor");

  await evalIn(guest, `document.querySelector('#name-input').value='Amigo';
    document.querySelector('#join-code-input').value=${JSON.stringify(code)};
    document.querySelector('#join-code-btn').click(); true;`);

  await waitFor(guest, `document.querySelector('#conn-pill').textContent.includes('Conectado')`, 40000, "guest conectado");
  await wait(3000);

  say("\n--- GUEST: mensagens de controle ---");
  say(
    JSON.stringify(
      await evalIn(
        guest,
        `window.__msgs.filter(m => m.type === 'joined' || m.type === 'peer-joined' || m.type === 'peer-left')`
      ),
      null,
      1
    )
  );
  say("\n--- GUEST: HTML da lista de participantes ---");
  say(await evalIn(guest, `document.querySelector('#peer-list').innerHTML`));
  say("\n--- GUEST: contagem (peer-count) ---");
  say(await evalIn(guest, `document.querySelector('#peer-count').textContent`));

  say("\n--- HOST: mensagens de controle ---");
  say(
    JSON.stringify(
      await evalIn(
        host,
        `window.__msgs.filter(m => m.type === 'joined' || m.type === 'peer-joined' || m.type === 'peer-left')`
      ),
      null,
      1
    )
  );
  say("\n--- HOST: HTML da lista de participantes ---");
  say(await evalIn(host, `document.querySelector('#peer-list').innerHTML`));

  app.exit(0);
});

setTimeout(() => app.exit(3), 180000);
