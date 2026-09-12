# Cloudflare — terceira transmissão (Realtime SFU)

Terceira opção ao lado do **Servidor de mídia** (LiveKit) e da **Conexão direta**
(WebRTC P2P), **sem alterar nenhuma das duas**. Id interno: `cfsfu`.

O Cloudflare Realtime SFU é um SFU de borda **passthrough**: não recodifica a
mídia. A tela sobe **uma vez** para o edge da Cloudflare e é repassada a cada
assinante na resolução que o navegador de quem compartilha conseguir codificar.
É a razão de existir desta opção — compartilhamento de tela em qualidade máxima,
com latência baixa e escala melhor que a malha P2P. Sem servidor próprio, sem
VPS, sem Socket.IO: o vídeo trafega só por WebRTC/Cloudflare.

---

## 1. Variáveis de ambiente

Todas **só no backend** (Vercel). Nenhuma tem prefixo `VITE_`; o
`scripts/check-bundle.mjs` quebra o build se o token vazar para o navegador.

| Variável | Obrigatória | Padrão | Papel |
|---|---|---|---|
| `CF_REALTIME_APP_ID` | para ligar | — | App ID do SFU no dashboard da Cloudflare. |
| `CF_REALTIME_APP_TOKEN` | para ligar | — | App Token (secret). **Nunca** chega ao browser. |
| `CF_REALTIME_MONTHLY_GB_LIMIT` | — | `1000` | Cota mensal de egress do free tier, para o aviso/bloqueio na UI. |
| `CF_REALTIME_ENABLED` | — | — | `false`/`0`/`off` desliga explicitamente mesmo com credencial presente. |

A **presença** de `CF_REALTIME_APP_ID` + `CF_REALTIME_APP_TOKEN` é o interruptor
— mesmo critério do `LIVEKIT_API_KEY`, sem uma flag separada para lembrar de
sincronizar junto. Aceita `CLOUDFLARE_REALTIME_APP_ID` /
`CLOUDFLARE_REALTIME_APP_SECRET` como reserva. Só metade da credencial (um
definido, outro não) **derruba o boot** (falha explícita, não um cartão que
some em silêncio).

**Como obter:** dashboard da Cloudflare → Realtime → SFU → criar aplicação →
copiar App ID e App Token. STUN usado: `stun:stun.cloudflare.com:3478` (grátis).

---

## 2. Endpoints do backend (control plane, na Vercel)

Todos sob `/api/cfsfu`, servidos pelo `CfsfuController`. Cada um valida que o
autor está na sala (presença) antes de assinar a chamada à Cloudflare. O
`appToken` só existe no `CloudflareRealtimeClient` — nenhum controller monta HTTP
para a Cloudflare por conta própria.

| Método | Rota | Faz |
|---|---|---|
| `GET`  | `/api/cfsfu/config` | STUN, se está ligado, e a cota do mês. |
| `POST` | `/api/cfsfu/sessions` | Cria a sessão no SFU → `sessionId`. |
| `POST` | `/api/cfsfu/sessions/:id/tracks` | Push (local) e pull (remoto) de tracks. |
| `PUT`  | `/api/cfsfu/sessions/:id/renegotiate` | Envia a answer ao offer do SFU. |
| `PUT`  | `/api/cfsfu/sessions/:id/tracks/close` | Encerra tracks. |
| `POST` | `/api/cfsfu/usage/report` | Assinante reporta bytes recebidos (egress). |
| `GET`  | `/api/cfsfu/usage` | **Admin.** Acumulado do mês. |

Cada chamada carrega `roomSlug` + `peerId`; a portaria é a presença na sala
(mesmo sinal do roster do P2P), não o login — anônimo é usuário de primeira
classe.

---

## 3. Fluxo de sessão

1. Cliente entra na sala e começa o heartbeat (`/api/peers/:slug/heartbeat`).
2. `CfSfuTransport.connect()` → `POST /api/cfsfu/sessions` → guarda o `sessionId`
   e cria uma `RTCPeerConnection` com o STUN da Cloudflare.
3. Uma sessão da Cloudflare = uma PeerConnection. As tracks que a pessoa
   **publica** entram como `sendonly`; as que ela **assina** entram como
   `recvonly`, na mesma conexão.

## 4. Fluxo de publicação (screen share)

1. `getDisplayMedia` com `{ ideal: 1920×1080, 30fps }` (FHD padrão).
2. `track.contentHint = 'detail'`; `addTransceiver(track, { direction: 'sendonly' })`.
3. `setCodecPreferences` — VP9 → AV1 → H264, filtrado pelo que o navegador
   oferece (só reordena; nunca quebra quem não tem um codec).
4. `createOffer` → `setLocalDescription` → espera o ICE reunir candidatos
   (o SFU não faz trickle) → `POST /sessions/:id/tracks/new` com
   `{ sessionDescription: offer, tracks: [{ location:'local', mid, trackName }] }`.
5. `setRemoteDescription(answer)`.
6. `setParameters`: `maxBitrate` (6/12/20 Mbps), `scaleResolutionDownBy: 1`,
   `degradationPreference: 'maintain-resolution'` — nunca reduzir resolução.
7. Anuncia `sessionId` + `trackName`s no roster do heartbeat.

## 5. Fluxo de subscription (pull)

1. O heartbeat traz o roster com o anúncio cfsfu de cada par (o SFU não tem
   descoberta — o telecord a faz).
2. Para cada par novo: `POST /sessions/:id/tracks/new` com
   `{ tracks: [{ location:'remote', sessionId, trackName }] }`.
3. Casa cada `mid` retornado ao par/track para reconhecer no `ontrack`.
4. `ontrack` → agrupa por `sessionId` do publicador → renderiza no `<video>`.

## 6. Fluxo de renegociação

Ao puxar tracks remotas, o SFU precisa adicionar linhas `recvonly` à conexão e
responde com `requiresImmediateRenegotiation: true` e um **offer**:

1. `setRemoteDescription(offer)` → `createAnswer` → `setLocalDescription(answer)`.
2. `PUT /sessions/:id/renegotiate` com `{ sessionDescription: answer }`.

## 7. Fluxo de reconexão e limpeza

- Tracks são coletadas pelo SFU após **~30 s sem pacotes**. O heartbeat de 2,5 s
  mantém a presença; parar de compartilhar remove o anúncio de vídeo do roster e
  os outros param de puxar.
- Ao sair: as tracks locais são paradas, a PeerConnection é fechada e
  `/api/peers/:slug/leave` avisa o roster. O que escapar cai pelo TTL de presença.
- Queda de conexão aparece em `connectionState` no cabeçalho; o cliente pode
  recompartilhar. (Reconexão automática total da sessão é uma evolução — ver §9.)

## 8. Métricas de qualidade

`CfSfuTransport.metrics()` lê `getStats()` e devolve um `QualityMetrics` tipado
(sem `any`/`unknown` fora da borda de leitura): `codec`, `width`, `height`,
`framesPerSecond`, `bitrateKbps`, `packetsLost`, `jitterMs`, `roundTripTimeMs`,
`framesDropped`, `framesDecoded`, `availableIncomingBitrateKbps`,
`availableOutgoingBitrateKbps`. O cabeçalho da sala mostra resolução, fps e
codec ao vivo. A cada 15 s o assinante reporta o egress consumido para a cota.

## 9. Limitações conhecidas

- **Sem simulcast/SVC** (por escolha): o SFU é passthrough e o objetivo é
  preservar a camada máxima; simulcast só serviria para cortar qualidade.
- **Sem gravação** (o LiveKit tem).
- **Consumo de banda de quem assiste**: a 12 Mbps, cada espectador puxa ~5,4
  GB/h — a cota de 1.000 GB/mês dá ~46 h de sala cheia. A UI avisa em 80% e
  bloqueia criar sala cfsfu em 100%; o número oficial fica no dashboard.
- **Áudio do sistema** sobe como track separada (`system-audio`) com bitrate
  alto; o munging do `fmtp` do Opus para estéreo full-band é uma evolução.
- **Reconexão** hoje é manual (recompartilhar); a automática é evolução.
- **H265** é suportado pelo SFU mas o *encode* em navegador é raro, então não
  entra na preferência de envio.
- **Chat/soundboard** não estão no modo cfsfu (estão no LiveKit e no P2P).

## 10. Como testar FHD / 30 FPS

1. Configure `CF_REALTIME_APP_ID` e `CF_REALTIME_APP_TOKEN` no backend (isso já
   liga o recurso — não precisa de `CF_REALTIME_ENABLED`).
2. Suba API + web; entre em `/`, escolha **Cloudflare** (o cartão só aparece
   com o servidor confirmando `enabled`). Deixe o bitrate em 12 Mbps.
3. Abra a **mesma sala em dois navegadores** (ou duas máquinas). Em um,
   selecione **1080p** e **Compartilhar tela**.
4. No outro, a tela deve aparecer. Confira no cabeçalho: `1920×1080 · 30fps` e o
   codec (`VP9`/`AV1`/`H264`). Para 1440p/2160p, troque a resolução — o navegador
   entrega o que a máquina der (`getSettings` diz o real).
5. No `chrome://webrtc-internals`, confirme `frameWidth/Height`, `framesPerSecond`
   e ausência de downscale ao apertar a rede.

## 11. Comparar Cloudflare vs LiveKit vs P2P

| | Servidor de mídia (LiveKit) | Conexão direta (P2P) | Cloudflare (cfsfu) |
|---|---|---|---|
| Onde a mídia passa | SFU LiveKit | direto entre navegadores | SFU de borda Cloudflare |
| Escala | alta | ~6 pessoas | alta |
| Qualidade de tela | boa (pode cair p/ simulcast) | limitada pela subida de quem publica | **máxima, passthrough** |
| Latência | baixa | menor | baixa (edge) |
| Gravação | sim | não | não |
| Custo | free tier pequeno | zero | free tier de egress (1.000 GB/mês) |

Troque de modo na tela de criação da sala; a escolha é por sala. Para uma
comparação direta, entre na **mesma** sala em cada modo e observe o cabeçalho
(resolução/fps/codec) e o `webrtc-internals`.

---

## Estado de verificação

Verificado aqui: `typecheck` (shared/api/web), build de produção, bundle do Nest,
check anti-vazamento de segredo e **testes unitários** (config/gating + cliente
HTTP do SFU com `fetch` dublê). **Não** foi possível validar o fluxo real
Publisher → SFU → Subscriber neste ambiente: exige credenciais da Cloudflare e
dois navegadores. Use o roteiro do §10 para essa validação final.
