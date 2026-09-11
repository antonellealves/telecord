import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { P2P_COMFORT_PEERS, type PeerInfo } from '@telecord/shared';
import { peerHeartbeat, peerInbox, peerLeave, peerSignal } from '../lib/peers';

/** Ritmo do batimento: renova presença e busca a caixa de sinais. */
const TICK_MS = 2500;

/**
 * STUN público do Google.
 *
 * Só STUN, sem TURN: STUN descobre o próprio endereço externo e é o que
 * resolve a maioria das redes domésticas. TURN RETRANSMITE a mídia quando o
 * caminho direto não existe (NAT simétrico, rede corporativa) — e um servidor
 * TURN pagando banda de vídeo é exatamente o que o modo P2P existe para
 * evitar. Sem TURN, alguns pares simplesmente não conectam, e a interface diz
 * isso em vez de fingir que está conectando.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export type PeerConnectionState = 'novo' | 'ligando' | 'ligado' | 'falhou';

export interface RemotePeer {
  peerId: string;
  displayName: string;
  isAnonymous: boolean;
  state: PeerConnectionState;
  /** Mídia que chegou desse par, pronta para um `<video>`. */
  stream: MediaStream | null;
}

export interface P2PMesh {
  peers: RemotePeer[];
  /** Streams crus por par, para quem precisa montar a cadeia de áudio. */
  streams: Map<string, MediaStream>;
  /** Manda uma mensagem para todos os pares conectados. */
  broadcast: (raw: string) => void;
  /** Erro que vale mostrar; `null` quando está tudo certo. */
  error: string | null;
  /** Passou do ponto confortável: a malha continua, mas avisa. */
  isCrowded: boolean;
}

interface Options {
  roomSlug: string;
  peerId: string;
  displayName: string;
  /** O que ESTE navegador publica. `null` enquanto nada foi ligado. */
  localStream: MediaStream | null;
  enabled: boolean;
  /** Chamado para cada mensagem que chega de qualquer par. */
  onData?: (fromPeer: string, raw: string) => void;
}

interface Link {
  pc: RTCPeerConnection;
  /** Canal de dados: chat, sons e presença de fala viajam por aqui. */
  channel: RTCDataChannel | null;
  stream: MediaStream;
  /** Quem faz a oferta, para os dois lados não ofertarem ao mesmo tempo. */
  isInitiator: boolean;
  senders: RTCRtpSender[];
}

/**
 * Malha WebRTC: cada navegador conectado a cada outro, sem SFU no meio.
 *
 * ## O que isto troca em relação ao LiveKit
 *
 * Ganha latência (o caminho é direto) e privacidade (nenhum servidor vê a
 * mídia). Perde escala: as conexões crescem com o QUADRADO das pessoas, e
 * cada navegador codifica o próprio vídeo uma vez PARA CADA par. Com 6, são
 * 15 conexões e 5 codificações por máquina — é onde um computador comum ainda
 * dá conta — mas não há teto: quem quiser tentar com mais gente pode, e a
 * interface avisa a partir de `P2P_COMFORT_PEERS`.
 *
 * ## Quem oferta
 *
 * Os dois lados descobrem um ao outro ao mesmo tempo, e se ambos ofertarem a
 * negociação colide ("glare"). A regra de desempate é o id: quem tem o id
 * menor oferta, o outro espera. É estável, não precisa de coordenação e os
 * dois lados chegam à mesma conclusão sozinhos.
 */
export function useP2PMesh({
  roomSlug,
  peerId,
  displayName,
  localStream,
  enabled,
  onData,
}: Options): P2PMesh {
  const [roster, setRoster] = useState<PeerInfo[]>([]);
  const [streams, setStreams] = useState<Map<string, MediaStream>>(new Map());
  const [states, setStates] = useState<Map<string, PeerConnectionState>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const links = useRef<Map<string, Link>>(new Map());
  const localRef = useRef<MediaStream | null>(localStream);
  localRef.current = localStream;
  // Por ref: trocar o receptor não pode reassinar a malha inteira.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const marcar = useCallback((id: string, state: PeerConnectionState) => {
    setStates((atual) => {
      if (atual.get(id) === state) return atual;
      const proximo = new Map(atual);
      proximo.set(id, state);
      return proximo;
    });
  }, []);

  /** Cria (ou devolve) a conexão com um par, já com os ouvintes montados. */
  const conectar = useCallback(
    (outro: string): Link => {
      const existente = links.current.get(outro);
      if (existente !== undefined) return existente;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const stream = new MediaStream();
      const isInitiator = peerId < outro;
      const link: Link = { pc, channel: null, stream, isInitiator, senders: [] };
      links.current.set(outro, link);

      /*
       * O canal de dados é criado por UM lado só — o mesmo que oferta. Os dois
       * criando abriria dois canais para a mesma conversa, e cada mensagem
       * chegaria duplicada. O outro lado recebe por `ondatachannel`.
       */
      const armarCanal = (channel: RTCDataChannel): void => {
        link.channel = channel;
        channel.onmessage = (event) => {
          if (typeof event.data === 'string') onDataRef.current?.(outro, event.data);
        };
      };

      if (isInitiator) {
        armarCanal(pc.createDataChannel('telecord', { ordered: true }));
      } else {
        pc.ondatachannel = (event) => armarCanal(event.channel);
      }

      pc.onicecandidate = (event) => {
        if (event.candidate !== null) {
          void peerSignal(roomSlug, peerId, outro, 'ice', JSON.stringify(event.candidate)).catch(
            () => undefined,
          );
        }
      };

      pc.ontrack = (event) => {
        for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
          if (!stream.getTracks().includes(track)) stream.addTrack(track);
        }
        // Novo objeto para o React perceber: MediaStream muda por dentro.
        setStreams((atual) => new Map(atual).set(outro, stream));
      };

      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case 'connected':
            marcar(outro, 'ligado');
            break;
          case 'failed':
            /*
             * Sem TURN, falha aqui quase sempre é NAT que não deixa caminho
             * direto. Dizer "falhou" é melhor do que tentar para sempre: quem
             * está nesse caso precisa do modo LiveKit, e a interface aponta.
             */
            marcar(outro, 'falhou');
            break;
          case 'connecting':
            marcar(outro, 'ligando');
            break;
          default:
            break;
        }
      };

      // O que já estiver publicado entra agora; o resto entra no efeito abaixo.
      const atual = localRef.current;
      if (atual !== null) {
        for (const track of atual.getTracks()) {
          link.senders.push(pc.addTrack(track, atual));
        }
      }

      return link;
    },
    [peerId, roomSlug, marcar],
  );

  const derrubar = useCallback((outro: string) => {
    const link = links.current.get(outro);
    if (link === undefined) return;
    link.pc.onicecandidate = null;
    link.pc.ontrack = null;
    link.pc.onconnectionstatechange = null;
    link.pc.ondatachannel = null;
    if (link.channel !== null) {
      link.channel.onmessage = null;
      link.channel.close();
    }
    link.pc.close();
    links.current.delete(outro);
    setStreams((atual) => {
      const proximo = new Map(atual);
      proximo.delete(outro);
      return proximo;
    });
    setStates((atual) => {
      const proximo = new Map(atual);
      proximo.delete(outro);
      return proximo;
    });
  }, []);

  /** Processa um envelope que chegou para nós. */
  const receber = useCallback(
    async (de: string, kind: string, payload: string): Promise<void> => {
      const link = conectar(de);
      const { pc } = link;

      if (kind === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload });
        const resposta = await pc.createAnswer();
        await pc.setLocalDescription(resposta);
        await peerSignal(roomSlug, peerId, de, 'answer', resposta.sdp ?? '');
        return;
      }

      if (kind === 'answer') {
        // Resposta que chega fora de hora (renegociação cruzada) é descartada:
        // aplicar no estado errado derruba a conexão que já estava boa.
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: payload });
        return;
      }

      if (kind === 'ice') {
        const candidato: unknown = JSON.parse(payload);
        // Candidato antes da descrição remota é normal e o navegador enfileira
        // sozinho; o que ele recusa é candidato malformado, que ignoramos.
        await pc.addIceCandidate(candidato as RTCIceCandidateInit).catch(() => undefined);
      }
    },
    [conectar, peerId, roomSlug],
  );

  /** Abre a negociação com quem devemos ofertar. */
  const ofertar = useCallback(
    async (outro: string): Promise<void> => {
      const link = conectar(outro);
      if (!link.isInitiator) return;
      if (link.pc.signalingState !== 'stable') return;

      marcar(outro, 'ligando');
      const oferta = await link.pc.createOffer();
      await link.pc.setLocalDescription(oferta);
      await peerSignal(roomSlug, peerId, outro, 'offer', oferta.sdp ?? '');
    },
    [conectar, marcar, peerId, roomSlug],
  );

  /* O batimento: renova presença, lê a caixa e reconcilia a malha. */
  useEffect(() => {
    if (!enabled) return;

    let vivo = true;
    let timer = 0;

    const bater = async (): Promise<void> => {
      try {
        const { peers } = await peerHeartbeat(roomSlug, peerId, displayName);
        if (!vivo) return;
        setRoster(peers);
        setError(null);

        // Sem corte: todo mundo que está na sala entra na malha. O custo
        // cresce ao quadrado, e quem decide se vale é quem está na sala.
        const outros = peers.filter((p) => p.peerId !== peerId);
        const esperados = new Set(outros.map((p) => p.peerId));

        // Quem saiu da lista perde a conexão.
        for (const id of [...links.current.keys()]) {
          if (!esperados.has(id)) derrubar(id);
        }

        // Quem entrou ganha uma — e só o de id menor oferta.
        for (const outro of outros) {
          if (!links.current.has(outro.peerId)) {
            await ofertar(outro.peerId);
          }
        }

        const { signals } = await peerInbox(roomSlug, peerId);
        if (!vivo) return;
        for (const envelope of signals) {
          await receber(envelope.fromPeer, envelope.kind, envelope.payload).catch(() => undefined);
        }
      } catch {
        if (vivo) setError('A sinalização do modo direto falhou. Tentando de novo…');
      } finally {
        if (vivo) timer = window.setTimeout(() => void bater(), TICK_MS);
      }
    };

    void bater();

    return () => {
      vivo = false;
      window.clearTimeout(timer);
      for (const id of [...links.current.keys()]) derrubar(id);
      // Avisa a saída; se falhar, o TTL de presença resolve em ~20 s.
      void peerLeave(roomSlug, peerId).catch(() => undefined);
    };
  }, [enabled, roomSlug, peerId, displayName, derrubar, ofertar, receber]);

  /*
   * Mídia local mudou (ligou câmera, começou a compartilhar): as conexões já
   * abertas precisam receber as faixas novas. Sem isto, quem entrou antes de
   * você ligar a câmera nunca a veria.
   */
  useEffect(() => {
    if (!enabled) return;
    for (const [outro, link] of links.current) {
      for (const sender of link.senders) {
        link.pc.removeTrack(sender);
      }
      link.senders = [];
      if (localStream !== null) {
        for (const track of localStream.getTracks()) {
          link.senders.push(link.pc.addTrack(track, localStream));
        }
      }
      // Trocar faixa exige nova oferta; só o iniciador a faz.
      if (link.isInitiator) void ofertar(outro);
    }
  }, [localStream, enabled, ofertar]);

  /*
   * Manda para todos os canais abertos.
   *
   * Sem fila para quem ainda não abriu: mensagem de chat que chega dois
   * segundos depois, quando a conexão subir, confunde mais do que ajuda — a
   * conversa já seguiu. Quem entrou depois vê o que vier a partir dali.
   */
  const broadcast = useCallback((raw: string) => {
    for (const link of links.current.values()) {
      if (link.channel?.readyState === 'open') {
        try {
          link.channel.send(raw);
        } catch {
          // Canal que fechou entre a checagem e o envio: o par sai na próxima
          // reconciliação e não há o que fazer aqui.
        }
      }
    }
  }, []);

  const peers = useMemo<RemotePeer[]>(
    () =>
      roster
        .filter((p) => p.peerId !== peerId)
        .map((p) => ({
          peerId: p.peerId,
          displayName: p.displayName,
          isAnonymous: p.isAnonymous,
          state: states.get(p.peerId) ?? 'novo',
          stream: streams.get(p.peerId) ?? null,
        })),
    [roster, peerId, states, streams],
  );

  return {
    peers,
    streams,
    broadcast,
    error,
    isCrowded: roster.length > P2P_COMFORT_PEERS,
  };
}
