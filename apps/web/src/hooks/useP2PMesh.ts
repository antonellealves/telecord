import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { P2P_COMFORT_PEERS, type PeerInfo } from '@telecord/shared';
import { DEFAULT_ICE_SERVERS } from '../lib/ice';
import type { VideoSendProfile } from '../lib/media';
import { peerHeartbeat, peerInbox, peerLeave, peerSignal } from '../lib/peers';

/** Ritmo do batimento: renova presença e busca a caixa de sinais. */
const TICK_MS = 2500;

/**
 * Voz um pouco acima do padrão do Opus (~32 kbps): 64 kbps devolve o brilho
 * das frequências altas sem custo que importe numa malha pequena.
 */
const AUDIO_MAX_BITRATE = 64_000;

/** `degradationPreference` não está no lib.dom, mas Chrome e Firefox o aceitam. */
interface SendParams extends RTCRtpSendParameters {
  degradationPreference?: VideoSendProfile['degradationPreference'];
}

/*
 * Ordem de preferência dos codecs de vídeo, resolvida uma vez.
 *
 * VP9 na frente: para tela cheia de texto ele resolve borda de letra que o VP8
 * borra, no mesmo bitrate — a maior parte da diferença entre "1080p nítido" e
 * "1080p que parece 720p". H264 depois, por ser barato de codificar (hardware);
 * VP8 de reserva. Só REORDENA, nunca remove: a negociação sempre acha um codec
 * comum, e quem não tem VP9 recebe o próximo da lista em vez de nada.
 */
// O nome do tipo do codec mudou entre versões do lib.dom; derivá-lo da própria
// API evita depender de qual nome está disponível.
type CodecCapability = NonNullable<ReturnType<typeof RTCRtpSender.getCapabilities>>['codecs'][number];

let codecsVideoOrdenados: CodecCapability[] | null | undefined;
function ordenarCodecsVideo(): CodecCapability[] | null {
  if (codecsVideoOrdenados !== undefined) return codecsVideoOrdenados;
  const caps =
    typeof RTCRtpSender !== 'undefined' && 'getCapabilities' in RTCRtpSender
      ? RTCRtpSender.getCapabilities('video')
      : null;
  if (caps === null) {
    codecsVideoOrdenados = null;
    return null;
  }
  const ordem = ['video/vp9', 'video/h264', 'video/vp8'];
  const rank = (codec: CodecCapability): number => {
    const posicao = ordem.indexOf(codec.mimeType.toLowerCase());
    return posicao === -1 ? ordem.length : posicao;
  };
  codecsVideoOrdenados = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  return codecsVideoOrdenados;
}

/** Põe o codec preferido na frente. Antes da oferta/resposta, no transceiver de vídeo. */
function preferirCodecsVideo(pc: RTCPeerConnection): void {
  const codecs = ordenarCodecsVideo();
  if (codecs === null) return;
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind !== 'video') continue;
    try {
      transceiver.setCodecPreferences(codecs);
    } catch {
      // Navegador sem `setCodecPreferences`: a negociação segue no padrão dele.
    }
  }
}

/**
 * Aplica o teto de bitrate/quadro e a preferência de degradação aos senders.
 *
 * É o que destrava a qualidade no modo direto: sem isto o navegador segura a
 * tela em ~2,5 Mbps. Roda DEPOIS de `setLocalDescription`, quando os
 * `encodings` já existem para receber os valores.
 */
function aplicarPerfilVideo(senders: RTCRtpSender[], profile: VideoSendProfile | null): void {
  for (const sender of senders) {
    const kind = sender.track?.kind;
    if (kind === 'video') {
      if (profile === null) continue;
      const params = sender.getParameters() as SendParams;
      if (params.encodings.length === 0) params.encodings = [{}];
      const encoding = params.encodings[0];
      if (encoding === undefined) continue;
      encoding.maxBitrate = profile.maxBitrate;
      encoding.maxFramerate = profile.maxFramerate;
      params.degradationPreference = profile.degradationPreference;
      void sender.setParameters(params).catch(() => undefined);
    } else if (kind === 'audio') {
      const params = sender.getParameters();
      if (params.encodings.length === 0) params.encodings = [{}];
      const encoding = params.encodings[0];
      if (encoding === undefined) continue;
      encoding.maxBitrate = AUDIO_MAX_BITRATE;
      void sender.setParameters(params).catch(() => undefined);
    }
  }
}

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
  /**
   * Servidores de gelo, buscados de `/api/ice`. Sem isto, o STUN público.
   * Conexões já abertas recebem a lista nova por `setConfiguration`.
   */
  iceServers?: RTCIceServer[];
  /**
   * Teto de qualidade do vídeo que ESTE navegador envia. `null` quando não há
   * vídeo. Aplicado a cada par e reaplicado quando muda (troca de nível, ou de
   * câmera para tela).
   */
  videoProfile?: VideoSendProfile | null;
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
  iceServers,
  videoProfile,
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
  // Por ref pelo mesmo motivo: uma conexão nova pega a lista mais recente sem
  // que uma mudança de ICE reconstrua todo o efeito da malha.
  const iceRef = useRef<RTCIceServer[]>(
    iceServers !== undefined && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS,
  );
  iceRef.current =
    iceServers !== undefined && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS;
  const videoRef = useRef<VideoSendProfile | null>(videoProfile ?? null);
  videoRef.current = videoProfile ?? null;

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

      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
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
        // Antes de responder: fixa o codec preferido no transceiver de vídeo.
        preferirCodecsVideo(pc);
        const resposta = await pc.createAnswer();
        await pc.setLocalDescription(resposta);
        // Depois da descrição local: os `encodings` existem e aceitam o teto.
        aplicarPerfilVideo(link.senders, videoRef.current);
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
      preferirCodecsVideo(link.pc);
      const oferta = await link.pc.createOffer();
      await link.pc.setLocalDescription(oferta);
      aplicarPerfilVideo(link.senders, videoRef.current);
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
   * ICE chegou (ou mudou) depois de a malha já ter conexões abertas: aplica a
   * lista nova sem derrubá-las. É o que faz um TURN configurado valer para
   * quem já estava na sala, e não só para quem entrar depois.
   */
  useEffect(() => {
    const servidores =
      iceServers !== undefined && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS;
    for (const link of links.current.values()) {
      try {
        link.pc.setConfiguration({ iceServers: servidores });
      } catch {
        // Navegador sem `setConfiguration`: as conexões seguem com o que tinham
        // ao nascer, e as próximas já usam a lista nova pela `iceRef`.
      }
    }
  }, [iceServers]);

  /*
   * Perfil de vídeo mudou (trocou o nível, ou de câmera para tela): reaplica o
   * teto aos senders já existentes. Sem isto, a mudança só valeria na próxima
   * renegociação.
   */
  useEffect(() => {
    for (const link of links.current.values()) {
      aplicarPerfilVideo(link.senders, videoProfile ?? null);
    }
  }, [videoProfile]);

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
