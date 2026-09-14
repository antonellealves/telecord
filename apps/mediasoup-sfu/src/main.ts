import { loadConfig } from './config';
import { startHttpServer } from './http';
import { createWorker, RoomRegistry } from './rooms';

function log(fields: Record<string, string | number>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ scope: 'mediasoup-sfu', ...fields }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const worker = await createWorker(config.rtcMinPort, config.rtcMaxPort);
  const registry = new RoomRegistry(worker, config.announcedIp);
  startHttpServer(config.port, config.internalSecret, registry);
  log({ event: 'started', port: config.port });
}

main().catch((error) => {
  log({ event: 'boot_failed', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
