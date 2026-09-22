// Upload dos artefatos da release para o GitHub.
const fs = require("fs");
const path = require("path");
const https = require("https");

const TOKEN = process.env.GH_TOKEN;
const RELEASE_ID = process.env.RELEASE_ID || "393465628";
const INSTALLER_DIR = path.join(__dirname, "..", "client", "installer");

const FILES = [
  "LiveBR Setup 0.2.0.exe",
  "LiveBR Setup 0.2.0.exe.blockmap",
  "LiveBR-Portable.exe",
  "latest.yml",
];

const log = (m) => console.log(m);

async function upload(name) {
  const filePath = path.join(INSTALLER_DIR, name);
  const data = fs.readFileSync(filePath);
  const url = `https://uploads.github.com/repos/ferickinhoferreira/LiveBR/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(name)}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "User-Agent": "livebr-release",
          "Content-Type": "application/octet-stream",
          "Content-Length": data.length,
        },
        timeout: 600000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 201) resolve();
          else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout de upload")));
    req.write(data);
    req.end();
  });
}

async function main() {
  for (const f of FILES) {
    const size = fs.statSync(path.join(INSTALLER_DIR, f)).size;
    log(`subindo ${f} (${(size / 1024 / 1024).toFixed(1)} MB)…`);
    await upload(f);
    log(`   OK: ${f}`);
  }
  log("TODOS OS ARTEFATOS ENVIADOS");
}

main().catch((e) => {
  log("ERRO: " + e.message);
  process.exit(1);
});
