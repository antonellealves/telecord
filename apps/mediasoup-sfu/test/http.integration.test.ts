/**
 * As rotas HTTP internas — o caminho ANTIGO da sinalização — contra o
 * registro novo.
 *
 * Quem ainda as usa: a aba que carregou o cliente anterior e não recarregou,
 * e o cliente novo quando o canal de mídia não abre. Um deploy do SFU não
 * pode derrubar nenhum dos dois, então o contrato delas fica travado aqui.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { MediasoupConsumeResult, MediasoupProduceResult, MediasoupTransportInfo } from '@telecord/shared';
import type { SfuNode } from '../src/node';
import { FAKE_DTLS, opusParameters, SECRET, startTestNode } from './helpers';

describe('rotas HTTP internas', () => {
  let node: SfuNode;
  before(async () => {
    node = await startTestNode(44_600);
  });
  after(async () => {
    await node.close();
  });

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, secret = SECRET): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${node.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} respondeu ${response.status}`);
    return (await response.json()) as T;
  }

  it('saúde responde sem segredo; o resto exige', async () => {
    const health = await fetch(`http://127.0.0.1:${node.port}/healthz`);
    assert.equal(health.status, 200);
    await assert.rejects(call('GET', '/rooms/presence', undefined, 'segredo-errado'), /401/);
  });

  it('perguntar as RTP capabilities de uma sala não cria nada no Worker', async () => {
    const before = node.registry.stats().rooms;
    for (const slug of ['inventada-1', 'inventada-2', 'inventada-3']) {
      const capabilities = await call<{ codecs: { mimeType: string }[] }>('GET', `/rooms/${slug}/rtp-capabilities`);
      assert.ok(capabilities.codecs.some((codec) => codec.mimeType === 'audio/opus'));
    }
    assert.equal(node.registry.stats().rooms, before);
    assert.equal(node.pool.slots[0]!.routers, 0);
  });

  it('o fluxo inteiro de publicar e assinar continua funcionando por HTTP', async () => {
    const room = '/rooms/sala-http';
    const anaSend = await call<MediasoupTransportInfo>('POST', `${room}/transports`, { peerId: 'ana', direction: 'send' });
    await call('POST', `${room}/transports/${anaSend.id}/connect`, { peerId: 'ana', dtlsParameters: FAKE_DTLS });
    const produced = await call<MediasoupProduceResult>('POST', `${room}/transports/${anaSend.id}/produce`, {
      peerId: 'ana',
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    const published = await call<{ tracks: { producerId: string }[] }>('GET', `${room}/published?peerId=ana`);
    assert.deepEqual(
      published.tracks.map((track) => track.producerId),
      [produced.producerId],
    );

    const biaRecv = await call<MediasoupTransportInfo>('POST', `${room}/transports`, { peerId: 'bia', direction: 'recv' });
    const consumed = await call<MediasoupConsumeResult>('POST', `${room}/transports/${biaRecv.id}/consume`, {
      peerId: 'bia',
      producerId: produced.producerId,
      // O caminho antigo manda as capabilities a cada chamada.
      rtpCapabilities: node.registry.routerRtpCapabilities,
    });
    assert.equal(consumed.producerId, produced.producerId);
    await call('POST', `${room}/consumers/${consumed.id}?action=resume`, { peerId: 'bia' });

    await call('POST', `${room}/leave`, { peerId: 'ana' });
    await call('POST', `${room}/leave`, { peerId: 'bia' });
    assert.deepEqual(node.registry.publishedTracksInRoom('sala-http'), []);
  });

  it('transporte pedido de novo pelo mesmo par fecha o anterior', async () => {
    const room = '/rooms/sala-f5';
    const first = await call<MediasoupTransportInfo>('POST', `${room}/transports`, { peerId: 'ana', direction: 'send' });
    await call('POST', `${room}/transports/${first.id}/produce`, {
      peerId: 'ana',
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });
    const second = await call<MediasoupTransportInfo>('POST', `${room}/transports`, { peerId: 'ana', direction: 'send' });
    assert.notEqual(second.id, first.id);
    // O producer do transporte antigo foi junto: nada de fantasma publicando.
    assert.deepEqual(node.registry.publishedTracksInRoom('sala-f5'), []);
    await call('POST', `${room}/leave`, { peerId: 'ana' });
  });
});
