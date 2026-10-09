/**
 * A configuração do nó: o que a máquina decide sozinha e o que recusa subir.
 *
 * O padrão de Workers é a peça que faz "trocar a VM por uma maior" bastar
 * para ter mais capacidade — e é exatamente o tipo de regra que, errada, não
 * falha: o nó sobe com um Worker só e ninguém nota até a sala engasgar.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config';

const BASE = { MEDIASOUP_INTERNAL_SECRET: 'segredo', MEDIASOUP_ANNOUNCED_IP: '203.0.113.7' };

describe('configuração do nó', () => {
  it('lista de uma vez tudo o que falta', () => {
    assert.throws(
      () => loadConfig({}, 4),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('MEDIASOUP_INTERNAL_SECRET') &&
        error.message.includes('MEDIASOUP_ANNOUNCED_IP'),
    );
  });

  it('sem MEDIASOUP_WORKERS, sobe um Worker por núcleo da máquina', () => {
    assert.equal(loadConfig(BASE, 1).workers, 1);
    assert.equal(loadConfig(BASE, 8).workers, 8);
  });

  it('nunca mais Workers do que portas de mídia na faixa', () => {
    // Faixa padrão: 40101-40200, cem portas.
    assert.equal(loadConfig(BASE, 512).workers, 100);
    const estreita = { ...BASE, MEDIASOUP_RTC_MIN_PORT: '40101', MEDIASOUP_RTC_MAX_PORT: '40102' };
    assert.equal(loadConfig(estreita, 16).workers, 2);
  });

  it('MEDIASOUP_WORKERS contraria o automático', () => {
    assert.equal(loadConfig({ ...BASE, MEDIASOUP_WORKERS: '1' }, 32).workers, 1);
    assert.equal(loadConfig({ ...BASE, MEDIASOUP_WORKERS: '6' }, 2).workers, 6);
  });

  it('MEDIASOUP_WORKERS=auto devolve a decisão à máquina', () => {
    assert.equal(loadConfig({ ...BASE, MEDIASOUP_WORKERS: 'auto' }, 8).workers, 8);
    assert.equal(loadConfig({ ...BASE, MEDIASOUP_WORKERS: ' AUTO ' }, 4).workers, 4);
  });

  it('recusa subir com mais Workers pedidos do que portas — em vez de subir com menos', () => {
    const env = { ...BASE, MEDIASOUP_WORKERS: '3', MEDIASOUP_RTC_MIN_PORT: '40101', MEDIASOUP_RTC_MAX_PORT: '40102' };
    assert.throws(() => loadConfig(env, 8), ConfigError);
  });

  it('recusa faixa de pontes que disputaria porta com a de mídia', () => {
    const env = { ...BASE, MEDIASOUP_PIPE_MIN_PORT: '40150', MEDIASOUP_PIPE_MAX_PORT: '40300' };
    assert.throws(() => loadConfig(env, 4), ConfigError);
  });

  it('recusa número que não é inteiro positivo', () => {
    assert.throws(() => loadConfig({ ...BASE, MEDIASOUP_WORKERS: '0' }, 4), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, MEDIASOUP_WORKER_CAPACITY: 'muito' }, 4), ConfigError);
  });

  it('mantém as portas e a escuta de sempre quando nada é dito', () => {
    const config = loadConfig(BASE, 2);
    assert.equal(config.port, 3100);
    assert.equal(config.listenIp, '0.0.0.0');
    assert.equal(config.rtcMinPort, 40101);
    assert.equal(config.rtcMaxPort, 40200);
    assert.equal(config.announcedIp, '203.0.113.7');
  });
});
