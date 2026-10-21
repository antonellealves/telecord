import { describe, expect, it } from 'vitest';
import { formatFmtpParams, mungeOpusFmtp, parseFmtpParams, readOpusSections } from './opusSdp';
import { mungeVoiceRecvSdp, mungeVoiceSendSdp } from './voiceSdp';

/**
 * Oferta de um Chrome de verdade (M155, Windows) para um microfone `sendonly`
 * mais uma câmera — cortada nas linhas de vídeo, mantida inteira no áudio.
 * Repara no que o Chrome oferece sem ninguém pedir: red, G722, PCMU, PCMA,
 * CN e telephone-event, e nenhum `nack` no Opus.
 */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:Zq3a',
  'a=ice-pwd:0z1kQd8y3TQ7gU5x0n8m9QxR',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CC:87:32:BE:DD:8C:66:A5:8E:50:55:EA:4C:D3:B6:5F:09:5E:D2:BC',
  'a=setup:actpass',
  'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=sendonly',
  'a=msid:- 6f0c9a1e-6a7a-4a43-9c4b-2f1f0c0b8a11',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000',
  'a=rtpmap:110 telephone-event/48000',
  'a=rtpmap:126 telephone-event/8000',
  'a=ssrc:3264015466 cname:qk1vC0pVfC2mN8yZ',
  'a=ssrc:3264015466 msid:- 6f0c9a1e-6a7a-4a43-9c4b-2f1f0c0b8a11',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sendonly',
  'a=rtcp-mux',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtcp-fb:96 nack pli',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  '',
].join('\r\n');

/**
 * Resposta que o mediasoup-client monta para o microfone quando o Router
 * ainda tem os fmtp antigos (alta fidelidade): é o caso real enquanto o SFU
 * não é republicado com os codecs novos.
 */
const MEDIASOUP_OLD_ANSWER = [
  'v=0',
  'o=mediasoup-client 10000 1 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=ice-lite',
  'a=group:BUNDLE 0',
  'm=audio 7 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 127.0.0.1',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 useinbandfec=1;maxaveragebitrate=510000;maxplaybackrate=48000;sprop-maxcapturerate=48000;stereo=1;sprop-stereo=1;ptime=10;minptime=10;complexity=10;usedtx=1',
  'a=rtcp-fb:111 transport-cc',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=setup:active',
  'a=mid:0',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  '',
].join('\r\n');

function opus(sdp: string, mid = '0') {
  const section = readOpusSections(sdp).find((entry) => entry.mid === mid);
  if (section === undefined) throw new Error(`sem Opus na seção ${mid}`);
  return section;
}

describe('parseFmtpParams / formatFmtpParams', () => {
  it('lê e escreve a linha preservando a ordem', () => {
    const params = parseFmtpParams('minptime=10; useinbandfec=1;usedtx=1');
    expect([...params]).toEqual([
      ['minptime', '10'],
      ['useinbandfec', '1'],
      ['usedtx', '1'],
    ]);
    expect(formatFmtpParams(params)).toBe('minptime=10;useinbandfec=1;usedtx=1');
  });

  it('aceita parâmetro sem valor (fmtp do RED)', () => {
    expect(formatFmtpParams(parseFmtpParams('111/111'))).toBe('111/111');
  });
});

describe('mungeOpusFmtp', () => {
  it('mescla por padrão: mantém o que havia e acrescenta o pedido', () => {
    const out = mungeOpusFmtp(CHROME_OFFER, { params: { usedtx: 1 } });
    expect(formatFmtpParams(opus(out).fmtp)).toBe('minptime=10;useinbandfec=1;usedtx=1');
  });

  it('no modo exato deixa só os parâmetros pedidos', () => {
    const out = mungeOpusFmtp(MEDIASOUP_OLD_ANSWER, {
      params: { minptime: 10, useinbandfec: 1, usedtx: 1 },
      exact: true,
    });
    expect(formatFmtpParams(opus(out).fmtp)).toBe('minptime=10;useinbandfec=1;usedtx=1');
  });

  it('remove parâmetros por nome', () => {
    const out = mungeOpusFmtp(MEDIASOUP_OLD_ANSWER, { params: {}, remove: ['stereo', 'sprop-stereo', 'ptime'] });
    const fmtp = opus(out).fmtp;
    expect(fmtp.has('stereo')).toBe(false);
    expect(fmtp.has('sprop-stereo')).toBe(false);
    expect(fmtp.has('ptime')).toBe(false);
    expect(fmtp.get('minptime')).toBe('10');
  });

  it('acrescenta nack sem duplicar o transport-cc que já existia', () => {
    const out = mungeOpusFmtp(CHROME_OFFER, { params: {}, rtcpFeedback: ['nack', 'transport-cc'] });
    expect(opus(out).rtcpFeedback.sort()).toEqual(['nack', 'transport-cc']);
    expect(out.split('a=rtcp-fb:111 transport-cc').length).toBe(2);
  });

  it('opusOnly tira red, G722, PCMU, PCMA, CN e telephone-event da seção', () => {
    const out = mungeOpusFmtp(CHROME_OFFER, { params: {}, opusOnly: true });
    expect(opus(out).payloads).toEqual([111]);
    expect(out).not.toMatch(/a=rtpmap:(63|9|0|8|13|110|126) /);
    expect(out).not.toContain('a=fmtp:63 ');
  });

  it('não encosta no vídeo, nem nas linhas que não são do Opus', () => {
    const out = mungeOpusFmtp(CHROME_OFFER, { params: { usedtx: 1 }, rtcpFeedback: ['nack'], opusOnly: true });
    const video = (sdp: string): string => sdp.slice(sdp.indexOf('m=video'));
    expect(video(out)).toBe(video(CHROME_OFFER));
    expect(out).toContain('a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level');
    expect(out).toContain('a=ssrc:3264015466 cname:qk1vC0pVfC2mN8yZ');
    expect(out.startsWith(CHROME_OFFER.slice(0, CHROME_OFFER.indexOf('m=audio')))).toBe(true);
  });

  it('só mexe nas seções de `mids`', () => {
    expect(mungeOpusFmtp(CHROME_OFFER, { params: { usedtx: 1 }, mids: ['7'] })).toBe(CHROME_OFFER);
    expect(opus(mungeOpusFmtp(CHROME_OFFER, { params: { usedtx: 1 }, mids: ['0'] })).fmtp.get('usedtx')).toBe('1');
  });

  it('cria a linha a=fmtp quando o Opus veio sem ela', () => {
    const bare = CHROME_OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    const out = mungeOpusFmtp(bare, { params: { minptime: 10, useinbandfec: 1 } });
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n');
  });

  it('é idempotente e preserva o fim de linha', () => {
    const options = { params: { usedtx: 1 }, rtcpFeedback: ['nack'], opusOnly: true } as const;
    const once = mungeOpusFmtp(CHROME_OFFER, options);
    expect(mungeOpusFmtp(once, options)).toBe(once);
    expect(once.endsWith('\r\n')).toBe(true);
    expect(once).not.toMatch(/[^\r]\n/);
  });

  it('SDP sem Opus volta intacto', () => {
    const noOpus = CHROME_OFFER.replace(/opus/g, 'xpus');
    expect(mungeOpusFmtp(noOpus, { params: { usedtx: 1 }, opusOnly: true })).toBe(noOpus);
  });
});

describe('regras da voz', () => {
  it('envio: o Opus do microfone fica igual ao do Discord', () => {
    const out = mungeVoiceSendSdp(MEDIASOUP_OLD_ANSWER, ['0']);
    const section = opus(out);
    expect(formatFmtpParams(section.fmtp)).toBe('minptime=10;useinbandfec=1;usedtx=1');
    expect(section.rtcpFeedback.sort()).toEqual(['nack', 'transport-cc']);
    expect(section.payloads).toEqual([111]);
    // ptime=10 some: a voz volta ao quadro padrão de 20 ms.
    expect(section.fmtp.has('ptime')).toBe(false);
  });

  it('envio: seção que não é do microfone (áudio da tela) não muda', () => {
    expect(mungeVoiceSendSdp(MEDIASOUP_OLD_ANSWER, ['3'])).toBe(MEDIASOUP_OLD_ANSWER);
  });

  it('recepção: padrão do Chrome, sem stereo=0 nem usedtx', () => {
    const answer = CHROME_OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1', 'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;usedtx=1');
    expect(formatFmtpParams(opus(mungeVoiceRecvSdp(answer)).fmtp)).toBe('minptime=10;useinbandfec=1');
  });

  it('recepção: estéreo de verdade (áudio da tela) sobrevive', () => {
    const answer = CHROME_OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1', 'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1');
    expect(formatFmtpParams(opus(mungeVoiceRecvSdp(answer)).fmtp)).toBe('minptime=10;useinbandfec=1;stereo=1');
  });
});
