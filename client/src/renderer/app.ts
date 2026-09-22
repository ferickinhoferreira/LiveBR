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
  setDisplayOptions: (sourceId: string, includeSystemAudio: boolean) => void;
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
};

// ---------------------------------------------------------------------------
// Preferências persistidas
// ---------------------------------------------------------------------------

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

/** Avatar circular com inicial e cor própria (para lista de participantes). */
function makeAvatar(name: string, size = 34): HTMLElement {
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.background = avatarColor(name);
  el.style.fontSize = `${Math.round(size * 0.44)}px`;
  el.textContent = initials(name);
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

  // Avatar colorido (para quando não está transmitindo vídeo).
  const avatar = document.createElement("div");
  avatar.className = "tile-avatar";
  const circle = makeAvatar(label, 72);
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
    node.fftSize = 512;
    src.connect(node);
    ctx.analyser = { ctx: actx, node, buf: new Uint8Array(node.frequencyBinCount) };
    ctx.levelTimer = setInterval(() => {
      const a = ctx.analyser;
      if (!a) return;
      a.node.getByteFrequencyData(a.buf as any);
      let sum = 0;
      for (const v of a.buf) sum += v;
      const level = sum / a.buf.length / 255;
      const speaking = level > speechThreshold();
      tiles.get(peerId)?.root.classList.toggle("speaking", speaking);
      const dot = document.querySelector(`#peer-list li[data-peer="${peerId}"] .dot`);
      dot?.classList.toggle("off", !speaking);
    }, 180);
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

    // Avatar colorido (estilo Discord), com coroa no host.
    const avatarWrap = document.createElement("span");
    avatarWrap.className = "avatar-wrap";
    avatarWrap.appendChild(makeAvatar(label));
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

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = isMe ? `${label} (você)` : label;

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

      const quality = tiles.get(id)?.quality;
      if (quality) {
        const tag = candType === "relay" ? "TURN" : candType === "srflx" ? "P2P*" : "P2P";
        quality.textContent = rtt !== null ? `${tag} ${Math.round(rtt)}ms` : tag;
      }
    } catch {
      /* peer fechando */
    }
  }

  $("#stat-rtt").textContent = bestRtt !== null ? `${Math.round(bestRtt)} ms` : "–";
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
      toast(`${msg.name} entrou na sala`);
      break;
    case "peer-left": {
      const name = peers.get(msg.peer)?.name ?? "Alguém";
      peers.get(msg.peer)?.pc.close();
      clearInterval(peers.get(msg.peer)?.levelTimer!);
      peers.get(msg.peer)?.analyser?.ctx.close().catch(() => undefined);
      peers.delete(msg.peer);
      removeTile(msg.peer);
      toast(`${name} saiu da sala`);
      break;
    }
    case "relay":
      handleRelay(msg.from, msg.payload).catch(console.error);
      break;
    case "error":
      toast(msg.message, "err");
      break;
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
  };
  peers.set(peerId, ctx);

  pc.createDataChannel("chat");

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
      relay(peerId, { description: pc.localDescription });
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
    if (sender.track?.kind !== "video") continue;
    const p = sender.getParameters();
    p.degradationPreference = prefs.hiQuality ? "maintain-resolution" : "balanced";
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = Math.round(prefs.bitrateMbps * 1_000_000);
    sender.setParameters(p).catch(console.error);
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

async function loadSources(type: "screen" | "window"): Promise<void> {
  const list = $("#source-list");
  list.innerHTML = `<div class="hint">Carregando…</div>`;
  pendingSourceId = null;
  ($("#share-confirm") as HTMLButtonElement).disabled = true;

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
  livebr.setDisplayOptions(sourceId, prefs.includeSystemAudio);
  hideModal("share-modal");

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: buildVideoConstraints(),
      audio: prefs.includeSystemAudio,
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

  $("#share-btn").classList.add("hidden");
  $("#stop-share-btn").classList.remove("hidden");
  renderParticipants();
  toast(
    `Transmitindo ${prefs.resolution === "native" ? "em resolução nativa" : prefs.resolution} @ ${prefs.fps}fps, ${prefs.bitrateMbps} Mbps`,
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
  renderParticipants();
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
    void loadSources(tab.getAttribute("data-src-type") as "screen" | "window");
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

// --- Restaura preferências ---
($("#server-input") as HTMLInputElement).value =
  localStorage.getItem("livebrServer") ?? DEFAULT_WS_URL;
($("#turn-input") as HTMLInputElement).value = localStorage.getItem("livebrTurn") ?? "";
($("#name-input") as HTMLInputElement).value = localStorage.getItem("livebrName") ?? "";
syncShareInputs();
syncSettingsInputs();

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







