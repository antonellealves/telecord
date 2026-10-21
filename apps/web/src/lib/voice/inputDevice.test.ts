import { describe, expect, it } from 'vitest';
import { opusOnlyCodecs } from './codecPreferences';
import { resolveInputDevice, selectedInputOption, type InputDeviceInfo } from './inputDevice';

/** O que o Chrome do Windows lista com um headset USB como padrão. */
const WINDOWS: InputDeviceInfo[] = [
  { kind: 'audioinput', deviceId: 'default', groupId: 'g-headset', label: 'Padrão - Microfone (HyperX Cloud II)' },
  { kind: 'audioinput', deviceId: 'communications', groupId: 'g-webcam', label: 'Comunicação - Microfone (C920)' },
  { kind: 'audioinput', deviceId: 'id-webcam', groupId: 'g-webcam', label: 'Microfone (C920)' },
  { kind: 'audioinput', deviceId: 'id-headset', groupId: 'g-headset', label: 'Microfone (HyperX Cloud II)' },
  { kind: 'audiooutput', deviceId: 'id-out', groupId: 'g-headset', label: 'Fone (HyperX Cloud II)' },
];

describe('resolveInputDevice', () => {
  it('a escolha da pessoa vence, se estiver plugada', () => {
    expect(resolveInputDevice(WINDOWS, 'id-webcam')).toBe('id-webcam');
  });

  it('"Padrão do sistema" vira o id concreto do aparelho por trás de default', () => {
    expect(resolveInputDevice(WINDOWS, 'default')).toBe('id-headset');
    expect(resolveInputDevice(WINDOWS, '')).toBe('id-headset');
  });

  it('nunca devolve uma entrada virtual', () => {
    expect(resolveInputDevice(WINDOWS, 'communications')).toBe('id-headset');
  });

  it('escolha desplugada cai no padrão do sistema', () => {
    expect(resolveInputDevice(WINDOWS, 'id-que-saiu')).toBe('id-headset');
  });

  it('desempata pelo rótulo quando dois aparelhos dividem o groupId', () => {
    const shared = WINDOWS.map((device) => ({ ...device, groupId: 'g-mesmo' }));
    expect(resolveInputDevice(shared, '')).toBe('id-headset');
  });

  it('sem entrada default (Firefox, Safari), usa o primeiro aparelho', () => {
    expect(resolveInputDevice(WINDOWS.slice(2), '')).toBe('id-webcam');
  });

  it('sem permissão (ids vazios) ou sem microfone, devolve null', () => {
    expect(resolveInputDevice([{ kind: 'audioinput', deviceId: '', groupId: '', label: '' }], '')).toBeNull();
    expect(resolveInputDevice([], 'id-headset')).toBeNull();
  });

  it('o seletor mostra "Padrão do sistema" quando nada foi escolhido', () => {
    expect(selectedInputOption('')).toBe('default');
    expect(selectedInputOption('id-webcam')).toBe('id-webcam');
  });
});

describe('opusOnlyCodecs', () => {
  it('fica só com o Opus de 48 kHz das capacidades do Chrome', () => {
    const codecs = [
      { mimeType: 'audio/opus', clockRate: 48_000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' },
      { mimeType: 'audio/red', clockRate: 48_000, channels: 2, sdpFmtpLine: '111/111' },
      { mimeType: 'audio/G722', clockRate: 8_000, channels: 1 },
      { mimeType: 'audio/PCMU', clockRate: 8_000, channels: 1 },
      { mimeType: 'audio/CN', clockRate: 8_000, channels: 1 },
      { mimeType: 'audio/telephone-event', clockRate: 48_000, channels: 1 },
    ];
    expect(opusOnlyCodecs(codecs)).toEqual([codecs[0]]);
  });
});
