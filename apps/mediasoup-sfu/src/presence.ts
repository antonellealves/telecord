import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { verifyAdminPresenceToken, verifyPresenceToken } from '@telecord/shared';
import type { RoomRegistry } from './rooms';

const ADMIN_ROOM_PREFIX = 'admin:';

interface PeerSocketData {
  kind: 'peer';
  peerId: string;
  roomSlug: string;
  displayName: string;
}

interface AdminSocketData {
  kind: 'admin';
  actorId: string;
}

type PresenceSocketData = PeerSocketData | AdminSocketData;

/**
 * Canal de presença ao vivo, exposto PUBLICAMENTE ao navegador (diferente do
 * resto deste processo — ver `http.ts`, que continua interno, só para
 * `apps/api`). Autenticado por um token de curta duração assinado com o
 * MESMO `MEDIASOUP_INTERNAL_SECRET` (ver `presenceToken.ts` em
 * `@telecord/shared`), sem precisar bater no Prisma/`apps/api` de novo — é
 * isso que deixa este processo validar a conexão sozinho.
 *
 * Substitui o heartbeat HTTP de 2.5s que existia antes para roster: aqui a
 * saída de um par é o evento `disconnect` do próprio transporte Socket.IO —
 * dispara ao fechar a aba, dar F5, ou perder a conexão de rede (detectado
 * pelo ping/pong nativo do socket.io, bem mais rápido que os 20s de TTL do
 * heartbeat antigo).
 *
 * Anexado ao MESMO `http.Server` que já escuta a porta pública de sempre
 * (ver `main.ts`) — o Caddy já encaminha upgrade de WebSocket por padrão
 * (`infra/Caddyfile`), então não precisa de porta nova nem config de infra.
 */
export function startPresenceServer(httpServer: HttpServer, internalSecret: string, registry: RoomRegistry): void {
  const io = new SocketIOServer(httpServer, {
    path: '/presence',
    cors: { origin: '*' },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== 'string' || token === '') {
      next(new Error('token de presença ausente'));
      return;
    }
    void authenticate(token, internalSecret).then((data) => {
      if (data === null) {
        next(new Error('token de presença inválido ou expirado'));
        return;
      }
      socket.data = data satisfies PresenceSocketData;
      next();
    });
  });

  registry.setTrackListeners(
    (event) => {
      io.to(event.roomSlug).emit('track:announced', event);
    },
    (event) => {
      io.to(event.roomSlug).emit('track:closed', event);
    },
  );

  io.on('connection', (socket: Socket) => {
    const data = socket.data as PresenceSocketData;

    if (data.kind === 'admin') {
      handleAdminConnection(socket, registry);
      return;
    }

    handlePeerConnection(socket, registry, data);
  });
}

async function authenticate(token: string, secret: string): Promise<PresenceSocketData | null> {
  const admin = await verifyAdminPresenceToken(token, secret);
  if (admin !== null) {
    return { kind: 'admin', actorId: admin.actorId };
  }
  const peer = await verifyPresenceToken(token, secret);
  if (peer !== null) {
    return { kind: 'peer', peerId: peer.peerId, roomSlug: peer.roomSlug, displayName: peer.displayName };
  }
  return null;
}

/** `displayName` vem do TOKEN (já verificado por `apps/api`, ver `signPresenceToken`), nunca de um campo solto do handshake — o handshake é entrada não confiável. */
function handlePeerConnection(socket: Socket, registry: RoomRegistry, data: PeerSocketData): void {
  const { peerId, roomSlug, displayName } = data;

  void socket.join(roomSlug);
  registry.setPresence(roomSlug, peerId, displayName);
  broadcastRoster(socket, registry, roomSlug);

  // Snapshot das tracks já publicadas por OUTROS pares — sem isto, quem entra
  // numa sala com um compartilhamento de tela já em andamento nunca recebe o
  // `track:announced` original (esse evento já passou) e fica sem consumir.
  for (const track of registry.publishedTracksInRoom(roomSlug)) {
    if (track.peerId === peerId) continue;
    socket.emit('track:announced', track);
  }

  socket.on('disconnect', () => {
    registry.removePeer(roomSlug, peerId);
    broadcastRoster(socket, registry, roomSlug);
  });
}

function handleAdminConnection(socket: Socket, registry: RoomRegistry): void {
  socket.on('admin:watch', (roomSlug: unknown) => {
    if (typeof roomSlug !== 'string' || roomSlug === '') return;
    void socket.join(`${ADMIN_ROOM_PREFIX}${roomSlug}`);
    // Manda o snapshot atual na hora — não espera o próximo evento de outro peer.
    socket.emit('roster:update', { roomSlug, peers: registry.listPresence(roomSlug) });
  });

  socket.on('admin:unwatch', (roomSlug: unknown) => {
    if (typeof roomSlug !== 'string' || roomSlug === '') return;
    void socket.leave(`${ADMIN_ROOM_PREFIX}${roomSlug}`);
  });
}

/** Emite o snapshot completo da sala (não delta — salas são pequenas, e reenviar tudo é mais simples e resiste melhor a perda de mensagem) para peers e para admins assistindo. */
function broadcastRoster(socket: Socket, registry: RoomRegistry, roomSlug: string): void {
  const payload = { roomSlug, peers: registry.listPresence(roomSlug) };
  socket.nsp.to(roomSlug).to(`${ADMIN_ROOM_PREFIX}${roomSlug}`).emit('roster:update', payload);
}
