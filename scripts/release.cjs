// LiveBR — release completo no GitHub: bump de versão, build, release, upload.
//
// Uso:
//   node scripts/release.cjs 0.3.0        → sobe como v0.3.0
//   node scripts/release.cjs patch        → incrementa o patch (0.2.0 → 0.3.0? não, 0.2.1)
//   node scripts/release.cjs minor        → incrementa o minor (0.2.0 → 0.3.0)
//   node scripts/release.cjs major        → incrementa o major
//
// Pré-requisito: variável de ambiente GH_TOKEN com um Personal Access Token
// com permissão "contents: write" no repositório.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const PKG_PATH = path.join(CLIENT, "package.json");
const OWNER = "ferickinhoferreira";
const REPO = "LiveBR";

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("❌ defina a variável GH_TOKEN com o seu Personal Access Token do GitHub.");
  process.exit(1);
}

const arg = process.argv[2] ?? "patch";
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
const [ma, mi, pa] = pkg.version.split(".").map(Number);

function bump(v) {
  if (arg === "patch") return `${ma}.${mi}.${pa + 1}`;
  if (arg === "minor") return `${ma}.${mi + 1}.0`;
  if (arg === "major") return `${ma + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  console.error("❌ versão inválida. Use patch | minor | major | x.y.z");
  process.exit(1);
}

const version = bump(pkg.version);
const log = (m) => console.log(m);

function ghApi(method, urlPath, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      `https://api.github.com${urlPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "User-Agent": "livebr-release",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...extra,
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(out ? JSON.parse(out) : {});
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function uploadAsset(releaseId, filePath) {
  const name = path.basename(filePath);
  const data = fs.readFileSync(filePath);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
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
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          if (res.statusCode === 201) resolve();
          else reject(new Error(`HTTP ${res.statusCode} em ${name}: ${out.slice(0, 200)}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(data);
    req.end();
  });
}

async function main() {
  log(`▶ versão ${pkg.version} → ${version}`);

  // 1) bump no package.json
  pkg.version = version;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  log(`   ✓ package.json atualizado`);

  // 2) build
  log("▶ gerando instalador…");
  execSync("npm run installer", { cwd: CLIENT, stdio: "inherit" });

  // 3) commit + tag + push
  log("▶ commit + tag + push…");
  const pushUrl = `https://${OWNER}:${TOKEN}@github.com/${OWNER}/${REPO}.git`;
  execSync("git add -A", { cwd: ROOT, stdio: "inherit" });
  execSync(`git commit -m "release v${version}"`, { cwd: ROOT, stdio: "inherit" });
  execSync(`git tag v${version}`, { cwd: ROOT, stdio: "inherit" });
  execSync(`git push ${pushUrl} main --tags`, { cwd: ROOT, stdio: "inherit" });

  // 4) release no GitHub
  log(`▶ criando release v${version}…`);
  const release = await ghApi("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: `v${version}`,
    target_commitish: "main",
    name: `LiveBR ${version}`,
    body: `## LiveBR ${version}\n\nCompartilhamento de tela P2P estilo Discord Go Live.\n\n**Download:** \`LiveBR-${version}-Setup.exe\`\n\nQuem já tem instalado recebe a atualização automaticamente.`,
    draft: false,
    prerelease: false,
  });
  log(`   ✓ release criada (id ${release.id})`);

  // 5) upload dos artefatos
  const installerDir = path.join(CLIENT, "installer");
  const files = fs
    .readdirSync(installerDir)
    .filter((f) => f.startsWith(`LiveBR-${version}-Setup`) || f === "latest.yml" || f === "LiveBR-Portable.exe");
  for (const f of files) {
    log(`   ↑ ${f} (${(fs.statSync(path.join(installerDir, f)).size / 1024 / 1024).toFixed(1)} MB)…`);
    await uploadAsset(release.id, path.join(installerDir, f));
  }

  log(`\n🎉 LiveBR ${version} publicada!`);
  log(`   https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`);
  log("   Quem já instalou recebe a atualização na próxima vez que abrir o app.");
}

main().catch((e) => {
  console.error("❌ " + e.message);
  process.exit(1);
});
