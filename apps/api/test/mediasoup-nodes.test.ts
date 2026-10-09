/**
 * Em qual nó do SFU cada sala mora.
 *
 * A regra que não pode quebrar: todo mundo da MESMA sala é mandado para o
 * mesmo nó, sempre — inclusive no meio de uma mudança na lista de nós. Errar
 * aqui não dá erro em lugar nenhum: a sala racha em duas de mesmo nome, e
 * quem entrou depois simplesmente não ouve quem já estava.
 *
 * Roda sem banco e sem rede, como o resto da pasta: o `fetch` é trocado por
 * um que responde no lugar dos nós.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AppConfig } from '../src/common/config';
import { loadConfig } from '../src/common/config';
import { MediasoupSfuClient } from '../src/mediasoup/mediasoup-sfu.client';
import { pickNode, rankNodes } from '../src/mediasoup/node-ring';

const A = 'https://ms-a.exemplo';
const B = 'https://ms-b.exemplo';
const C = 'https://ms-c.exemplo';

const salas = Array.from({ length: 2_000 }, (_unused, index) => `sala-${index}`);

describe('rendezvous — a conta que escolhe o nó', () => {
  it('é determinística e não depende da ordem em que os nós foram escritos', () => {
    for (const sala of salas.slice(0, 200)) {
      assert.equal(pickNode([A, B, C], sala), pickNode([C, A, B], sala));
      assert.equal(pickNode([A, B, C], sala), pickNode([A, B, C], sala));
    }
  });

  it('com um nó só, toda sala mora nele', () => {
    for (const sala of salas.slice(0, 50)) assert.equal(pickNode([A], sala), A);
  });

  it('acrescentar um nó só move salas PARA o nó novo — nenhuma troca entre os antigos', () => {
    let movidas = 0;
    for (const sala of salas) {
      const antes = pickNode([A, B], sala);
      const depois = pickNode([A, B, C], sala);
      if (antes === depois) continue;
      movidas += 1;
      assert.equal(depois, C, `${sala} saiu de ${antes} para ${depois}, que não é o nó novo`);
    }
    // Por volta de um terço: o nó novo fica com a parte dele, e só.
    assert.ok(movidas > salas.length * 0.25 && movidas < salas.length * 0.42, `movidas: ${movidas}`);
  });

  it('tirar um nó só move as salas que moravam nele', () => {
    for (const sala of salas) {
      const antes = pickNode([A, B, C], sala);
      const depois = pickNode([A, B], sala);
      if (antes !== C) assert.equal(depois, antes, `${sala} não morava no nó removido e mudou assim mesmo`);
      // E vai para o segundo colocado da ordem de preferência.
      else assert.equal(depois, rankNodes([A, B, C], sala)[1]);
    }
  });

  it('espalha as salas entre os nós sem favorito', () => {
    const contagem = new Map<string, number>([[A, 0], [B, 0], [C, 0]]);
    for (const sala of salas) {
      const node = pickNode([A, B, C], sala);
      contagem.set(node, (contagem.get(node) ?? 0) + 1);
    }
    for (const [node, total] of contagem) {
      assert.ok(total > salas.length * 0.28 && total < salas.length * 0.39, `${node} ficou com ${total}`);
    }
  });
});

// ---------------------------------------------------------------------------

interface Chamada {
  node: string;
  method: string;
  path: string;
  body: unknown;
}

/**
 * Troca o `fetch` por um que faz o papel dos nós: `ocupacao[nó][sala]` é
 * quanta gente aquele nó diz ter naquela sala; nó em `foraDoAr` não responde.
 */
function fingeNos(
  ocupacao: Record<string, Record<string, number>>,
  foraDoAr: string[] = [],
): { chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const node = url.origin;
    const path = url.pathname;
    chamadas.push({
      node,
      method: init?.method ?? 'GET',
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (foraDoAr.includes(node)) throw new Error('nó fora do ar');

    if (path === '/rooms/presence') {
      const rooms = Object.entries(ocupacao[node] ?? {})
        .filter(([, participants]) => participants > 0)
        .map(([slug, participants]) => ({ slug, participants, earliestJoinedAt: '2026-01-01T00:00:00.000Z' }));
      return Response.json({ rooms });
    }
    const presence = /^\/rooms\/([^/]+)\/presence$/.exec(path);
    if (presence !== null) {
      const total = ocupacao[node]?.[decodeURIComponent(presence[1]!)] ?? 0;
      const peers = Array.from({ length: total }, (_unused, index) => ({
        peerId: `p${index}`,
        displayName: `P${index}`,
        joinedAt: '2026-01-01T00:00:00.000Z',
      }));
      return Response.json({ peers });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { chamadas };
}

function cliente(nodeUrls: string[]): MediasoupSfuClient {
  return new MediasoupSfuClient({ mediasoup: { nodeUrls, internalSecret: 'segredo' } } as AppConfig);
}

describe('cliente do SFU — para qual nó cada chamada vai', () => {
  const fetchOriginal = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it('com um nó só não pergunta nada a ninguém: vai direto', async () => {
    const { chamadas } = fingeNos({});
    const sfu = cliente([A]);
    assert.equal(sfu.multiNode, false);
    assert.equal(await sfu.nodeFor('qualquer'), A);
    await sfu.createTransport('qualquer', { peerId: 'ana', direction: 'send' });
    assert.deepEqual(
      chamadas.map((chamada) => `${chamada.method} ${chamada.node}${chamada.path}`),
      [`POST ${A}/rooms/qualquer/transports`],
    );
  });

  it('sala vazia vai para o nó que a conta escolhe', async () => {
    fingeNos({});
    const sfu = cliente([A, B, C]);
    assert.equal(sfu.multiNode, true);
    for (const sala of salas.slice(0, 20)) {
      assert.equal(await sfu.nodeFor(sala), pickNode([A, B, C], sala));
    }
  });

  it('sala que JÁ tem gente fica onde está, mesmo que a conta mande para outro nó', async () => {
    // Uma sala que a conta poria em A, mas que está viva em B — é o que
    // acontece logo depois de acrescentar um nó à lista.
    const sala = salas.find((slug) => pickNode([A, B], slug) === A)!;
    fingeNos({ [B]: { [sala]: 3 } });
    assert.equal(await cliente([A, B]).nodeFor(sala), B);
  });

  it('sala rachada em dois nós: quem entra vai para onde está a maioria', async () => {
    fingeNos({ [A]: { rachada: 1 }, [B]: { rachada: 4 } });
    assert.equal(await cliente([A, B]).nodeFor('rachada'), B);
  });

  it('nó fora do ar não recebe sala nova', async () => {
    const sala = salas.find((slug) => pickNode([A, B], slug) === A)!;
    fingeNos({}, [A]);
    assert.equal(await cliente([A, B]).nodeFor(sala), B);
  });

  it('todas as chamadas de uma entrada vão para o MESMO nó, com uma consulta só', async () => {
    const { chamadas } = fingeNos({});
    const sfu = cliente([A, B, C]);
    await sfu.routerRtpCapabilities('reuniao');
    await sfu.createTransport('reuniao', { peerId: 'ana', direction: 'send' });
    await sfu.createTransport('reuniao', { peerId: 'ana', direction: 'recv' });

    const consultas = chamadas.filter((chamada) => chamada.path === '/rooms/reuniao/presence');
    assert.equal(consultas.length, 3, 'uma consulta por nó, uma vez');
    const efetivas = chamadas.filter((chamada) => chamada.path !== '/rooms/reuniao/presence');
    assert.equal(efetivas.length, 3);
    assert.equal(new Set(efetivas.map((chamada) => chamada.node)).size, 1);
    assert.equal(efetivas[0]!.node, pickNode([A, B, C], 'reuniao'));
  });

  it('remoção pela moderação avisa o SFU de que é expulsão; saída comum, não', async () => {
    const { chamadas } = fingeNos({});
    const sfu = cliente([A]);
    await sfu.leave('sala', 'ana', true);
    await sfu.leave('sala', 'bia');
    assert.deepEqual(
      chamadas.map((chamada) => chamada.body),
      [{ peerId: 'ana', kicked: true }, { peerId: 'bia' }],
    );
  });

  it('a lista de salas ao vivo junta todos os nós e diz onde cada uma está', async () => {
    fingeNos({ [A]: { dota: 3 }, [B]: { filme: 2 }, [C]: {} });
    const rooms = await cliente([A, B, C]).liveRoomsPresence();
    assert.deepEqual(
      rooms.map((room) => `${room.slug}@${room.node}:${room.participants}`).sort(),
      [`dota@${A}:3`, `filme@${B}:2`],
    );
  });

  it('um nó fora do ar não esconde as salas dos outros; todos fora é erro', async () => {
    fingeNos({ [A]: { dota: 3 }, [B]: { filme: 2 } }, [A]);
    const rooms = await cliente([A, B]).liveRoomsPresence();
    assert.deepEqual(
      rooms.map((room) => room.slug),
      ['filme'],
    );

    fingeNos({}, [A, B]);
    await assert.rejects(cliente([A, B]).liveRoomsPresence());
  });
});

// ---------------------------------------------------------------------------

describe('configuração — MEDIASOUP_INTERNAL_URL', () => {
  const base = {
    APP_URL: 'https://telecord.example',
    API_URL: 'https://telecord.example/api',
    DATABASE_URL: 'mysql://u:p@127.0.0.1:4000/t',
    AUTH_JWT_PRIVATE_KEY: 'chave',
    AUTH_JWT_PUBLIC_KEY: 'chave',
  };

  it('sem URL e sem segredo, o recurso fica desligado', () => {
    assert.equal(loadConfig(base).mediasoup, null);
  });

  it('uma URL é um nó, como sempre foi — inclusive http na rede interna do Docker', () => {
    const config = loadConfig({
      ...base,
      MEDIASOUP_INTERNAL_URL: 'http://mediasoup-sfu:3100/',
      MEDIASOUP_INTERNAL_SECRET: 's',
    });
    assert.deepEqual(config.mediasoup, { nodeUrls: ['http://mediasoup-sfu:3100'], internalSecret: 's' });
  });

  it('várias URLs separadas por vírgula são vários nós', () => {
    const config = loadConfig({
      ...base,
      MEDIASOUP_INTERNAL_URL: ` ${A}/ , ${B} ,`,
      MEDIASOUP_INTERNAL_SECRET: 's',
    });
    assert.deepEqual(config.mediasoup?.nodeUrls, [A, B]);
  });

  it('recusa metade da credencial, nó repetido, endereço torto e nó sem TLS numa lista', () => {
    const recusadas: Record<string, string>[] = [
      { MEDIASOUP_INTERNAL_URL: A },
      { MEDIASOUP_INTERNAL_SECRET: 's' },
      { MEDIASOUP_INTERNAL_URL: `${A},${A}/`, MEDIASOUP_INTERNAL_SECRET: 's' },
      { MEDIASOUP_INTERNAL_URL: 'ms-a.exemplo', MEDIASOUP_INTERNAL_SECRET: 's' },
      { MEDIASOUP_INTERNAL_URL: `${A},http://ms-b.exemplo`, MEDIASOUP_INTERNAL_SECRET: 's' },
    ];
    for (const extra of recusadas) {
      assert.throws(() => loadConfig({ ...base, ...extra }), `deveria recusar ${JSON.stringify(extra)}`);
    }
  });
});
