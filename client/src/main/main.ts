import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "path";
import { startSignalingServer, EmbeddedServer } from "./signaling-server";
import { startTunnel, Tunnel } from "./tunnel";

// Sala hospedada pelo próprio app (invisível para o usuário).
let embeddedServer: EmbeddedServer | null = null;
let activeTunnel: Tunnel | null = null;

// ---------------------------------------------------------------------------
// AUTO-UPDATE (GitHub Releases)
// ---------------------------------------------------------------------------

function setupAutoUpdate(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    console.log(`[LiveBR] Nova versão ${info.version} disponível, baixando…`);
    mainWindow?.webContents.send("update:available", info.version);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[LiveBR] Versão ${info.version} baixada, pronta para instalar`);
    mainWindow?.webContents.send("update:downloaded", info.version);
  });

  autoUpdater.on("error", (err) => {
    console.warn("[LiveBR] Erro no auto-update:", err.message);
  });

  // Checa atualização ao abrir (não em dev).
  if (!process.env.ELECTRON_IS_DEV) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

let mainWindow: BrowserWindow | null = null;

// Opções definidas pelo renderer antes de chamar getDisplayMedia.
let chosenSourceId: string | null = null;
let includeSystemAudio = true;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "LiveBR",
    icon: path.join(__dirname, "..", "..", "src", "renderer", "images", "liveBR.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "index.html"));
}

app.whenReady().then(() => {
  // Necessário para navigator.mediaDevices.getDisplayMedia() funcionar no Electron.
  // No Windows, `audio: 'loopback'` captura o áudio do sistema junto com a tela.
  ipcMain.on(
    "display:options",
    (_e, opts: { sourceId: string; includeSystemAudio: boolean }) => {
      chosenSourceId = opts.sourceId;
      includeSystemAudio = opts.includeSystemAudio;
    }
  );

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const deliver = async () => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
          });
          const source =
            sources.find((s) => s.id === chosenSourceId) ?? sources[0] ?? null;
          if (!source) {
            callback({} as Electron.Streams);
            return;
          }
          callback({
            video: source,
            ...(includeSystemAudio ? { audio: "loopback" } : {}),
          } as unknown as Electron.Streams);
        } catch {
          callback({} as Electron.Streams);
        } finally {
          chosenSourceId = null;
        }
      };
      void deliver();
    },
    { useSystemPicker: false }
  );

  ipcMain.handle(
    "display:get-sources",
    async (_e, type: "screen" | "window" | "all" = "all") => {
      const types: Array<"screen" | "window"> =
        type === "all" ? ["screen", "window"] : [type];
      const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 400, height: 225 },
        fetchWindowIcons: false,
      });
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        isScreen: s.id.startsWith("screen"),
      }));
    }
  );

  // ---------------------------------------------------------------------------
  // Criar sala: sobe o servidor embutido + túnel público, devolve o código.
  // ---------------------------------------------------------------------------
  ipcMain.handle("room:create", async () => {
    try {
      if (!embeddedServer) embeddedServer = await startSignalingServer(0);

      if (!activeTunnel) activeTunnel = await startTunnel(embeddedServer.port);

      const room = Math.random().toString(36).slice(2, 6).toUpperCase();
      return {
        ok: true,
        // Código = endereço público + sala. O convidado só cola isso.
        code: `livebr://${activeTunnel.host}/${room}`,
        localUrl: `ws://127.0.0.1:${embeddedServer.port}/ws`,
        room,
        port: embeddedServer.port,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("room:stop", async () => {
    activeTunnel?.stop();
    activeTunnel = null;
    await embeddedServer?.close();
    embeddedServer = null;
    return { ok: true };
  });

  // Abre o mixer de volume do Windows (para o usuário abaixar o volume de um app
  // que ele não quer transmitir, ex.: Discord).
  ipcMain.on("open-volume-mixer", () => {
    const { exec } = require("child_process");
    exec("sndvol.exe");
  });

  // Auto-update: o renderer pede para reiniciar e aplicar.
  ipcMain.on("update:install", quitAndInstall);
  ipcMain.handle("update:check", () => autoUpdater.checkForUpdates());

  setupAutoUpdate();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});