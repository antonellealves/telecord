import { describe, expect, it } from 'vitest';
import { SCREEN_QUALITY_OPTIONS, roomOptions, screenSharePublishOptions } from './media';
import { chooseScreenCodec, screenCodec } from './screenCodec';

describe('chooseScreenCodec', () => {
  it('AV1 quando o navegador envia e dá conta do tamanho', () => {
    expect(chooseScreenCodec({ av1Listed: true, av1Smooth: true })).toBe('av1');
  });

  it('VP9 quando o AV1 engasgaria neste aparelho', () => {
    expect(chooseScreenCodec({ av1Listed: true, av1Smooth: false })).toBe('vp9');
  });

  it('VP9 quando o navegador não envia AV1, diga o que disser a consulta', () => {
    expect(chooseScreenCodec({ av1Listed: false, av1Smooth: true })).toBe('vp9');
  });

  it('antes de detectar, vale o comportamento antigo', () => {
    expect(screenCodec()).toBe('vp9');
  });

  it('resolução nativa fica em VP9', () => {
    expect(screenCodec(true)).toBe('vp9');
  });
});

describe('codec nas opções de publicação da tela', () => {
  it('leva o codec escolhido, em todo nível de qualidade', () => {
    for (const quality of SCREEN_QUALITY_OPTIONS) {
      expect(screenSharePublishOptions(quality.id, 'av1').videoCodec).toBe('av1');
      expect(screenSharePublishOptions(quality.id, 'vp9').videoCodec).toBe('vp9');
    }
  });

  it('sem codec informado, é VP9', () => {
    expect(screenSharePublishOptions().videoCodec).toBe('vp9');
  });

  it('a reserva para quem não decodifica o codec principal continua sendo VP8', () => {
    expect(roomOptions.publishDefaults?.backupCodec).toEqual({ codec: 'vp8' });
  });

  it('a câmera continua em VP9: o AV1 só foi medido para tela', () => {
    expect(roomOptions.publishDefaults?.videoCodec).toBe('vp9');
  });
});
