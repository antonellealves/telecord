/**
 * A verificação de assinatura do webhook do LiveKit.
 *
 * É a única rota pública do serviço que ESCREVE, e o que ela escreve é a
 * tabela de sessões — a fonte dos minutos de conversa que o painel mostra.
 * Se ela ceder, qualquer pessoa inventa atividade que nunca existiu.
 *
 * O caso que dá nome ao arquivo é o terceiro: um JWT legítimo, capturado de
 * uma entrega de verdade, reapresentado com OUTRO corpo. A assinatura continua
 * válida — ela cobre o token, não o corpo —, e o que fecha essa porta é o
 * campo `sha256` de dentro do token. Sem conferi-lo, a verificação inteira é
 * decorativa.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { verifyLiveKitWebhook } from '../src/livekit/webhook-auth';

const API_KEY = 'APIchavedeteste';
const API_SECRET = 'segredo-do-projeto-de-teste-bem-comprido';

function secretOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Assina como o LiveKit assina: HS256, `iss` = key, `sha256` = hash do corpo. */
async function sign(
  body: Buffer,
  options: { secret?: string; issuer?: string; hash?: string; expired?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sha256: options.hash ?? createHash('sha256').update(body).digest('base64') })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? API_KEY)
    .setIssuedAt(now - (options.expired === true ? 3600 : 0))
    .setExpirationTime(options.expired === true ? now - 1800 : now + 300)
    .sign(secretOf(options.secret ?? API_SECRET));
}

function event(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'EV_123',
      event: 'participant_joined',
      createdAt: 1_700_000_000,
      room: { name: 'sala-do-dota' },
      participant: { identity: 'abc', name: 'Fulano' },
      ...overrides,
    }),
    'utf8',
  );
}

async function check(body: Buffer, authorization: string | undefined): ReturnType<typeof verifyLiveKitWebhook> {
  return verifyLiveKitWebhook({ authorization, body, apiKey: API_KEY, apiSecret: API_SECRET });
}

describe('assinatura do webhook do LiveKit', () => {
  it('aceita evento assinado corretamente', async () => {
    const body = event();
    const result = await check(body, await sign(body));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.event.event, 'participant_joined');
    assert.equal(result.event.roomName, 'sala-do-dota');
    assert.equal(result.event.participantIdentity, 'abc');
    assert.equal(result.event.id, 'EV_123');
  });

  it('aceita com o prefixo Bearer, que algumas versões mandam', async () => {
    const body = event();
    const result = await check(body, `Bearer ${await sign(body)}`);
    assert.equal(result.ok, true);
  });

  // ---------------------------------------------------------------------------
  // O que precisa ser recusado
  // ---------------------------------------------------------------------------

  it('RECUSA token válido reapresentado com outro corpo', async () => {
    /*
     * O ataque que justifica o campo `sha256`. O token é autêntico, assinado
     * pelo LiveKit de verdade; só o corpo foi trocado — por um que inventa
     * horas de sala. Sem conferir o hash, isto passaria.
     */
    const autorizacao = await sign(event());
    const forjado = event({ room: { name: 'sala-inventada' }, id: 'EV_999' });

    const result = await check(forjado, autorizacao);
    assert.equal(result.ok, false);
  });

  it('RECUSA assinatura de outra chave', async () => {
    const body = event();
    const result = await check(body, await sign(body, { secret: 'segredo-de-outro-projeto' }));
    assert.equal(result.ok, false);
  });

  it('RECUSA token emitido por outro projeto', async () => {
    // Mesmo segredo não basta: o `iss` tem que ser a nossa API key.
    const body = event();
    const result = await check(body, await sign(body, { issuer: 'APIoutroprojeto' }));
    assert.equal(result.ok, false);
  });

  it('RECUSA token vencido', async () => {
    const body = event();
    const result = await check(body, await sign(body, { expired: true }));
    assert.equal(result.ok, false);
  });

  it('RECUSA token sem o hash do corpo', async () => {
    const body = event();
    const semHash = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(API_KEY)
      .setExpirationTime('5m')
      .sign(secretOf(API_SECRET));

    const result = await check(body, semHash);
    assert.equal(result.ok, false);
  });

  it('RECUSA requisição sem cabeçalho', async () => {
    assert.equal((await check(event(), undefined)).ok, false);
    assert.equal((await check(event(), '')).ok, false);
  });

  it('RECUSA algoritmo "none"', async () => {
    /*
     * O token declara `alg: none` e vem sem assinatura. Sem fixar o algoritmo
     * na verificação, bibliotecas de JWT aceitam isso — e aí nem é preciso ter
     * o segredo para forjar evento.
     */
    const body = event();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: API_KEY,
        sha256: createHash('sha256').update(body).digest('base64'),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');

    const result = await check(body, `${header}.${payload}.`);
    assert.equal(result.ok, false);
  });

  it('RECUSA corpo que não é evento reconhecível', async () => {
    const body = Buffer.from('{"nada":"aqui"}', 'utf8');
    const result = await check(body, await sign(body));
    assert.equal(result.ok, false, 'sem campo `event` não há o que processar');
  });

  // ---------------------------------------------------------------------------
  // Leitura do evento
  // ---------------------------------------------------------------------------

  it('lê createdAt em segundos, inclusive como texto', async () => {
    /*
     * O campo é `int64` no protobuf, e o JSON o serializa entre aspas para não
     * perder precisão. Tratado como milissegundos, todo evento cairia em 1970
     * e a série do painel ficaria vazia sem ninguém entender por quê.
     */
    const body = event({ createdAt: '1700000000' });
    const result = await check(body, await sign(body));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.event.createdAt, 1_700_000_000_000);
  });

  it('tolera campos ausentes sem estourar', async () => {
    // Formato pode mudar entre versões do LiveKit, e exceção aqui faria o
    // evento ser reentregue em laço.
    const body = Buffer.from(JSON.stringify({ event: 'room_finished' }), 'utf8');
    const result = await check(body, await sign(body));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.event.roomName, null);
    assert.equal(result.event.participantIdentity, null);
    assert.equal(result.event.id, null);
  });
});
