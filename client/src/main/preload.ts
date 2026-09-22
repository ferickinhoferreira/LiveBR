import { contextBridge, ipcRenderer } from "electron";

export interface DisplaySource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}

contextBridge.exposeInMainWorld("livebr", {
  /** Lista telas ou janelas. */
  getDisplaySources: (type: "screen" | "window" | "all"): Promise<DisplaySource[]> =>
    ipcRenderer.invoke("display:get-sources", type),

  /** Define a fonte escolhida e se o áudio do sistema deve ser capturado. */
  setDisplayOptions: (sourceId: string, includeSystemAudio: boolean): void =>
    ipcRenderer.send("display:options", { sourceId, includeSystemAudio }),

  /** Cria uma sala: o app hospeda a sinalização e abre o acesso público sozinho. */
  createRoom: (): Promise<{
    ok: boolean;
    code?: string;
    localUrl?: string;
    room?: string;
    error?: string;
  }> => ipcRenderer.invoke("room:create"),

  /** Encerra a sala hospedada (servidor + túnel). */
  stopRoom: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("room:stop"),

  /** Auto-update: notificações e controle. */
  onUpdateAvailable: (cb: (version: string) => void): void => {
    ipcRenderer.on("update:available", (_e, v) => cb(v));
  },
  onUpdateDownloaded: (cb: (version: string) => void): void => {
    ipcRenderer.on("update:downloaded", (_e, v) => cb(v));
  },
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
  installUpdate: (): void => ipcRenderer.send("update:install"),
});