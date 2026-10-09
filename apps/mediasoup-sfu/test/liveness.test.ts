/**
 * A folga de reconexão: quem some volta, quem se despede sai na hora.
 *
 * É a regra que decide se uma queda de rede de dois segundos derruba a voz
 * de alguém — e ela erra em silêncio para os dois lados: folga de menos
 * derruba quem só trocou de Wi-Fi, folga onde não devia deixa fantasma no
 * roster de quem fechou a aba.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PeerLiveness } from '../src/liveness';

const GRACE_MS = 40;

function setup(): { liveness: PeerLiveness; expired: string[] } {
  const expired: string[] = [];
  const liveness = new PeerLiveness(GRACE_MS, (roomSlug, peerId, reason) => {
    expired.push(`${roomSlug}/${peerId}:${reason}`);
  });
  return { liveness, expired };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('folga de reconexão', () => {
  it('quem cai e volta dentro da folga não é removido', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'signal:1');
    liveness.detach('sala', 'ana', 'signal:1', false);
    await wait(GRACE_MS / 2);
    liveness.attach('sala', 'ana', 'signal:2');
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);
  });

  it('quem cai e não volta é removido quando a folga vence, e não antes', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'signal:1');
    liveness.detach('sala', 'ana', 'signal:1', false);
    await wait(GRACE_MS / 2);
    assert.deepEqual(expired, []);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, ['sala/ana:timeout']);
  });

  it('despedida remove na hora, mesmo com o outro canal da mesma página ainda aberto', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'presence:1', 'pagina');
    liveness.attach('sala', 'ana', 'signal:1', 'pagina');
    liveness.detach('sala', 'ana', 'signal:1', true);
    assert.deepEqual(expired, ['sala/ana:left']);

    // O canal que sobrou fecha logo depois: não há segunda remoção.
    liveness.detach('sala', 'ana', 'presence:1', false);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, ['sala/ana:left']);
  });

  it('com dois canais, perder um não inicia contagem nenhuma', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'presence:1');
    liveness.attach('sala', 'ana', 'signal:1');
    liveness.detach('sala', 'ana', 'presence:1', false);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);

    liveness.detach('sala', 'ana', 'signal:1', false);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, ['sala/ana:timeout']);
  });

  it('o disconnect atrasado do canal ANTIGO não derruba quem já reconectou', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'presence:velho');
    // A ordem entre "nova conexão" e "desconexão da antiga" não é garantida.
    liveness.attach('sala', 'ana', 'presence:novo');
    liveness.detach('sala', 'ana', 'presence:velho', false);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);
  });

  it('par removido por outro caminho não é removido de novo', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'signal:1');
    liveness.detach('sala', 'ana', 'signal:1', false);
    liveness.forget('sala', 'ana');
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);
  });

  it('pares de mesmo id em salas diferentes não se misturam', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala-a', 'ana', 'signal:1');
    liveness.attach('sala-b', 'ana', 'signal:2');
    liveness.detach('sala-a', 'ana', 'signal:1', false);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, ['sala-a/ana:timeout']);
  });
});

describe('folga de reconexão — de qual página veio o canal', () => {
  it('a despedida de uma página não derruba a outra que acabou de entrar com o mesmo par', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'presence:1', 'pagina-velha');
    liveness.attach('sala', 'ana', 'signal:1', 'pagina-velha');
    // Saiu e entrou de novo: os canais novos chegam ANTES da despedida dos antigos.
    liveness.attach('sala', 'ana', 'presence:2', 'pagina-nova');
    liveness.attach('sala', 'ana', 'signal:2', 'pagina-nova');
    liveness.detach('sala', 'ana', 'signal:1', true);
    liveness.detach('sala', 'ana', 'presence:1', true);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);

    // E a página nova, quando ELA se despede, sai na hora.
    liveness.detach('sala', 'ana', 'signal:2', true);
    assert.deepEqual(expired, ['sala/ana:left']);
  });

  it('canal do cliente antigo (sem instância) conta como de outra página', async () => {
    const { liveness, expired } = setup();
    liveness.attach('sala', 'ana', 'presence:antigo');
    liveness.attach('sala', 'ana', 'presence:novo');
    liveness.detach('sala', 'ana', 'presence:antigo', true);
    await wait(GRACE_MS * 2);
    assert.deepEqual(expired, []);

    liveness.detach('sala', 'ana', 'presence:novo', true);
    assert.deepEqual(expired, ['sala/ana:left']);
  });
});
