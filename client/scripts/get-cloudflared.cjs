// Baixa o cloudflared (túnel automático) se ainda não estiver em resources/.
// Usado antes do build do instalador.
const fs = require("fs");
const path = require("path");
const https = require("https");

const dest = path.join(__dirname, "..", "resources", "cloudflared.exe");
if (fs.existsSync(dest)) {
  console.log("cloudflared já presente, pulando download.");
  process.exit(0);
}

const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
console.log("Baixando cloudflared de", url, "…");

fs.mkdirSync(path.dirname(dest), { recursive: true });
const file = fs.createWriteStream(dest);

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Falha no download (HTTP ${res.statusCode}).`);
    process.exit(1);
  }
  res.pipe(file);
  file.on("finish", () => {
    file.close();
    console.log("✅ cloudflared baixado em", dest);
  });
}).on("error", (e) => {
  console.error("Erro no download:", e.message);
  process.exit(1);
});
