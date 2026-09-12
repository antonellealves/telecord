/**
 * O transporte Cloudflare (Cloudflare Realtime SFU), na borda que dá para
 * testar sem navegador: a leitura da configuração (ligado/desligado, cota) e o
 * cliente HTTP do SFU (criação de sessão, publicação de tracks, e a recusa de
 * respostas ruins).
 *
 * Roda sem banco e sem rede: a config é função pura, e o `fetch` é substituído
 * por um dublê tipado. O fluxo WebRTC completo (offer/answer/renegociação entre
 * navegador e SFU) exige credencial da Cloudflare e dois navegadores, e fica
 * para a validação ponta a ponta.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig, type AppConfig } from '../src/common/config';
import { AppError } from '../src/common/errors';
import { CloudflareRealtimeClient } from '../src/cfsfu/cloudflare-realtime.client';

const BASE_ENV: NodeJS.ProcessEnv = {
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:3000/api',
  DATABASE_URL: 'mysql://root@localhost:4000/telecord',
  AUTH_JWT_PRIVATE_KEY: 'chave-privada-de-teste',
  AUTH_JWT_PUBLIC_KEY: 'chave-publica-de-teste',
};

function envWith(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...extra };
}

/** Config com o Cloudflare ligado, para construir o cliente nos testes. */
function enabledConfig(): AppConfig {
  return loadConfig(
    envWith({
      CF_REALTIME_APP_ID: 'app-de-teste',
      CF_REALTIME_APP_TOKEN: 'token-de-teste',
    }),
  );
}

/** Substitui o `fetch` global por um dublê tipado e devolve como restaurar. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): () => void {
  const original = globalThis.fetch;
  const fake: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(handler(String(input), init));
  globalThis.fetch = fake;
  return () => {
    globalThis.fetch = original;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('configuração do Cloudflare', () => {
  it('sem credencial devolve null', () => {
    assert.equal(loadConfig(BASE_ENV).cfsfu, null);
  });

  it('a PRESENÇA da credencial liga — sem flag separada para lembrar', () => {
    const config = enabledConfig();
    assert.notEqual(config.cfsfu, null);
    assert.equal(config.cfsfu?.appId, 'app-de-teste');
    assert.equal(config.cfsfu?.appToken, 'token-de-teste');
    assert.equal(config.cfsfu?.monthlyLimitGb, 1000);
  });

  it('respeita CF_REALTIME_MONTHLY_GB_LIMIT', () => {
    const config = loadConfig(
      envWith({
        CF_REALTIME_APP_ID: 'x',
        CF_REALTIME_APP_TOKEN: 'y',
        CF_REALTIME_MONTHLY_GB_LIMIT: '250',
      }),
    );
    assert.equal(config.cfsfu?.monthlyLimitGb, 250);
  });

  it('CF_REALTIME_ENABLED=false desliga mesmo com credencial presente', () => {
    const config = loadConfig(
      envWith({
        CF_REALTIME_APP_ID: 'x',
        CF_REALTIME_APP_TOKEN: 'y',
        CF_REALTIME_ENABLED: 'false',
      }),
    );
    assert.equal(config.cfsfu, null);
  });

  it('só metade da credencial derruba o boot', () => {
    assert.throws(() => loadConfig(envWith({ CF_REALTIME_APP_ID: 'só-o-id' })), /CF_REALTIME_APP_ID/);
  });

  it('aceita os nomes CLOUDFLARE_REALTIME_* como reserva', () => {
    const config = loadConfig(
      envWith({
        CLOUDFLARE_REALTIME_APP_ID: 'via-alias',
        CLOUDFLARE_REALTIME_APP_SECRET: 'segredo-alias',
      }),
    );
    assert.equal(config.cfsfu?.appId, 'via-alias');
    assert.equal(config.cfsfu?.appToken, 'segredo-alias');
  });
});

describe('CloudflareRealtimeClient', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('cria sessão e devolve o sessionId', async () => {
    let vistoUrl = '';
    let vistoAuth: string | null = null;
    restore = stubFetch((url, init) => {
      vistoUrl = url;
      const headers = new Headers(init?.headers);
      vistoAuth = headers.get('Authorization');
      return json({ sessionId: 'sess-123' });
    });
    const client = new CloudflareRealtimeClient(enabledConfig());
    const result = await client.createSession();
    assert.equal(result.sessionId, 'sess-123');
    assert.match(vistoUrl, /\/v1\/apps\/app-de-teste\/sessions\/new$/);
    assert.equal(vistoAuth, 'Bearer token-de-teste');
  });

  it('publica tracks e devolve a answer', async () => {
    restore = stubFetch(() =>
      json({
        requiresImmediateRenegotiation: false,
        sessionDescription: { type: 'answer', sdp: 'v=0...' },
        tracks: [{ mid: '0', trackName: 'screen-video' }],
      }),
    );
    const client = new CloudflareRealtimeClient(enabledConfig());
    const result = await client.newTracks('sess-1', {
      sessionDescription: { type: 'offer', sdp: 'v=0...' },
      tracks: [{ location: 'local', mid: '0', trackName: 'screen-video' }],
    });
    assert.equal(result.requiresImmediateRenegotiation, false);
    assert.equal(result.tracks.length, 1);
  });

  it('recusa resposta HTTP não-ok (503 AppError)', async () => {
    restore = stubFetch(() => json({ nope: true }, 500));
    const client = new CloudflareRealtimeClient(enabledConfig());
    await assert.rejects(
      () => client.createSession(),
      (error) => error instanceof AppError && error.getStatus() === 503,
    );
  });

  it('recusa corpo com errorCode, mesmo em HTTP 200', async () => {
    restore = stubFetch(() => json({ errorCode: 'NoSuchSession', errorDescription: 'sumiu' }));
    const client = new CloudflareRealtimeClient(enabledConfig());
    await assert.rejects(
      () => client.createSession(),
      (error) => error instanceof AppError && error.getStatus() === 503,
    );
  });

  it('recusa resposta com forma inesperada', async () => {
    restore = stubFetch(() => json({ semSessionId: true }));
    const client = new CloudflareRealtimeClient(enabledConfig());
    await assert.rejects(
      () => client.createSession(),
      (error) => error instanceof AppError && error.getStatus() === 503,
    );
  });

  it('sem configuração, recusa antes de tocar na rede', async () => {
    const client = new CloudflareRealtimeClient(loadConfig(BASE_ENV));
    assert.equal(client.enabled, false);
    await assert.rejects(
      () => client.createSession(),
      (error) => error instanceof AppError && error.getStatus() === 503,
    );
  });
});
