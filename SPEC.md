# SPEC.md — Sala de voz + screen share (MVP)

Especificação técnica. Nenhum código de aplicação foi escrito ainda.
Escopo: sala efêmera, sem banco, sem autenticação, 1 tela + até 20 áudios.

Convenções: pacotes sob o escopo `@telecord/*`; o app web se chama `web`.

---

## 1. Arquitetura

### 1.1 Diagrama de fluxo

```
┌── Browser (participante) ─────────────────────────────────────────────┐
│  SPA Vite + React (bundle estático servido pelo CDN da Vercel)        │
│                                                                       │
│   (1) POST /api/token  { roomId, displayName }        ── HTTPS ───┐   │
│   (4) new Room(...).connect(VITE_LIVEKIT_URL, token)  ── wss:// ──┼─┐ │
│   (5) mídia: DTLS/SRTP sobre UDP (fallback TCP/TLS 443) ──────────┼─┤ │
└───────────────────────────────────────────────────────────────────┼─┼─┘
                                                                    │ │
        ┌───────────────────────────────────────────────────────────┘ │
        ▼ (mesma origem, sem CORS)                                    │
┌── Vercel (Hobby) ──────────────────────────────┐                    │
│  Estático:  apps/web/dist  → CDN               │                    │
│  Função:    /api/token (Node 22, ~5 ms)        │                    │
│    - valida roomId e displayName               │                    │
│    - gera identity (UUID)                      │                    │
│    - (2) assina JWT HS256 com API_KEY/SECRET   │                    │
│    - (3) responde { token, identity, ... }     │                    │
│    - SEM I/O externo, SEM estado, SEM cache    │                    │
└────────────────────────────────────────────────┘                    │
                                                                      ▼
                                    ┌── LiveKit Cloud (SFU) ────────────────────┐
                                    │  - valida o JWT com o mesmo secret        │
                                    │  - cria a sala no primeiro join           │
                                    │  - encaminha tracks entre participantes   │
                                    │  - destrói a sala vazia (emptyTimeout)    │
                                    │  - ÚNICA fonte de verdade do estado       │
                                    └───────────────────────────────────────────┘
```

### 1.2 O que roda onde, e por quê

| Peça | Onde | Por quê |
|---|---|---|
| SPA | CDN da Vercel (estático) | Sem SSR, sem dado por request. É um bundle burro; todo estado vem do SFU. |
| `/api/token` | Função serverless Node na Vercel | É o único lugar que pode tocar no `LIVEKIT_API_SECRET`. Assinatura HS256 é CPU puro: sem rede, sem disco, sem banco — cabe folgado em qualquer timeout do Hobby. |
| Sinalização + mídia | LiveKit Cloud | WebRTC exige conexão longa e stateful. Função serverless não mantém socket, então o SFU **não pode** rodar na Vercel. |
| Estado da sala | Memória do SFU | Sala é efêmera por definição: existe enquanto houver gente. Persistir seria inventar uma fonte de verdade concorrente. |
| Preferência de nome | `localStorage` do browser | É preferência do usuário, não estado da sala. |

### 1.3 Sequência completa

1. Usuário abre `/sala/:roomId`. A SPA lê `displayName` do `localStorage`; se não houver, redireciona para `/` com a sala pré-preenchida.
2. SPA faz `POST /api/token`.
3. Função valida, gera `identity` e devolve o JWT (TTL 10 min).
4. SPA conecta em `VITE_LIVEKIT_URL` com o token, **sem publicar nada** (`audio: false`, `video: false`).
5. LiveKit valida o JWT, cria a sala se não existir, e envia o roster atual.
6. SPA assina automaticamente as tracks remotas e renderiza.
7. Ao publicar mic ou tela, o browser pede permissão; a track sobe para o SFU, que encaminha aos demais.

---

## 2. Contrato da API

### 2.1 `POST /api/token`

Só `POST`. Outro método → `405` com header `Allow: POST`.
`Content-Type: application/json`. Resposta sempre com `Cache-Control: no-store`.

**Request**

```jsonc
{
  "roomId": "sala-do-time",   // slug
  "displayName": "Ana Souza"
}
```

**Validação** (nesta ordem; a primeira falha corta)

| Campo | Regra |
|---|---|
| corpo | JSON válido, objeto, no máximo 4 KB → senão `400` / `413` |
| `roomId` | string obrigatória. Servidor aplica `trim().toLowerCase()` e então exige `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 3–64 chars. Qualquer outra coisa → `400`. |
| `displayName` | string obrigatória. `trim()`, colapsa espaços internos, 1–32 chars após normalizar, rejeita caracteres de controle e formatação (`\p{Cc}`, `\p{Cf}`) → `400`. |

Slugificar é responsabilidade do cliente; o servidor **rejeita**, não conserta. Assim a sala que o usuário vê na URL é exatamente a sala em que ele entra.

**Response 200**

```jsonc
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "identity": "5f2b8c1e-...-9a",  // gerado no servidor
  "roomId": "sala-do-time",       // normalizado
  "displayName": "Ana Souza",     // normalizado
  "expiresInSeconds": 600
}
```

**Erro** — mesma forma em todos os casos:

```jsonc
{ "error": { "code": "INVALID_ROOM_ID", "message": "roomId deve ser um slug de 3 a 64 caracteres." } }
```

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `INVALID_JSON` | corpo não é JSON de objeto |
| 400 | `MISSING_FIELD` | `roomId` ou `displayName` ausente |
| 400 | `INVALID_ROOM_ID` | falha no slug/tamanho |
| 400 | `INVALID_DISPLAY_NAME` | vazio, longo demais ou com caractere proibido |
| 405 | `METHOD_NOT_ALLOWED` | método ≠ POST |
| 413 | `PAYLOAD_TOO_LARGE` | corpo > 4 KB |
| 500 | `SERVER_MISCONFIGURED` | `LIVEKIT_API_KEY` ou `LIVEKIT_API_SECRET` ausente no ambiente |
| 500 | `TOKEN_SIGN_FAILED` | falha inesperada ao assinar |

`SERVER_MISCONFIGURED` diz **qual** variável falta, mas nunca o valor de nenhuma.

### 2.2 Grants do JWT

```ts
const at = new AccessToken(apiKey, apiSecret, {
  identity,              // UUID gerado no servidor
  name: displayName,     // rótulo, NÃO é identidade
  ttl: '10m',
});
at.addGrant({
  roomJoin: true,
  room: roomId,
  canSubscribe: true,
  canPublish: true,
  canPublishSources: ['microphone', 'screen_share', 'screen_share_audio'], // sem 'camera'
  canPublishData: false,
  canUpdateOwnMetadata: false,
  roomCreate: false,
  roomAdmin: false,
  hidden: false,
  recorder: false,
});
const token = await at.toJwt();   // v2 do SDK: assíncrono
```

Notas que valem como regra:

- **`identity` é gerado no servidor.** Duas conexões com a mesma identity fazem o LiveKit derrubar a anterior — derivar identity do nome digitado transformaria "dois Joões" em kick mútuo. UUID por emissão também impede que o cliente escolha se passar por outra identity.
- **`name` não é confiável.** Não há autenticação; é rótulo auto-declarado. Registrado em §9.
- **`canPublishSources` sem `camera`** é a única restrição de mídia efetivamente imposta pelo servidor no MVP. É de graça, então vale.
- **O TTL de 10 min governa só o join.** Depois de conectado, o próprio servidor LiveKit entrega token renovado pelo canal de sinalização, então a reconexão automática não quebra. Ainda assim o cliente trata falha por token expirado refazendo `POST /api/token` e reconectando.
- **Sem CORS**: front e função na mesma origem em produção; em dev o handler é montado dentro do próprio Vite (§8.3).
- **Logs**: só `{ roomId, identity, code, durationMs }`. Nunca key, secret, token ou corpo cru.
- **Sem rate limit** — limitação consciente, registrada em §9.

---

## 3. Modelo de dados em memória

Não há persistência em lugar nenhum. **A fonte de verdade é o SFU**; o estado React é um cache derivado dos eventos do `Room`, reconstruível a qualquer momento a partir do objeto `room`.

| Estado da UI | Derivação |
|---|---|
| Lista de participantes | `room.localParticipant` + `room.remoteParticipants` |
| Nome exibido | `participant.name` (fallback: `identity`) |
| Quem está falando | `RoomEvent.ActiveSpeakersChanged` / `participant.isSpeaking` |
| Quem está mutado | `participant.isMicrophoneEnabled` e `publication.isMuted` |
| Tela ativa | primeira publicação com `source === Track.Source.ScreenShare` |
| Áudio da tela | publicação com `source === Track.Source.ScreenShareAudio` |
| Sou eu que compartilho | `room.localParticipant.isScreenShareEnabled` |
| Status de conexão | `room.state` + eventos `Connected` / `Reconnecting` / `Reconnected` / `Disconnected` |
| Áudio bloqueado pelo browser | `room.canPlaybackAudio` + `RoomEvent.AudioPlaybackStatusChanged` |

Regras:

- **Em `Reconnected`, re-derivar tudo do objeto `room`**, sem confiar em deltas: durante a reconexão eventos se perdem.
- **A sala nasce no primeiro join e morre sozinha.** Nenhum código nosso cria ou destrói sala; quem faz isso é o LiveKit, com o `emptyTimeout` configurado no projeto do Cloud. Se todos saem, a sala deixa de existir; a URL continua válida e recria a sala no próximo join.
- **`localStorage` guarda apenas `telecord.displayName`.** Nada de sala, token ou participantes.
- Reload da página = nova identity, novo token, participante novo do ponto de vista do SFU.

---

## 4. Regra de tela única

### 4.1 Alternativas avaliadas

| Opção | Custo | Garantia | Veredito |
|---|---|---|---|
| **(a) Checagem client-side das tracks publicadas** | zero | nenhuma contra adversário; corrida de ~1 RTT + tempo do seletor de tela | **escolhida**, com desempate |
| **(b) Metadata da sala** | exige `RoomServiceClient.updateRoomMetadata` → chamada HTTP da função para a API do LiveKit | não resolve: metadata não tem compare-and-swap; dois writes concorrentes terminam em "o último ganha" | rejeitada |
| **(c) `canPublishSources` diferenciado no token** | exige saber quem é o dono da tela na hora de emitir → estado no servidor (KV/Redis) ou consulta ao LiveKit | é a única de fato imposta pelo servidor | rejeitada **no MVP** |

Por que (b) cai: adiciona I/O externo na função (o prompt proíbe), soma latência e risco de timeout, e mesmo assim continua sem atomicidade — troca uma corrida por outra, mais cara.

Por que (c) cai: o grant é fixado no join. Trocar de apresentador exigiria emitir token novo e reconectar, e decidir "quem é o dono" exige exatamente o estado no servidor que o MVP existe para evitar. É o caminho de produção, não o do MVP.

### 4.2 Mecanismo escolhido

1. `screenShareOwner` = primeira publicação `Track.Source.ScreenShare` entre local + remotos.
2. O botão "Compartilhar tela" fica **desabilitado com tooltip** (`"Fulano já está compartilhando"`) sempre que existir owner diferente de mim.
3. **Lock otimista local**: no clique, `isStartingShare = true` desabilita o botão *antes* do `await setScreenShareEnabled(true)`, para não haver duplo clique local.
4. **Desempate determinístico**: se, após a publicação, houver 2+ screenshares na sala, todo cliente aplica a mesma ordem total — vence o menor `trackSid` (o sid é atribuído pelo servidor e é visível para todos, então todos calculam o mesmo vencedor). O perdedor chama `setScreenShareEnabled(false)` e mostra o aviso *"Outra tela entrou primeiro."*. Converge em ~1 RTT, sem servidor de estado.

### 4.3 A corrida que continua aberta

Entre A clicar e o evento `TrackPublished` de A chegar em B, B ainda vê o botão habilitado. A janela real é **maior que o RTT**: B pode ter aberto o seletor de tela antes de A publicar e ficar parado nele alguns segundos — a publicação de B só acontece quando ele confirma. Não há como fechar isso no cliente.

Consequências aceitas:

- O desempate de §4.2.4 é **obrigatório**, não opcional: sem ele a sala fica com duas telas.
- Custo visível: a tela do perdedor pode aparecer por ~1 s antes de ser recolhida (flicker).
- Não fecha contra adversário: quem tem o token pode publicar `screen_share` direto pelo SDK e ignorar a UI. Aceito por ser uso interno; o fechamento real é a opção (c).

---

## 5. Componentes de UI

```
main.tsx
└── App                                  BrowserRouter + rotas
    ├── "/"            JoinPage          entrada
    │   ├── RoomField                    nome da sala; slugifica ao digitar; gera slug se vazio
    │   ├── DisplayNameField             nome de exibição
    │   ├── JoinButton                   valida e navega para /sala/:roomId
    │   └── useDisplayName()             leitura/escrita em localStorage
    │
    ├── "/sala/:roomId"  RoomPage        orquestra token + conexão
    │   ├── useToken(roomId, name)       POST /api/token → { token, status, error, retry }
    │   ├── TokenGate                    "obtendo acesso" | erro com botão tentar de novo
    │   │                                | sem nome salvo → redirect para "/"
    │   └── <LiveKitRoom connect audio={false} video={false} options={roomOptions}>
    │       ├── ConnectionBanner         conectando | conectado | reconectando | desconectado | erro
    │       ├── AudioPlaybackGate        botão "Ativar áudio" quando o browser bloqueia autoplay
    │       ├── RoomAudioRenderer        (@livekit/components-react) toca todo áudio remoto
    │       ├── Stage
    │       │   ├── ScreenStage          <VideoTrack> da tela ativa + nome de quem apresenta
    │       │   └── EmptyStage           estado vazio: "Ninguém está compartilhando"
    │       ├── ParticipantSidebar
    │       │   └── ParticipantRow[]     nome, anel de "falando", ícone de mutado, badge "apresentando"
    │       ├── ControlBar
    │       │   ├── MicToggle            entra mutado; 1º clique dispara o prompt de permissão
    │       │   ├── ShareScreenButton    desabilitado + tooltip conforme §4
    │       │   └── LeaveButton          room.disconnect() e volta para "/"
    │       └── ToastStack               permissão negada, seletor cancelado, desempate perdido
    │
    └── "*"             NotFound         link de volta para "/"
```

Hooks próprios:

| Hook | Responsabilidade |
|---|---|
| `useDisplayName()` | lê/grava `telecord.displayName`; tolera `localStorage` indisponível (modo privado) |
| `useToken(roomId, displayName)` | busca o token, expõe `status`/`error`/`retry`, aborta no unmount |
| `useScreenShareLock()` | dono da tela, `canShare`, `startShare`, `stopShare`, desempate de §4 |
| `useConnectionStatus()` | traduz eventos do `Room` em um enum de UI |

Decisões de comportamento embutidas na árvore:

- `audio={false}` no `<LiveKitRoom>` é o que garante **entrar mutado**: o mic nem chega a ser publicado, então o prompt de permissão só aparece no primeiro clique.
- `RoomAudioRenderer` é obrigatório — sem ele ninguém ouve nada, e a falha é silenciosa.
- O `AudioPlaybackGate` existe porque a política de autoplay bloqueia áudio antes de qualquer gesto do usuário; sem ele o sintoma é "entrei e não escuto ninguém".

---

## 6. Configuração de mídia

### 6.1 Opções do Room

```ts
const roomOptions: RoomOptions = {
  adaptiveStream: true,   // pausa vídeo fora da viewport / ajusta à área renderizada
  dynacast: true,         // SFU para de encaminhar o que ninguém consome
  publishDefaults: {
    dtx: true,                                   // silêncio quase não gasta banda
    red: true,                                   // redundância de áudio contra perda de pacote
    audioPreset: AudioPresets.speech,            // Opus mono ~20 kbps
    stopMicTrackOnMute: false,                   // mute instantâneo, sem repedir permissão
    videoCodec: 'vp8',                           // compatibilidade ampla
    screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,  // 1920x1080 @15 fps, ~2,5 Mbps
    simulcast: false,                            // ver 6.4
  },
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};
```

### 6.2 Captura da tela

```ts
await localParticipant.setScreenShareEnabled(true, {
  audio: true,                                   // áudio da aba/sistema, quando o browser oferecer
  contentHint: 'detail',                         // prioriza nitidez de texto sobre fluidez
  resolution: ScreenSharePresets.h1080fps15.resolution,
  selfBrowserSurface: 'exclude',                 // evita o efeito túnel de compartilhar a própria aba
  surfaceSwitching: 'include',                   // trocar de janela sem republicar
  systemAudio: 'include',
});
```

`15 fps` e `contentHint: 'detail'` porque o conteúdo esperado é IDE, slide e planilha — texto legível vale mais que suavidade. Se o uso virar demonstração animada, o preset certo é `h1080fps30` (~5 Mbps) com `contentHint: 'motion'`.

### 6.3 Áudio da aba

Tratar como **opcional e ausente por padrão**: só navegadores Chromium em desktop entregam áudio de aba/sistema no `getDisplayMedia`; Firefox e Safari não. Quando vier, é uma track separada (`Track.Source.ScreenShareAudio`) e deve ser publicada **sem** processamento de voz (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`) — o AEC destruiria o áudio do conteúdo. A UI não promete o recurso; no máximo informa quando ele existe.

### 6.4 Política de assinatura

- `autoSubscribe: true` (padrão). Cada cliente assina **todos** os áudios remotos + a tela.
- Por participante: 1 vídeo + até 19 áudios + eventualmente 1 áudio de tela. 19 decodificações Opus são baratas; o gargalo é o vídeo.
- `adaptiveStream` pausa o vídeo quando o elemento não está visível (aba em background, sidebar por cima).
- `simulcast: false` para a tela: com um único publicador e ≤20 espectadores, camadas extras custam CPU de encoding e upstream do apresentador sem ganho real. **Trade-off assumido**: espectador em rede ruim não tem camada menor para cair — ele perde qualidade pela degradação do próprio encoder, não pela troca de camada. Se aparecer relato de travamento, ligar simulcast é uma linha.
- Nada de `setSubscribed(false)` manual no MVP.

### 6.5 Contas de banda (por que isso importa)

Por participante, downstream: `2,5 Mbps (tela) + 19 × 20 kbps (≈0,4 Mbps) ≈ 2,9 Mbps`.
Upstream do apresentador: `2,5 Mbps + mic`.
Egress agregado do SFU com 20 pessoas: `≈ 58 Mbps` → **≈ 26 GB por hora de reunião**.
Em `h720fps15` (~1,5 Mbps) cai para ~15 GB/h; em `h720fps5`, bem menos.

Esse número é a variável que decide se o plano free do LiveKit aguenta o uso real (§9).

---

## 7. Variáveis de ambiente

| Nome | Escopo | Público | Onde configurar |
|---|---|---|---|
| `LIVEKIT_API_KEY` | runtime, servidor | **não** | Vercel → Environment Variables (Production, Preview, Development) + `.env` local |
| `LIVEKIT_API_SECRET` | runtime, servidor | **não** | idem |
| `VITE_LIVEKIT_URL` | build (Vite), opcional | **sim** | default versionado em `apps/web/src/lib/config.ts`; defina só para apontar para outro servidor |
| `VITE_TOKEN_ENDPOINT` | build (Vite), opcional | sim | default `/api/token` |

> **Emenda (pós-implementação).** A URL do servidor LiveKit passou a ter default no código. Ela é pública por definição — o navegador precisa dela e ela acaba no bundle de qualquer forma —, então versioná-la não expõe nada e elimina uma classe de falha real: publicar um build sem a variável e obter um app que não conecta. Key e secret continuam proibidos de serem versionados, e são o motivo pelo qual a configuração na Vercel continua obrigatória: arquivo `.env` do repositório **não** é carregado no runtime das funções.

**A regra dura:** apenas variáveis com prefixo `VITE_` são injetadas no bundle, e tudo que entra no bundle é **legível por qualquer visitante** — basta abrir o devtools. Portanto:

- `LIVEKIT_API_SECRET` **nunca** pode ganhar prefixo `VITE_`, ser referenciado em código de `apps/web`, nem entrar em `define` do Vite. Vazamento do secret = qualquer pessoa emite token para qualquer sala, entra, escuta e publica. A remediação é rotacionar a key no dashboard do LiveKit.
- `LIVEKIT_API_KEY` tem o mesmo tratamento: sozinha não assina nada, mas não há motivo para expô-la.
- `VITE_LIVEKIT_URL` é público por natureza (o browser precisa dele para conectar) e é **congelado no build** — trocar de servidor LiveKit exige rebuild + redeploy, seja mexendo na variável ou no default versionado. Ver decisão 6 em §10.

Guard-rail sugerido no build: um script que faz `grep` do `dist/` procurando `LIVEKIT_API_` e o valor do secret, e falha o build se achar. Custa 15 linhas e fecha a classe inteira de erro.

Arquivos: `.env` na raiz do monorepo (git-ignorado), `.env.example` versionado com comentário marcando o que é público. O Vite deve usar `envDir` apontando para a raiz, para as três variáveis viverem em um arquivo só.

---

## 8. Deploy

### 8.1 `vercel.json` (raiz)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",
  "outputDirectory": "apps/web/dist",
  "functions": {
    "api/*.ts": { "maxDuration": 10 }
  },
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    },
    {
      "source": "/api/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "no-store" }]
    }
  ]
}
```

Notas:

- O rewrite de SPA é o que faz `/sala/qualquer-coisa` servir o `index.html` em vez de 404 — sem ele, recarregar dentro da sala quebra.
- Rewrites da `vercel.json` só são avaliados **depois** do filesystem, então arquivos estáticos e as funções em `/api` já ganham antes. O negative lookahead `(?!api/)` é cinto-e-suspensório: garante que um caminho `/api/*` inexistente devolva 404 de API, e não o HTML da SPA (que viraria um erro de JSON parse confuso no cliente).
- `maxDuration: 10` é higiene, não necessidade: a emissão de token roda em poucos milissegundos.

### 8.2 Configuração do projeto na Vercel

| Campo | Valor | Motivo |
|---|---|---|
| Root Directory | **`.` (raiz do repo)** | Se apontar para `apps/web`, o diretório `api/` deixa de ser detectado e não existe função nenhuma. |
| Framework Preset | Vite | |
| Build Command | `pnpm run build` (da `vercel.json`) | expande para `pnpm --filter @telecord/shared build && pnpm --filter web build` |
| Output Directory | `apps/web/dist` | |
| Install Command | `pnpm install --frozen-lockfile` | pnpm é detectado pelo `pnpm-lock.yaml`; `packageManager` no `package.json` da raiz fixa a versão via corepack |
| Node.js Version | 22.x | |
| Env vars | as três de §7, em Production/Preview/Development | |

Ordem que importa: a Vercel roda o `buildCommand` **antes** de compilar as funções de `api/`. Logo, `packages/shared/dist` já existe quando `api/token.ts` é empacotado.

> **Emenda (pós-implementação).** O deploy automático da Vercel foi desligado (`git.deploymentEnabled: false`) e a publicação passou para o GitHub Actions: `vercel pull` → `vercel build --prod` → `vercel deploy --prebuilt --prod`, com verificação de `/api/token` no fim.
>
> A consequência que importa para esta seção: **deploy prebuilt não carrega arquivo `.env` para o runtime das funções**. O ambiente do Lambda continua vindo da plataforma, então o workflow sincroniza `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` no projeto (via `vercel env`) antes de publicar. Os valores vivem nos GitHub Secrets; o repositório continua sem nenhuma credencial.

### 8.3 Dev local

`vite dev` sozinho não executa a função `/api/token`. A proposta é um plugin de dev do próprio Vite que monta o handler no middleware, lendo `LIVEKIT_API_KEY`/`SECRET` via `loadEnv` — **sem** passar por `define`, então nada disso encosta no bundle. Custa zero dependência nova e mantém front e API na mesma origem, igual à produção. A alternativa é `vercel dev`, que exige a CLI da Vercel instalada (ver decisão 2 em §10).

---

## 9. Limites conhecidos

**Acima de 20 pessoas**

- O limite de 20 é **convenção, não é imposto**. `maxParticipants` é opção de criação de sala via API de servidor, que o MVP não chama — a 21ª pessoa entra normalmente.
- O custo cresce no egress do SFU (§6.5), não na CPU do cliente: 30 decodificações Opus continuam baratas.
- Acima de ~30–50 áudios simultâneos vale limitar a assinatura aos N mais altos (`ActiveSpeakers`), o que muda a política de §6.4.
- A `ParticipantSidebar` re-renderiza a cada `ActiveSpeakersChanged`; com muita gente falando isso vira gargalo de UI e pede memoização por linha.

**Se o free do LiveKit estourar**

- O plano gratuito tem teto de participantes simultâneos e de banda mensal. **Confira os números atuais na página de pricing do LiveKit** — não confie em número decorado, inclusive os deste documento.
- Com as contas de §6.5, uma reunião de 1 h com 20 pessoas em 1080p15 consome ~26 GB de egress. É fácil estourar cota mensal com poucas reuniões.
- Ao estourar, o sintoma é join recusado na sinalização: o cliente cai no estado de erro de conexão. Nada de degradação silenciosa.
- Mitigação imediata: baixar o preset para `h720fps15` ou `h720fps5` (~metade ou menos da banda). Mitigação real: self-host trocando `VITE_LIVEKIT_URL` e as credenciais — o código não muda.

**Sem autenticação**

- Quem tem a URL entra. `displayName` é auto-declarado e falsificável.
- Não há expulsar, silenciar, nem lista de moderação.
- `/api/token` não tem rate limit: dá para gerar tokens em volume. Limitar por IP exige estado (KV/Redis) — fora do MVP.

**Corrida da tela única** — §4.3.

**Compatibilidade**

- Áudio de aba só em Chromium desktop (§6.3).
- iOS Safari não faz `getDisplayMedia`: **não dá para apresentar do iPhone/iPad**, só assistir e falar.
- Autoplay bloqueado até o primeiro gesto do usuário → o `AudioPlaybackGate` de §5 não é enfeite.

**Efemeridade**

- Recarregar a página = novo participante (nova identity). Sair todo mundo = sala destruída.
- Nada de chat, gravação ou histórico, por definição de escopo.

**O que falta para produção**

1. Regra de tela única imposta pelo servidor (opção (c) + estado).
2. Rate limit e proteção de abuso no endpoint de token.
3. Moderação: kick, mute remoto, papel de apresentador.
4. Observabilidade: webhooks do LiveKit, captura de erro no front, métrica de qualidade de conexão.
5. Testes E2E de sala com múltiplos participantes.
6. Autenticação, se a sala deixar de ser "quem tem o link entra".

---

## 10. Decisões que tomei por conta própria — revise antes da implementação

1. **Tipagem do handler da Vercel.** `@vercel/node` (que fornece `VercelRequest`/`VercelResponse`) **não está na lista de dependências permitidas**. Proposta: tipar com `IncomingMessage`/`ServerResponse` de `node:http` e fazer o parse do corpo manualmente — zero dependência nova, e funciona igual no runtime da Vercel. Alternativa: você autoriza `@vercel/node` como devDependency (só tipos).
2. **Dev local da API.** Proposta: plugin de dev do Vite montando o handler (zero dep). Alternativa: `vercel dev`, que exige a CLI da Vercel.
3. **`packages/shared` compilado.** Proposta: `tsc` gerando `dist/` (consumido pela função) + alias no Vite apontando para `src/` (DX no dev). Alternativa mais simples: pacote **só de tipos**, com `import type` dos dois lados — mas aí regex de validação e limites ficam duplicados.
4. **`identity` gerado no servidor (UUID)** em vez de derivado do nome. Muda o comportamento de "mesma pessoa em duas abas": vira dois participantes, em vez de a segunda aba derrubar a primeira.
5. **TTL de 10 minutos.** Se a reconexão em rede ruim se mostrar frágil, subir para 30–60 min é trivial.
6. **`VITE_LIVEKIT_URL` no bundle**, como na sua tabela. **Recomendo o contrário**: devolver a URL do servidor na resposta de `/api/token`, lendo de uma env var de runtime. Passa a ser possível trocar de servidor LiveKit (Cloud → self-host) mexendo só em env vars, sem rebuild. Mantive sua versão por estar explícita nas notas; diga se troco.
7. **Desempate por menor `trackSid`**, com flicker de ~1 s no perdedor. Alternativa: bloquear nova tentativa de compartilhar por alguns segundos após um desempate perdido.
8. **1080p @15 fps como padrão de tela** (~26 GB/h com 20 pessoas). Se a cota do plano free for apertada, o padrão certo é `h720fps15`.
9. **Estilo: CSS Modules** (a escolha é do Prompt 2, adianto aqui para você confirmar). Justificativa: já vem pronto no Vite, escopo por componente sem runtime extra, sem passo de build adicional nem classe utilitária espalhada pelo JSX.
10. **Nomes**: escopo `@telecord/shared`, app `web`, chave de `localStorage` `telecord.displayName`, rota em português `/sala/:roomId` (conforme o prompt).
11. **Slug automático** quando o campo de sala vem vazio: formato `sala-<6 chars base36>`, curto e digitável. Diga se prefere palavras legíveis.
12. **Máquina atual não tem `pnpm` instalado.** O caminho recomendado é `corepack enable pnpm`, com `packageManager` fixado no `package.json` da raiz para a Vercel usar a mesma versão. Confirma?
