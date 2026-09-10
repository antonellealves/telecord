/**
 * A regra de vinculação entre login social e conta local.
 *
 * Está isolada aqui, como decisão pura, porque é a peça mais perigosa da
 * autenticação e a única que não dá para exercitar sem credencial do Google:
 * dentro do serviço, provar o comportamento exigiria rede, banco e um projeto
 * no Google Cloud. Como função sem dependência, cada caminho vira um teste de
 * uma linha — e a regra fica legível sem ler o resto do serviço.
 *
 * ## O ataque que ela existe para impedir
 *
 * Pré-vinculação de conta:
 *
 * 1. O atacante cadastra `voce@gmail.com` por e-mail e senha. O endereço não é
 *    dele, então ele nunca confirma — e não precisa.
 * 2. Meses depois você entra pelo Google com esse mesmo endereço.
 * 3. Um sistema que vincula por e-mail coloca você DENTRO da conta dele. Ele
 *    continua sabendo a senha, e passa a ler tudo que é seu.
 *
 * O que fecha isso é não deixar o e-mail sozinho provar posse. Um e-mail só
 * identifica a mesma pessoa quando os DOIS lados o confirmaram: o Google, pelo
 * `email_verified` do `id_token`, e a conta local, por ter aberto o link de
 * confirmação.
 */

export type LinkDecision =
  /** Já existe vínculo com esta conta do provedor. Entra direto. */
  | { kind: 'usar-vinculada' }
  /** Mesma pessoa, comprovado dos dois lados: vincula e entra. */
  | { kind: 'vincular-existente' }
  /** Há conta com este e-mail, mas ninguém provou posse. Recusa. */
  | { kind: 'recusar'; reason: 'conta-nao-confirmada' | 'provedor-nao-confirmou' }
  /** Ninguém usa este e-mail. Cria conta nova, já confirmada pelo provedor. */
  | { kind: 'criar' };

export interface LinkInput {
  /** Existe `OAuthAccount` para o par (provider, providerAccountId). */
  hasLinkedAccount: boolean;
  /** Existe usuário local com este e-mail. */
  existingUser: { emailVerified: boolean; deleted: boolean } | null;
  /** O `email_verified` que veio no `id_token`. */
  providerEmailVerified: boolean;
}

export function decideAccountLink(input: LinkInput): LinkDecision {
  /*
   * Primeiro o vínculo explícito, e por identidade do provedor — não por
   * e-mail. Quem trocou o endereço no Google continua sendo a mesma pessoa, e
   * o `sub` é o que não muda. Vem antes de tudo porque, uma vez estabelecido,
   * nenhuma consideração sobre e-mail se aplica.
   */
  if (input.hasLinkedAccount) {
    return { kind: 'usar-vinculada' };
  }

  if (input.existingUser !== null) {
    /*
     * Conta apagada com o mesmo e-mail: tratada como não confirmada. Adotá-la
     * ressuscitaria dados de alguém que pediu para sair.
     */
    if (input.existingUser.deleted || !input.existingUser.emailVerified) {
      return { kind: 'recusar', reason: 'conta-nao-confirmada' };
    }
    if (!input.providerEmailVerified) {
      return { kind: 'recusar', reason: 'provedor-nao-confirmou' };
    }
    return { kind: 'vincular-existente' };
  }

  /*
   * Sem conta local. Criar exige que o provedor tenha confirmado o endereço —
   * senão qualquer um cria conta no Google com o e-mail de outra pessoa e
   * chega aqui primeiro, tomando o endereço antes do dono.
   */
  if (!input.providerEmailVerified) {
    return { kind: 'recusar', reason: 'provedor-nao-confirmou' };
  }
  return { kind: 'criar' };
}
