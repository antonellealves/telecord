/**
 * Perfil de captura e publicação de voz em ALTA FIDELIDADE.
 *
 * A meta aqui não é "boa o suficiente para reunião" — é o melhor que o
 * navegador e o Opus conseguem entregar, aceitando gastar banda e CPU para
 * isso. O preset de videoconferência (o que se ganha sem configurar nada)
 * mira o oposto: ~32 kbps mono, banda cortada em ~16 kHz, processamento de
 * voz agressivo. É isso que faz chamada comum soar "de telefone".
 *
 * As três camadas precisam concordar, senão a mais restritiva vence:
 * 1. CAPTURA (`MIC_CONSTRAINTS`, aqui) — o que o navegador entrega do
 *    microfone antes de qualquer codificação.
 * 2. CODEC (`MEDIA_CODECS` em `apps/mediasoup-sfu/src/rooms.ts`) — os fmtp
 *    do Opus negociados com o SFU (`maxaveragebitrate`, `maxplaybackrate`…).
 * 3. ENVIO (`MIC_SEND_ENCODING`, aqui) — o teto real aplicado ao
 *    `RTCRtpSender`, que é quem manda no bitrate de verdade.
 */

/**
 * Bitrate alvo do microfone, em bits por segundo.
 *
 * 256 kbps para VOZ é exagero deliberado: o Opus é transparente para fala
 * bem antes disso. O ponto é nunca deixar o encoder apertar — com teto
 * folgado ele gasta o que precisa nos transientes (ataque de consoante,
 * sibilância) em vez de borrar para caber num orçamento apertado. O custo é
 * por pessoa FALANDO, não por pessoa na sala.
 */
export const MIC_TARGET_BITRATE = 256_000;

/**
 * Constraints de captura do microfone.
 *
 * ## Por que o processamento de voz fica DESLIGADO
 *
 * `echoCancellation`, `noiseSuppression` e `autoGainControl` são o trio que
 * torna voz inteligível em notebook no viva-voz — e são também o que mais
 * destrói fidelidade:
 *
 * - **AEC** aplica filtro adaptativo no sinal inteiro e derruba a banda alta
 *   junto com o eco; em fone de ouvido (onde não existe eco acústico) ele só
 *   tira qualidade.
 * - **NS** é um gate espectral: ele decide o que é "ruído" e apaga, levando
 *   junto respiração, reverb natural da sala e cauda de consoante — o que
 *   dá naturalidade à voz.
 * - **AGC** comprime a dinâmica para um nível alvo, achatando a diferença
 *   entre falar baixo e falar alto, e costuma bombear ruído de fundo nas
 *   pausas.
 *
 * Desligados, o que chega ao Opus é o sinal do microfone como ele é. Em
 * troca, quem usa alto-falante aberto pode gerar eco — a escolha aqui é
 * assumir fone de ouvido, que é o cenário de quem quer qualidade.
 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  // Mono: voz de uma pessoa não tem imagem estéreo para preservar, e o
  // segundo canal só dobraria o bitrate sem ganho audível.
  channelCount: 1,
  // Taxa de amostragem de banda completa. `ideal` (e não `exact`) porque
  // placa que só entrega 44.1 kHz deve degradar, não falhar a captura.
  sampleRate: { ideal: 48_000 },
  sampleSize: { ideal: 24 },
  // Desliga o processamento de voz do Chrome que não tem constraint própria
  // (supressão de ruído por nuvem, "voice isolation" etc.). Não é padrão do
  // W3C; navegador que não conhece simplesmente ignora.
  ...({ googAudioMirroring: false } as Record<string, unknown>),
};

/**
 * Encoding do `RTCRtpSender` do microfone.
 *
 * É ESTE valor que manda no bitrate real. Os fmtp do Opus (`maxaveragebitrate`
 * no codec do Router) só dizem ao encoder o que ele PODE fazer; sem um teto
 * explícito aqui, o Chrome continua aplicando o preset conservador dele
 * (~32 kbps) por mais folga que o codec anuncie. O mesmo vale do lado do
 * LiveKit, onde `audioPreset` cumpre este papel.
 *
 * `dtx: false` reforça no sender o que o codec já pede: nada de cortar o
 * envio em trecho "silencioso".
 */
export const MIC_SEND_ENCODING: RTCRtpEncodingParameters = {
  maxBitrate: MIC_TARGET_BITRATE,
  priority: 'high',
  networkPriority: 'high',
  ...({ dtx: 'disabled' } as Record<string, unknown>),
};

/**
 * Opções de codec passadas ao `transport.produce()` do mediasoup-client.
 *
 * `opusMaxAverageBitrate` é o que o mediasoup-client reescreve no SDP local
 * antes de publicar — o caminho suportado para elevar o teto do Opus sem
 * mexer no SDP na mão.
 */
export const MIC_CODEC_OPTIONS = {
  opusStereo: false,
  opusFec: true,
  opusDtx: false,
  opusMaxPlaybackRate: 48_000,
  opusMaxAverageBitrate: MIC_TARGET_BITRATE,
  opusPtime: 10,
  // Retransmissão de pacote de áudio perdido. Áudio normalmente não usa NACK
  // (chegar tarde é pior que não chegar), mas com pacotes de 10 ms e RTT
  // baixo a retransmissão cabe no jitter buffer — e aí uma perda que o FEC
  // não cobriu vira áudio íntegro em vez de um "tec" no meio da palavra.
  opusNack: true,
} as const;

/**
 * Áudio da TELA compartilhada (música, vídeo, jogo) — não é voz.
 *
 * Aqui o estéreo importa de verdade (é conteúdo mixado, com imagem estéreo
 * real) e o material é muito mais exigente que fala: 320 kbps é o patamar em
 * que o Opus fica transparente para música. Vale o dobro do bitrate da voz
 * justamente porque é o caso em que se ouve a diferença.
 */
export const SCREEN_AUDIO_TARGET_BITRATE = 320_000;

export const SCREEN_AUDIO_CODEC_OPTIONS = {
  opusStereo: true,
  opusFec: true,
  opusDtx: false,
  opusMaxPlaybackRate: 48_000,
  opusMaxAverageBitrate: SCREEN_AUDIO_TARGET_BITRATE,
  // 20 ms aqui, e não 10: música não precisa da latência mínima da conversa,
  // e o pacote maior rende melhor eficiência de codificação.
  opusPtime: 20,
  opusNack: true,
} as const;

export const SCREEN_AUDIO_SEND_ENCODING: RTCRtpEncodingParameters = {
  maxBitrate: SCREEN_AUDIO_TARGET_BITRATE,
  priority: 'high',
  networkPriority: 'high',
  ...({ dtx: 'disabled' } as Record<string, unknown>),
};
