/**
 * Em qual nó do SFU uma sala mora, quando há mais de um.
 *
 * O desenho é o do Discord: cada canal de voz é atribuído a UM servidor de
 * voz, e todo mundo daquele canal fala com o mesmo. Aqui, cada sala a um nó
 * do `mediasoup-sfu` — duas pessoas da mesma sala em nós diferentes estariam
 * em duas salas de mesmo nome sem se ouvir.
 *
 * ## Por que rendezvous hashing, e não "hash módulo N"
 *
 * Com módulo, acrescentar um nó muda o destino de quase TODA sala: quem
 * entrasse depois do deploy cairia num nó diferente de quem já estava dentro,
 * e toda sala viva racharia ao meio. No rendezvous cada sala pontua cada nó e
 * fica com o de maior nota; um nó novo só "ganha" as salas em que ele pontua
 * mais alto que todos — por volta de 1/N delas — e nenhuma outra se move.
 *
 * Função pura, sem rede e sem estado: é o que deixa qualquer instância da
 * função serverless chegar à mesma resposta sem combinar nada com as outras.
 */
import { createHash } from 'node:crypto';

/** Nota de um nó para uma sala: 48 bits do SHA-256 de `nó + "\n" + sala`. */
function score(nodeUrl: string, roomSlug: string): number {
  const digest = createHash('sha256').update(nodeUrl).update('\n').update(roomSlug).digest();
  return digest.readUIntBE(0, 6);
}

/**
 * Os nós em ordem de preferência para esta sala — o primeiro é onde ela mora;
 * os seguintes, para onde iria se ele saísse da lista.
 */
export function rankNodes(nodeUrls: readonly string[], roomSlug: string): string[] {
  return nodeUrls
    .map((url) => ({ url, value: score(url, roomSlug) }))
    .sort((a, b) => b.value - a.value || a.url.localeCompare(b.url))
    .map((entry) => entry.url);
}

export function pickNode(nodeUrls: readonly string[], roomSlug: string): string {
  const [first] = rankNodes(nodeUrls, roomSlug);
  if (first === undefined) throw new Error('nenhum nó de SFU configurado');
  return first;
}
