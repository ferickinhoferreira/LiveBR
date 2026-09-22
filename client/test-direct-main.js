// Executa o teste E2E do modo direto (sem servidor) dentro do Chromium do Electron.
// Uso: npx electron test-direct-main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.commandLine.appendSwitch("use-fake-device-for-media-stream");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  let failed = false;

  win.webContents.on("console-message", (_e, _level, message) => {
    if (message.startsWith("RESULT")) console.log("✅ " + message.slice(7));
    else if (message.startsWith("FAIL")) {
      failed = true;
      console.log("❌ " + message.slice(5));
    } else if (message === "ALL_PASS") {
      console.log("\n🎉 MODO DIRETO VALIDADO (oferta/resposta manual + mídia bidirecional)");
      app.exit(0);
    } else if (message === "HAS_FAIL") {
      console.log("\n💥 FALHOU");
      app.exit(1);
    } else if (!message.includes("Electron Security Warning")) {
      console.log("   " + message);
    }
  });

  win.loadFile(path.join(__dirname, "test-direct.html"));

  setTimeout(() => {
    if (!failed) console.log("⏱ timeout do teste");
    app.exit(failed ? 1 : 2);
  }, 60000);
});
