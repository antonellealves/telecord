import { describe, expect, it } from 'vitest';
import { DtxMeter, codecLabel, summarizeVoiceStream, type StatsMap, type StatsRecord } from './voiceStats';

function report(records: StatsRecord[]): StatsMap {
  return new Map(records.map((record) => [record.id, record]));
}

const CODEC: StatsRecord = {
  id: 'COT01_111',
  type: 'codec',
  timestamp: 0,
  mimeType: 'audio/opus',
  payloadType: 111,
  clockRate: 48_000,
  channels: 2,
  sdpFmtpLine: 'minptime=10;usedtx=1;useinbandfec=1',
};

/** Um microfone falando a ~64 kbps, como o Chrome reporta, em dois instantes. */
function sendReport(t: number, bytesSent: number, audioLevel: number): StatsMap {
  return report([
    { ...CODEC, timestamp: t },
    {
      id: 'OT01A',
      type: 'outbound-rtp',
      timestamp: t,
      kind: 'audio',
      codecId: 'COT01_111',
      mediaSourceId: 'SA1',
      bytesSent,
      headerBytesSent: (t / 1000) * 50 * 12,
      packetsSent: (t / 1000) * 50,
      targetBitrate: 64_000,
      nackCount: 0,
      retransmittedPacketsSent: 0,
    },
    { id: 'SA1', type: 'media-source', timestamp: t, kind: 'audio', audioLevel },
    {
      id: 'RIA1',
      type: 'remote-inbound-rtp',
      timestamp: t,
      kind: 'audio',
      localId: 'OT01A',
      packetsLost: 0,
      fractionLost: 0,
      jitter: 0.002,
      roundTripTime: 0.015,
    },
  ]);
}

describe('summarizeVoiceStream — envio', () => {
  it('lê codec, alvo, bitrate, RTT e nível como o webrtc-internals', () => {
    const before = sendReport(10_000, 80_000, 0.2);
    const after = sendReport(11_000, 88_000, 0.2);
    const stats = summarizeVoiceStream('send', after, before)!;
    expect(stats.codec).toBe('opus (111, minptime=10;usedtx=1;useinbandfec=1)');
    expect(stats.targetBitrate).toBe(64_000);
    expect(stats.bitrateBps).toBe(64_000);
    expect(stats.wireBitrateBps).toBe(64_000 + 50 * 12 * 8);
    expect(stats.packetsPerSecond).toBe(50);
    expect(stats.rttMs).toBeCloseTo(15);
    expect(stats.jitterMs).toBeCloseTo(2);
    expect(stats.fractionLost).toBe(0);
    expect(stats.audioLevel).toBe(0.2);
  });

  it('sem leitura anterior, não inventa bitrate', () => {
    expect(summarizeVoiceStream('send', sendReport(1_000, 8_000, 0))!.bitrateBps).toBeNull();
  });

  it('sem remote-inbound-rtp, o RTT vem do par de candidatos', () => {
    const stats = report([
      { id: 'OT', type: 'outbound-rtp', timestamp: 0, kind: 'audio', bytesSent: 0 },
      { id: 'T', type: 'transport', timestamp: 0, selectedCandidatePairId: 'CP' },
      { id: 'CP', type: 'candidate-pair', timestamp: 0, currentRoundTripTime: 0.021 },
    ]);
    expect(summarizeVoiceStream('send', stats)!.rttMs).toBeCloseTo(21);
  });

  it('relatório sem áudio de saída devolve null', () => {
    expect(summarizeVoiceStream('send', report([CODEC]))).toBeNull();
  });
});

function recvReport(t: number, values: Partial<Record<string, number>>): StatsMap {
  return report([
    { ...CODEC, id: 'CIT01_111', sdpFmtpLine: 'minptime=10;useinbandfec=1', timestamp: t },
    {
      id: 'IT01A',
      type: 'inbound-rtp',
      timestamp: t,
      kind: 'audio',
      codecId: 'CIT01_111',
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
      jitter: 0.003,
      fecPacketsReceived: 0,
      nackCount: 0,
      concealedSamples: 0,
      silentConcealedSamples: 0,
      totalSamplesReceived: 0,
      jitterBufferDelay: 0,
      jitterBufferEmittedCount: 0,
      audioLevel: 0.1,
      ...values,
    },
  ]);
}

describe('summarizeVoiceStream — recepção', () => {
  it('concealment não silencioso e jitter buffer no intervalo', () => {
    const before = recvReport(0, { totalSamplesReceived: 0, concealedSamples: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 });
    const after = recvReport(1_000, {
      bytesReceived: 8_000,
      packetsReceived: 49,
      packetsLost: 1,
      totalSamplesReceived: 48_000,
      // 480 amostras escondidas, 240 delas no silêncio do DTX: 0,5% de verdade.
      concealedSamples: 480,
      silentConcealedSamples: 240,
      jitterBufferDelay: 48_000 * 0.042,
      jitterBufferEmittedCount: 48_000,
      fecPacketsReceived: 1,
    });
    const stats = summarizeVoiceStream('recv', after, before)!;
    expect(stats.codec).toBe('opus (111, minptime=10;useinbandfec=1)');
    expect(stats.bitrateBps).toBe(64_000);
    expect(stats.fractionLost).toBeCloseTo(0.02);
    expect(stats.concealedNonSilentSamples).toBe(240);
    expect(stats.concealmentPercent).toBeCloseTo(0.5);
    expect(stats.jitterBufferMs).toBeCloseTo(42);
    expect(stats.fecPacketsReceived).toBe(1);
    expect(stats.jitterMs).toBeCloseTo(3);
  });

  it('sem leitura anterior, o jitter buffer usa o acumulado', () => {
    const stats = summarizeVoiceStream('recv', recvReport(0, { jitterBufferDelay: 2, jitterBufferEmittedCount: 40 }))!;
    expect(stats.jitterBufferMs).toBeCloseTo(50);
    expect(stats.concealmentPercent).toBeNull();
  });
});

describe('codecLabel', () => {
  it('sem fmtp, mostra só o payload', () => {
    expect(codecLabel({ id: 'c', type: 'codec', timestamp: 0, mimeType: 'audio/opus', payloadType: 111 })).toBe('opus (111)');
  });
});

describe('DtxMeter', () => {
  it('DTX funcionando: calado fica em ~1,6 kbps', () => {
    const meter = new DtxMeter();
    for (let i = 0; i < 4; i += 1) meter.push(0.2, 62_000);
    for (let i = 0; i < 5; i += 1) meter.push(0.001, 1_600);
    expect(meter.summary).toEqual({ silenceBps: 1_600, speakingBps: 62_000, verdict: 'ok' });
  });

  it('DTX desligado: calado continua gastando quase o mesmo que falando', () => {
    const meter = new DtxMeter();
    for (let i = 0; i < 5; i += 1) meter.push(0.002, 40_000);
    expect(meter.summary.verdict).toBe('dtx-inativo');
  });

  it('a primeira janela calada depois da fala não conta', () => {
    const meter = new DtxMeter();
    meter.push(0.2, 64_000);
    meter.push(0.001, 30_000);
    expect(meter.summary.silenceBps).toBeNull();
    expect(meter.summary.verdict).toBe('medindo');
  });
});
