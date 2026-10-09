import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SfuConfig } from './config';
import { startHttpServer } from './http';
import { PeerLiveness } from './liveness';
import { log, type LogFields } from './log';
import { startPresenceServer } from './presence';
import { RoomRegistry } from './rooms';
import { startSignalServer } from './signal/server';
import { WorkerPool } from './workers';

export interface SfuNode {
  /** A porta em que o processo de fato escuta — difere de `config.port` quando ela é 0. */
  readonly port: number;
  readonly server: Server;
  readonly registry: RoomRegistry;
  readonly pool: WorkerPool;
  /** Fecha tudo. Os clientes são avisados de que podem voltar (`SIGNAL_CLOSE.serverShutdown`). */
  close(): Promise<void>;
}

export interface SfuNodeHooks {
  /** O processo de um Worker morreu. `main.ts` responde encerrando o nó inteiro. */
  onWorkerDied: (index: number) => void;
  log?: (fields: LogFields) => void;
}

/**
 * Um nó do SFU, de pé: Workers, registro de salas e os três canais no mesmo
 * `http.Server`.
 *
 * Separado de `main.ts` para o teste poder subir um nó inteiro — o Worker de
 * verdade, o WebSocket de verdade — numa porta sorteada, e derrubá-lo no fim.
 */
export async function startNode(config: SfuConfig, hooks: SfuNodeHooks): Promise<SfuNode> {
  const emit = hooks.log ?? log;

  const pool = await WorkerPool.create({
    workers: config.workers,
    rtcMinPort: config.rtcMinPort,
    listenIp: config.listenIp,
    announcedIp: config.announcedIp,
    capacity: config.workerCapacity,
    onWorkerDied: hooks.onWorkerDied,
  });
  const registry = await RoomRegistry.create(pool, {
    pipeListenInfo: {
      protocol: 'udp',
      ip: '127.0.0.1',
      portRange: { min: config.pipeMinPort, max: config.pipeMaxPort },
    },
  });

  // A folga de reconexão vale para os dois canais: a sessão de mídia de um
  // par só cai quando NENHUM deles voltou a tempo.
  const liveness = new PeerLiveness(config.resumeGraceMs, (roomSlug, peerId, reason) => {
    registry.removePeer(roomSlug, peerId, reason);
  });
  registry.on('peer:removed', (event) => liveness.forget(event.roomSlug, event.peerId));

  let sessionCount = (): number => 0;
  const server = startHttpServer(config.port, config.internalSecret, registry, () => ({
    workers: pool.stats(),
    ...registry.stats(),
    signalSessions: sessionCount(),
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  // Mesma porta/processo do HTTP interno acima — ver docstring de `http.ts`
  // para o porquê de ser seguro conviver com as rotas `/rooms/*`.
  const io = startPresenceServer(server, config.internalSecret, registry, liveness);
  const signal = startSignalServer(server, {
    internalSecret: config.internalSecret,
    registry,
    liveness,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    log: emit,
  });
  sessionCount = () => signal.sessionCount;

  return {
    port: (server.address() as AddressInfo).port,
    server,
    registry,
    pool,
    async close(): Promise<void> {
      signal.shutdown();
      // Um instante para os quadros de fechamento saírem antes de cortar
      // quem não respondeu a eles.
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal.terminateAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        // `io.close` só chama de volta quando o `http.Server` termina de
        // fechar; o teto existe para um socket teimoso não segurar o deploy.
        const giveUp = setTimeout(resolve, 1_000);
        giveUp.unref();
        void io.close(() => {
          clearTimeout(giveUp);
          resolve();
        });
      });
      pool.close();
    },
  };
}
