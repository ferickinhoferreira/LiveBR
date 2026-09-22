# LiveBR — screen sharing P2P estilo "Discord Go Live"

WebRTC P2P mesh + sinalização em Rust + cliente Electron (TypeScript), com interface
no estilo Discord: grade de vídeos, barra de controles, painel de participantes,
indicador de quem está falando e modal de compartilhamento com opções de qualidade.

## Funcionalidades da UI

- **Grade de vídeos** com zoom (⤢), tela cheia (⛶) e volume individual (🔊) por pessoa
- **Barra de controles** estilo Discord: compartilhar tela, microfone, áudio (deafen) e sair
- **Painel de participantes** com indicador verde de fala e estado da transmissão
- **Modal de compartilhamento** com:
  - Abas **Telas** / **Janelas**
  - **Resolução** (480p, 720p, 1080p, 1440p, nativa)
  - **FPS** (15, 30, 60)
  - **Qualidade / bitrate** (1–12 Mbps)
  - **Áudio do sistema** on/off
  - **Transmitir microfone junto** on/off
- **Ajustes de áudio**: supressão de ruído, cancelamento de eco, controle automático de
  ganho, sensibilidade de entrada (com ganho real de 0.5x a 2x) e **medidor de nível** ao vivo
- **Estatísticas** em tempo real: latência, bitrate e tipo de conexão (P2P ou TURN)
- **Reconexão automática** com heartbeat, notificações (toasts) e cópia do código da sala


## Estrutura

- `server/` — sinalização em Rust (axum + WebSocket). Salas em memória, relay cego de SDP/ICE.
- `client/` — Electron + TypeScript. Captura de tela (com áudio do sistema no Windows via `audio: 'loopback'`), mixagem com microfone, mesh WebRTC com perfect negotiation.
- `docker-compose.yml` — sinalização + coturn (STUN/TURN) para produção.

## Rodando localmente

### 1. Servidor de sinalização (requer Rust — https://rustup.rs)

```bash
cd server
cargo run
# -> servidor ouvindo em ws://0.0.0.0:3000/ws
```

### 2. Cliente

```bash
cd client
npm install
npm start
```

Abra duas instâncias (para testar P2P local):

```bash
npm start -- --user-data-dir=tmp1
npm start -- --user-data-dir=tmp2
```

Entre com o mesmo código de sala nas duas e clique em "Compartilhar tela".

## Publicando atualizações (auto-update)

Quem já instalou o LiveBR recebe a nova versão **automaticamente**:

1. Faça as mudanças e commite normalmente.
2. Defina o token do GitHub: `set GH_TOKEN=ghp_...` (PowerShell: `$env:GH_TOKEN = '...'`)
3. Rode:
   ```bash
   node scripts/release.cjs patch   # 0.2.0 → 0.2.1
   node scripts/release.cjs minor   # 0.2.0 → 0.3.0
   node scripts/release.cjs 0.4.2   # versão exata
   ```
4. O script: bump de versão → build do instalador → commit+tag+push → cria a release → sobe os artefatos.
5. Quem já tem o app instalado vê o banner **"Nova versão encontrada"** → baixa sozinho →
   **"Reiniciar e atualizar"**.

## Distribuindo para amigos (instalador)

Gere o instalador no seu PC:

```bash
cd client
npm run installer
```

Saída em `client/installer/`:
- `LiveBR Setup 0.1.0.exe` — instalador NSIS (atalho na área de trabalho)
- `LiveBR-Portable.exe` — versão portátil, sem instalar (basta executar)

Mande um dos dois para seu amigo (Discord aceita até ~500 MB). Ele só precisa:
1. Abrir o instalador/portable
2. Preencher "Servidor" com `wss://URL-DO-TUNNEL/ws`, nome e código da sala

> Nota: o executável não é assinado digitalmente (certificado custa caro), então o
> Windows SmartScreen pode mostrar aviso — clique em "Mais informações > Executar assim mesmo".

## Android (APK)

O mesmo renderer roda num app Android (WebView) empacotado em `android/`:

- **Baixando:** abra a release mais recente no GitHub e baixe o `LiveBR-x.y.z.apk`
  no celular → permita instalar de **fontes desconhecidas** → abra e conceda
  câmera/microfone.
- **Criar sala** é função do PC (o app hospeda o servidor + túnel). No celular use
  **Entrar com código** com o convite de quem está no PC, ou a aba **Sem servidor**
  (convite/resposta manual) para conversar entre celulares.
- No celular o botão de compartilhar abre a **câmera** (a WebView não captura a
  tela do sistema); para ver a tela de quem está no PC, é só entrar na sala.

Gerando o APK localmente (requer JDK 17, Android SDK e Gradle 8.9):

```bash
node scripts/build-android.cjs
# saída: android/LiveBR-<versão>.apk
```

## Sala com código (o app hospeda sozinho)

Fluxo recomendado — **ninguém configura nada**:

1. **Host**: abre o app → aba **Sala** → clica em **"Criar sala"**.
   Por trás, o app sobe um servidor de sinalização embutido e um túnel público
   (cloudflared empacotado) sozinho, e gera um código tipo
   `livebr://xxxx.trycloudflare.com/4821`.
2. O app **copia o código sozinho** (ou clique em "📋 copiar convite" no topo).
3. **Convidado**: aba **Sala** → cola o código em **"Entrar com código"** → **Entrar**.

Pronto: o convidado conecta pelo túnel público do host, e o vídeo/áudio trafega
direto entre os PCs (P2P).

> Validado por teste automatizado: `npm run test:host` (dois apps reais, host
> criando sala com túnel e convidado entrando só com o código).

## Funcionalidades da versão 0.3.0

- 💬 **Chat na sala** (P2P via data channel, sem servidor de mensagens)
- 👁 **Parar de assistir** a transmissão de alguém (e voltar quando quiser)
- ✕ **Fechar o tile** de quem parou de transmitir (some da grade automaticamente)
- 📷 **Compartilhar câmera** (aba Câmera no modal de compartilhar)
- 🎬 **Assistir vídeo juntos**: cole um link do **YouTube**, **Twitch** ou um
  **.mp4/.webm** — aparece sincronizado para todo mundo (play/pause/seek)
- 🎧 **Seleção de dispositivos**: escolha o microfone (headset) e o alto-falante
  de saída nos Ajustes — como no Discord
- 👑 **Coroa do host** em todos os tiles e na lista de participantes
- 🗣️ **Indicador de quem está falando** (borda verde no tile)
- 📊 **Latência/bitrate** em tempo real por pessoa

## Modo "Sem servidor" (sem internet/túnel)

Aba **Sem servidor** no lobby: troca manual de convite/resposta (SDP por chat).
Use quando o túnel automático não funcionar ou em LAN isolada.

## Teste local (passo 0)

```bash
# terminal 1
cd server && cargo run

# terminal 2
cd client && npm start

# terminal 3 (segunda instância para testar P2P local)
cd client && npm start -- --user-data-dir=tmp2
```

Nas duas janelas: mesmo código de sala, clique em "Compartilhar tela" —
a tela da outra instância deve aparecer na grade.

Teste automatizado da sinalização (servidor precisa estar rodando):

```bash
cd client && node test-signaling.mjs
```

## Testando com um amigo (sem VPS)

Exponha o servidor local com um túnel:

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

O comando imprime uma URL tipo `https://algo.trycloudflare.com`.
Seu amigo preenche no campo "Servidor": `wss://algo.trycloudflare.com/ws`
(o túnel do Cloudflare já entrega TLS, por isso `wss`).

Conexões P2P atravessam NAT direto na maioria dos casos (STUN público).
Se alguém não conectar, suba o coturn no seu VPS (`docker compose up -d`) e
defina no cliente: `localStorage.setItem('turnUrl', 'turn:IP_DO_VPS:3478')`.

## Deploy

```bash
docker compose up -d
```

Ajuste o `ICE_SERVERS` em `client/src/renderer/app.ts` com o endereço do seu TURN
(`turn:SEU_IP:3478`, usuário `livebr`, senha definida no docker-compose).
Em produção, coloque o WebSocket atrás de TLS (Caddy/Nginx) e use `wss://`.
