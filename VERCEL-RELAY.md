# Vercel Relay — quarta opção de transmissão

Screen share experimental com **R$0 de infraestrutura**: captura por **WebCodecs**,
chunks binários por **WebSocket**, a **Vercel** repassando em memória. Sem
LiveKit, mediasoup, Cloudflare, RTMP/HLS, FFmpeg, storage ou banco para vídeo —
nenhum byte de vídeo é persistido. Id interno: `vercel-relay`.

> **Estado:** implementado e verde em typecheck/build e **92 testes unitários**
> (protocolo, sequência, backpressure, sala, adaptive bitrate). O fluxo ao vivo
> (getDisplayMedia + WebCodecs + WebSocket entre dois navegadores) **não foi
> testado neste ambiente** — precisa de dois navegadores no deploy. Roteiro no §11.

## 1. Arquivos

**Compartilhado** (`packages/shared/src/vercel-relay.ts`): protocolo binário +
controle, `SequenceTracker`, `RelayRoom`/`RelayRegistry`, adaptive bitrate. Puro,
testado, e tree-shaken do bundle do front (só a função de relay usa a sala).

**Cliente** (`apps/web/src/lib/vercelRelay/`): `capabilities`, `codec`,
`transport` (interface + `VercelWebSocketTransport`), `encoder`, `decoder`.
`hooks/useVercelRelayRoom.ts` orquestra; `pages/VercelRelayRoom.tsx` desenha.

**Servidor** (`api/relay.ts`): a função WebSocket (pacote `ws`).

**Alterados:** `TransportMode` (+`vercel-relay`), `lib/transports.ts` (registry),
`RoomPage.tsx` (rota), `vercel.json` (rewrite `/api/relay`), `package.json` (`ws`).

## 2. Arquitetura

```
Streamer:  getDisplayMedia → VideoEncoder(VP9/H264) → EncodedVideoChunk
              → protocolo binário → WebSocket → api/relay.ts (RelayRoom)
Relay:     recebe · valida · repassa  (nunca decodifica/grava/transcodifica)
Viewer:    WebSocket → chunk → VideoDecoder → VideoFrame → <canvas>
```

Controle (init, keyframe-request, viewers, end, congestion) viaja como **frame de
texto JSON**; vídeo, como **frame binário** — os dois no mesmo WebSocket, sem JSON
por quadro.

## 3. Seleção dos 4 transportes

Tudo lê de um **registry** (`lib/transports.ts`): `{ id, label, Icon, tagline,
pros, cons }`. O `TransportPicker` desenha 4 ícones discretos com tooltip de
prós/contras. Um 5º transporte é **uma linha** nessa lista — a UI não muda.

## 4. Troca dentro da sala (sem sair)

O `RoomPage` guarda o transporte em **estado**. Cada sala recebe
`onChangeTransport`; o switcher compacto o chama, o `RoomPage` remonta a sala no
novo modo **no mesmo `roomId`/URL** (a conexão antiga cai na limpeza, a nova
sobe). Nada de navegação nem recarregar.

## 5. Config abstraída

`ScreenStreamTransport` isola o transporte da UI. A resolução alvo (HD/FHD/QHD/UHD)
vem de `lib/cfsfuQuality.ts`, compartilhada com o Cloudflare. As faixas de bitrate
e a captura são as mesmas independentemente da sala.

## 6. Implementação do relay

`RelayRoom` (puro, testado): um streamer, N viewers, **backpressure por
`bufferedAmount`** — viewer lento perde deltas (e pede keyframe), keyframe tem
prioridade, ninguém derruba os outros. `RelayRegistry` cria/descarta salas
efêmeras. `api/relay.ts` só liga o socket `ws` a essa lógica.

## 7. Limitações reais da Vercel

| | |
|---|---|
| **LIMITAÇÃO** | Um WebSocket é pinado a **uma instância**; a Vercel **não garante** que streamer e viewers caiam na mesma. A conexão **cai no teto de duração** da function (`vercel.json` fixa 30 s). Estado entre instâncias pediria **Redis** (proibido para vídeo aqui). |
| **IMPACTO** | Relay confiável só quando todos caem na mesma instância — comum em app de baixo tráfego com uma instância quente, **não garantido**. A cada ~30 s a conexão reabre. Não é SFU ilimitado. |
| **WORKAROUND** | `ScreenStreamTransport` desacoplado: reconnect + `SequenceTracker` (o viewer pede keyframe ao reconectar) escondem a queda; e a mesma interface troca por mediasoup depois (§13). |

Exige **Fluid Compute** ligado (padrão em projetos novos). Fonte:
[Vercel Docs — WebSockets](https://vercel.com/docs/functions/websockets).

## 8. Rodar localmente

O front roda em `pnpm dev`. **A função WebSocket da Vercel NÃO roda no Vite** —
o relay só existe no deploy (ou via `vercel dev`). Localmente, escolha outro
transporte; o Vercel Relay se testa no ambiente publicado.

## 9. Deploy

`git push` na `main` dispara o workflow, que publica na Vercel. A função
`api/relay.ts` sobe junto (rewrite `/api/relay` já configurado). Confira em
Project → Settings que **Fluid Compute** está ligado.

## 10. Variáveis de ambiente

**Nenhuma.** O relay não tem segredo — é a razão de existir (R$0). A validação
de entrada é por presença na sala + papel, como o resto do modo direto.

## 11. Testar com dois navegadores

1. Deploy verde. Abra a **mesma sala** em dois navegadores Chrome/Edge.
2. Em um, escolha **Vercel Relay** → **Compartilhar tela** (1080p).
3. No outro, entre no mesmo modo/sala: o canvas deve mostrar a tela.
4. Ligue **Debug** para ver codec, resolução, fps, bitrate, chunks, keyframes,
   descartados. No `chrome://webrtc-internals` não há nada (não é WebRTC) — as
   métricas do WebCodecs estão no painel de debug.
5. Feche e reabra o viewer: deve recuperar via keyframe. Pare e recompartilhe.

## 12. Métricas

Streamer: codec, W×H, fps, bitrate, chunks/bytes enviados, fila do encoder,
keyframes. Viewer: W×H, fps decodificado, quadros, chunks descartados, keyframes.
Ambas no painel **Debug** da sala.

## 13. Próximo passo: mediasoup como 5º transporte

`ScreenStreamTransport` já isola o transporte. Um `MediasoupTransport` implementa
os mesmos `publishChunk`/`onChunk`/`requestKeyframe` (ou passa a mídia por
WebRTC), entra como `'mediasoup'` no `TransportMode` + uma linha no registry, e
nem a UI nem as salas mudam. O relay em memória sai; o resto fica.
