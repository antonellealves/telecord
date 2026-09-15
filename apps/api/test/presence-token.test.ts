/**
 * Assinatura/verificação do token de presença (canal Socket.IO do
 * mediasoup-sfu) — lógica pura em `@telecord/shared`, sem rede. Mesmo
 * espírito de `webhook-auth.test.ts`: regras que quebram caladas (assinatura
 * de outro segredo aceita, token vencido aceito) não podem depender só de
 * teste manual.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  signAdminPresenceToken,
  signPresenceToken,
  verifyAdminPresenceToken,
  verifyPresenceToken,
} from '@telecord/shared';

const SECRET = 'segredo-de-teste-bem-longo-o-suficiente';

describe('token de presença de peer', () => {
  it('assina e verifica de volta os mesmos claims', async () => {
    const token = await signPresenceToken({
      peerId: 'peer-1',
      roomSlug: 'sala-teste',
      displayName: 'Fulano de Tal',
      secret: SECRET,
      ttlMs: 60_000,
    });
    const claims = await verifyPresenceToken(token, SECRET);
    assert.notEqual(claims, null);
    assert.equal(claims?.peerId, 'peer-1');
    assert.equal(claims?.roomSlug, 'sala-teste');
    assert.equal(claims?.displayName, 'Fulano de Tal');
  });

  it('RECUSA assinatura de outro segredo', async () => {
    const token = await signPresenceToken({
      peerId: 'peer-1',
      roomSlug: 'sala-teste',
      displayName: 'Fulano',
      secret: SECRET,
      ttlMs: 60_000,
    });
    const claims = await verifyPresenceToken(token, 'outro-segredo-completamente-diferente');
    assert.equal(claims, null);
  });

  it('RECUSA token vencido', async () => {
    const token = await signPresenceToken({
      peerId: 'peer-1',
      roomSlug: 'sala-teste',
      displayName: 'Fulano',
      secret: SECRET,
      ttlMs: -1000,
    });
    const claims = await verifyPresenceToken(token, SECRET);
    assert.equal(claims, null);
  });

  it('RECUSA token malformado', async () => {
    assert.equal(await verifyPresenceToken('lixo-qualquer', SECRET), null);
    assert.equal(await verifyPresenceToken('a.b.c', SECRET), null);
  });

  it('RECUSA payload adulterado mesmo com assinatura de formato válido', async () => {
    const token = await signPresenceToken({
      peerId: 'peer-1',
      roomSlug: 'sala-teste',
      displayName: 'Fulano',
      secret: SECRET,
      ttlMs: 60_000,
    });
    const partes = token.split('.');
    partes[0] = 'peer-adulterado';
    const claims = await verifyPresenceToken(partes.join('.'), SECRET);
    assert.equal(claims, null);
  });

  it('não confunde um token de peer com um de admin', async () => {
    const token = await signPresenceToken({
      peerId: 'peer-1',
      roomSlug: 'sala-teste',
      displayName: 'Fulano',
      secret: SECRET,
      ttlMs: 60_000,
    });
    assert.equal(await verifyAdminPresenceToken(token, SECRET), null);
  });
});

describe('token de presença de admin', () => {
  it('assina e verifica de volta o actorId, sem roomSlug fixo', async () => {
    const token = await signAdminPresenceToken({ actorId: 'admin-1', secret: SECRET, ttlMs: 60_000 });
    const claims = await verifyAdminPresenceToken(token, SECRET);
    assert.notEqual(claims, null);
    assert.equal(claims?.actorId, 'admin-1');
  });

  it('RECUSA assinatura de outro segredo', async () => {
    const token = await signAdminPresenceToken({ actorId: 'admin-1', secret: SECRET, ttlMs: 60_000 });
    const claims = await verifyAdminPresenceToken(token, 'outro-segredo-completamente-diferente');
    assert.equal(claims, null);
  });

  it('RECUSA token vencido', async () => {
    const token = await signAdminPresenceToken({ actorId: 'admin-1', secret: SECRET, ttlMs: -1000 });
    assert.equal(await verifyAdminPresenceToken(token, SECRET), null);
  });

  it('não confunde um token de admin com um de peer', async () => {
    const token = await signAdminPresenceToken({ actorId: 'admin-1', secret: SECRET, ttlMs: 60_000 });
    assert.equal(await verifyPresenceToken(token, SECRET), null);
  });
});
