/**
 * O filtro que impede credencial de entrar no log.
 *
 * Este arquivo existe porque a regra "nunca logar senha, token ou refresh
 * token" não se verifica lendo código: ela falha no dia em que alguém escreve
 * `context: { ...body }` num caminho de erro. O que dá para verificar é que o
 * filtro obrigatório no meio do caminho remove o que precisa remover — e é
 * isso que está aqui.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HIDDEN, redactContext } from '../src/logging/redact';

describe('redação do contexto de log', () => {
  it('esconde o valor de campo com nome de credencial', () => {
    const result = redactContext({
      email: 'alguem@exemplo.com',
      password: 'senha-secreta-de-verdade',
      refreshToken: 'abc123',
      authorization: 'Bearer xyz',
    });

    assert.equal(result?.email, 'alguem@exemplo.com', 'e-mail não é credencial');
    assert.equal(result?.password, HIDDEN);
    assert.equal(result?.refreshToken, HIDDEN);
    assert.equal(result?.authorization, HIDDEN);
  });

  it('pega o nome em português e em qualquer caixa', () => {
    const result = redactContext({ Senha: 'x', SECRET_KEY: 'y', apiKey: 'z' });
    assert.equal(result?.Senha, HIDDEN);
    assert.equal(result?.SECRET_KEY, HIDDEN);
    assert.equal(result?.apiKey, HIDDEN);
  });

  it('esconde JWT mesmo num campo de nome inocente', () => {
    /*
     * O caso que o filtro por nome não pega: alguém registra o corpo inteiro
     * de uma requisição num campo chamado `dados`, e dentro dele vem o token.
     */
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.assinatura-aqui';
    const result = redactContext({ dados: jwt });
    assert.equal(result?.dados, HIDDEN);
  });

  it('esconde chave privada PEM em qualquer campo', () => {
    const result = redactContext({
      conteudo: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vw\n-----END PRIVATE KEY-----',
    });
    assert.equal(result?.conteudo, HIDDEN);
  });

  it('desce em objeto aninhado', () => {
    const result = redactContext({ corpo: { user: { email: 'a@b.co', password: 'p' } } });
    const corpo = result?.corpo as { user: { email: string; password: string } };
    assert.equal(corpo.user.email, 'a@b.co');
    assert.equal(corpo.user.password, HIDDEN);
  });

  it('corta profundidade, largura e comprimento', () => {
    // Um log não é um dump: sem teto, um contexto malfeito vira problema de
    // armazenamento fingindo ser diagnóstico.
    const fundo = { a: { b: { c: { d: { e: 'marcador-do-quinto-nivel' } } } } };
    assert.equal(
      JSON.stringify(redactContext(fundo)).includes('marcador-do-quinto-nivel'),
      false,
      'o quinto nível não deveria ser gravado',
    );

    const largo: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) largo[`campo${index}`] = index;
    assert.ok(Object.keys(redactContext(largo) ?? {}).length <= 33);

    const comprido = redactContext({ texto: 'x'.repeat(5000) });
    assert.ok(String(comprido?.texto).length < 400);

    const lista = redactContext({ itens: Array.from({ length: 200 }, (_, i) => i) });
    assert.ok((lista?.itens as unknown[]).length <= 21);
  });

  it('devolve null quando não sobra nada para gravar', () => {
    // Coluna nula ocupa menos e diz o mesmo que `{}`.
    assert.equal(redactContext(undefined), null);
    assert.equal(redactContext({}), null);
  });

  it('preserva o que é útil para diagnosticar', () => {
    // O filtro não pode ser tão largo que esvazie o log: se número, booleano e
    // data não passarem, ninguém mais consegue investigar nada.
    const result = redactContext({ status: 500, ok: false, quando: new Date(0), quantos: 12 });
    assert.equal(result?.status, 500);
    assert.equal(result?.ok, false);
    assert.equal(result?.quando, '1970-01-01T00:00:00.000Z');
    assert.equal(result?.quantos, 12);
  });
});
