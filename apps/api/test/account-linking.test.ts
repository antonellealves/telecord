/**
 * A regra de vinculação de conta, caso a caso.
 *
 * Este arquivo cobre o requisito do PLANO.md §3 — "conta por senha com e-mail
 * não verificado não é vinculada ao Google" — sem precisar de credencial do
 * Google, de rede ou de banco. É de propósito: um teste que exige projeto no
 * Google Cloud não roda no CI, e a regra que ele guardaria é justamente a que
 * ninguém percebe quando quebra.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAccountLink, type LinkInput } from '../src/auth/account-linking';

/** Caso base: ninguém vinculado, nenhuma conta local, Google confirmou. */
function input(overrides: Partial<LinkInput> = {}): LinkInput {
  return {
    hasLinkedAccount: false,
    existingUser: null,
    providerEmailVerified: true,
    ...overrides,
  };
}

describe('vinculação de conta com o Google', () => {
  it('já vinculada: entra direto, sem olhar e-mail', () => {
    // A identidade no provedor é o `sub`, não o endereço. Quem trocou de
    // e-mail no Google continua sendo a mesma pessoa.
    assert.deepEqual(decideAccountLink(input({ hasLinkedAccount: true })), {
      kind: 'usar-vinculada',
    });

    // Vale mesmo com o provedor dizendo que o e-mail não está confirmado: o
    // vínculo já foi estabelecido antes, e nada aqui o desfaz.
    assert.deepEqual(
      decideAccountLink(input({ hasLinkedAccount: true, providerEmailVerified: false })),
      { kind: 'usar-vinculada' },
    );
  });

  it('sem conta local e com e-mail confirmado: cria', () => {
    assert.deepEqual(decideAccountLink(input()), { kind: 'criar' });
  });

  it('conta local confirmada dos dois lados: vincula', () => {
    assert.deepEqual(
      decideAccountLink(
        input({ existingUser: { emailVerified: true, deleted: false } }),
      ),
      { kind: 'vincular-existente' },
    );
  });

  // -------------------------------------------------------------------------
  // O ataque de pré-vinculação
  // -------------------------------------------------------------------------

  it('NÃO adota conta por senha com e-mail não confirmado', () => {
    /*
     * O caso que dá nome à regra. O atacante cadastrou `voce@gmail.com` por
     * senha e nunca confirmou — não tem a caixa. Se este teste virar
     * "vincular-existente", o dono real do endereço entra pelo Google e cai
     * dentro da conta do atacante, que continua sabendo a senha.
     */
    assert.deepEqual(
      decideAccountLink(
        input({ existingUser: { emailVerified: false, deleted: false } }),
      ),
      { kind: 'recusar', reason: 'conta-nao-confirmada' },
    );
  });

  it('NÃO vincula quando o provedor não confirmou o e-mail', () => {
    // O outro lado do mesmo problema: uma conta Google pode declarar um
    // endereço sem tê-lo provado.
    assert.deepEqual(
      decideAccountLink(
        input({
          existingUser: { emailVerified: true, deleted: false },
          providerEmailVerified: false,
        }),
      ),
      { kind: 'recusar', reason: 'provedor-nao-confirmou' },
    );
  });

  it('NÃO cria conta quando o provedor não confirmou o e-mail', () => {
    // Sem isto, quem criasse uma conta Google com o endereço de outra pessoa
    // tomaria o endereço aqui antes do dono chegar.
    assert.deepEqual(decideAccountLink(input({ providerEmailVerified: false })), {
      kind: 'recusar',
      reason: 'provedor-nao-confirmou',
    });
  });

  it('NÃO ressuscita conta apagada', () => {
    // Adotá-la devolveria dados de quem pediu para sair, a quem provou apenas
    // ter o mesmo endereço hoje.
    assert.deepEqual(
      decideAccountLink(input({ existingUser: { emailVerified: true, deleted: true } })),
      { kind: 'recusar', reason: 'conta-nao-confirmada' },
    );
  });

  it('nenhuma combinação vincula sem confirmação dos dois lados', () => {
    /*
     * Varredura exaustiva do espaço de entrada: com três booleanos são oito
     * casos, e é barato provar a propriedade inteira em vez de confiar nos
     * exemplos acima. A propriedade: `vincular-existente` exige as duas
     * confirmações, e `criar` exige a do provedor.
     */
    for (const hasLinkedAccount of [false, true]) {
      for (const localVerified of [false, true, null]) {
        for (const providerEmailVerified of [false, true]) {
          const decision = decideAccountLink({
            hasLinkedAccount,
            existingUser:
              localVerified === null ? null : { emailVerified: localVerified, deleted: false },
            providerEmailVerified,
          });

          if (decision.kind === 'vincular-existente') {
            assert.equal(localVerified, true, 'vinculou sem a conta local confirmada');
            assert.equal(providerEmailVerified, true, 'vinculou sem o provedor confirmar');
          }
          if (decision.kind === 'criar') {
            assert.equal(providerEmailVerified, true, 'criou sem o provedor confirmar');
            assert.equal(localVerified, null, 'criou por cima de conta existente');
          }
        }
      }
    }
  });
});
