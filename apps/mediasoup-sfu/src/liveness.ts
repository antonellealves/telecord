/**
 * Quem ainda está do outro lado — e por quanto tempo esperar por quem sumiu.
 *
 * Um par tem até dois canais de controle abertos com este processo: o socket
 * de presença (`presence.ts`) e o canal de mídia (`signal/server.ts`). A
 * sessão de mídia dele vale enquanto pelo menos UM estiver de pé.
 *
 * ## Por que existe uma folga
 *
 * Antes, o `disconnect` do socket de presença removia o par na hora — e
 * junto os transportes dele. Uma queda de rede de dois segundos, que o
 * WebRTC atravessaria sem ninguém notar, derrubava a voz e a tela de quem
 * estava no meio de uma frase: a mídia estava saudável, só o aviso de que a
 * pessoa "saiu" é que era falso.
 *
 * Agora quem some sem avisar ganha `graceMs` para voltar. Quem AVISA que
 * está saindo — fechou a aba, clicou em sair — é removido na hora, como
 * antes: a folga é para queda, não para despedida.
 *
 * ## De qual página veio o canal
 *
 * Cada canal carrega a `instance` da página que o abriu. Serve para uma
 * coisa só: a despedida de uma página não pode derrubar OUTRA. Quem sai da
 * sala e entra de novo em seguida tem, por um instante, os canais da página
 * antiga se despedindo e os da nova chegando — e a ordem em que o servidor
 * vê as duas coisas não é garantida.
 */
export class PeerLiveness {
  /** `par -> canal -> instância da página` (`null` para o cliente antigo, que não informa). */
  private readonly channels = new Map<string, Map<string, string | null>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly graceMs: number,
    private readonly expire: (roomSlug: string, peerId: string, reason: 'left' | 'timeout') => void,
  ) {}

  /** Um canal deste par abriu. Cancela qualquer contagem em andamento. */
  attach(roomSlug: string, peerId: string, channelId: string, instance: string | null = null): void {
    const key = peerKey(roomSlug, peerId);
    this.cancel(key);
    let set = this.channels.get(key);
    if (set === undefined) {
      set = new Map();
      this.channels.set(key, set);
    }
    set.set(channelId, instance);
  }

  /**
   * Um canal deste par fechou.
   *
   * `goodbye` é o cliente dizendo que saiu de propósito. Vale mesmo que o
   * outro canal DA MESMA PÁGINA ainda apareça aberto: ele está a
   * milissegundos de fechar também, e esperar por ele deixaria um fantasma no
   * roster. Canal de outra página segura o par — a despedida é de quem saiu,
   * não de quem acabou de chegar.
   */
  detach(roomSlug: string, peerId: string, channelId: string, goodbye: boolean): void {
    const key = peerKey(roomSlug, peerId);
    const set = this.channels.get(key);
    // Canal de um par que já foi removido (expulso, ou despedida pelo outro
    // canal): não há mais nada a decidir.
    if (set === undefined || !set.has(channelId)) return;
    const instance = set.get(channelId) ?? null;
    set.delete(channelId);

    if (goodbye) {
      // Sem `instance` não dá para saber de quem é cada canal: qualquer
      // outro aberto conta como sendo de outra página.
      const fromAnotherPage = [...set.values()].some((other) => instance === null || other !== instance);
      if (fromAnotherPage) return;
      this.forget(roomSlug, peerId);
      this.expire(roomSlug, peerId, 'left');
      return;
    }
    if (set.size > 0) return;

    this.channels.delete(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (!this.channels.has(key)) this.expire(roomSlug, peerId, 'timeout');
    }, this.graceMs);
    // Uma contagem pendente não deve segurar o processo de pé no desligamento.
    timer.unref();
    this.timers.set(key, timer);
  }

  /** O par saiu do registry por outro caminho — nada mais a esperar dele. */
  forget(roomSlug: string, peerId: string): void {
    const key = peerKey(roomSlug, peerId);
    this.cancel(key);
    this.channels.delete(key);
  }

  private cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }
}

/**
 * JSON, e não concatenação com separador: `peerId` vem do navegador e pode
 * conter qualquer caractere — com um separador fixo, dois pares diferentes
 * poderiam cair na mesma chave.
 */
export function peerKey(roomSlug: string, peerId: string): string {
  return JSON.stringify([roomSlug, peerId]);
}
