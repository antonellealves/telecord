/**
 * A voz que sai da sala LiveKit é a que foi programada?
 *
 * Três frentes, porque a configuração pode falhar em três lugares:
 *
 * 1. CONFIGURAÇÃO — as opções que o app entrega ao SDK carregam o perfil,
 *    inclusive depois da mescla com `publishDefaults` que o SDK faz em
 *    `publishTrack` (foi aí que o áudio da tela herdou o RED da voz).
 * 2. BANDA — o perfil cabe numa sala cheia sem roubar a banda da tela (o
 *    lag de 256 kbps + RED) e não desce a qualidade de telefone para caber.
 * 3. AUDITORIA — dado o que um `RTCRtpSender` real reporta, a conferência
 *    acusa cada divergência conhecida e não acusa o que está certo. É ela
 *    que roda no navegador (`useAudioSendAudit`).
 */
import { describe, expect, it } from 'vitest';
import type { TrackPublishOptions } from 'livekit-client';
import {
  ROOM_AUDIO_BUDGET,
  SCREEN_AUDIO_PROFILE,
  VOICE_PROFILE,
  auditAudioSender,
  roomAudioDownlink,
  wireBitrate,
  type AudioSendProfile,
  type AudioSenderSnapshot,
} from './audioSendProfile';
import { SCREEN_QUALITY_OPTIONS, roomOptions, screenSharePublishOptions } from './media';

/** O que `LocalParticipant.publishTrack` faz antes de montar o encoding. */
function effectiveOptions(options?: TrackPublishOptions): TrackPublishOptions {
  return { ...roomOptions.publishDefaults, ...options };
}

/** O encoding de áudio que o SDK põe no sender, a partir das opções. */
function audioEncoding(options: TrackPublishOptions): RTCRtpEncodingParameters {
  return { maxBitrate: options.audioPreset?.maxBitrate, priority: options.audioPreset?.priority ?? 'high' };
}

describe('configuração entregue ao SDK', () => {
  it('microfone publica com o teto, RED e DTX do perfil de voz', () => {
    const options = effectiveOptions();
    expect(audioEncoding(options).maxBitrate).toBe(VOICE_PROFILE.maxBitrate);
    expect(options.red).toBe(VOICE_PROFILE.red);
    expect(options.dtx).toBe(VOICE_PROFILE.dtx);
    expect(options.forceStereo ?? false).toBe(VOICE_PROFILE.stereo);
  });

  it('captura do microfone em 48 kHz mono, sem reamostrar para banda estreita', () => {
    expect(roomOptions.audioCaptureDefaults?.sampleRate).toBe(48_000);
    expect(roomOptions.audioCaptureDefaults?.channelCount).toBe(1);
  });

  it.each(SCREEN_QUALITY_OPTIONS.map((option) => option.id))(
    'áudio da tela (%s) usa o próprio perfil e não herda o da voz',
    (quality) => {
      const options = effectiveOptions(screenSharePublishOptions(quality));
      expect(audioEncoding(options).maxBitrate).toBe(SCREEN_AUDIO_PROFILE.maxBitrate);
      expect(options.red).toBe(SCREEN_AUDIO_PROFILE.red);
      expect(options.dtx).toBe(SCREEN_AUDIO_PROFILE.dtx);
      expect(options.forceStereo).toBe(SCREEN_AUDIO_PROFILE.stereo);
    },
  );
});

describe('banda', () => {
  const fullRoom = { participants: 10, screenShares: 1 };

  it('sala cheia com todos os microfones abertos cabe no orçamento de áudio', () => {
    expect(roomAudioDownlink(fullRoom)).toBeLessThanOrEqual(ROOM_AUDIO_BUDGET);
  });

  it('o perfil de 256 kbps + RED (o que travava a tela) estoura o orçamento', () => {
    const lagging: AudioSendProfile = { maxBitrate: 256_000, stereo: false, red: true, dtx: false };
    expect(roomAudioDownlink(fullRoom, lagging, lagging)).toBeGreaterThan(ROOM_AUDIO_BUDGET);
  });

  it('RED dobra o payload no fio', () => {
    const plain = wireBitrate({ ...VOICE_PROFILE, red: false });
    const red = wireBitrate({ ...VOICE_PROFILE, red: true });
    expect(red - plain).toBeGreaterThanOrEqual(VOICE_PROFILE.maxBitrate);
  });

  it('a voz não desce abaixo da banda completa do Opus para economizar', () => {
    // Abaixo de ~64 kbps mono o Opus começa a estreitar a banda e a voz volta
    // a soar "de telefone" — o lag se resolve na conta acima, não aqui.
    expect(VOICE_PROFILE.maxBitrate).toBeGreaterThanOrEqual(64_000);
    expect(SCREEN_AUDIO_PROFILE.maxBitrate).toBeGreaterThanOrEqual(96_000);
  });
});

/** Payload de fala contínua com RED: um pouco abaixo do dobro do teto (VBR). */
const SPEECH_WITH_RED = VOICE_PROFILE.maxBitrate * 1.875;

/** O que o Chromium reporta para o microfone publicado conforme o perfil. */
function conformingVoice(overrides: Partial<AudioSenderSnapshot> = {}): AudioSenderSnapshot {
  const target = VOICE_PROFILE.maxBitrate;
  return {
    maxBitrate: target,
    codecs: [
      { mimeType: 'audio/red', clockRate: 48_000, channels: 2, sdpFmtpLine: '111/111' },
      { mimeType: 'audio/opus', clockRate: 48_000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' },
    ],
    sampleRate: 48_000,
    channelCount: 1,
    // 5 s de fala entre as duas leituras.
    first: { timestamp: 10_000, bytesSent: 200_000, targetBitrate: target, codecMimeType: 'audio/red' },
    second: {
      timestamp: 15_000,
      bytesSent: 200_000 + (SPEECH_WITH_RED * 5) / 8,
      targetBitrate: target,
      codecMimeType: 'audio/red',
    },
    ...overrides,
  };
}

function issueCodes(snapshot: AudioSenderSnapshot, profile: AudioSendProfile = VOICE_PROFILE): string[] {
  return auditAudioSender(snapshot, profile).issues.map((issue) => issue.code);
}

describe('auditoria do sender', () => {
  it('microfone conforme passa limpo e mede o bitrate do fio', () => {
    const audit = auditAudioSender(conformingVoice(), VOICE_PROFILE);
    expect(audit.issues).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.measuredBitrate).toBeCloseTo(SPEECH_WITH_RED, -3);
  });

  it('acusa o teto do sender diferente do programado', () => {
    expect(issueCodes(conformingVoice({ maxBitrate: VOICE_PROFILE.maxBitrate * 2 }))).toEqual(['max-bitrate']);
    expect(issueCodes(conformingVoice({ maxBitrate: undefined }))).toEqual(['max-bitrate']);
  });

  it('acusa SDP que corta o Opus abaixo do teto', () => {
    const codecs = [
      { mimeType: 'audio/red', sdpFmtpLine: '111/111' },
      { mimeType: 'audio/opus', clockRate: 48_000, sdpFmtpLine: 'minptime=10;useinbandfec=1;maxaveragebitrate=32000' },
    ];
    expect(issueCodes(conformingVoice({ codecs }))).toEqual(['fmtp-ceiling']);
  });

  it('acusa DTX e FEC negociados ao contrário do perfil', () => {
    const codecs = [
      { mimeType: 'audio/red', sdpFmtpLine: '111/111' },
      { mimeType: 'audio/opus', clockRate: 48_000, sdpFmtpLine: 'minptime=10;usedtx=1' },
    ];
    expect(issueCodes(conformingVoice({ codecs }))).toEqual(['fec', 'dtx']);
  });

  it('acusa RED faltando na voz', () => {
    const codecs = [{ mimeType: 'audio/opus', clockRate: 48_000, sdpFmtpLine: 'minptime=10;useinbandfec=1' }];
    const second = { timestamp: 15_000, bytesSent: 200_000 + (VOICE_PROFILE.maxBitrate * 5) / 8, codecMimeType: 'audio/opus' };
    expect(issueCodes(conformingVoice({ codecs, second }))).toEqual(['red']);
  });

  it('acusa captura reamostrada ou em estéreo', () => {
    expect(issueCodes(conformingVoice({ sampleRate: 16_000 }))).toEqual(['sample-rate']);
    expect(issueCodes(conformingVoice({ channelCount: 2 }))).toEqual(['channels']);
  });

  it('acusa encoder acima do teto (Firefox usando maxaveragebitrate=510000 como alvo)', () => {
    const codecs = [{ mimeType: 'audio/opus', clockRate: 48_000, sdpFmtpLine: 'useinbandfec=1;maxaveragebitrate=510000' }];
    const first = { timestamp: 0, bytesSent: 0, codecMimeType: 'audio/opus' };
    const second = { timestamp: 5_000, bytesSent: 318_750, targetBitrate: 510_000, codecMimeType: 'audio/opus' };
    const profile = { ...VOICE_PROFILE, red: false };
    expect(issueCodes(conformingVoice({ codecs, first, second }), profile)).toEqual(['target-bitrate', 'overspend']);
  });

  it('áudio da tela com RED herdado da voz é acusado', () => {
    const screen: AudioSenderSnapshot = {
      maxBitrate: SCREEN_AUDIO_PROFILE.maxBitrate,
      codecs: [
        { mimeType: 'audio/red', sdpFmtpLine: '111/111' },
        { mimeType: 'audio/opus', clockRate: 48_000, sdpFmtpLine: 'minptime=10;useinbandfec=1;stereo=1' },
      ],
      sampleRate: 48_000,
    };
    expect(issueCodes(screen, SCREEN_AUDIO_PROFILE)).toEqual(['red']);
    const fixed = { ...screen, codecs: screen.codecs.slice(1) };
    expect(issueCodes(fixed, SCREEN_AUDIO_PROFILE)).toEqual([]);
  });

  it('navegador que não expõe codecs nem stats não gera falso alarme', () => {
    expect(issueCodes({ maxBitrate: VOICE_PROFILE.maxBitrate, codecs: [] })).toEqual([]);
  });
});
