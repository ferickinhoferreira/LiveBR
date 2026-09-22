// Teste de INTEGRACAO: host cria sala (servidor embutido + tunel automatico)
// e o convidado entra apenas colando o codigo. Sem configuracao de servidor.
// Uso: npx electron test-host-app.js
const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");
const fs = require("fs");

const LOG = path.join(__dirname, "test-host-app-result.log");
fs.writeFileSync(LOG, "");
const say = (m) => {
  process.stdout.write(m + "\n");
  fs.appendFileSync(LOG, m + "\n");
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalIn(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(win, expr, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await evalIn(
      win,
      `(() => { try { return !!(${expr}); } catch(e) { return false; } })()`
    );
    if (ok) return true;
    await wait(500);
  }
  say(`FALHOU: timeout esperando ${label}`);
  return false;
}

app.whenReady().then(async () => {
  let ok = true;

  // --- handlers do processo main (equivalentes ao main.ts do app) ---
  const { startSignalingServer } = require("./dist/main/signaling-server.js");
  const { startTunnel } = require("./dist/main/tunnel.js");

  let embeddedServer = null;
  let activeTunnel = null;

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

  ipcMain.handle("room:create", async () => {
    try {
      if (!embeddedServer) embeddedServer = await startSignalingServer(0);
      if (!activeTunnel) activeTunnel = await startTunnel(embeddedServer.port);
      const room = Math.random().toString(36).slice(2, 6).toUpperCase();
      return {
        ok: true,
        code: `livebr://${activeTunnel.host}/${room}`,
        localUrl: `ws://127.0.0.1:${embeddedServer.port}/ws`,
        room,
        port: embeddedServer.port,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("room:stop", async () => {
    activeTunnel?.stop();
    activeTunnel = null;
    await embeddedServer?.close();
    embeddedServer = null;
    return { ok: true };
  });

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

  // --- HOST: clica em "Criar sala" (sem configurar nada) ---
  say("1) host clicando em Criar sala (sobe servidor + tunel escondidos)...");
  await evalIn(
    host,
    `document.querySelector('#name-input').value = 'Erick';
     document.querySelector('#create-room-btn').click(); true;`
  );

  const gotCode = await waitFor(
    host,
    `document.querySelector('#share-room-btn').title.startsWith('livebr://')`,
    90000,
    "codigo da sala do host"
  );
  if (!gotCode) ok = false;

  const code = gotCode ? await evalIn(host, `document.querySelector('#share-room-btn').title`) : "";
  if (gotCode) say(`   OK host criou a sala: ${code}`);

  // --- CONVIDADO: cola o codigo e entra ---
  if (gotCode) {
    say("2) convidado colando o codigo e entrando...");
    await evalIn(
      guest,
      `document.querySelector('#name-input').value = 'Amigo';
       document.querySelector('#join-code-input').value = ${JSON.stringify(code)};
       document.querySelector('#join-code-btn').click(); true;`
    );

    const guestConnected = await waitFor(
      guest,
      `document.querySelector('#conn-pill').textContent.includes('Conectado')`,
      40000,
      "convidado conectado"
    );
    const hostConnected = await waitFor(
      host,
      `document.querySelector('#conn-pill').textContent.includes('Conectado')`,
      40000,
      "host conectado"
    );

    if (guestConnected && hostConnected) {
      say("   OK os dois apps conectados na sala (sem configurar servidor)");
    } else {
      ok = false;
    }

    // --- Cada um ve o outro na lista de participantes ---
    await wait(2500);
    const hostSees = await evalIn(
      host,
      `[...document.querySelectorAll('#peer-list .name')].map(e=>e.textContent).join(',')`
    );
    const guestSees = await evalIn(
      guest,
      `[...document.querySelectorAll('#peer-list .name')].map(e=>e.textContent).join(',')`
    );
    say(`   host ve: ${hostSees}`);
    say(`   guest ve: ${guestSees}`);
    if (hostSees.includes("Amigo") && guestSees.includes("Erick")) {
      say("   OK presenca mutua confirmada");
    } else {
      ok = false;
    }

    // --- Perfil + Amizade via data channel ---
    const guestGotProfile = await waitFor(
      guest,
      `document.querySelectorAll('#peer-list li[data-peer] .avatar').length >= 2`,
      8000,
      "perfil recebido"
    );
    say(guestGotProfile ? "   OK perfil dos peers renderizado" : "   aviso: perfil não apareceu");

    // Envia pedido de amizade do host para o guest (clica no avatar do guest)
    await evalIn(
      host,
      `(() => {
        const li = [...document.querySelectorAll('#peer-list li')].find(l => l.dataset.peer && l.dataset.peer !== 'me');
        if (li) li.querySelector('.avatar-wrap').click();
        return !!li;
      })()`
    );
    await wait(600);
    const popOpened = await evalIn(host, `!!document.getElementById('profile-pop')`);
    say(popOpened ? "   OK popover de perfil abriu ao clicar no avatar" : "   FALHOU popover de perfil");

    if (popOpened) {
      // Pode ser botão "Adicionar" (não amigos ainda) ou "✅ já são amigos"
      // (estado persistido de execuções anteriores).
      await evalIn(
        host,
        `[...document.querySelectorAll('#profile-pop .btn')].find(b => b.textContent.includes('Adicionar'))?.click(); true;`
      );
      await wait(1200);
      const guestSawReq = await evalIn(
        guest,
        `!!document.querySelector('.toast.friend-req')`
      );
      const alreadyFriends = await evalIn(
        host,
        `[...document.querySelectorAll('#profile-pop span')].some(s => s.textContent.includes('Vocês são amigos'))`
      );
      if (guestSawReq) say("   OK pedido de amizade chegou no guest");
      else if (alreadyFriends) say("   OK ja sao amigos (estado persistido de teste anterior)");
      else ok = false;
        await evalIn(
          guest,
          `[...document.querySelectorAll('.toast.friend-req .btn')].find(b => b.textContent.includes('Aceitar'))?.click(); true;`
        );
        await wait(1500);
        const hostFriendCount = await evalIn(
          host,
          `JSON.parse(localStorage.getItem('livebrFriends') || '[]').length`
        );
        const guestFriendCount = await evalIn(
          guest,
          `JSON.parse(localStorage.getItem('livebrFriends') || '[]').length`
        );
        // >= 1 porque o localStorage persiste entre execuções do teste.
        say(
          hostFriendCount >= 1 && guestFriendCount >= 1
            ? `   OK amizade registrada nos DOIS lados (host=${hostFriendCount}, guest=${guestFriendCount})`
            : `   FALHOU amizade (host=${hostFriendCount}, guest=${guestFriendCount})`
        );
        if (!(hostFriendCount >= 1 && guestFriendCount >= 1)) ok = false;
      }
    }

    // --- Mic automático ao entrar (feedback de áudio presente) ---
    const micActive = await evalIn(
      guest,
      `document.querySelector('#mic-btn') && !document.querySelector('#mic-btn').classList.contains('off')`
    );
    say(micActive ? "   OK microfone ligado automaticamente ao entrar" : "   aviso: mic não iniciou (permissão?)");

    // --- Coroa do host ---
    const hostCrowns = await evalIn(
      host,
      `document.querySelectorAll('#peer-list .crown').length`
    );
    const guestCrowns = await evalIn(
      guest,
      `document.querySelectorAll('#peer-list .crown').length`
    );
    const guestSeesHost = await evalIn(
      guest,
      `[...document.querySelectorAll('#peer-list li')].some(li => li.querySelector('.crown') && li.querySelector('.name').textContent === 'Erick')`
    );
    if (hostCrowns === 1 && guestCrowns === 1 && guestSeesHost) {
      say("   OK coroa do host (Erick) aparece nos DOIS apps");
    } else {
      say(`   FALHOU coroa: host tem ${hostCrowns}, guest tem ${guestCrowns}, guest ve host=${guestSeesHost}`);
      ok = false;
    }

    // --- Chat via data channel ---
    await wait(2000);
    await evalIn(
      host,
      `document.querySelector('#chat-input').value = 'ola pessoal'; document.querySelector('#chat-send').click(); true;`
    );
    const guestSawChat = await waitFor(
      guest,
      `[...document.querySelectorAll('#chat-messages .chat-text')].some(e => e.textContent.includes('ola pessoal'))`,
      10000,
      "chat chegou no guest"
    );
    if (guestSawChat) {
      say("   OK chat funcionou (mensagem do host apareceu no guest)");
      // Resposta do guest
      await evalIn(
        guest,
        `document.querySelector('#chat-input').value = 'e ai!'; document.querySelector('#chat-send').click(); true;`
      );
      const hostSawReply = await waitFor(
        host,
        `[...document.querySelectorAll('#chat-messages .chat-text')].some(e => e.textContent.includes('e ai!'))`,
        10000,
        "resposta chegou no host"
      );
      if (hostSawReply) say("   OK chat bidirecional");
      else ok = false;
    } else {
      ok = false;
    }

    // --- Watch party: link do YouTube ---
    await evalIn(
      host,
      `document.querySelector('#watch-url').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
       document.querySelector('#watch-add').click(); true;`
    );
    const guestSawVideo = await waitFor(
      guest,
      `!!document.querySelector('#tile-watch iframe')`,
      10000,
      "video apareceu no guest"
    );
    if (guestSawVideo) say("   OK watch party (YouTube) sincronizou para o guest");
    else ok = false;

    // --- Parar de assistir ---
    const watchBtnExists = await evalIn(
      guest,
      `!!document.querySelector('#tile-watch, #peer-list')`
    );
    void watchBtnExists;
    const peerTileHasWatchBtn = await evalIn(
      host,
      `(() => { const t = document.querySelector('#tile-watch .tile-actions'); return !!t; })()`
    );
    say(peerTileHasWatchBtn ? "   OK controles do tile de video presentes" : "   aviso: tile sem controles");
  }

  console.log(ok ? "\nAPP: CRIAR SALA + ENTRAR COM CODIGO FUNCIONANDO" : "\nFALHOU");
  app.exit(ok ? 0 : 1);
});

setTimeout(() => {
  say("timeout geral do teste");
  app.exit(3);
}, 180000);
