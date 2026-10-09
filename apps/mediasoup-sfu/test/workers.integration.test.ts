/**
 * Vários Workers: onde cada sala entra, e o que acontece quando uma sala
 * não cabe mais num só.
 *
 * É a parte do desenho que faz capacidade ser assunto de máquina. O caso
 * comum (sala pequena, um Worker) não passa por aqui — e por isso mesmo
 * precisa de teste: é código que em produção só roda no dia em que a sala
 * enche, que é o pior dia para descobrir que não funciona.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { MediasoupTransportInfo } from '@telecord/shared';
import type { SfuNode } from '../src/node';
import {
  FAKE_DTLS,
  opusParameters,
  SECRET,
  setUpTransports,
  startTestNode,
  TestClient,
  until,
  vp8Parameters,
} from './helpers';

/** A porta de mídia que o servidor anunciou para um transporte — diz em qual Worker ele mora. */
function rtcPortOf(transport: MediasoupTransportInfo): number {
  const candidates = transport.iceCandidates as { port: number; protocol: string }[];
  const udp = candidates.find((candidate) => candidate.protocol === 'udp');
  assert.ok(udp !== undefined, 'transporte sem candidato UDP');
  return udp.port;
}

describe('pool de Workers — onde cada sala entra', () => {
  const PORT_BASE = 44_000;
  let node: SfuNode;
  before(async () => {
    node = await startTestNode(PORT_BASE, { workers: 3 });
  });
  after(async () => {
    await node.close();
  });

  it('cada Worker escuta na própria porta, e todos os transportes dele a dividem', async () => {
    assert.deepEqual(
      node.pool.slots.map((slot) => slot.rtcPort),
      [PORT_BASE, PORT_BASE + 1, PORT_BASE + 2],
    );

    const { client } = await TestClient.join(node.port, 'porta-unica', 'ana');
    const send = await client.request('createTransport', { direction: 'send' });
    const recv = await client.request('createTransport', { direction: 'recv' });
    // Dois transportes, UMA porta: é o que tira o teto de gente por faixa de portas.
    assert.equal(rtcPortOf(send), rtcPortOf(recv));
    assert.ok(node.pool.slots.some((slot) => slot.rtcPort === rtcPortOf(send)));
    await client.leave();
  });

  it('duas pessoas entrando na mesma sala nova no mesmo instante caem no MESMO Router', async () => {
    const [ana, bia] = await Promise.all([
      TestClient.join(node.port, 'corrida', 'ana'),
      TestClient.join(node.port, 'corrida', 'bia'),
    ]);
    const [anaSend, biaSend] = await Promise.all([
      ana.client.request('createTransport', { direction: 'send' }),
      bia.client.request('createTransport', { direction: 'send' }),
    ]);
    assert.equal(rtcPortOf(anaSend), rtcPortOf(biaSend));
    assert.equal(node.registry.stats().roomsSpanningWorkers, 0);

    // E se ouvem: a de uma é assinável pela outra, sem ponte.
    await ana.client.request('connectTransport', { transportId: anaSend.id, dtlsParameters: FAKE_DTLS });
    const { producerId } = await ana.client.request('produce', {
      transportId: anaSend.id,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });
    await bia.client.request('setRtpCapabilities', { rtpCapabilities: bia.ready.routerRtpCapabilities });
    const biaRecv = await bia.client.request('createTransport', { direction: 'recv' });
    const consumer = await bia.client.request('consume', { transportId: biaRecv.id, producerId });
    assert.equal(consumer.producerId, producerId);
    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('sala nova vai para o Worker mais folgado, não para onde já tem gente', async () => {
    const ana = await TestClient.join(node.port, 'ocupada', 'ana');
    const { sendId } = await setUpTransports(ana.client, ana.ready);
    await ana.client.request('produce', {
      transportId: sendId,
      kind: 'video',
      rtpParameters: vp8Parameters(),
      trackKind: 'screen-video',
    });
    const ocupado = node.pool.slots.find((slot) => slot.units > 0);
    assert.ok(ocupado !== undefined, 'nenhum Worker contabilizou a tela');

    const bia = await TestClient.join(node.port, 'outra-sala', 'bia');
    const biaSend = await bia.client.request('createTransport', { direction: 'send' });
    assert.notEqual(rtcPortOf(biaSend), ocupado.rtcPort);
    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('a rota de carga do nó exige o segredo e descreve cada Worker', async () => {
    const semSegredo = await fetch(`http://127.0.0.1:${node.port}/node`);
    assert.equal(semSegredo.status, 401);

    const response = await fetch(`http://127.0.0.1:${node.port}/node`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(response.status, 200);
    const stats = (await response.json()) as { workers: { index: number; rtcPort: number; saturated: boolean }[] };
    assert.deepEqual(
      stats.workers.map((worker) => worker.rtcPort),
      [PORT_BASE, PORT_BASE + 1, PORT_BASE + 2],
    );
    assert.ok(stats.workers.every((worker) => !worker.saturated));
  });
});

describe('pool de Workers — sala que transborda', () => {
  const PORT_BASE = 44_300;
  let node: SfuNode;
  before(async () => {
    // Capacidade 1: a primeira track já enche o Worker, e a próxima pessoa
    // é obrigada a entrar por outro.
    node = await startTestNode(PORT_BASE, { workers: 2, workerCapacity: 1 });
  });
  after(async () => {
    await node.close();
  });

  it('quem entra com o Worker cheio vai para outro, e as tracks atravessam nos dois sentidos', async () => {
    const room = 'transborda';
    const ana = await TestClient.join(node.port, room, 'ana');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    const mic = await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });
    const cheio = node.pool.slots.find((slot) => slot.routers === 1);
    assert.ok(cheio !== undefined);
    assert.equal(node.pool.isSaturated(cheio), true);

    // Bia entra DEPOIS: a sala passa a ocupar dois Workers.
    const bia = await TestClient.join(node.port, room, 'bia');
    assert.deepEqual(
      bia.ready.tracks.map((track) => track.producerId),
      [mic.producerId],
    );
    const biaTransports = await setUpTransports(bia.client, bia.ready);
    assert.equal(node.registry.stats().roomsSpanningWorkers, 1);
    assert.deepEqual(
      node.pool.slots.map((slot) => slot.routers),
      [1, 1],
    );

    // De um Worker para o outro: a assinatura cria a ponte sozinha.
    const heard = await bia.client.request('consume', {
      transportId: biaTransports.recvId,
      producerId: mic.producerId,
    });
    assert.equal(heard.producerId, mic.producerId);
    assert.equal(heard.kind, 'audio');

    // E de volta: o que Bia publica, Ana assina.
    const screen = await bia.client.request('produce', {
      transportId: biaTransports.sendId,
      kind: 'video',
      rtpParameters: vp8Parameters(),
      trackKind: 'screen-video',
    });
    await ana.client.waitEvent('track:announced', (event) => event.producerId === screen.producerId);
    const seen = await ana.client.request('consume', {
      transportId: anaTransports.recvId,
      producerId: screen.producerId,
    });
    assert.equal(seen.kind, 'video');

    // A track fechada na origem some do outro lado da ponte também.
    await ana.client.request('closeProducer', { producerId: mic.producerId });
    await bia.client.waitEvent('track:closed', (event) => event.producerId === mic.producerId);

    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('cinco pessoas assinando a mesma track no mesmo instante pedem UMA ponte, não cinco', async () => {
    const room = 'uma-ponte';
    const ana = await TestClient.join(node.port, room, 'ana');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    const mic = await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    // Cinco ouvintes, todos no segundo Worker (o primeiro está cheio). São
    // conexões diferentes de propósito: pedidos da MESMA conexão são
    // atendidos em fila, e o que se quer aqui é a corrida de verdade.
    const listeners = [];
    for (const peerId of ['bia', 'caio', 'duda', 'edu', 'fabi']) {
      const joined = await TestClient.join(node.port, room, peerId);
      listeners.push({ ...joined, transports: await setUpTransports(joined.client, joined.ready) });
    }
    const unitsBefore = node.pool.slots.map((slot) => slot.units);

    const consumers = await Promise.all(
      listeners.map((listener) =>
        listener.client.request('consume', {
          transportId: listener.transports.recvId,
          producerId: mic.producerId,
        }),
      ),
    );
    assert.equal(new Set(consumers.map((consumer) => consumer.id)).size, 5);

    // Carga somada: 5 consumers, mais UMA ponte (um consumer no Worker de
    // origem, um producer no de destino). Cinco pontes seriam 15.
    const added = node.pool.slots.reduce((sum, slot, index) => sum + slot.units - unitsBefore[index]!, 0);
    assert.equal(added, 7);
    await Promise.all([ana.client.leave(), ...listeners.map((listener) => listener.client.leave())]);
  });

  it('o Router do segundo Worker é liberado quando o último par dele sai', async () => {
    const room = 'encolhe';
    const ana = await TestClient.join(node.port, room, 'ana');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });
    const bia = await TestClient.join(node.port, room, 'bia');
    await setUpTransports(bia.client, bia.ready);
    assert.equal(node.registry.stats().roomsSpanningWorkers, 1);

    await bia.client.leave();
    await until(() => node.registry.stats().roomsSpanningWorkers === 0, 2_000, 'a sala voltar a um Worker');
    assert.equal(node.pool.slots.reduce((sum, slot) => sum + slot.routers, 0), 1);
    // Quem ficou continua publicando normalmente.
    assert.equal(node.registry.publishedTracksInRoom(room).length, 1);
    await ana.client.leave();
    await until(() => node.pool.slots.every((slot) => slot.units === 0 && slot.routers === 0), 2_000, 'o nó esvaziar');
  });
});
