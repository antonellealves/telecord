# Voz no formato do Discord

O pipeline de áudio de voz do telecord replica a configuração que o Discord usa, lida de um dump do
`chrome://webrtc-internals` dele (Chrome 155, Windows). Este documento diz o que foi copiado, onde mora
em cada transporte, o que ficou diferente e por quê, e como conferir no navegador.

## Como o áudio é feito

Os dois transportes são **SFU** — não há mesh P2P em lugar nenhum.

| | LiveKit (padrão) | mediasoup (servidor próprio) |
|---|---|---|
| Biblioteca no navegador | `livekit-client` 2.22 + `@livekit/components-react` | `mediasoup-client` 3.23 |
| Servidor | LiveKit Cloud (ou `livekit/` self-host) | `apps/mediasoup-sfu` |
| PeerConnections por pessoa | **uma** (`singlePeerConnection`, padrão do SDK): microfone `sendonly` + um `recvonly` por voz remota — o desenho do Discord | **duas**: um transporte de envio e um de recepção (é como o mediasoup-client funciona) |
| `getUserMedia` | o SDK, a partir de `roomOptions.audioCaptureDefaults` (`lib/media.ts`) | `captureMicrophone` em `hooks/mediasoup/useMediasoupTalkControls.ts` |
| Oferta/resposta | o SDK; o telecord entra pelo evento `LocalSenderCreated` (`hooks/useLiveKitVoicePipeline.ts`) | o mediasoup-client; o telecord embrulha o handler (`hooks/mediasoup/voiceDevice.ts`) |
| `setParameters` (teto) | `useLiveKitVoicePipeline` | `MediasoupConnection.setVoiceBitrate` |
| Sinalização | WebSocket do LiveKit | `/signal` (stream) e `/presence` (Socket.IO) direto no nó |

Ter duas PeerConnections no mediasoup não muda codec, bitrate nem latência: muda só que o envio e a
recepção negociam separado. Juntar as duas exigiria trocar o mediasoup-client por código próprio de
SDP; não vale o risco pelo ganho.

## O que foi copiado

| Item | Discord | telecord |
|---|---|---|
| Captura | `deviceId: { exact }`, `echoCancellation`/`autoGainControl`/`noiseSuppression` como `ideal`, sem `sampleRate`/`channelCount` | igual — `voiceCaptureConstraints` em `lib/voice/voiceProfile.ts` |
| Aparelho | id exato, nunca `default` | igual; "Padrão do sistema" é resolvido para o aparelho por trás de `default` a cada captura e a cada `devicechange` (`lib/voice/inputDevice.ts`) |
| Troca de aparelho / filtro | `replaceTrack`, sem renegociar | igual nos dois transportes |
| Codec | só Opus, PT 111, mono | igual; `setCodecPreferences` deixa só o Opus na seção do microfone |
| `fmtp` de envio | `minptime=10;useinbandfec=1;usedtx=1` | mediasoup: idêntico. LiveKit: o mesmo mais `maxaveragebitrate=<teto>` (ver abaixo) |
| `fmtp` de recepção | `minptime=10;useinbandfec=1` | mediasoup: idêntico. LiveKit: mais `stereo=1` (o SDK acrescenta) |
| `ptime` | 20 ms | 20 ms (o `ptime=10` antigo saiu do SFU e do cliente) |
| RTCP-FB | `nack`, `transport-cc` | mediasoup: os dois, nos dois sentidos. LiveKit: decide o servidor |
| Bitrate | 64 kbps no sender | 64 kbps padrão; 96 ou 128 por sala, em Configurações → Áudio |
| DTX | ~1,6 kbps calado | medido 1,2 kbps (LiveKit) e 0,1 kbps (mediasoup, silêncio digital) |
| Jitter buffer | NetEq padrão | padrão — `jitterBufferTarget` só é mexido na tela compartilhada |
| Volume por pessoa | 0–200 % e mudo local | já existia nos dois transportes (WebAudio) |
| E2EE por quadro | DAVE | gancho pronto, sem criptografia, atrás de flag |

### Diferenças que ficaram no LiveKit, e por quê

- **`maxaveragebitrate=<teto>` no fmtp de envio.** O servidor do LiveKit não negocia transport-cc no
  áudio, então o Chrome não põe o áudio no controle de banda e o encoder fica no bitrate do fmtp — sem
  `maxaveragebitrate`, cairia para 32 kbps. O telecord troca o `510000` que o servidor manda pelo teto
  da sala (o mesmo munging que o SDK já faz para o Firefox). O `targetBitrate` fica igual ao do Discord.
- **Sem `nack` nem `transport-cc` no áudio.** Quem escreve a resposta é o servidor do LiveKit; o
  cliente não consegue ligar isso sozinho.
- **`stereo=1` na recepção.** O SDK acrescenta em toda seção de áudio que recebe, para o áudio da tela
  chegar em estéreo. Só diz "posso decodificar estéreo"; não muda a voz.
- **`voiceActivityDetection` na oferta.** O SDK não deixa passar opções ao `createOffer`. O Chrome
  atual ignora essa opção de qualquer jeito; o silêncio é cortado pelo DTX.

## Painel de debug

`Ctrl+Shift+D` em qualquer sala abre o painel (`components/VoiceDebugPanel.tsx`). Ele lê `getStats()`
de cada sender e receiver de voz a cada segundo e mostra codec com `sdpFmtpLine`, `targetBitrate`,
bytes/s, `packetsLost`, `fractionLost`, `jitter`, `roundTripTime`, `fecPacketsReceived`, `nackCount`,
`concealedSamples − silentConcealedSamples`, `jitterBufferDelay/jitterBufferEmittedCount` e o
`audioLevel` da fonte. Para o microfone, separa o bitrate calado do bitrate falando e diz se o DTX
está agindo.

## Gancho de E2EE

Desligado por padrão. Para ligar, no console do navegador:

```js
localStorage['telecord.voiceE2eeHook'] = 'on'
```

ou `VITE_VOICE_E2EE_HOOK=1` no build. Com ele ligado, cada sender e receiver de voz ganha um
`RTCRtpScriptTransform` que passa os quadros por `lib/voice/voiceFrameWorker.ts`. A criptografia vai
em `transformFrame`, que hoje devolve o quadro intacto.

## Checklist no `chrome://webrtc-internals` do telecord

Abra `chrome://webrtc-internals` em outra aba **antes** de entrar na sala, ligue o microfone e fale.

1. **Quantas PeerConnections.** LiveKit: uma, para `wss://…livekit.cloud`. mediasoup: duas (envio e
   recepção).
2. **Configuração.** Na linha da PeerConnection: `bundlePolicy: max-bundle`, `rtcpMuxPolicy: require`.
3. **Captura.** Em `getUserMedia` (topo da página): `deviceId: {exact: "<id longo>"}` — não `default` —,
   `echoCancellation`, `autoGainControl` e `noiseSuppression` com `ideal`, sem `sampleRate` nem
   `channelCount`. No LiveKit o SDK escreve os três como booleanos soltos (`true`), que para o
   `getUserMedia` valem o mesmo que `ideal`.
4. **Codec de envio.** Em `outbound-rtp (kind=audio)`, campo `codecId` → o codec deve aparecer como
   - mediasoup: `opus (111, minptime=10;usedtx=1;useinbandfec=1)` — igual ao Discord;
   - LiveKit: `opus (111, maxaveragebitrate=64000;minptime=10;usedtx=1;useinbandfec=1)`.
5. **Só Opus na seção.** Em `createOffer`/`setLocalDescription`, a linha `m=audio` do microfone
   (`a=sendonly`) só tem `111`. Nada de `63` (red), `9`, `0`, `8`, `13`, `110`, `126`.
6. **Alvo.** `targetBitrate = 64000` (ou o teto escolhido na sala).
7. **Falando.** Gráfico `[bytesSent_in_bits/s]` perto de 64 000.
8. **Calado.** Fique em silêncio uns 10 s: o mesmo gráfico cai para ~1–2 kbps. Se ficar perto de
   64 000, o DTX não está agindo — o painel `Ctrl+Shift+D` também acusa.
9. **Recepção.** Em `inbound-rtp (kind=audio)` de outra pessoa: codec
   `opus (111, minptime=10;useinbandfec=1)` (no LiveKit, com `stereo=1`); `packetsLost` parado; perto
   de 0 % em `concealedSamples − silentConcealedSamples` sobre `totalSamplesReceived`;
   `jitterBufferDelay/jitterBufferEmittedCount` na casa de 20–60 ms.
10. **Header extensions.** Na seção do microfone: `ssrc-audio-level` sempre; `transport-wide-cc` no
    mediasoup (no LiveKit, depende do servidor).
11. **Comparar com o Discord, na mesma rede:** RTT ~15 ms, 0 % de perda, menos de 1 % de concealment
    que não é silêncio, ~64 kbps falando, ~1,6 kbps calado.

### O que foi medido aqui

Chrome sem interface, servidor local, mesma máquina (RTT ~1 ms):

| | mediasoup | LiveKit 1.13.10 |
|---|---|---|
| codec de envio | `opus (111, minptime=10;usedtx=1;useinbandfec=1)` | `opus (111, maxaveragebitrate=64000;minptime=10;usedtx=1;useinbandfec=1)` |
| codec de recepção | `opus (111, minptime=10;useinbandfec=1)` | `opus (111, minptime=10;stereo=1;useinbandfec=1)` |
| `targetBitrate` | 64 000 | 64 000 |
| falando | ~64 kbps | ~64 kbps |
| calado | ~0,1 kbps | ~1,2 kbps |
| teto 128 kbps aplicado no ar | sim, `targetBitrate` 128 000 | sim, `targetBitrate` 128 000 |
| troca de microfone no ar | mesmo producer, sem corte | mesmo sender e mesma publicação |
| concealment | 0 % | 0 % (um pico de 0,7 % ao renegociar o teto) |
| jitter buffer | ~35 ms | ~30 ms |
