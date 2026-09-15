/**
 * Protocolo Socket.IO de presença do transporte `mediasoup`, compartilhado
 * entre `apps/mediasoup-sfu` (servidor) e `apps/web` (cliente e painel
 * admin). Ver `presenceToken.ts` para a autenticação da conexão.
 */

/** Uma entrada do roster ao vivo — presença pura, sem tracks nem comando de moderação (isso continua em `PeerInfo`/`PeerPresence`). */
export interface PresenceRosterEntry {
  peerId: string;
  displayName: string;
  /** ISO 8601 — quando este par conectou o socket. */
  joinedAt: string;
}

export interface PresenceRosterUpdate {
  roomSlug: string;
  peers: PresenceRosterEntry[];
}

/** Uma track publicada — mesmo formato usado no anúncio antigo por heartbeat (`MediasoupAnnounce`), agora entregue ao vivo. */
export interface PresenceTrackAnnounced {
  roomSlug: string;
  peerId: string;
  producerId: string;
  kind: 'audio' | 'video';
  trackKind: 'mic' | 'camera' | 'screen-video' | 'screen-audio';
}

export interface PresenceTrackClosed {
  roomSlug: string;
  peerId: string;
  producerId: string;
}

export interface ServerToClientPresenceEvents {
  'roster:update': (payload: PresenceRosterUpdate) => void;
  /** Emitido assim que alguém publica uma track nova (mic, câmera ou tela) — o resto da sala assina na hora, sem esperar o próximo heartbeat. */
  'track:announced': (payload: PresenceTrackAnnounced) => void;
  /** Emitido quando uma track publicada fecha (parou de compartilhar, saiu da sala, transporte caiu). */
  'track:closed': (payload: PresenceTrackClosed) => void;
}

export interface ClientToServerPresenceEvents {
  /** Só usado pelo socket do painel admin: passa a receber `roster:update` desta sala também. */
  'admin:watch': (roomSlug: string) => void;
  'admin:unwatch': (roomSlug: string) => void;
}
