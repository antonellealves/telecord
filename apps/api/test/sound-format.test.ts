/**
 * O farejador de formato do arquivo enviado.
 *
 * A regra que estes testes guardam: o tipo da RESPOSTA sai dos bytes, nunca do
 * `Content-Type` que quem enviou declarou. Se este arquivo passar a aceitar
 * qualquer coisa, a origem passa a servir o que o remetente escolher — e uma
 * origem que serve HTML de terceiro é uma origem comprometida.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extensionFor, sniffAudioMime } from '../src/sounds/sound-format';

/** Cabeçalho seguido de enchimento, para passar do tamanho mínimo. */
function file(head: number[] | string, padding = 32): Buffer {
  const bytes = typeof head === 'string' ? Buffer.from(head, 'ascii') : Buffer.from(head);
  return Buffer.concat([bytes, Buffer.alloc(padding)]);
}

describe('reconhecimento de áudio pelos bytes', () => {
  it('reconhece os formatos que o soundboard aceita', () => {
    assert.equal(sniffAudioMime(file('ID3\x03\x00\x00\x00')), 'audio/mpeg');
    assert.equal(sniffAudioMime(file('OggS')), 'audio/ogg');
    assert.equal(sniffAudioMime(file('fLaC')), 'audio/flac');
    assert.equal(sniffAudioMime(file([0x1a, 0x45, 0xdf, 0xa3])), 'audio/webm');
  });

  it('reconhece WAV só com o marcador WAVE no lugar certo', () => {
    // `RIFF` sozinho é contêiner genérico: AVI e WebP começam igual.
    const wave = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(16),
    ]);
    assert.equal(sniffAudioMime(wave), 'audio/wav');

    const avi = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('AVI ', 'ascii'),
      Buffer.alloc(16),
    ]);
    assert.equal(sniffAudioMime(avi), null);
  });

  it('reconhece MP4/M4A pela caixa ftyp no byte 4', () => {
    const m4a = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ', 'ascii'), Buffer.alloc(16)]);
    assert.equal(sniffAudioMime(m4a), 'audio/mp4');
  });

  it('separa MP3 sem tag de AAC solto pelo campo de camada', () => {
    /*
     * Os dois começam com o mesmo sincronismo de quadro (11 bits em 1). O que
     * os distingue é o campo de camada: 01 é camada III (MP3), 00 não é camada
     * válida de MPEG-1 e marca o ADTS do AAC. Confundir os dois faz o arquivo
     * ser servido com o tipo errado, e nenhum navegador toca.
     */
    assert.equal(sniffAudioMime(file([0xff, 0xfb])), 'audio/mpeg', 'MPEG-1 camada III');
    assert.equal(sniffAudioMime(file([0xff, 0xf1])), 'audio/aac', 'ADTS MPEG-4');
    assert.equal(sniffAudioMime(file([0xff, 0xf9])), 'audio/aac', 'ADTS MPEG-2');
  });

  it('recusa o que não é áudio reconhecido', () => {
    assert.equal(sniffAudioMime(file('<!DOCTYPE html><html>')), null, 'HTML');
    assert.equal(sniffAudioMime(file('MZ\x90\x00')), null, 'executável do Windows');
    assert.equal(sniffAudioMime(file('%PDF-1.7')), null, 'PDF');
    assert.equal(sniffAudioMime(file([0x89, 0x50, 0x4e, 0x47])), null, 'PNG');
    assert.equal(sniffAudioMime(file('#!/bin/sh\necho oi')), null, 'script');
  });

  it('recusa arquivo curto demais para ter assinatura', () => {
    // Sem isto, `subarray` devolveria vazio e alguma comparação passaria por
    // acidente num arquivo de três bytes.
    assert.equal(sniffAudioMime(Buffer.alloc(0)), null);
    assert.equal(sniffAudioMime(Buffer.from('ID3')), null);
  });

  it('dá uma extensão a cada formato aceito', () => {
    assert.equal(extensionFor('audio/mpeg'), 'mp3');
    assert.equal(extensionFor('audio/mp4'), 'm4a');
    assert.equal(extensionFor('audio/ogg'), 'ogg');
  });
});
