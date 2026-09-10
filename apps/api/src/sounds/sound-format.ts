import type { SoundMimeType } from '@telecord/shared';

/**
 * Que formato de áudio é este arquivo — decidido pelos BYTES, nunca pelo que o
 * cliente disse que mandou.
 *
 * O `Content-Type` da requisição é texto livre escolhido por quem envia, e o
 * arquivo é servido de volta para o navegador de todo mundo na sala. Se o tipo
 * da resposta viesse do pedido, bastaria mandar HTML dizendo `audio/mpeg` para
 * escolher o que o navegador executa ao abrir a URL — e uma origem que serve
 * HTML de terceiro é uma origem comprometida. Aqui o tipo da resposta sai
 * daqui, e nada que não seja reconhecido chega a ser guardado.
 *
 * Está isolada como função pura porque é a única peça da rota de envio que dá
 * para exercitar por inteiro sem banco, sem rede e sem arquivo: cada formato
 * vira um teste de duas linhas.
 *
 * Limite conhecido: `audio/webm` e `audio/mp4` são contêineres, e um arquivo de
 * VÍDEO nesses formatos passa por aqui. Não é furo de segurança — continua
 * sendo mídia inerte, servida com o tipo certo e com `nosniff` — e o teto de
 * 2 MiB torna o abuso pouco interessante. Distinguir exigiria abrir o
 * contêiner, e o servidor não decodifica mídia.
 */
export function sniffAudioMime(bytes: Buffer): SoundMimeType | null {
  if (bytes.length < 12) return null;

  // Cada teste é sobre uma assinatura documentada, na ordem em que elas não se
  // confundem entre si.
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'audio/wav';
  }
  // EBML — contêiner do WebM e do Matroska.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  // ISO base media (MP4/M4A): a caixa `ftyp` começa no byte 4.
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';

  // MP3 com tag ID3 na frente é o caso mais comum de todos.
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';

  /*
   * Sincronismo de quadro: 11 bits em 1. Cobre o MP3 sem tag e o AAC solto, e
   * os dois compartilham o mesmo início — o que separa é o campo de camada.
   * No ADTS do AAC ele é 00, que não é camada válida de MPEG-1; no MP3 é 01
   * (camada III). Testar o AAC primeiro seria o mesmo, desde que se teste o
   * campo — o que não dá é aceitar `0xFF 0xE0` como MP3 e pronto, porque aí
   * todo AAC entraria rotulado errado e nenhum navegador tocaria.
   */
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    const layer = ((bytes[1] ?? 0) >> 1) & 0x03;
    if (layer === 0) return 'audio/aac';
    if (layer === 1) return 'audio/mpeg';
    // Camadas I e II existem, e nenhuma delas é o que um soundboard usa.
    return null;
  }

  return null;
}

/** Extensão canônica de cada tipo, para o nome sugerido no download. */
export function extensionFor(mime: SoundMimeType): string {
  switch (mime) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    case 'audio/webm':
      return 'webm';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/flac':
      return 'flac';
    case 'audio/aac':
      return 'aac';
  }
}
