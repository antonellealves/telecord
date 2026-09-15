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

export interface ServerToClientPresenceEvents {
  'roster:update': (payload: PresenceRosterUpdate) => void;
}

export interface ClientToServerPresenceEvents {
  /** Só usado pelo socket do painel admin: passa a receber `roster:update` desta sala também. */
  'admin:watch': (roomSlug: string) => void;
  'admin:unwatch': (roomSlug: string) => void;
}
