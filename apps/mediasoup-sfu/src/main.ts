import { loadConfig } from './config';
import { log } from './log';
import { startNode } from './node';

async function main(): Promise<void> {
  const config = loadConfig();
  const node = await startNode(config, {
    onWorkerDied: (index) => {
      // O mediasoup mata o Worker em vez de deixar o processo nativo (C++) num
      // estado indefinido. Com vários Workers daria para tentar repor só o
      // que morreu, mas as salas que tinham um pedaço nele ficariam pela
      // metade — sair e deixar o supervisor do Docker (`restart:
      // unless-stopped`) subir um processo inteiro é o estado conhecido. Os
      // clientes voltam sozinhos e refazem a sessão.
      log({ event: 'worker_died', worker: index });
      process.exit(1);
    },
  });
  log({
    event: 'started',
    port: node.port,
    workers: config.workers,
    rtcPorts: `${config.rtcMinPort}-${config.rtcMinPort + config.workers - 1}`,
  });

  /*
   * Sem tratar SIGTERM, o processo (PID 1 no contêiner) ignora o sinal e o
   * Docker espera dez segundos antes de matá-lo — com todos os clientes
   * descobrindo a queda só pelo silêncio. Tratando, cada um recebe o aviso de
   * que o nó está reiniciando e já volta tentando.
   */
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log({ event: 'stopping', signal });
    void node.close().finally(() => process.exit(0));
    // Se o fechamento educado travar, o deploy não pode ficar esperando.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error) => {
  log({ event: 'boot_failed', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
