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
 * Opus no formato do Discord, espelhando `apps/web/src/lib/voice/
 * voiceProfile.ts`: mesma meta dos dois lados do transporte.
 */
export const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    // `channels` no RTP do Opus é sempre 2 por definição do RFC 7587 (é o
    // número de canais do STREAM Opus, não da captura) — a voz é mono por
    // não ter `stereo=1` no fmtp, como no Discord, então baixar isto para 1
    // aqui só faz o `canProduce('audio')` do Device falhar em navegadores que
    // seguem o RFC à risca (o codec deixa de "casar" com o suportado pelo
    // Router).
    channels: 2,
    // 111, o número que o Chrome dá ao Opus e que o Discord usa nos dois
    // sentidos. Sem isto o Router numera a partir de 100, e quem RECEBE via
    // o Opus como 100 no webrtc-internals.
    preferredPayloadType: 111,
    /*
     * O mínimo, de propósito: estes `parameters` são o PONTO DE PARTIDA da
     * resposta que o mediasoup-client monta para cada producer de áudio, e o
     * que cada tipo de track quer por cima disto vem dos `codecOptions` do
     * cliente (`apps/web/src/hooks/mediasoup/audioProfile.ts`):
     *
     * - voz: `minptime=10;useinbandfec=1;usedtx=1`, mono, quadro de 20 ms —
     *   o que o Discord usa;
     * - áudio da tela: estéreo e teto alto, sem DTX.
     *
     * Antes estavam aqui `stereo=1`, `ptime=10`, `maxaveragebitrate=510000` e
     * companhia, e todos vazavam para a voz: estéreo de mentira (o dobro de
     * bits para o mesmo som mono) e pacote de 10 ms.
     */
    parameters: {
      minptime: 10,
      // Resiliência a perda de pacote embutida no próprio codec (RFC 6716
      // §2.1.7) — repõe quadro perdido sem retransmissão.
      useinbandfec: 1,
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
