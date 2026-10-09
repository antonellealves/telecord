import type * as mediasoup from 'mediasoup';

/**
 * Os codecs que todo `Router` deste nó negocia.
 *
 * Fica num arquivo só dele porque é a MESMA lista para qualquer sala, em
 * qualquer Worker: é isso que deixa as RTP capabilities serem calculadas uma
 * vez no boot (ver `RoomRegistry.create`) em vez de exigir um Router vivo por
 * sala só para responder a quem ainda nem entrou, e é o que deixa uma track
 * atravessar de um Worker para outro sem renegociar nada.
 *
 * Opus sem DTX e com FEC, espelhando `apps/web/src/hooks/mediasoup/
 * audioProfile.ts`: mesma meta de qualidade dos dois lados do transporte.
 */
export const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    // `channels` no RTP do Opus é sempre 2 por definição do RFC 7587 (é o
    // número de canais do STREAM Opus, não da captura) — o cliente publica
    // mono via `sprop-stereo=0`/`stereo=0` nos fmtp, então baixar isto para 1
    // aqui só faz o `canProduce('audio')` do Device falhar em navegadores que
    // seguem o RFC à risca (o codec deixa de "casar" com o suportado pelo
    // Router).
    channels: 2,
    /*
     * Perfil de voz de ALTA FIDELIDADE, bem acima do padrão de
     * videoconferência.
     *
     * Sem estes fmtp o Chrome negocia o preset dele: ~32 kbps mono, banda
     * cortada em ~16 kHz. É o que faz voz soar "de telefone" em qualquer
     * chamada comum. Cada parâmetro abaixo empurra o Opus para o extremo
     * oposto — o custo é banda de subida por pessoa FALANDO (não por pessoa
     * na sala), que numa conversa real fica na casa de algumas centenas de
     * kbps no total.
     */
    parameters: {
      // Resiliência a perda de pacote embutida no próprio codec (RFC 6716
      // §2.1.7) — repõe quadro perdido sem retransmissão, essencial numa
      // faixa de bitrate alta onde cada perda custa mais.
      useinbandfec: 1,
      // SEM `usedtx`: DTX corta o envio nos trechos que o encoder considera
      // silêncio, e essa detecção é agressiva o bastante para comer o início
      // de fala. Para "melhor som possível" isso é o avesso do que se quer —
      // o ganho seria economizar banda de quem está calado, e não é esse o
      // objetivo aqui.
      //
      // 510 kbps é o TETO ABSOLUTO do Opus (RFC 7587 §7.1, `maxaveragebitrate`).
      // Na prática o encoder só chega perto disso em música/estéreo; para voz
      // ele se acomoda bem abaixo, mas sem este teto alto ele NUNCA passa do
      // preset conservador do navegador, por mais banda que sobre.
      maxaveragebitrate: 510000,
      // Áudio de banda completa (48 kHz, todo o espectro audível). Sem isto o
      // Chrome entrega `wideband` (16 kHz) e tudo acima de 8 kHz — o "ar" da
      // voz, sibilância, presença — simplesmente não existe do outro lado.
      maxplaybackrate: 48000,
      'sprop-maxcapturerate': 48000,
      // Estéreo habilitado na negociação. A captura de voz continua mono (ver
      // `useMediasoupTalkControls`), mas deixar isto ligado evita que o
      // caminho estéreo seja descartado na negociação — e é o que permite o
      // soundboard/áudio de tela chegarem em estéreo de verdade.
      stereo: 1,
      'sprop-stereo': 1,
      // Pacotes de 10 ms em vez dos 20 ms padrão: metade da latência de
      // empacotamento e menos áudio perdido por pacote descartado. Custa mais
      // overhead de cabeçalho RTP, que a esta altura de bitrate é ruído.
      ptime: 10,
      minptime: 10,
      // Sem limite de complexidade: o encoder usa o algoritmo mais caro (e
      // mais fiel) que a CPU permitir, em vez de economizar ciclos.
      complexity: 10,
    },
  },
  /*
   * ORDEM IMPORTA: o `Device` do navegador escolhe o primeiro codec da lista
   * que ele sabe codificar. Do melhor para o mais compatível.
   *
   * O telecord não grava nada — só retransmite — então não há custo de
   * armazenamento para justificar compressão agressiva. O único orçamento
   * real é CPU de quem publica e banda; ambos são gastos de propósito aqui.
   */
  {
    /*
     * AV1: ~30% mais eficiente que VP9 no mesmo bitrate, e a diferença
     * aparece justamente onde tela compartilhada sofre — borda de letra,
     * linha fina de interface, gradiente. Chrome/Edge recentes codificam em
     * software; quem não suportar cai no VP9 logo abaixo, sem quebrar nada.
     */
    kind: 'video',
    mimeType: 'video/AV1',
    clockRate: 90000,
    parameters: {
      // Perfil 0 (8-bit 4:2:0) — o universalmente suportado.
      'profile': 0,
      // Nível alto o bastante para 4K60 sem o encoder se auto-limitar.
      'level-idx': 8,
      'tier': 0,
    },
  },
  {
    /*
     * VP9 perfil 0 (8-bit 4:2:0).
     *
     * O `profile-id: 2` que estava aqui antes é 10-BIT: quase nenhum
     * navegador CODIFICA nesse perfil, então na prática ele nunca era
     * escolhido e tudo caía para VP8 — jogando fora o ganho de qualidade do
     * VP9 justamente em texto, que é o conteúdo mais caro de codificar.
     */
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 0 },
  },
  {
    /*
     * H.264 High profile, com aceleração de hardware na maioria das
     * máquinas — é o que salva notebook fraco publicando 1080p60, onde
     * VP9/AV1 em software derrubariam o frame rate.
     *
     * `packetization-mode: 1` e `level-asymmetry-allowed: 1` são exigidos
     * pelo WebRTC; `profile-level-id: 640032` é High 5.0 (até 4K).
     */
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '640032',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    // Último recurso: VP8 funciona em absolutamente tudo.
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];
