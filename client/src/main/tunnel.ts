// Túnel automático: expõe o servidor embutido do host na internet sem o usuário
// saber que isso existe. Usa o cloudflared empacotado no app (quick tunnel).
import { app } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface Tunnel {
  /** Hostname público, ex: "algo-aleatorio.trycloudflare.com" */
  host: string;
  stop: () => void;
}

function cloudflaredPath(): string | null {
  const candidates = [
    // Empacotado (produção): <recursos>/cloudflared.exe
    path.join(process.resourcesPath ?? "", "cloudflared.exe"),
    // Desenvolvimento: client/resources/cloudflared.exe
    path.join(__dirname, "..", "..", "resources", "cloudflared.exe"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignora */
    }
  }
  return null;
}

export async function startTunnel(localPort: number, timeoutMs = 30000): Promise<Tunnel> {
  const bin = cloudflaredPath();
  if (!bin) throw new Error("cloudflared não encontrado no app empacotado.");

  const proc: ChildProcess = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
    { windowsHide: true }
  );

  let output = "";
  let stopped = false;

  const host = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Tempo esgotado ao abrir o túnel."));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      // Procura a URL pública no log do cloudflared.
      const m = output.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("exit", (code) => {
      if (!stopped) {
        clearTimeout(timer);
        reject(new Error(`cloudflared terminou inesperadamente (código ${code}).`));
      }
    });
  });

  app.once("before-quit", () => {
    stopped = true;
    proc.kill();
  });

  return {
    host,
    stop: () => {
      stopped = true;
      proc.kill();
    },
  };
}
