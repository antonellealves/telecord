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

/** Chat e soundboard — mesmo envelope opaco que `RoomMessage` (`@telecord/shared`) já usa nos outros transportes; o socket só carrega, nunca interpreta. */
export interface PresenceChatMessage {
  roomSlug: string;
  fromPeer: string;
  displayName: string;
  /** `RoomMessage` serializado — o servidor não decodifica, só repassa. */
  body: string;
}

/**
 * Comando de moderação cooperativo (mute/move), empurrado para UM peer
 * específico assim que o admin age — ver `MediasoupModerationService` em
 * `apps/api`. Mesmo formato de `PeerAdminCommand`, mas entregue ao vivo em
 * vez de esperado no próximo heartbeat.
 */
export interface PresenceModerationCommand {
  roomSlug: string;
  peerId: string;
  forceMuted?: boolean;
  moveTo?: string | null;
}

export interface ServerToClientPresenceEvents {
  'roster:update': (payload: PresenceRosterUpdate) => void;
  /** Emitido assim que alguém publica uma track nova (mic, câmera ou tela) — o resto da sala assina na hora, sem esperar o próximo heartbeat. */
  'track:announced': (payload: PresenceTrackAnnounced) => void;
  /** Emitido quando uma track publicada fecha (parou de compartilhar, saiu da sala, transporte caiu). */
  'track:closed': (payload: PresenceTrackClosed) => void;
  /** Retransmitido para o resto da sala assim que alguém manda uma mensagem — substitui o polling de `RoomBroadcastMessage`. */
  'chat:message': (payload: PresenceChatMessage) => void;
  /** Empurrado só para o peer alvo — substitui a leitura de `adminCommand` no heartbeat. */
  'moderation:command': (payload: PresenceModerationCommand) => void;
}

export interface ClientToServerPresenceEvents {
  /** Só usado pelo socket do painel admin: passa a receber `roster:update` desta sala também. */
  'admin:watch': (roomSlug: string) => void;
  'admin:unwatch': (roomSlug: string) => void;
  /** Manda uma mensagem de chat/soundboard para o resto da sala — sem histórico aqui (ver `apps/api` para persistência). */
  'chat:send': (payload: { displayName: string; body: string }) => void;
}
