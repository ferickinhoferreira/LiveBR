// ============================================================================
// LiveBR — UI estilo Discord Go Live + mesh WebRTC (perfect negotiation)
// ============================================================================

interface DisplaySource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}
declare const livebr: {
  getDisplaySources: (type: "screen" | "window" | "all") => Promise<DisplaySource[]>;
  setDisplayOptions: (
    sourceId: string,
    includeSystemAudio: boolean,
    audioMode?: "loopback" | "window" | "none"
  ) => void;
  createRoom: () => Promise<{
    ok: boolean;
    code?: string;
    localUrl?: string;
    room?: string;
    error?: string;
  }>;
  stopRoom: () => Promise<{ ok: boolean }>;
  onUpdateAvailable: (cb: (version: string) => void) => void;
  onUpdateDownloaded: (cb: (version: string) => void) => void;
  checkForUpdates: () => Promise<unknown>;
  installUpdate: () => void;
  openVolumeMixer: () => void;
  listAudioApps: () => Promise<{ name: string }[]>;
  setAppVolume: (app: string, volume: number) => void;
  restoreAllAppVolumes: (apps: string[]) => void;
};

// ---------------------------------------------------------------------------
// Perfil do usuário (estilo Discord): nome, foto, banner, bio, moldura, efeito
// ---------------------------------------------------------------------------

interface Profile {
  name: string;
  bio: string;
  /** dataURL da foto (thumbnail ~128px) */
  photo: string;
  /** cor do banner (hex) */
  banner: string;
  /** moldura do avatar */
  frame: "none" | "gold" | "neon" | "rainbow" | "fire" | "glitch";
  /** efeito no nome */
  nameEffect: "none" | "gradient" | "glow";
  /** código de amigo único da instalação */
  friendCode: string;
}

const DEFAULT_PROFILE: Profile = {
  name: "Convidado",
  bio: "",
  photo: "",
  banner: "#5865f2",
  frame: "none",
  nameEffect: "none",
  friendCode: "",
};

function genFriendCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function loadProfile(): Profile {
  let p: Profile;
  try {
    p = { ...DEFAULT_PROFILE, ...JSON.parse(localStorage.getItem("livebrProfile") ?? "{}") };
  } catch {
    p = { ...DEFAULT_PROFILE };
  }
  if (!p.friendCode) p.friendCode = genFriendCode();
  return p;
}

let myProfile: Profile = loadProfile();
function saveProfile(): void {
  localStorage.setItem("livebrProfile", JSON.stringify(myProfile));
}

/** Perfis dos outros, recebidos via data channel. */
const peerProfiles = new Map<string, Profile>();

function myAvatarHtml(size: number): string {
  if (myProfile.photo) {
    return `<img src="${myProfile.photo}" class="avatar-img" style="width:${size}px;height:${size}px" alt=""/>`;
  }
  return "";
}


interface Prefs {
  resolution: "480p" | "720p" | "1080p" | "1440p" | "native";
  fps: 15 | 30 | 60;
  bitrateMbps: number;
  includeSystemAudio: boolean;
  micCapture: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  sensitivity: number;
  hiQuality: boolean;
  micDeviceId: string;
  speakerDeviceId: string;
}

const DEFAULT_PREFS: Prefs = {
  resolution: "1080p",
  fps: 30,
  bitrateMbps: 4,
  includeSystemAudio: true,
  micCapture: true,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  sensitivity: 50,
  hiQuality: true,
  micDeviceId: "",
  speakerDeviceId: "",
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("livebrPrefs") ?? "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
function savePrefs(): void {
  localStorage.setItem("livebrPrefs", JSON.stringify(prefs));
}
const prefs: Prefs = loadPrefs();

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------

const DEFAULT_WS_URL = "ws://localhost:3000/ws";

let ws: WebSocket | null = null;
let myId = "";
let myName = "";
let roomCode = "";
let wsUrl = DEFAULT_WS_URL;
let turnUrl = "";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let intentionallyLeft = false;

let ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

let displayStream: MediaStream | null = null;
let localStream = new MediaStream();
let sharing = false;

// Áudio do microfone: raw -> gain(sensibilidade) -> track transmitida
let micRawStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micGain: GainNode | null = null;
let micOutTrack: MediaStreamTrack | null = null;
let micEnabled = true;
let deafened = false;

interface PeerCtx {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  name: string;
  stream: MediaStream | null;
  analyser: { ctx: AudioContext; node: AnalyserNode; buf: Uint8Array } | null;
  levelTimer: ReturnType<typeof setInterval> | null;
  rtt: number | null;
  bitrate: number;
  isSharing: boolean;
  /** Quem criou a sala. */
  isHost: boolean;
  /** Data channel para chat e watch party. */
  dc: RTCDataChannel | null;
}
const peers = new Map<string, PeerCtx>();

/** Eu sou o host da sala (quem criou). */
let amIHost = false;

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function toast(msg: string, kind: "info" | "ok" | "err" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast ${kind === "info" ? "" : kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function initials(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** Cor de avatar consistente por nome (hash → matiz), estilo Discord. */
const AVATAR_COLORS = [
  "#5865f2", "#eb459e", "#57f287", "#fee75c", "#ed4245",
  "#f47fff", "#ffa500", "#00d4aa", "#4c8dff", "#ff6b6b",
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/** Avatar circular: foto de perfil (se houver) ou cor por nome, com moldura. */
function makeAvatar(name: string, size = 34, useImage = false, profile?: Profile): HTMLElement {
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;

  const photo = profile?.photo ?? "";
  if (photo) {
    // Foto de perfil da pessoa — SEM texto por cima.
    el.style.backgroundImage = `url(${photo})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.classList.add("with-img");
  } else if (useImage) {
    // Imagem de perfil padrão (guest) — sem texto por cima.
    el.style.backgroundImage = "url(images/guest_profile.png)";
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.classList.add("with-img");
  } else {
    // Sem foto: cor por nome + inicial.
    el.style.background = avatarColor(name);
    el.textContent = initials(name);
  }

  const frame = profile?.frame ?? "none";
  if (frame !== "none") el.classList.add(`frame-${frame}`);

  el.style.fontSize = `${Math.round(size * 0.44)}px`;
  return el;
}

function fmtMbps(v: number): string {
  return v > 0 ? `${v.toFixed(1)} Mbps` : "–";
}

function showModal(id: string): void {
  $(`#${id}`).classList.remove("hidden");
}
function hideModal(id: string): void {
  $(`#${id}`).classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Tiles de vídeo
// ---------------------------------------------------------------------------

interface TileRefs {
  root: HTMLElement;
  video: HTMLVideoElement;
  avatar: HTMLElement;
  live: HTMLElement;
  quality: HTMLElement;
}

const tiles = new Map<string, TileRefs>();

function createTile(id: string, label: string): TileRefs {
  const existing = tiles.get(id);
  if (existing) return existing;

  const isHost = id === "me" ? amIHost : (peers.get(id)?.isHost ?? false);

  const root = document.createElement("div");
  root.className = "tile";
  root.id = `tile-${id}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (id === "me") video.muted = true;

  // Avatar grande (imagem de convidado) quando não está transmitindo vídeo.
  const avatar = document.createElement("div");
  avatar.className = "tile-avatar";
  const circle = makeAvatar(label, 84, true);
  circle.classList.add("big");
  const avName = document.createElement("div");
  avName.textContent = label;
  avatar.append(circle, avName);

  const bar = document.createElement("div");
  bar.className = "tile-bar";
  const nameEl = document.createElement("div");
  nameEl.className = "tile-name";
  nameEl.textContent = `${id === "me" ? "▶ " : ""}${label}`;
  if (isHost) {
    const crown = document.createElement("span");
    crown.className = "crown-inline";
    crown.title = "Host";
    crown.textContent = "👑";
    nameEl.prepend(crown);
  }
  const badges = document.createElement("div");
  badges.className = "tile-badges";
  const live = document.createElement("span");
  live.className = "badge-live";
  live.textContent = "AO VIVO";
  live.style.display = "none";
  const quality = document.createElement("span");
  quality.className = "badge-q";
  quality.textContent = "•";
  badges.append(quality, live);
  bar.append(nameEl, badges);

  const actions = document.createElement("div");
  actions.className = "tile-actions";
  const zoomBtn = document.createElement("button");
  zoomBtn.textContent = "⤢";
  zoomBtn.title = "Expandir / reduzir";
  zoomBtn.onclick = () => root.classList.toggle("zoomed");
  const fullBtn = document.createElement("button");
  fullBtn.textContent = "⛶";
  fullBtn.title = "Tela cheia";
  fullBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => undefined);
  };

  // Slider de volume individual (0 a 150%) — só faz sentido para os outros.
  let volWrap: HTMLElement | null = null;
  if (id !== "me") {
    volWrap = document.createElement("div");
    volWrap.className = "vol-slider";
    const icon = document.createElement("span");
    icon.textContent = "🔊";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "150";
    slider.value = "100";
    slider.oninput = () => {
      const v = Number(slider.value) / 100;
      // Acima de 100% usa WebAudio para amplificar.
      if (v > 1) boostAudio(video, v);
      else video.volume = v;
      icon.textContent = v === 0 ? "🔇" : v < 0.5 ? "🔉" : v > 1 ? "📢" : "🔊";
    };
    volWrap.append(icon, slider);
  }

  actions.append(zoomBtn, fullBtn);

  // Parar/voltar a assistir (só para transmissões de outras pessoas).
  if (id !== "me" && id !== "me-cam" && id !== watchTileId) {
    const watchBtn = document.createElement("button");
    watchBtn.textContent = "👁";
    watchBtn.title = "Parar de assistir / voltar a assistir";
    watchBtn.onclick = () => toggleWatchPeer(id);
    actions.prepend(watchBtn);

    // Fechar o tile (esconder da grade até voltar a transmitir).
    const hideBtn = document.createElement("button");
    hideBtn.textContent = "✕";
    hideBtn.title = "Fechar transmissão de " + label;
    hideBtn.onclick = () => removeTile(id);
    actions.appendChild(hideBtn);
  }

  if (volWrap) actions.appendChild(volWrap);

  root.append(video, avatar, bar, actions);
  $("#video-grid").appendChild(root);
  $("#empty-stage").classList.add("hidden");

  const refs: TileRefs = { root, video, avatar, live, quality };
  tiles.set(id, refs);
  return refs;
}

/** Amplificação de volume acima de 100% via WebAudio (para quem está assistindo). */
const boostMap = new WeakMap<HTMLVideoElement, { ctx: AudioContext; gain: GainNode }>();
function boostAudio(video: HTMLVideoElement, factor: number): void {
  let b = boostMap.get(video);
  if (!b) {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(ctx.destination);
    b = { ctx, gain };
    boostMap.set(video, b);
  }
  b.gain.gain.value = factor;
}

function attachStream(id: string, label: string, stream: MediaStream): void {
  const refs = createTile(id, label);
  refs.video.srcObject = stream;
  refs.video.play().catch(() => undefined);

  const hasVideo = stream.getVideoTracks().length > 0;
  refs.avatar.style.display = hasVideo ? "none" : "flex";
  refs.live.style.display = hasVideo ? "inline-block" : "none";

  // No modo direto os placeholders chegam como vídeo: só mostramos "AO VIVO"
  // depois que o outro lado avisa pelo data channel que está transmitindo.
  if (loginMode === "direct" && id === DIRECT_PEER_ID) {
    refs.avatar.style.display = "flex";
    refs.live.style.display = "none";
  }

  if (hasVideo) {
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      refs.avatar.style.display = "flex";
      refs.live.style.display = "none";
    });
  }

  // Voz: analisa o áudio remoto para o indicador de fala.
  if (id !== "me") setupRemoteLevel(id, stream);
}

function removeTile(id: string): void {
  const refs = tiles.get(id);
  if (refs) {
    refs.video.srcObject = null;
    refs.root.remove();
    tiles.delete(id);
  }
  const ctx = peers.get(id);
  if (ctx) {
    clearInterval(ctx.levelTimer!);
    ctx.analyser?.ctx.close().catch(() => undefined);
    ctx.levelTimer = null;
    ctx.analyser = null;
  }
  renderParticipants();
  if (tiles.size === 0) $("#empty-stage").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Indicador de fala + lista de participantes + estatísticas
// ---------------------------------------------------------------------------

function speechThreshold(): number {
  // Sensibilidade maior => limiar menor (detecta voz mais baixa).
  return 0.015 + ((100 - prefs.sensitivity) / 100) * 0.085;
}

function setupRemoteLevel(peerId: string, stream: MediaStream): void {
  const ctx = peers.get(peerId);
  if (!ctx || stream.getAudioTracks().length === 0) return;
  if (ctx.analyser) {
    ctx.analyser.ctx.close().catch(() => undefined);
    clearInterval(ctx.levelTimer!);
  }
  try {
    const actx = new AudioContext();
    const src = actx.createMediaStreamSource(stream);
    const node = actx.createAnalyser();
    // FFT menor = leitura mais rápida; suavização para o anel não piscar.
    node.fftSize = 256;
    node.smoothingTimeConstant = 0.7;
    src.connect(node);
    ctx.analyser = { ctx: actx, node, buf: new Uint8Array(node.frequencyBinCount) };

    let displayed = 0;
    // ~60fps para animação fluida de verdade (via requestAnimationFrame).
    const tick = (): void => {
      const a = ctx.analyser;
      if (!a) return;
      a.node.getByteFrequencyData(a.buf as any);
      let sum = 0;
      for (const v of a.buf) sum += v;
      const raw = sum / a.buf.length / 255;
      // Suavização exponencial: sobe rápido, desce devagar (como o Discord).
      displayed = raw > displayed ? displayed + (raw - displayed) * 0.55 : displayed * 0.88;

      const speaking = displayed > speechThreshold();
      const wrap = document.querySelector<HTMLElement>(
        `#peer-list li[data-peer="${peerId}"] .avatar-wrap`
      );
      if (wrap) {
        wrap.classList.toggle("speaking", speaking);
        wrap.style.setProperty("--speak-level", Math.min(1, displayed * 3).toFixed(2));
      }
      const dot = document.querySelector(`#peer-list li[data-peer="${peerId}"] .dot`);
      dot?.classList.toggle("off", !speaking);
      tiles.get(peerId)?.root.classList.toggle("speaking", speaking);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    /* sem áudio analisável */
  }
}

function renderParticipants(): void {
  const list = $("#peer-list");
  list.innerHTML = "";

  const addRow = (
    id: string,
    label: string,
    live: boolean,
    mic: boolean,
    isHost: boolean,
    isMe: boolean
  ): void => {
    const li = document.createElement("li");
    li.dataset.peer = id;

    // Perfil da pessoa (meu ou recebido via data channel).
    const prof: Profile | null =
      isMe ? myProfile : (peerProfiles.get(id) ?? null);
    const shownName = prof?.name || label;

    // Avatar com foto/moldura — clicar abre o perfil.
    const avatarWrap = document.createElement("span");
    avatarWrap.className = "avatar-wrap";
    const av = makeAvatar(shownName, 34, false, prof ?? undefined);
    avatarWrap.appendChild(av);
    if (isHost) {
      const crown = document.createElement("span");
      crown.className = "crown";
      crown.title = "Host";
      crown.textContent = "👑";
      avatarWrap.appendChild(crown);
    }
    const dot = document.createElement("span");
    dot.className = `dot${isMe || live ? "" : " off"}`;
    avatarWrap.appendChild(dot);
    avatarWrap.style.cursor = "pointer";
    avatarWrap.title = "Ver perfil";
    avatarWrap.onclick = (e) => {
      e.stopPropagation();
      const fallback: Profile = {
        name: shownName,
        bio: "",
        photo: "",
        banner: "#586b8c",
        frame: "none",
        nameEffect: "none",
        friendCode: "",
      };
      openProfilePopover(id, prof ?? fallback, peers.get(id) ?? null);
    };

    const name = document.createElement("span");
    name.className = "name";
    if (prof && prof.nameEffect !== "none") name.classList.add(`name-effect-${prof.nameEffect}`);
    name.textContent = isMe ? `${shownName} (você)` : shownName;

    const icons = document.createElement("span");
    icons.className = "icons";
    icons.textContent = `${live ? "🖥️" : ""}${mic ? "" : "🔇"}`;

    li.append(avatarWrap, name, icons);
    list.appendChild(li);
  };

  addRow("me", myName, sharing, micEnabled && !deafened, amIHost, true);
  for (const [id, ctx] of peers) {
    const t = tiles.get(id);
    // No modo direto, quem manda é o aviso pelo data channel.
    const isLive =
      loginMode === "direct" ? ctx.isSharing : !!t && t.live.style.display !== "none";
    addRow(id, ctx.name, isLive, true, ctx.isHost, false);
  }

  $("#peer-count").textContent = String(peers.size + 1);
  $("#viewers-pill").textContent = `👥 ${peers.size + 1}`;
}

function setConnPill(state: "ok" | "warn" | "err", text: string): void {
  const pill = $("#conn-pill");
  pill.className = `pill ${state}`;
  pill.textContent = `● ${text}`;
}

// ---------------------------------------------------------------------------
// Qualidade de conexão (ping): verde bom / amarelo ok / vermelho ruim
// ---------------------------------------------------------------------------

function rttClass(rtt: number | null): "net-good" | "net-ok" | "net-bad" | "net-off" {
  if (rtt === null) return "net-off";
  if (rtt < 80) return "net-good";
  if (rtt < 160) return "net-ok";
  return "net-bad";
}

/** Texto curto de qualidade de rede por peer (usado no badge do tile). */
function netLabel(rtt: number | null, candType: string): string {
  const tag = candType === "relay" ? "TURN" : "P2P";
  if (rtt === null) return tag;
  return `${tag} ${Math.round(rtt)}ms`;
}

async function pollStats(): Promise<void> {
  let totalBitrate = 0;
  let bestRtt: number | null = null;

  for (const [id, ctx] of peers) {
    try {
      const stats = await ctx.pc.getStats();
      let rtt: number | null = null;
      let bytes = 0;
      let candType = "";

      const candidates = new Map<string, any>();
      stats.forEach((r) => {
        if (r.type === "local-candidate") candidates.set(r.id, r);
      });
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && (r.state === "succeeded" || r.nominated)) {
          if (typeof r.currentRoundTripTime === "number") rtt = r.currentRoundTripTime * 1000;
          if (r.localCandidateId) {
            const local = candidates.get(r.localCandidateId);
            if (local?.candidateType) candType = local.candidateType;
          }
        }
        if (r.type === "inbound-rtp" && r.kind === "video" && r.bytesReceived) {
          bytes += r.bytesReceived;
        }
      });

      // Bitrate aproximado entre polls (2s).
      const prev = ctx.bitrate;
      const mbps = bytes > 0 ? (bytes * 8) / 2 / 1_000_000 : 0;
      ctx.bitrate = mbps;
      void prev;

      ctx.rtt = rtt;
      totalBitrate += mbps;
      if (rtt !== null && (bestRtt === null || rtt < bestRtt)) bestRtt = rtt;

      // Badge do tile com cor por latência.
      const quality = tiles.get(id)?.quality;
      if (quality) {
        quality.className = `badge-q ${rttClass(rtt)}`;
        quality.textContent = netLabel(rtt, candType);
        quality.title = rtt !== null ? `Latência: ${Math.round(rtt)} ms` : "Sem dados";
      }

      // Indicador de sinal na lista de participantes.
      const li = document.querySelector(`#peer-list li[data-peer="${id}"]`);
      if (li) {
        let sig = li.querySelector(".net-signal") as HTMLElement | null;
        if (!sig) {
          sig = document.createElement("span");
          sig.className = "net-signal";
          const icons = li.querySelector(".icons");
          icons?.prepend(sig);
        }
        sig.className = `net-signal ${rttClass(rtt)}`;
        sig.textContent = rtt !== null ? `${Math.round(rtt)}ms` : "–";
        sig.title = rtt !== null ? `Ping de ${ctx.name}: ${Math.round(rtt)} ms` : "";
      }
    } catch {
      /* peer fechando */
    }
  }

  // Sidebar: latência geral com a cor do melhor peer.
  const rttEl = $("#stat-rtt");
  if (bestRtt !== null) {
    rttEl.textContent = `${Math.round(bestRtt)} ms`;
    rttEl.className = rttClass(bestRtt);
  } else {
    rttEl.textContent = "–";
    rttEl.className = "";
  }
  $("#stat-bitrate").textContent = fmtMbps(totalBitrate);
}

function startStatsPolling(): void {
  clearInterval(statsTimer!);
  statsTimer = setInterval(() => void pollStats(), 2000);
}

// ---------------------------------------------------------------------------
// Sinalização
// ---------------------------------------------------------------------------

function sendToServer(msg: object): void {
  ws?.send(JSON.stringify(msg));
}

function relay(peerId: string, payload: object): void {
  sendToServer({ type: "relay", to: peerId, payload });
}

async function buildIceServers(): Promise<void> {
  ICE_SERVERS = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  if (!turnUrl) return;
  try {
    const httpUrl = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
    const res = await fetch(`${httpUrl}/turn-creds`);
    const creds = await res.json();
    ICE_SERVERS.push({
      urls: [turnUrl, turnUrl.replace(/^turn:/, "turns:")],
      username: creds.username,
      credential: creds.password,
    });
    console.log("TURN efêmero configurado (expira em", creds.ttl, "s)");
  } catch {
    console.warn("Sem credenciais TURN — seguindo só com STUN.");
  }
}

function connect(): void {
  clearTimeout(reconnectTimer!);
  setConnPill("warn", "Conectando…");

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setConnPill("ok", "Conectado");
    clearInterval(pingTimer!);
    pingTimer = setInterval(() => sendToServer({ type: "ping" }), 30_000);
    sendToServer({ type: "join", room: roomCode, name: myName });
  };

  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // A sinalização NUNCA deve parar por causa de um erro de UI.
    try {
      handleServerMessage(msg);
    } catch (err) {
      console.error("Erro ao processar mensagem de sinalização:", err);
    }
  };

  ws.onclose = () => {
    clearInterval(pingTimer!);
    if (intentionallyLeft) return;
    setConnPill("err", "Reconectando…");
    for (const ctx of peers.values()) {
      ctx.pc.close();
      clearInterval(ctx.levelTimer!);
      ctx.analyser?.ctx.close().catch(() => undefined);
    }
    peers.clear();
    for (const id of [...tiles.keys()]) if (id !== "me") removeTile(id);
    renderParticipants();
    reconnectTimer = setTimeout(connect, 3000);
  };
}

// ---------------------------------------------------------------------------
// Qualidade de áudio (MÚSICA): Opus estéreo + bitrate alto via SDP munging.
// Sem isso o WebRTC negocia o Opus em modo "voz" (mono, bitrate baixo), que
// estraga música. É o mesmo truque que o Google Meet usa.
// ---------------------------------------------------------------------------

function enhanceOpusSdp(sdp: string): string {
  const lines = sdp.split("\r\n");
  let opusPt: string | null = null;
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
    if (m) {
      opusPt = m[1];
      break;
    }
  }
  if (!opusPt) return sdp;

  const extra = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000";
  const out: string[] = [];
  let found = false;
  for (const l of lines) {
    if (l.startsWith(`a=fmtp:${opusPt}`)) {
      const base = l.replace(`a=fmtp:${opusPt}`, "").replace(/^[\s=]+/, "");
      const kept = base
        .split(";")
        .filter(
          (p) =>
            p.trim() &&
            !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)\s*=/i.test(p.trim())
        );
      out.push(`a=fmtp:${opusPt} ${[...kept, extra].join(";")}`);
      found = true;
    } else {
      out.push(l);
    }
  }
  if (!found) {
    const idx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt}`));
    if (idx >= 0) out.splice(idx + 1, 0, `a=fmtp:${opusPt} ${extra}`);
  }
  return out.join("\r\n");
}

/** Trata cada mensagem do servidor de sinalização. */
function handleServerMessage(msg: any): void {
  switch (msg.type) {
    case "joined":
      myId = msg.self;
      amIHost = !!msg.isHost;
      for (const p of msg.peers) createPeer(p.id, p.name, !!p.isHost);
      renderParticipants();
      toast(`Você entrou na sala ${roomCode}${amIHost ? " — você é o host 👑" : ""}`, "ok");
      break;
    case "peer-joined":
      createPeer(msg.peer, msg.name, !!msg.isHost);
      renderParticipants();
      playChime("join");
      toast(`${msg.name} entrou na sala`);
      break;
    case "peer-left": {
      const name = peers.get(msg.peer)?.name ?? "Alguém";
      // Marca o amigo como offline.
      const prof = peerProfiles.get(msg.peer);
      if (prof) {
        peerProfiles.delete(msg.peer);
        const idx = friends.findIndex((f) => f.code === prof.friendCode);
        if (idx >= 0) {
          friends[idx].onlineNow = false;
          saveFriends();
          renderFriends();
        }
      }
      peers.get(msg.peer)?.pc.close();
      clearInterval(peers.get(msg.peer)?.levelTimer!);
      peers.get(msg.peer)?.analyser?.ctx.close().catch(() => undefined);
      peers.delete(msg.peer);
      removeTile(msg.peer);
      playChime("leave");
      toast(`${name} saiu da sala`);
      break;
    }
    case "relay":
      handleRelay(msg.from, msg.payload).catch(console.error);
      break;
    case "reaction":
      showReaction(msg.emoji, msg.name);
      break;
    case "error":
      toast(msg.message, "err");
      break;
  }
}

// ---------------------------------------------------------------------------
// Feedbacks visuais: reações flutuantes, anel de fala, beeps, título
// ---------------------------------------------------------------------------

function showReaction(emoji: string, name: string): void {
  const el = document.createElement("div");
  el.className = "reaction";
  el.textContent = emoji;
  // Posição aleatória ao longo da largura (mais no centro).
  const left = 25 + Math.random() * 50;
  el.style.left = `${left}%`;
  el.title = name;

  const label = document.createElement("div");
  label.className = "reaction-name";
  label.textContent = name;
  label.style.cssText =
    "font-size:12px;text-align:center;margin-top:-6px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8);font-weight:600";
  el.appendChild(label);

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

function sendReaction(emoji: string): void {
  showReaction(emoji, myName);
  sendData({ kind: "reaction", emoji, from: myId || "me", name: myName });
}

function playChime(kind: "join" | "leave"): void {
  // Usa os efeitos sonoros do app (join.mp3 / leave_ui.mp3).
  playSound(kind === "join" ? "join" : "leave_ui");
}

// ---------------------------------------------------------------------------
// Efeitos sonoros (mp3 do app)
// ---------------------------------------------------------------------------

const soundCache = new Map<string, HTMLAudioElement>();

function playSound(
  name: "join" | "leave_ui" | "chat_mensage" | "mic_or_headset_off" | "share_screen_on" | "share_screen_off",
  opts?: { pitch?: number; volume?: number }
): void {
  try {
    let base = soundCache.get(name);
    if (!base) {
      base = new Audio(`sounds/${name}.mp3`);
      soundCache.set(name, base);
    }
    const a = base.cloneNode() as HTMLAudioElement;
    a.volume = opts?.volume ?? 0.6;
    if (opts?.pitch) a.playbackRate = opts.pitch;
    void a.play().catch(() => undefined);
  } catch {
    /* som indisponível */
  }
}

// ---------------------------------------------------------------------------
// Chat + Parar de assistir + estado dos peers
// ---------------------------------------------------------------------------

interface ChatMsg {
  kind: "chat";
  from: string;
  name: string;
  text: string;
  ts: number;
}
interface PeerStateMsg {
  kind: "state";
  watching?: boolean;
  sharing?: boolean;
  from: string;
}
interface ReactionMsg {
  kind: "reaction";
  emoji: string;
  from: string;
  name: string;
}
type DataMsg =
  | ChatMsg
  | WatchMsg
  | PeerStateMsg
  | ReactionMsg
  | ProfileMsg
  | FriendReqMsg
  | FriendResMsg;

function wireDataChannel(peerId: string, dc: RTCDataChannel): void {
  dc.onopen = () => {
    console.log(`dc ${peerId} aberto`);
    // Handshake: manda meu perfil assim que o canal abre.
    sendMyProfile(peerId);
  };
  dc.onmessage = (e) => {
    let msg: DataMsg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.kind === "chat") addChatMessage(msg as ChatMsg, false);
    else if (msg.kind === "watch") handleWatchMessage(msg as WatchMsg);
    else if (msg.kind === "state") handlePeerState(msg as PeerStateMsg);
    else if (msg.kind === "reaction") {
      const m = msg as ReactionMsg;
      showReaction(m.emoji, m.name);
    } else if (msg.kind === "profile") {
      applyPeerProfile(peerId, (msg as ProfileMsg).profile);
    } else if (msg.kind === "friendReq") {
      const m = msg as FriendReqMsg;
      if (!isFriend(m.code)) showFriendRequest(peerId, m);
    } else if (msg.kind === "friendAccept") {
      const m = msg as FriendResMsg;
      const pending = pendingFriendSends.get(m.code);
      if (pending) {
        addFriend({ ...pending, addedAt: Date.now(), onlineNow: true });
        pendingFriendSends.delete(m.code);
        toast("Pedido de amizade aceito 🎉", "ok");
      }
    } else if (msg.kind === "friendDecline") {
      const m = msg as FriendResMsg;
      pendingFriendSends.delete(m.code);
      toast("Pedido de amizade recusado.", "err");
    }
  };
}

function sendData(msg: DataMsg, onlyPeer?: string): void {
  const text = JSON.stringify(msg);
  for (const [id, ctx] of peers) {
    if (onlyPeer && id !== onlyPeer) continue;
    if (ctx.dc?.readyState === "open") ctx.dc.send(text);
  }
}

// -------------------- Ações de amizade + popover de perfil --------------------

/** Pedidos que EU enviei, aguardando resposta (por código). */
const pendingFriendSends = new Map<string, Omit<Friend, "addedAt" | "onlineNow">>();

function sendFriendRequest(peerId: string): void {
  const p = peerProfiles.get(peerId);
  if (!p) {
    toast("Ainda não recebi o perfil dessa pessoa. Tente em instantes.", "err");
    return;
  }
  if (isFriend(p.friendCode)) {
    toast("Vocês já são amigos!", "ok");
    return;
  }
  pendingFriendSends.set(p.friendCode, {
    code: p.friendCode,
    name: p.name,
    photo: p.photo,
    banner: p.banner,
    frame: p.frame,
  });
  sendData(
    {
      kind: "friendReq",
      code: myProfile.friendCode,
      name: myProfile.name,
      photo: myProfile.photo,
      banner: myProfile.banner,
      frame: myProfile.frame,
      from: myId || "me",
    },
    peerId
  );
  toast(`Pedido de amizade enviado para ${p.name}`, "ok");
}

function showFriendRequest(peerId: string, req: FriendReqMsg): void {
  const el = document.createElement("div");
  el.className = "toast friend-req";
  el.innerHTML = `<strong>${req.name}</strong> quer ser seu amigo`;

  const accept = document.createElement("button");
  accept.className = "btn primary small-btn";
  accept.textContent = "Aceitar";
  accept.onclick = () => {
    addFriend({
      code: req.code,
      name: req.name,
      photo: req.photo,
      banner: req.banner,
      frame: req.frame,
      addedAt: Date.now(),
      onlineNow: true,
    });
    sendData({ kind: "friendAccept", code: req.code, from: myId || "me" }, peerId);
    el.remove();
  };

  const decline = document.createElement("button");
  decline.className = "btn small-btn";
  decline.textContent = "Recusar";
  decline.onclick = () => {
    sendData({ kind: "friendDecline", code: req.code, from: myId || "me" }, peerId);
    el.remove();
  };

  el.append(accept, decline);
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 30000);
}

/** Popover com o perfil de alguém (abre ao clicar na foto). */
function openProfilePopover(peerId: string, profile: Profile, peerCtx: PeerCtx | null): void {
  closeProfilePopover();

  const pop = document.createElement("div");
  pop.className = "profile-pop";
  pop.id = "profile-pop";

  const banner = document.createElement("div");
  banner.className = "pop-banner";
  banner.style.background = profile.banner || "#5865f2";

  const av = makeAvatar(profile.name, 76, true, profile);
  av.classList.add("pop-avatar");

  const body = document.createElement("div");
  body.className = "pop-body";

  const name = document.createElement("div");
  name.className = "pop-name";
  name.textContent = profile.name;
  if (profile.nameEffect !== "none") name.classList.add(`name-effect-${profile.nameEffect}`);

  const code = document.createElement("div");
  code.className = "muted";
  code.style.fontSize = "12px";
  code.textContent = `Código de amigo: ${profile.friendCode || "—"}`;

  const bio = document.createElement("div");
  bio.className = "pop-bio";
  bio.textContent = profile.bio || "Sem descrição.";

  body.append(name, code, bio);

  const actions = document.createElement("div");
  actions.className = "pop-actions";

  const isMe = peerId === "me";

  if (!isMe) {
    if (peerCtx && !isFriend(profile.friendCode)) {
      const addBtn = document.createElement("button");
      addBtn.className = "btn primary small-btn";
      addBtn.textContent = "➕ Adicionar amigo";
      addBtn.onclick = () => {
        sendFriendRequest(peerId);
        closeProfilePopover();
      };
      actions.appendChild(addBtn);
    } else if (isFriend(profile.friendCode)) {
      const okBtn = document.createElement("span");
      okBtn.className = "muted";
      okBtn.style.cssText = "font-size:12px;padding:8px";
      okBtn.textContent = "✅ Vocês são amigos";
      actions.appendChild(okBtn);
    }

    const focusBtn = document.createElement("button");
    focusBtn.className = "btn small-btn";
    focusBtn.textContent = "⤢ Ver em foco";
    focusBtn.onclick = () => {
      tiles.get(peerId)?.root.classList.toggle("zoomed");
      closeProfilePopover();
    };
    actions.appendChild(focusBtn);
  } else {
    const editBtn = document.createElement("button");
    editBtn.className = "btn primary small-btn";
    editBtn.textContent = "✏️ Editar meu perfil";
    editBtn.onclick = () => {
      closeProfilePopover();
      openProfileEditor();
    };
    actions.appendChild(editBtn);
  }

  pop.append(banner, av, body, actions);
  document.body.appendChild(pop);

  setTimeout(() => {
    document.addEventListener("click", outsideClose, { once: true });
  }, 10);
}

function outsideClose(e: MouseEvent): void {
  const pop = document.getElementById("profile-pop");
  if (pop && !pop.contains(e.target as Node)) closeProfilePopover();
}

function closeProfilePopover(): void {
  document.getElementById("profile-pop")?.remove();
}

// -------------------- Volume por app (excluir apps do som) --------------------

let excludedApps: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem("livebrExcludedApps") ?? "[]");
  } catch {
    return [];
  }
})();

function saveExcludedApps(): void {
  localStorage.setItem("livebrExcludedApps", JSON.stringify(excludedApps));
}

async function renderAppAudioList(): Promise<void> {
  const list = $("#app-audio-list");
  list.innerHTML = '<div class="hint">Carregando apps…</div>';

  let apps: { name: string }[] = [];
  try {
    apps = await livebr.listAudioApps();
  } catch {
    list.innerHTML = '<div class="hint">Não foi possível listar os apps.</div>';
    return;
  }

  list.innerHTML = "";
  if (apps.length === 0) {
    list.innerHTML = '<div class="hint">Nenhum app aberto com janela.</div>';
    return;
  }

  for (const app of apps) {
    const row = document.createElement("label");
    row.className = "radio-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !excludedApps.includes(app.name);
    cb.onchange = () => {
      if (cb.checked) {
        // Marcado: app pode transmitir (restaura volume).
        excludedApps = excludedApps.filter((a) => a !== app.name);
        livebr.setAppVolume(app.name, 1);
      } else {
        excludedApps.push(app.name);
        // Muta o app para o sistema todo — então não entra na transmissão.
        livebr.setAppVolume(app.name, 0);
      }
      saveExcluded();
    };

    const span = document.createElement("span");
    span.textContent = app.name;

    row.append(cb, span);
    list.appendChild(row);
  }
}

function saveExcluded(): void {
  localStorage.setItem("livebrExcludedApps", JSON.stringify(excludedApps));
}

/** Restaura os volumes dos apps que estavam excluídos (ao sair da sala). */
function restoreExcludedApps(): void {
  if (excludedApps.length > 0) {
    livebr.restoreAllAppVolumes(excludedApps);
    excludedApps = [];
    saveExcluded();
  }
}

// -------------------- Perfil via data channel + Amigos --------------------

interface ProfileMsg {
  kind: "profile";
  profile: Profile;
}
interface FriendReqMsg {
  kind: "friendReq";
  code: string;
  name: string;
  photo: string;
  banner: string;
  frame: Profile["frame"];
  from: string;
}
interface FriendResMsg {
  kind: "friendAccept" | "friendDecline";
  code: string;
  from: string;
}

interface Friend {
  code: string;
  name: string;
  photo: string;
  banner: string;
  frame: Profile["frame"];
  addedAt: number;
  onlineNow: boolean;
}

let friends: Friend[] = (() => {
  try {
    return JSON.parse(localStorage.getItem("livebrFriends") ?? "[]");
  } catch {
    return [];
  }
})();

function saveFriends(): void {
  localStorage.setItem("livebrFriends", JSON.stringify(friends));
}

/** Envia meu perfil quando o canal abre (handshake). */
function sendMyProfile(peerId?: string): void {
  sendData({ kind: "profile", profile: myProfile }, peerId);
}

function applyPeerProfile(peerId: string, profile: Profile): void {
  peerProfiles.set(peerId, profile);
  const ctx = peers.get(peerId);
  if (ctx) ctx.name = profile.name || ctx.name;

  // Se essa pessoa é meu amigo, marco como online agora e atualizo os dados.
  const idx = friends.findIndex((f) => f.code === profile.friendCode);
  if (idx >= 0) {
    friends[idx] = {
      ...friends[idx],
      name: profile.name,
      photo: profile.photo,
      banner: profile.banner,
      frame: profile.frame,
      onlineNow: true,
    };
    saveFriends();
    renderFriends();
  }

  renderParticipants();
  // Atualiza o tile se existir.
  const tile = tiles.get(peerId);
  if (tile) {
    const av = tile.avatar;
    av.innerHTML = "";
    const circle = makeAvatar(profile.name, 84, true, profile);
    circle.classList.add("big");
    const name = document.createElement("div");
    name.textContent = profile.name;
    name.className = profile.nameEffect !== "none" ? `name-effect-${profile.nameEffect}` : "";
    av.append(circle, name);
  }
}

// -------------------- Amigos --------------------

function isFriend(code: string): boolean {
  return friends.some((f) => f.code === code);
}

function addFriend(f: Friend): void {
  if (isFriend(f.code)) return;
  friends.push(f);
  saveFriends();
  renderFriends();
  toast(`${f.name} agora é seu amigo 🎉`, "ok");
}

function renderFriends(): void {
  const list = $("#friend-list");
  if (!list) return;
  list.innerHTML = "";

  const online = friends.filter((f) => f.onlineNow);
  const offline = friends.filter((f) => !f.onlineNow);

  const addRow = (f: Friend): void => {
    const li = document.createElement("li");
    li.className = "friend-item";
    li.dataset.code = f.code;

    const wrap = document.createElement("span");
    wrap.className = "avatar-wrap";
    const av = makeAvatar(f.name, 32, false, f as unknown as Profile);
    wrap.appendChild(av);
    const dot = document.createElement("span");
    dot.className = `dot${f.onlineNow ? "" : " off"}`;
    wrap.appendChild(dot);
    if (f.frame !== "none") av.classList.add(`frame-${f.frame}`);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name;

    li.append(wrap, name);
    li.onclick = () => openProfilePopover(f.code, f as unknown as Profile, null);
    list.appendChild(li);
  };

  if (online.length) {
    const h = document.createElement("div");
    h.className = "friend-section muted";
    h.textContent = `Online — ${online.length}`;
    list.appendChild(h);
    online.forEach(addRow);
  }
  if (offline.length) {
    const h = document.createElement("div");
    h.className = "friend-section muted";
    h.textContent = `Offline — ${offline.length}`;
    list.appendChild(h);
    offline.forEach(addRow);
  }
  if (friends.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.padding = "8px";
    empty.textContent = "Sem amigos ainda. Entre na sala e clique na foto da pessoa.";
    list.appendChild(empty);
  }
}

function addChatMessage(msg: ChatMsg, mine: boolean): void {
  const box = $("#chat-messages");
  const row = document.createElement("div");
  row.className = "chat-msg";
  if (mine) row.dataset.mine = "1";

  const body = document.createElement("div");
  body.className = "chat-body";

  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const name = document.createElement("span");
  name.className = "chat-name";
  name.textContent = msg.name;
  name.style.color = avatarColor(msg.name);
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = new Date(msg.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  meta.append(name, time);

  const text = document.createElement("div");
  text.className = "chat-text";
  text.textContent = msg.text;

  body.append(meta, text);
  row.appendChild(body);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  if (!mine) toast(`${msg.name}: ${msg.text.slice(0, 40)}`);
}

function sendChat(): void {
  const input = $("#chat-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  const msg: ChatMsg = { kind: "chat", from: myId || "me", name: myName, text, ts: Date.now() };
  addChatMessage(msg, true);
  sendData(msg);
  playSound("chat_mensage", { volume: 0.3 });
}

// -------------------- Parar de assistir --------------------

/** Set de peers que estamos assistindo (false = pausamos). */
const watching = new Map<string, boolean>();

function toggleWatchPeer(peerId: string): void {
  const now = !watching.get(peerId);
  watching.set(peerId, now);

  const tile = tiles.get(peerId);
  if (tile) {
    if (now) {
      tile.video.srcObject = peers.get(peerId)?.stream ?? null;
      tile.root.style.opacity = "";
      tile.avatar.style.display = "none";
    } else {
      tile.video.srcObject = null;
      tile.root.style.opacity = "0.35";
      tile.avatar.style.display = "flex";
      tile.avatar.innerHTML = "";
      const av = makeAvatar(peers.get(peerId)?.name ?? "?", 56);
      const txt = document.createElement("div");
      txt.className = "muted";
      txt.style.marginTop = "8px";
      txt.textContent = "Transmissão pausada por você";
      tile.avatar.append(av, txt);
    }
  }
  sendData({ kind: "state", watching: now, from: myId || "me" }, peerId);
  renderParticipants();
}

function handlePeerState(msg: PeerStateMsg): void {
  const ctx = peers.get(msg.from);
  if (!ctx) return;

  // O outro começou/parou de transmitir (aplica também à câmera).
  if (typeof msg.sharing === "boolean") {
    ctx.isSharing = msg.sharing;
    if (!msg.sharing) {
      // Parou de transmitir: o tile dele some da grade.
      removeTile(msg.from);
      toast(`${ctx.name} parou de transmitir a tela`);
    } else {
      toast(`${ctx.name} começou a transmitir a tela`);
    }
    renderParticipants();
  }

  if (typeof msg.watching === "boolean") {
    toast(
      msg.watching
        ? `${ctx.name} voltou a assistir sua tela`
        : `${ctx.name} parou de assistir sua tela`
    );
    renderParticipants();
  }
}

// ---------------------------------------------------------------------------
// Câmera
// ---------------------------------------------------------------------------

let cameraStream: MediaStream | null = null;

async function shareCamera(): Promise<void> {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    toast("Não foi possível abrir a câmera.", "err");
    console.error(err);
    return;
  }

  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;

  for (const ctx of peers.values()) ctx.pc.addTrack(track, cameraStream);

  const refs = createTile("me-cam", `${myName} (câmera)`);
  refs.video.srcObject = cameraStream;
  refs.avatar.style.display = "none";
  refs.live.style.display = "inline-block";
  refs.live.textContent = "CÂMERA";

  toast("Câmera compartilhada", "ok");
}

function stopCamera(): void {
  for (const t of cameraStream?.getTracks() ?? []) t.stop();
  for (const ctx of peers.values()) {
    for (const sender of ctx.pc.getSenders()) {
      if (sender.track && cameraStream?.getTracks().includes(sender.track)) {
        ctx.pc.removeTrack(sender);
      }
    }
  }
  cameraStream = null;
  removeTile("me-cam");
  toast("Câmera desligada");
}

// ---------------------------------------------------------------------------
// Watch party (vídeo externo: YouTube, Twitch, vídeo direto)
// ---------------------------------------------------------------------------

interface WatchMsg {
  kind: "watch";
  action: "add" | "play" | "pause" | "seek" | "remove";
  url: string;
  time?: number;
  from: string;
}

let watchState: {
  url: string;
  type: "youtube" | "twitch" | "video";
  el: HTMLVideoElement | HTMLIFrameElement | null;
} | null = null;
const watchTileId = "watch";

function parseWatchUrl(url: string): { type: "youtube" | "twitch" | "video"; embed: string } | null {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return { type: "youtube", embed: `https://www.youtube.com/embed/${yt[1]}?autoplay=1` };

  const tw = url.match(/twitch\.tv\/(?:videos\/(\d+)|([\w]+))/);
  if (tw) {
    const base = "https://player.twitch.tv/?parent=" + location.hostname;
    if (tw[1]) return { type: "twitch", embed: `${base}&video=${tw[1]}&autoplay=true` };
    return { type: "twitch", embed: `${base}&channel=${tw[2]}&autoplay=true` };
  }

  if (/\.(mp4|webm|m3u8)(\?|$)/i.test(url)) return { type: "video", embed: url };
  return null;
}

function addWatchTile(url: string, isOwner: boolean): void {
  const parsed = parseWatchUrl(url);
  if (!parsed) {
    toast("Link não reconhecido. Use YouTube, Twitch ou um vídeo .mp4/.webm.", "err");
    return;
  }

  removeTile(watchTileId);

  const root = document.createElement("div");
  root.className = "tile watch-tile";
  root.id = `tile-${watchTileId}`;

  let mediaEl: HTMLVideoElement | HTMLIFrameElement;
  if (parsed.type === "video") {
    const v = document.createElement("video");
    v.src = parsed.embed;
    v.autoplay = true;
    v.controls = true;
    v.playsInline = true;
    mediaEl = v;
  } else {
    const f = document.createElement("iframe");
    f.src = parsed.embed;
    f.allow = "autoplay; fullscreen; picture-in-picture";
    f.allowFullscreen = true;
    f.style.border = "none";
    mediaEl = f;
  }

  const bar = document.createElement("div");
  bar.className = "watch-bar";
  const who = document.createElement("span");
  who.className = "muted";
  who.textContent = isOwner ? "Você adicionou" : "Sincronizado";
  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.title = "Remover vídeo";
  removeBtn.onclick = () => {
    removeTile(watchTileId);
    watchState = null;
    sendData({ kind: "watch", action: "remove", url, from: myId || "me" });
  };
  bar.append(who, removeBtn);

  root.append(mediaEl, bar);
  $("#video-grid").appendChild(root);
  $("#empty-stage").classList.add("hidden");

  // Para vídeo direto (.mp4), sincroniza play/pause/seek.
  if (parsed.type === "video") {
    const v = mediaEl as HTMLVideoElement;
    v.addEventListener("play", () =>
      sendData({ kind: "watch", action: "play", url, time: v.currentTime, from: myId || "me" })
    );
    v.addEventListener("pause", () =>
      sendData({ kind: "watch", action: "pause", url, time: v.currentTime, from: myId || "me" })
    );
    v.addEventListener("seeked", () =>
      sendData({ kind: "watch", action: "seek", url, time: v.currentTime, from: myId || "me" })
    );
  }

  watchState = { url, type: parsed.type, el: mediaEl };
}

function handleWatchMessage(msg: WatchMsg): void {
  switch (msg.action) {
    case "add":
      addWatchTile(msg.url, false);
      toast(`${peers.get(msg.from)?.name ?? "Alguém"} adicionou um vídeo para assistir juntos`, "ok");
      break;
    case "remove":
      removeTile(watchTileId);
      watchState = null;
      break;
    case "play":
    case "pause":
    case "seek": {
      if (!watchState?.el || watchState.type !== "video") break;
      const v = watchState.el as HTMLVideoElement;
      if (msg.action === "play") v.play().catch(() => undefined);
      else if (msg.action === "pause") v.pause();
      if (typeof msg.time === "number" && Math.abs(v.currentTime - msg.time) > 0.8) {
        v.currentTime = msg.time;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Seleção de dispositivos (microfone / alto-falante)
// ---------------------------------------------------------------------------

async function listDevices(): Promise<{ mic: MediaDeviceInfo[]; speaker: MediaDeviceInfo[] }> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return {
      mic: devs.filter((d) => d.kind === "audioinput"),
      speaker: devs.filter((d) => d.kind === "audiooutput"),
    };
  } catch {
    return { mic: [], speaker: [] };
  }
}

async function populateDevicePickers(): Promise<void> {
  const { mic, speaker } = await listDevices();
  const micSel = $("#opt-mic-device") as HTMLSelectElement;
  const spkSel = $("#opt-speaker-device") as HTMLSelectElement;

  micSel.innerHTML = '<option value="">Padrão do sistema</option>';
  for (const d of mic) {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Microfone ${micSel.length}`;
    micSel.appendChild(o);
  }

  spkSel.innerHTML = '<option value="">Padrão do sistema</option>';
  for (const d of speaker) {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Alto-falante ${spkSel.length}`;
    spkSel.appendChild(o);
  }

  micSel.value = prefs.micDeviceId ?? "";
  spkSel.value = prefs.speakerDeviceId ?? "";
}

/** Aplica o dispositivo de saída em todos os elementos de vídeo. */
async function applySpeaker(): Promise<void> {
  const id = prefs.speakerDeviceId;
  if (!id) return;
  for (const [, t] of tiles) {
    const v = t.video;
    if ((v as any).setSinkId) await (v as any).setSinkId(id).catch(console.warn);
  }
}

/** Recria o microfone com o dispositivo selecionado. */
async function applyMicDevice(): Promise<void> {
  const id = prefs.micDeviceId;
  if (!id) return;
  if (micRawStream) {
    micRawStream.getTracks().forEach((t) => t.stop());
    micRawStream = null;
    micOutTrack = null;
    await ensureMic();
    for (const ctx of peers.values()) {
      for (const sender of ctx.pc.getSenders()) {
        if (sender.track?.kind === "audio") {
          sender.replaceTrack(micOutTrack).catch(console.error);
        }
      }
    }
    toast("Microfone alterado", "ok");
  }
}

// ---------------------------------------------------------------------------
// Mesh WebRTC — perfect negotiation
// ---------------------------------------------------------------------------

function createPeer(peerId: string, name: string, isHost = false): PeerCtx {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ctx: PeerCtx = {
    pc,
    polite: myId > peerId,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswerPending: false,
    name,
    stream: new MediaStream(),
    analyser: null,
    levelTimer: null,
    rtt: null,
    bitrate: 0,
    isSharing: false,
    isHost,
    dc: null,
  };
  peers.set(peerId, ctx);

  // Canal de dados para chat e watch party.
  const dc = pc.createDataChannel("chat");
  ctx.dc = dc;
  wireDataChannel(peerId, dc);
  pc.ondatachannel = (e) => {
    if (e.channel.label === "chat") {
      ctx.dc = e.channel;
      wireDataChannel(peerId, e.channel);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) relay(peerId, { description: null, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    ctx.stream = e.streams[0] ?? new MediaStream([e.track]);
    attachStream(peerId, ctx.name, ctx.stream);
    renderParticipants();
  };

  pc.onnegotiationneeded = async () => {
    try {
      ctx.makingOffer = true;
      await pc.setLocalDescription();
      // Envia o SDP com Opus em modo música (estéreo + bitrate alto).
      const desc = {
        type: pc.localDescription!.type,
        sdp: enhanceOpusSdp(pc.localDescription!.sdp),
      };
      relay(peerId, { description: desc });
    } finally {
      ctx.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setConnPill("ok", "Conectado");
      const q = tiles.get(peerId)?.quality;
      if (q && q.textContent === "•") q.textContent = "negociando…";
    }
    if (pc.connectionState === "failed") {
      toast(`Conexão com ${ctx.name} falhou — tentando reiniciar ICE`, "err");
      ctx.pc.restartIce();
    }
  };

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  applySenderPrefs(pc);

  return ctx;
}

// Bitrate + preferência de degradação para os senders de vídeo.
function applySenderPrefs(pc: RTCPeerConnection): void {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind === "video") {
      const p = sender.getParameters();
      p.degradationPreference = prefs.hiQuality ? "maintain-resolution" : "balanced";
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = Math.round(prefs.bitrateMbps * 1_000_000);
      sender.setParameters(p).catch(console.error);
    } else if (sender.track?.kind === "audio") {
      // Áudio de música: Opus estéreo com bitrate alto (o SDP munging negocia
      // o codec; aqui garantimos o teto de bitrate do encoder).
      const p = sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = 192_000;
      sender.setParameters(p).catch(console.error);
    }
  }
}

async function handleRelay(from: string, payload: any): Promise<void> {
  let ctx = peers.get(from);
  if (!ctx) ctx = createPeer(from, `Peer ${from.slice(-4)}`);

  const { pc, polite } = ctx;
  const { description, candidate } = payload;

  try {
    if (description) {
      const readyForOffer =
        !ctx.makingOffer &&
        (pc.signalingState === "stable" || ctx.settingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;
      ctx.ignoreOffer = !polite && offerCollision;
      if (ctx.ignoreOffer) return;

      ctx.settingRemoteAnswerPending = description.type === "answer";
      await pc.setRemoteDescription(description);
      ctx.settingRemoteAnswerPending = false;

      if (description.type === "offer") {
        await pc.setLocalDescription();
        relay(from, { description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ctx.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error("Erro no relay WebRTC:", err);
  }
}

// ---------------------------------------------------------------------------
// Compartilhamento de tela (modal com opções)
// ---------------------------------------------------------------------------

let pendingSourceId: string | null = null;

function buildVideoConstraints(): MediaTrackConstraints {
  const map: Record<string, number | null> = {
    "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, native: null,
  };
  const height = map[prefs.resolution];
  const c: MediaTrackConstraints = {
    frameRate: { ideal: prefs.fps, max: prefs.fps },
  };
  if (height) {
    c.height = { ideal: height };
    c.width = { ideal: Math.round((height * 16) / 9) };
  }
  return c;
}

async function loadSources(type: "screen" | "window" | "camera"): Promise<void> {
  const list = $("#source-list");
  list.innerHTML = `<div class="hint">Carregando…</div>`;
  pendingSourceId = null;
  ($("#share-confirm") as HTMLButtonElement).disabled = true;

  // Aba Câmera: não lista telas, oferece compartilhar a webcam.
  if (type === "camera") {
    list.innerHTML = "";
    const item = document.createElement("div");
    item.className = "source-item";
    item.innerHTML =
      '<div style="font-size:42px;padding:24px 0">📷</div>' +
      '<div class="name">Sua câmera</div>';
    item.onclick = () => {
      hideModal("share-modal");
      if (cameraStream) stopCamera();
      else void shareCamera();
    };
    list.appendChild(item);
    $("#share-hint").textContent = "Clique para ligar/desligar sua câmera.";
    return;
  }

  const sources = await livebr.getDisplaySources(type);
  list.innerHTML = "";

  if (sources.length === 0) {
    list.innerHTML = `<div class="hint">Nenhuma fonte encontrada.</div>`;
    return;
  }

  for (const s of sources) {
    const item = document.createElement("div");
    item.className = "source-item";
    const img = document.createElement("img");
    img.src = s.thumbnail;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = s.name;
    item.append(img, name);

    item.onclick = () => {
      list.querySelectorAll(".source-item").forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
      pendingSourceId = s.id;
      ($("#share-confirm") as HTMLButtonElement).disabled = false;
      $("#share-hint").textContent = `Selecionado: ${s.name}`;
    };

    list.appendChild(item);
  }
  $("#share-hint").textContent = "Escolha uma tela ou janela.";
}

function openShareModal(): void {
  syncShareInputs();
  showModal("share-modal");
  void loadSources("screen");
  void renderAppAudioList();
}

function syncShareInputs(): void {
  ($("#opt-resolution") as HTMLSelectElement).value = prefs.resolution;
  ($("#opt-fps") as HTMLSelectElement).value = String(prefs.fps);
  ($("#opt-bitrate") as HTMLInputElement).value = String(prefs.bitrateMbps);
  $("#bitrate-label").textContent = `${prefs.bitrateMbps} Mbps`;
  ($("#opt-system-audio") as HTMLInputElement).checked = prefs.includeSystemAudio;
  ($("#opt-mic-capture") as HTMLInputElement).checked = prefs.micCapture;
}

function readShareInputs(): void {
  prefs.resolution = ($("#opt-resolution") as HTMLSelectElement).value as Prefs["resolution"];
  prefs.fps = Number(($("#opt-fps") as HTMLSelectElement).value) as Prefs["fps"];
  prefs.bitrateMbps = Number(($("#opt-bitrate") as HTMLInputElement).value);
  prefs.includeSystemAudio = ($("#opt-system-audio") as HTMLInputElement).checked;
  prefs.micCapture = ($("#opt-mic-capture") as HTMLInputElement).checked;
  savePrefs();
}

async function startShare(): Promise<void> {
  if (!pendingSourceId) return;
  readShareInputs();

  const sourceId = pendingSourceId;
  const isWindowShare = sourceId.startsWith("window:");

  // Modo de áudio (igual ao Go Live):
  //  - "app"    -> janela: som SÓ do app (Process Loopback); tela: som do sistema
  //  - "system" -> som do sistema inteiro (só funciona compartilhando a tela)
  //  - "mic"    -> sem áudio da fonte, só o microfone
  let audioMode: "loopback" | "window" | "none";
  const choice = (
    document.querySelector('input[name="audio-mode"]:checked') as HTMLInputElement
  ).value;

  if (choice === "mic") {
    audioMode = "none";
  } else if (choice === "system") {
    audioMode = "loopback"; // sistema inteiro (a tela captura tudo)
  } else {
    // "app": janela = som isolado do app; tela = som do sistema (não dá para isolar).
    audioMode = isWindowShare ? "window" : "loopback";
  }

  livebr.setDisplayOptions(sourceId, audioMode !== "none", audioMode);
  hideModal("share-modal");

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: buildVideoConstraints(),
      audio: audioMode !== "none",
    });
  } catch (err) {
    toast("Não foi possível capturar a tela.", "err");
    console.error(err);
    return;
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = "detail";
    if (videoTrack.contentHint !== "detail") videoTrack.contentHint = "text";
    videoTrack.addEventListener("ended", () => stopShare());
  }

  // Se não veio áudio da fonte (ex.: o app estava silenciado), avisa.
  if (audioMode !== "none" && displayStream.getAudioTracks().length === 0) {
    toast("Nenhum áudio capturado desta fonte. Tente compartilhar a janela do app.", "err");
  }

  if (prefs.micCapture) await ensureMic();

  rebuildLocalStream();

  sharing = true;
  attachStream("me", `${myName}`, localStream);

  if (loginMode === "direct") {
    // Modo direto: troca as faixas nos m-lines já negociados (sem renegociar).
    const mixed = await buildDirectAudioTrack();
    await directSendVideo?.replaceTrack(videoTrack ?? null).catch(console.error);
    await directSendAudio?.replaceTrack(mixed).catch(console.error);
    sendDirectMeta();
  } else {
    for (const ctx of peers.values()) {
      for (const track of localStream.getTracks()) {
        if (!ctx.pc.getSenders().some((s) => s.track === track)) {
          ctx.pc.addTrack(track, localStream);
        }
      }
      applySenderPrefs(ctx.pc);
    }
  }

  // Aplica os volumes dos apps excluídos (muta os apps desmarcados).
  for (const app of excludedApps) {
    livebr.setAppVolume(app, 0);
  }

  $("#share-btn").classList.add("hidden");
  $("#stop-share-btn").classList.remove("hidden");
  renderParticipants();
  sendData({ kind: "state", sharing: true, from: myId || "me" });
  document.title = "🔴 LiveBR — transmitindo";
  playSound("share_screen_on");

  const audioDesc =
    audioMode === "window"
      ? "🔊 som apenas do aplicativo"
      : audioMode === "loopback"
      ? "🔊 som do sistema"
      : "🎤 só microfone";
  toast(
    `Transmitindo ${prefs.resolution === "native" ? "nativo" : prefs.resolution} @ ${prefs.fps}fps · ${prefs.bitrateMbps} Mbps · ${audioDesc}`,
    "ok"
  );
}

/** Mistura microfone + áudio do sistema numa única faixa (modo direto). */
async function buildDirectAudioTrack(): Promise<MediaStreamTrack | null> {
  const tracks: MediaStreamTrack[] = [];
  if (micOutTrack) tracks.push(micOutTrack);
  if (prefs.includeSystemAudio) {
    const sysTrack = displayStream?.getAudioTracks()[0];
    if (sysTrack) tracks.push(sysTrack);
  }
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0];

  const mixCtx = new AudioContext();
  const dest = mixCtx.createMediaStreamDestination();
  for (const t of tracks) mixCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  return dest.stream.getAudioTracks()[0];
}

function rebuildLocalStream(): void {
  localStream = new MediaStream();
  for (const t of displayStream?.getTracks() ?? []) localStream.addTrack(t);
  if (micOutTrack) localStream.addTrack(micOutTrack);
}

function stopShare(): void {
  for (const t of displayStream?.getTracks() ?? []) t.stop();
  displayStream = null;
  sharing = false;

  if (loginMode === "direct") {
    void directSendVideo?.replaceTrack(null).catch(console.error);
    void directSendAudio?.replaceTrack(null).catch(console.error);
    sendDirectMeta();
  } else {
    for (const ctx of peers.values()) {
      for (const sender of ctx.pc.getSenders()) {
        if (sender.track && sender.track.kind === "video") ctx.pc.removeTrack(sender);
      }
    }
  }

  rebuildLocalStream();
  removeTile("me");
  $("#share-btn").classList.remove("hidden");
  $("#stop-share-btn").classList.add("hidden");
  document.title = "LiveBR";
  renderParticipants();
  sendData({ kind: "state", sharing: false, from: myId || "me" });
  playSound("share_screen_off");
  toast("Transmissão encerrada");
}

// ---------------------------------------------------------------------------
// Microfone: supressão de ruído, eco, AGC, sensibilidade + medidor
// ---------------------------------------------------------------------------

async function ensureMic(): Promise<void> {
  if (micRawStream && micOutTrack) return;

  try {
    micRawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: prefs.micDeviceId ? { exact: prefs.micDeviceId } : undefined,
        noiseSuppression: prefs.noiseSuppression,
        echoCancellation: prefs.echoCancellation,
        autoGainControl: prefs.autoGainControl,
      },
    });
  } catch {
    toast("Microfone indisponível.", "err");
    return;
  }

  micCtx = micCtx ?? new AudioContext();
  const src = micCtx.createMediaStreamSource(micRawStream);
  micGain = micCtx.createGain();
  micGain.gain.value = micEnabled ? gainFromSensitivity() : 0;
  const dest = micCtx.createMediaStreamDestination();
  src.connect(micGain);
  micGain.connect(dest);
  micOutTrack = dest.stream.getAudioTracks()[0];

  // Indicador azul de fala FLUIDO para mim mesmo (mesmo sistema dos peers).
  const analyser = micCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let shown = 0;
  const tickMe = (): void => {
    analyser.getByteFrequencyData(buf as any);
    let sum = 0;
    for (const v of buf) sum += v;
    const raw = sum / buf.length / 255;
    shown = raw > shown ? shown + (raw - shown) * 0.55 : shown * 0.88;
    const speaking = micEnabled && shown > speechThreshold();
    const wrap = document.querySelector<HTMLElement>('#peer-list li[data-peer="me"] .avatar-wrap');
    if (wrap) {
      wrap.classList.toggle("speaking", speaking);
      wrap.style.setProperty("--speak-level", Math.min(1, shown * 3).toFixed(2));
    }
    requestAnimationFrame(tickMe);
  };
  requestAnimationFrame(tickMe);

  rebuildLocalStream();
  // No modo direto não se adiciona faixa (exigiria renegociação):
  // a faixa do microfone entra via replaceTrack no slot de áudio já negociado.
  if (loginMode === "server") {
    for (const ctx of peers.values()) {
      if (!ctx.pc.getSenders().some((s) => s.track === micOutTrack)) {
        ctx.pc.addTrack(micOutTrack, localStream);
      }
    }
  }
  renderParticipants();
}

function gainFromSensitivity(): number {
  // 5% -> 0.5x | 50% -> 1.25x | 100% -> 2x
  return 0.5 + (prefs.sensitivity / 100) * 1.5;
}

/** Recria o pipeline do microfone aplicando novos constraints/ganho. */
async function restartMic(): Promise<void> {
  if (!micRawStream) {
    if (prefs.micCapture) await ensureMic();
    return;
  }

  for (const sender of [...peers.values()].flatMap((c) => c.pc.getSenders())) {
    if (sender.track === micOutTrack) sender.track?.stop();
  }
  micRawStream.getTracks().forEach((t) => t.stop());
  micRawStream = null;
  micOutTrack = null;

  await ensureMic();
  for (const ctx of peers.values()) {
    for (const sender of ctx.pc.getSenders()) {
      if (sender.track?.kind === "audio") {
        sender.replaceTrack(micOutTrack).catch(console.error);
      }
    }
  }
  toast("Configurações de microfone aplicadas", "ok");
}

let meterTimer: ReturnType<typeof setInterval> | null = null;

function startMicMeter(): void {
  clearInterval(meterTimer!);
  meterTimer = setInterval(() => {
    if (!micRawStream) return;
    if (!micCtx || micCtx.state === "closed") micCtx = new AudioContext();
    const analyser = micCtx.createAnalyser();
    analyser.fftSize = 512;
    const src = micCtx.createMediaStreamSource(micRawStream);
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (const v of buf) sum += v;
    const level = Math.min(100, Math.round((sum / buf.length / 255) * 400));
    $("#mic-meter-fill").style.width = `${level}%`;
    $("#mic-meter-val").textContent = micEnabled ? `${level}%` : "mudo";
    src.disconnect();
    analyser.disconnect();
  }, 150);
}

function stopMicMeter(): void {
  clearInterval(meterTimer!);
  meterTimer = null;
  $("#mic-meter-fill").style.width = "0%";
}

function toggleMic(): void {
  micEnabled = !micEnabled;
  if (micGain) micGain.gain.value = micEnabled ? gainFromSensitivity() : 0;
  // Som com tonalidade diferente: mais grave ao desligar, mais agudo ao ligar.
  playSound("mic_or_headset_off", { pitch: micEnabled ? 1.25 : 0.8 });
  const btn = $("#mic-btn");
  btn.classList.toggle("off", !micEnabled);
  btn.querySelector(".ico")!.textContent = micEnabled ? "🎤" : "🔇";
  renderParticipants();
  toast(micEnabled ? "Microfone ativado" : "Microfone mutado");
}

function toggleDeafen(): void {
  deafened = !deafened;
  for (const [id] of peers) {
    const v = tiles.get(id)?.video;
    if (v) v.muted = deafened;
  }
  // Mesmo som do mic, mas mais grave para "ouvido desligados".
  playSound("mic_or_headset_off", { pitch: deafened ? 0.75 : 1.15 });
  const btn = $("#deafen-btn");
  btn.classList.toggle("off", deafened);
  btn.querySelector(".ico")!.textContent = deafened ? "🔇" : "🎧";
  renderParticipants();
  toast(deafened ? "Áudio dos outros silenciado" : "Áudio restaurado");
}

// ---------------------------------------------------------------------------
// Ajustes (modal de configurações)
// ---------------------------------------------------------------------------

function syncSettingsInputs(): void {
  ($("#opt-sensitivity") as HTMLInputElement).value = String(prefs.sensitivity);
  $("#sens-label").textContent = `${prefs.sensitivity}%`;
  ($("#opt-noise") as HTMLInputElement).checked = prefs.noiseSuppression;
  ($("#opt-echo") as HTMLInputElement).checked = prefs.echoCancellation;
  ($("#opt-agc") as HTMLInputElement).checked = prefs.autoGainControl;
  ($("#opt-hi-quality") as HTMLInputElement).checked = prefs.hiQuality;
}

function openSettings(): void {
  syncSettingsInputs();
  showModal("settings-modal");
  if (micRawStream) startMicMeter();
  void populateDevicePickers();
}

// ---------------------------------------------------------------------------
// Conexão DIRETA (sem servidor de sinalização) — convite/resposta manual
// ---------------------------------------------------------------------------

type LoginMode = "server" | "direct";
let loginMode: LoginMode = "server";
let directPc: RTCPeerConnection | null = null;
let directSendVideo: RTCRtpSender | null = null;
let directSendAudio: RTCRtpSender | null = null;
let directMetaChannel: RTCDataChannel | null = null;
let directConnected = false;
let hosting = false;
let shareCode = "";

const DIRECT_PEER_ID = "direct";

// --- Faixas "vazias" (tela preta + silêncio) ---
// Necessárias para o Chromium negociar os m-lines como sendrecv nos DOIS lados,
// permitindo que qualquer um compartilhe depois via replaceTrack (sem renegociar).
let phVideoTrack: MediaStreamTrack | null = null;
let phAudioTrack: MediaStreamTrack | null = null;

function getPlaceholderTracks(): { video: MediaStreamTrack; audio: MediaStreamTrack } {
  if (!phVideoTrack || phVideoTrack.readyState === "ended") {
    const cv = document.createElement("canvas");
    cv.width = 16;
    cv.height = 16;
    const c2d = cv.getContext("2d")!;
    c2d.fillStyle = "#000";
    c2d.fillRect(0, 0, 16, 16);
    phVideoTrack = cv.captureStream(1).getVideoTracks()[0];
  }
  if (!phAudioTrack || phAudioTrack.readyState === "ended") {
    const actx = new AudioContext();
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    gain.gain.value = 0; // silêncio
    const dest = actx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    phAudioTrack = dest.stream.getAudioTracks()[0];
  }
  return { video: phVideoTrack, audio: phAudioTrack };
}

/** Marca se o outro lado está realmente transmitindo (via data channel). */
function setPeerLive(id: string, live: boolean): void {
  const tile = tiles.get(id);
  if (tile) {
    tile.avatar.style.display = live ? "none" : "flex";
    tile.live.style.display = live ? "inline-block" : "none";
  }
  const ctx = peers.get(id);
  if (ctx) ctx.isSharing = live;
  renderParticipants();
}

function sendDirectMeta(): void {
  if (directMetaChannel?.readyState !== "open") return;
  directMetaChannel.send(JSON.stringify({ sharing, name: myName }));
}

function wireMetaChannel(ch: RTCDataChannel): void {
  directMetaChannel = ch;
  ch.onopen = () => sendDirectMeta();
  ch.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (typeof m.sharing === "boolean") setPeerLive(DIRECT_PEER_ID, m.sharing);
      if (typeof m.name === "string" && m.name) {
        const ctx = peers.get(DIRECT_PEER_ID);
        if (ctx) ctx.name = m.name;
        renderParticipants();
      }
    } catch {
      /* ignora */
    }
  };
}

function packDirectBlob(desc: RTCSessionDescription | null, name: string): string {
  const payload = JSON.stringify({ t: desc?.type, sdp: desc?.sdp, n: name });
  return btoa(unescape(encodeURIComponent(payload)));
}

function unpackDirectBlob(text: string): { type: RTCSdpType; sdp: string; name: string } {
  const clean = text.trim().replace(/\s+/g, "");
  const data = JSON.parse(decodeURIComponent(escape(atob(clean))));
  if (!data.sdp || !data.t) throw new Error("Convite/resposta inválido.");
  return { type: data.t, sdp: data.sdp, name: data.n || "Convidado" };
}

function waitForIce(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Cria o peer direto. Os dois lados já reservam slots de envio e recebimento
 * (sendonly + recvonly), então ambos podem compartilhar tela na MESMA conexão,
 * trocando as faixas depois via replaceTrack (sem nova negociação).
 */
function createDirectPeer(isHost: boolean, peerName = "Convidado"): PeerCtx {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  directPc = pc;

  const ctx: PeerCtx = {
    pc,
    polite: !isHost,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswerPending: false,
    name: peerName,
    stream: new MediaStream(),
    analyser: null,
    levelTimer: null,
    rtt: null,
    bitrate: 0,
    isSharing: false,
    isHost: !isHost, // o OUTRO é o host se ele criou o convite
    dc: null,
  };
  peers.set(DIRECT_PEER_ID, ctx);

  // Quem cria o convite é o host.
  amIHost = isHost;

  // Faixas placeholder => m-lines sendrecv nos dois sentidos, nos DOIS lados.
  // Qualquer um pode compartilhar depois via replaceTrack, sem renegociar.
  const ph = getPlaceholderTracks();
  directSendVideo = pc.addTrack(ph.video);
  directSendAudio = pc.addTrack(ph.audio);

  // Canal de dados para avisar quem está transmitindo de verdade.
  if (isHost) {
    wireMetaChannel(pc.createDataChannel("meta"));
  }
  pc.ondatachannel = (e) => {
    if (e.channel.label === "meta") wireMetaChannel(e.channel);
  };

  pc.ontrack = (e) => {
    ctx.stream = e.streams[0] ?? new MediaStream([e.track]);
    attachStream(DIRECT_PEER_ID, ctx.name, ctx.stream);
    renderParticipants();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      directConnected = true;
      setConnPill("ok", "Direto (P2P)");
      renderParticipants();
      toast("Conectado direto com " + ctx.name, "ok");
    }
    if (pc.connectionState === "failed") {
      setConnPill("err", "Falha na conexão");
      toast("A conexão direta falhou — pode ser NAT restritivo (precisa de TURN).", "err");
    }
  };

  return ctx;
}

async function directHostCreate(): Promise<void> {
  myName = ($("#name-input") as HTMLInputElement).value.trim() || "Convidado";
  localStorage.setItem("livebrName", myName);
  turnUrl = ($("#turn-input") as HTMLInputElement).value.trim();
  await buildIceServers();

  setLobbyStatus("Capturando rotas de rede…");
  createDirectPeer(true, "Convidado");
  await directPc!.setLocalDescription();
  await waitForIce(directPc!);

  ($("#direct-invite") as HTMLTextAreaElement).value = packDirectBlob(
    directPc!.localDescription,
    myName
  );
  $("#direct-host-box").classList.remove("hidden");
  ($("#direct-host-btn") as HTMLButtonElement).disabled = true;
  setLobbyStatus("");
  toast("Convite gerado! Envie para seu amigo.", "ok");
}

async function directGuestAnswer(): Promise<void> {
  myName = ($("#name-input") as HTMLInputElement).value.trim() || "Convidado";
  localStorage.setItem("livebrName", myName);
  turnUrl = ($("#turn-input") as HTMLInputElement).value.trim();

  let invite;
  try {
    invite = unpackDirectBlob(($("#direct-invite-in") as HTMLTextAreaElement).value);
  } catch {
    setLobbyStatus("Convite inválido — copie o texto inteiro, sem quebras.");
    return;
  }

  await buildIceServers();
  setLobbyStatus("Gerando resposta…");
  createDirectPeer(false, invite.name);
  await directPc!.setRemoteDescription({ type: invite.type, sdp: invite.sdp });
  await directPc!.setLocalDescription();
  await waitForIce(directPc!);

  ($("#direct-answer-out") as HTMLTextAreaElement).value = packDirectBlob(
    directPc!.localDescription,
    myName
  );
  $("#direct-answer-out-box").classList.remove("hidden");
  $("#copy-answer").classList.remove("hidden");
  ($("#direct-answer-btn") as HTMLButtonElement).disabled = true;
  setLobbyStatus("");

  // O convidado já entra na sala enquanto aguarda o host colar a resposta.
  enterRoom();
  toast("Resposta gerada! Envie de volta para o host.", "ok");
}

async function directHostConnect(): Promise<void> {
  if (!directPc) {
    setLobbyStatus("Crie o convite primeiro.");
    return;
  }
  let answer;
  try {
    answer = unpackDirectBlob(($("#direct-answer-in") as HTMLTextAreaElement).value);
  } catch {
    setLobbyStatus("Resposta inválida — cole o texto inteiro.");
    return;
  }

  const ctx = peers.get(DIRECT_PEER_ID);
  if (ctx) ctx.name = answer.name;

  await directPc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  enterRoom();
  setLobbyStatus("");
}

function setLobbyStatus(msg: string): void {
  $("#lobby-status").textContent = msg;
}


function enterRoom(): void {
  $("#lobby").classList.add("hidden");
  $("#room").classList.remove("hidden");
  const chip = $("#share-room-btn");
  if (loginMode === "direct") {
    $("#room-name").textContent = "Conexão direta";
    chip.classList.add("hidden");
    setConnPill("warn", "Negociando…");
  } else if (hosting) {
    $("#room-name").textContent = `Sala ${roomCode}`;
    chip.classList.remove("hidden");
    chip.classList.add("invite");
    chip.textContent = "📋 copiar convite";
    chip.title = shareCode;
    setConnPill("warn", "Conectando…");
  } else {
    $("#room-name").textContent = `Sala ${roomCode}`;
    chip.classList.remove("hidden", "invite");
    chip.textContent = `📋 ${roomCode}`;
    chip.title = "Copiar código da sala";
    setConnPill("warn", "Conectando…");
  }
  startStatsPolling();
  renderParticipants();
  renderFriends();

  // Microfone liga AUTOMATICAMENTE ao entrar (como no Discord), para a pessoa
  // já ter feedback visual do anel de fala e não precisar ligar na mão.
  if (!micRawStream && prefs.micCapture) {
    void ensureMic().then(() => {
      rebuildLocalStream();
      renderParticipants();
    });
  }
}

function leave(): void {
  intentionallyLeft = true;
  if (sharing) stopShare();
  sendToServer({ type: "leave" });
  clearTimeout(reconnectTimer!);
  clearInterval(pingTimer!);
  clearInterval(statsTimer!);
  ws?.close();
  ws = null;
  for (const ctx of peers.values()) {
    ctx.pc.close();
    clearInterval(ctx.levelTimer!);
    ctx.analyser?.ctx.close().catch(() => undefined);
  }
  peers.clear();
  for (const id of [...tiles.keys()]) removeTile(id);
  directPc = null;
  directSendVideo = null;
  directSendAudio = null;
  directConnected = false;

  // Se eu era o host, encerro o servidor embutido e o túnel.
  if (hosting) {
    hosting = false;
    shareCode = "";
    void livebr.stopRoom().catch(() => undefined);
  }

  // Restaura os volumes dos apps que foram excluídos do som.
  restoreExcludedApps();

  $("#room").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
  $("#lobby-status").textContent = "";
  renderParticipants();
}

// --- Lobby ---
// (criar sala e entrar com código estão nos botões acima)

// --- Lobby: criar sala (o app hospeda sozinho) ---
$("#create-room-btn").addEventListener("click", async () => {
  myName = ($("#name-input") as HTMLInputElement).value.trim() || "Convidado";
  // Mantém o perfil em sincronia com o nome digitado no lobby.
  myProfile.name = myName;
  saveProfile();
  localStorage.setItem("livebrName", myName);
  turnUrl = ($("#turn-input") as HTMLInputElement).value.trim();
  loginMode = "server";
  hosting = true;
  intentionallyLeft = false;

  setLobbyStatus("Criando sua sala… (uns segundinhos na primeira vez)");
  const res = await livebr.createRoom();
  if (!res.ok || !res.code || !res.room || !res.localUrl) {
    hosting = false;
    setLobbyStatus("Não foi possível criar a sala: " + (res.error ?? "erro desconhecido"));
    return;
  }

  shareCode = res.code;
  roomCode = res.room;
  wsUrl = res.localUrl;
  setLobbyStatus("");

  await buildIceServers();
  enterRoom();
  connect();

  navigator.clipboard.writeText(shareCode).then(
    () => toast("Sala criada! Código copiado — mande para seus amigos.", "ok"),
    () => toast("Sala criada! Copie o código no topo da janela.", "ok")
  );
});

// --- Lobby: entrar com código ---
$("#join-code-btn").addEventListener("click", async () => {
  const raw = ($("#join-code-input") as HTMLInputElement).value.trim();
  if (!raw) {
    setLobbyStatus("Cole o código que você recebeu.");
    return;
  }
  myName = ($("#name-input") as HTMLInputElement).value.trim() || "Convidado";
  myProfile.name = myName;
  saveProfile();
  localStorage.setItem("livebrName", myName);
  turnUrl = ($("#turn-input") as HTMLInputElement).value.trim();
  loginMode = "server";
  hosting = false;
  intentionallyLeft = false;

  const parsed = parseRoomCode(raw);
  wsUrl = parsed.wsUrl;
  roomCode = parsed.room;
  setLobbyStatus("");

  await buildIceServers();
  enterRoom();
  connect();
});

/** Aceita "livebr://host/sala", "host/sala" ou apenas "sala". */
function parseRoomCode(raw: string): { wsUrl: string; room: string } {
  const hasScheme = /^livebr:\/\//i.test(raw);
  const body = raw.replace(/^livebr:\/\//i, "").replace(/\/+$/, "").trim();

  if (hasScheme || (/^[a-z0-9-]+\.[a-z0-9.-]+/i.test(body) && body.includes("/"))) {
    const [hostPart, room] = body.split("/");
    return { wsUrl: `wss://${hostPart}/ws`, room: (room || "GERAL").toUpperCase() };
  }

  // Código de sala simples: usa o servidor avançado (ou o padrão local).
  const server = ($("#server-input") as HTMLInputElement).value.trim() || DEFAULT_WS_URL;
  return { wsUrl: server, room: body.toUpperCase() || "GERAL" };
}

// --- Alternância de modo (sala / sem servidor) ---
document.querySelectorAll("[data-login-mode]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-login-mode]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    loginMode = tab.getAttribute("data-login-mode") as LoginMode;
    $("#server-fields").classList.toggle("hidden", loginMode !== "server");
    $("#direct-fields").classList.toggle("hidden", loginMode !== "direct");
    setLobbyStatus("");
  });
});

// --- Modo direto ---
$("#direct-host-btn").addEventListener("click", () => {
  directHostCreate().catch((e) => {
    console.error(e);
    setLobbyStatus("Erro ao criar convite. Tente novamente.");
  });
});
$("#direct-answer-btn").addEventListener("click", () => {
  directGuestAnswer().catch((e) => {
    console.error(e);
    setLobbyStatus("Erro ao gerar resposta — verifique se o convite está completo.");
  });
});
$("#direct-connect-btn").addEventListener("click", () => {
  directHostConnect().catch((e) => {
    console.error(e);
    setLobbyStatus("Erro ao conectar — verifique se a resposta está completa.");
  });
});
$("#copy-invite").addEventListener("click", () => {
  const txt = ($("#direct-invite") as HTMLTextAreaElement).value;
  navigator.clipboard.writeText(txt).then(
    () => toast("Convite copiado! Cole no chat do seu amigo.", "ok"),
    () => toast("Selecione e copie manualmente.", "err")
  );
});
$("#copy-answer").addEventListener("click", () => {
  const txt = ($("#direct-answer-out") as HTMLTextAreaElement).value;
  navigator.clipboard.writeText(txt).then(
    () => toast("Resposta copiada! Envie de volta ao host.", "ok"),
    () => toast("Selecione e copie manualmente.", "err")
  );
});

// --- Barra de controles ---
$("#share-btn").addEventListener("click", openShareModal);
$("#stop-share-btn").addEventListener("click", stopShare);
$("#mic-btn").addEventListener("click", () => {
  if (!micRawStream) {
    prefs.micCapture = true;
    savePrefs();
    void ensureMic().then(() => {
      rebuildLocalStream();
      renderParticipants();
    });
    return;
  }
  toggleMic();
});
$("#deafen-btn").addEventListener("click", toggleDeafen);
$("#leave-btn").addEventListener("click", leave);
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-btn2").addEventListener("click", openSettings);

// --- Topbar: copiar convite (host) ou código da sala (convidado) ---
$("#share-room-btn").addEventListener("click", () => {
  const text = shareCode || roomCode;
  navigator.clipboard.writeText(text).then(
    () => toast(hosting ? "Convite copiado! Mande para seus amigos." : "Código copiado!", "ok"),
    () => toast("Não foi possível copiar.", "err")
  );
});

// --- Modal compartilhar ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    void loadSources(tab.getAttribute("data-src-type") as "screen" | "window" | "camera");
  });
});
$("#opt-bitrate").addEventListener("input", (e) => {
  $("#bitrate-label").textContent = `${(e.target as HTMLInputElement).value} Mbps`;
});
$("#share-confirm").addEventListener("click", () => void startShare());

// --- Modal configurações ---
$("#opt-sensitivity").addEventListener("input", (e) => {
  prefs.sensitivity = Number((e.target as HTMLInputElement).value);
  $("#sens-label").textContent = `${prefs.sensitivity}%`;
});
$("#test-mic-btn").addEventListener("click", async () => {
  await ensureMic();
  if (!micRawStream) return;
  startMicMeter();
  toast("Fale algo para ver o nível de entrada", "ok");
});
$("#apply-settings").addEventListener("click", async () => {
  prefs.noiseSuppression = ($("#opt-noise") as HTMLInputElement).checked;
  prefs.echoCancellation = ($("#opt-echo") as HTMLInputElement).checked;
  prefs.autoGainControl = ($("#opt-agc") as HTMLInputElement).checked;
  prefs.hiQuality = ($("#opt-hi-quality") as HTMLInputElement).checked;
  savePrefs();

  for (const ctx of peers.values()) applySenderPrefs(ctx.pc);
  await restartMic();
  hideModal("settings-modal");
  stopMicMeter();
  toast("Configurações salvas", "ok");
});

// --- Fechar modais ---
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-close")!;
    hideModal(id);
    if (id === "settings-modal") stopMicMeter();
  });
});

// --- Chat ---
$("#chat-send").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") sendChat();
});

// --- Reações flutuantes ---
document.querySelectorAll("[data-react]").forEach((btn) => {
  btn.addEventListener("click", () => sendReaction(btn.getAttribute("data-react")!));
});

// --- Assistir vídeo juntos ---
$("#watch-btn").addEventListener("click", () => showModal("watch-modal"));
$("#watch-add").addEventListener("click", () => {
  const url = ($("#watch-url") as HTMLInputElement).value.trim();
  if (!url) return;
  if (!parseWatchUrl(url)) {
    toast("Link não reconhecido. Use YouTube, Twitch ou .mp4/.webm.", "err");
    return;
  }
  addWatchTile(url, true);
  sendData({ kind: "watch", action: "add", url, from: myId || "me" });
  ($("#watch-url") as HTMLInputElement).value = "";
  hideModal("watch-modal");
  toast("Vídeo adicionado para todo mundo", "ok");
});

// --- Abrir mixer de volume do Windows (para ignorar áudio de um app) ---
$("#open-mixer").addEventListener("click", () => livebr.openVolumeMixer());

// --- Lista de apps com áudio (excluir do som da transmissão) ---
$("#app-audio-refresh").addEventListener("click", () => void renderAppAudioList());

// --- Seleção de dispositivos ---
$("#opt-mic-device").addEventListener("change", async () => {
  prefs.micDeviceId = ($("#opt-mic-device") as HTMLSelectElement).value;
  savePrefs();
  await applyMicDevice();
});
$("#opt-speaker-device").addEventListener("change", async () => {
  prefs.speakerDeviceId = ($("#opt-speaker-device") as HTMLSelectElement).value;
  savePrefs();
  await applySpeaker();
  toast("Saída de áudio alterada", "ok");
});

// --- Abas da sidebar (Pessoas / Amigos) ---
document.querySelectorAll("[data-ptab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-ptab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.getAttribute("data-ptab");
    $("#people-panel").classList.toggle("hidden", which !== "people");
    $("#friends-panel").classList.toggle("hidden", which !== "friends");
  });
});

// --- Meu perfil ---
$("#my-profile-btn").addEventListener("click", openProfileEditor);
$("#settings-btn").addEventListener("dblclick", openProfileEditor);

$("#prof-photo").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handlePhotoPick(file);
});
$("#prof-photo-remove").addEventListener("click", () => {
  myProfile.photo = "";
  saveProfile();
  renderProfilePreview();
  renderParticipants();
  sendMyProfile();
  toast("Foto removida");
});
$("#prof-banner").addEventListener("input", () => {
  myProfile.banner = ($("#prof-banner") as HTMLInputElement).value;
  renderProfilePreview();
});
$("#prof-name").addEventListener("input", () => {
  myProfile.name = ($("#prof-name") as HTMLInputElement).value;
  renderProfilePreview();
});
$("#prof-frame").addEventListener("change", () => {
  myProfile.frame = ($("#prof-frame") as HTMLSelectElement).value as Profile["frame"];
  renderProfilePreview();
});
$("#prof-effect").addEventListener("change", () => {
  myProfile.nameEffect = ($("#prof-effect") as HTMLSelectElement)
    .value as Profile["nameEffect"];
  renderProfilePreview();
});
$("#prof-save").addEventListener("click", () => {
  myProfile.name = ($("#prof-name") as HTMLInputElement).value.trim() || "Convidado";
  myProfile.bio = ($("#prof-bio") as HTMLTextAreaElement).value.trim();
  myName = myProfile.name;
  saveProfile();
  sendMyProfile();
  renderParticipants();
  renderFriends();
  hideModal("profile-modal");
  toast("Perfil salvo", "ok");
});
$("#copy-friend-code").addEventListener("click", () => {
  navigator.clipboard.writeText(myProfile.friendCode).then(
    () => toast(`Código ${myProfile.friendCode} copiado!`, "ok"),
    () => toast("Não foi possível copiar.", "err")
  );
});

// --- Restaura preferências ---
($("#server-input") as HTMLInputElement).value =
  localStorage.getItem("livebrServer") ?? DEFAULT_WS_URL;
($("#turn-input") as HTMLInputElement).value = localStorage.getItem("livebrTurn") ?? "";
($("#name-input") as HTMLInputElement).value =
  localStorage.getItem("livebrName") ?? (myProfile.name === "Convidado" ? "" : myProfile.name);
syncShareInputs();
syncSettingsInputs();

// -------------------- Editor de perfil --------------------

function openProfileEditor(): void {
  ($("#prof-name") as HTMLInputElement).value = myProfile.name;
  ($("#prof-bio") as HTMLTextAreaElement).value = myProfile.bio;
  ($("#prof-banner") as HTMLInputElement).value = myProfile.banner;
  ($("#prof-frame") as HTMLSelectElement).value = myProfile.frame;
  ($("#prof-effect") as HTMLSelectElement).value = myProfile.nameEffect;
  $("#prof-code").textContent = myProfile.friendCode;
  renderProfilePreview();
  showModal("profile-modal");
}

function renderProfilePreview(): void {
  const preview = $("#prof-preview-avatar");
  preview.innerHTML = "";
  const av = makeAvatar(myProfile.name, 84, true, myProfile);
  preview.appendChild(av);
  const nm = $("#prof-preview-name");
  nm.textContent = myProfile.name;
  nm.className =
    myProfile.nameEffect !== "none" ? `name-effect-${myProfile.nameEffect}` : "";
  $("#prof-preview-banner").style.background = myProfile.banner;
}

/** Reduz a imagem escolhida para um thumbnail quadrado e salva. */
function handlePhotoPick(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 128;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const min = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - min) / 2,
        (img.height - min) / 2,
        min,
        min,
        0,
        0,
        size,
        size
      );
      myProfile.photo = canvas.toDataURL("image/jpeg", 0.8);
      saveProfile();
      renderProfilePreview();
      renderParticipants();
      sendMyProfile();
      toast("Foto de perfil atualizada", "ok");
    };
    img.src = reader.result as string;
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------------------
// AUTO-UPDATE: banner quando sair versão nova no GitHub
// ---------------------------------------------------------------------------

function showUpdateBanner(text: string, showInstall: boolean): void {
  $("#update-text").textContent = text;
  $("#update-banner").classList.remove("hidden");
  $("#update-install-btn").classList.toggle("hidden", !showInstall);
}

try {
  livebr.onUpdateAvailable((v) =>
    showUpdateBanner(`Nova versão ${v} encontrada — baixando em segundo plano…`, false)
  );
  livebr.onUpdateDownloaded((v) =>
    showUpdateBanner(`Versão ${v} pronta! Reinicie o app para atualizar.`, true)
  );
  $("#update-install-btn").addEventListener("click", () => livebr.installUpdate());
} catch {
  /* fora do Electron (ex.: testes) */
}







