// LiveBR — gera o APK Android a partir do renderer web.
//
// Uso:
//   node scripts/build-android.cjs
//
// Passos: build do client → copia web para android/app/src/main/assets/www
// → gradle assembleRelease → android/LiveBR-<versão>.apk
//
// Requisitos: JDK 17, Android SDK (platforms;android-34 + build-tools;34.0.0)
// e Gradle 8.9 (ou defina GRADLE_HOME / LIVEBR_JDK no ambiente).
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const ANDROID = path.join(ROOT, "android");
const RENDERER = path.join(CLIENT, "src", "renderer");
const WWW = path.join(ANDROID, "app", "src", "main", "assets", "www");

const log = (m) => console.log(m);

// --- JDK 17 (o Gradle 8.9 não roda no Java mais novo que costuma estar no PATH) ---
const jdk = [
  process.env.LIVEBR_JDK,
  "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot",
  "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.10+1",
  "C:\\Program Files\\Java\\jdk-17",
  process.env.JAVA_HOME,
].find((p) => p && fs.existsSync(path.join(p, "bin", "java.exe")));
if (jdk) process.env.JAVA_HOME = jdk;

// --- Gradle ---
function findGradle() {
  if (process.env.GRADLE_HOME) {
    return path.join(
      process.env.GRADLE_HOME,
      "bin",
      process.platform === "win32" ? "gradle.bat" : "gradle"
    );
  }
  const local = "D:\\Android\\gradle-8.9\\bin\\gradle.bat";
  if (process.platform === "win32" && fs.existsSync(local)) return local;
  return "gradle";
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT, "package.json"), "utf-8"));
  const version = pkg.version;
  const [ma, mi, pa] = version.split(".").map((n) => Number(n) || 0);
  const versionCode = ma * 10000 + mi * 100 + pa;

  // 1) build do renderer (tsc + esbuild)
  if (!process.argv.includes("--skip-build")) {
    log("▶ buildando o client…");
    execSync("npm run build", { cwd: CLIENT, stdio: "inherit" });
  }

  // 2) copia a web app para os assets do APK
  log("▶ copiando web assets…");
  fs.rmSync(WWW, { recursive: true, force: true });
  fs.mkdirSync(path.join(WWW, "dist"), { recursive: true });

  // O index.html referencia ../../dist/renderer.js (layout do Electron);
  // dentro do APK tudo fica sob assets/www, então o caminho vira dist/…
  const html = fs
    .readFileSync(path.join(RENDERER, "index.html"), "utf-8")
    .replace("../../dist/renderer.js", "dist/renderer.js");
  fs.writeFileSync(path.join(WWW, "index.html"), html);

  fs.copyFileSync(path.join(RENDERER, "style.css"), path.join(WWW, "style.css"));
  fs.copyFileSync(path.join(RENDERER, "android-shim.js"), path.join(WWW, "android-shim.js"));
  fs.cpSync(path.join(RENDERER, "images"), path.join(WWW, "images"), { recursive: true });
  fs.cpSync(path.join(RENDERER, "sounds"), path.join(WWW, "sounds"), { recursive: true });
  fs.copyFileSync(path.join(CLIENT, "dist", "renderer.js"), path.join(WWW, "dist", "renderer.js"));

  // 3) APK assinado
  const gradle = findGradle();
  log(`▶ gradle assembleRelease (v${version})…`);
  execSync(
    `"${gradle}" -p "${ANDROID}" assembleRelease -PappVersionName=${version} -PappVersionCode=${versionCode}`,
    { stdio: "inherit", windowsHide: true }
  );

  const built = path.join(ANDROID, "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!fs.existsSync(built)) {
    console.error("❌ APK não encontrado em " + built);
    process.exit(1);
  }
  const out = path.join(ANDROID, `LiveBR-${version}.apk`);
  fs.copyFileSync(built, out);
  log(`\n🎉 ${out}`);
  log(`   versionCode=${versionCode} · assinado com android/keystore/livebr.keystore`);
}

main();
