import { loadConfig } from './config';
import { startHttpServer } from './http';
import { startPresenceServer } from './presence';
import { createWorker, RoomRegistry } from './rooms';

function log(fields: Record<string, string | number>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ scope: 'mediasoup-sfu', ...fields }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const worker = await createWorker(config.rtcMinPort, config.rtcMaxPort);
  const registry = new RoomRegistry(worker, config.announcedIp);
  const server = startHttpServer(config.port, config.internalSecret, registry);
  // Mesma porta/processo do HTTP interno acima — ver docstring de `presence.ts`
  // para o porquê de ser seguro conviver com as rotas `/rooms/*` autenticadas por Bearer.
  startPresenceServer(server, config.internalSecret, registry);
  log({ event: 'started', port: config.port });
}

main().catch((error) => {
  log({ event: 'boot_failed', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
