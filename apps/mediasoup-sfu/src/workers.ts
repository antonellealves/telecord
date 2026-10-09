import * as mediasoup from 'mediasoup';

/**
 * Um Worker do mediasoup e o que se sabe sobre a carga dele.
 *
 * Worker é um processo C++ à parte, preso a UM núcleo. É ele que recebe e
 * reenvia cada pacote de áudio e vídeo — o Node só diz o que ligar a quê e
 * nunca vê um pacote passar. É o que torna este nó comparável ao servidor de
 * voz do Discord: o caminho da mídia não depende do event loop.
 */
export interface WorkerSlot {
  readonly index: number;
  readonly worker: mediasoup.types.Worker;
  /**
   * UMA porta de mídia para todos os transportes deste Worker.
   *
   * Antes cada `WebRtcTransport` sorteava a própria porta dentro de
   * 40101-40200 — e como cada pessoa abre dois transportes (um para publicar,
   * outro para assinar), a faixa de 100 portas era um teto de ~50 pessoas no
   * nó inteiro, não importava quanta CPU sobrasse. Com o `WebRtcServer`, o
   * Worker distingue os transportes pelo ICE e o teto passa a ser o que a
   * máquina aguenta.
   */
  readonly webRtcServer: mediasoup.types.WebRtcServer;
  readonly rtcPort: number;
  /** Soma dos pesos de producers e consumers vivos — ver `LOAD_UNITS` em `rooms.ts`. */
  units: number;
  /** Fração de um núcleo usada pelo processo no último intervalo, suavizada. De 0 a 1. */
  cpu: number;
  /** Quantas salas têm um Router aqui. */
  routers: number;
}

export interface WorkerPoolOptions {
  workers: number;
  rtcMinPort: number;
  listenIp: string;
  announcedIp: string;
  /** Carga a partir da qual o Worker conta como cheio. */
  capacity: number;
  /** Chamado quando o processo de um Worker morre — ver `main.ts`. */
  onWorkerDied: (index: number) => void;
}

export interface WorkerStats {
  index: number;
  pid: number;
  rtcPort: number;
  cpu: number;
  units: number;
  routers: number;
  saturated: boolean;
}

/**
 * Acima disto de CPU o Worker é tratado como cheio mesmo que a conta de
 * carga diga que cabe mais.
 *
 * Um Worker é um laço só: perto de 100% ele começa a atrasar pacote, e
 * atraso em áudio vira estalo. 85% deixa folga para o pico de um quadro-chave
 * de tela sem que alguém precise ouvir o limite ser encontrado.
 */
const CPU_SATURATION = 0.85;

const CPU_SAMPLE_MS = 2_000;

/**
 * Os Workers do nó, um por núcleo, e a decisão de onde cada sala nova entra.
 *
 * A capacidade do nó é a soma deles — é por isso que crescer é trocar a
 * máquina: mais núcleos, mais Workers, sem nenhuma linha diferente aqui.
 */
export class WorkerPool {
  private readonly lastSample = new Map<number, { cpuMs: number; at: number }>();
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    readonly slots: WorkerSlot[],
    private readonly capacity: number,
  ) {}

  static async create(options: WorkerPoolOptions): Promise<WorkerPool> {
    const slots = await Promise.all(
      Array.from({ length: options.workers }, async (_unused, index): Promise<WorkerSlot> => {
        // Sem `rtcMinPort`/`rtcMaxPort` no Worker: toda porta é pedida
        // explicitamente — a de mídia logo abaixo, as das pontes em
        // `RoomRegistry` —, então nada é sorteado numa faixa que alguém
        // esqueceu de liberar.
        const worker = await mediasoup.createWorker({ logLevel: 'warn' });
        worker.on('died', () => options.onWorkerDied(index));

        const rtcPort = options.rtcMinPort + index;
        const listen = {
          ip: options.listenIp,
          announcedAddress: options.announcedIp,
          port: rtcPort,
        };
        const webRtcServer = await worker.createWebRtcServer({
          // UDP é o caminho de verdade. O TCP na mesma porta só serve a quem
          // está atrás de rede que bloqueia UDP, e só se a porta estiver
          // liberada em TCP também — candidato que não conecta é ignorado.
          listenInfos: [
            { protocol: 'udp', ...listen },
            { protocol: 'tcp', ...listen },
          ],
        });

        return { index, worker, webRtcServer, rtcPort, units: 0, cpu: 0, routers: 0 };
      }),
    );

    const pool = new WorkerPool(slots, options.capacity);
    pool.timer = setInterval(() => void pool.sampleCpu(), CPU_SAMPLE_MS);
    // O medidor não pode ser o que mantém o processo vivo.
    pool.timer.unref();
    return pool;
  }

  /**
   * Quão cheio está, onde 1 é "não ponha mais nada aqui".
   *
   * Duas medidas, e vale a pior: a conta de carga responde na hora (quem
   * acabou de entrar já pesa, antes de a CPU subir), e a CPU medida é a
   * verdade que a conta só estima.
   */
  score(slot: WorkerSlot): number {
    return Math.max(slot.units / this.capacity, slot.cpu / CPU_SATURATION);
  }

  isSaturated(slot: WorkerSlot): boolean {
    return this.score(slot) >= 1;
  }

  /** O mais folgado entre `candidates` — ou entre todos. Empate fica com o de menor índice. */
  leastLoaded(candidates: Iterable<WorkerSlot> = this.slots): WorkerSlot {
    let best: WorkerSlot | null = null;
    for (const slot of candidates) {
      if (best === null || this.score(slot) < this.score(best)) best = slot;
    }
    if (best === null) throw new Error('nenhum Worker disponível');
    return best;
  }

  stats(): WorkerStats[] {
    return this.slots.map((slot) => ({
      index: slot.index,
      pid: slot.worker.pid,
      rtcPort: slot.rtcPort,
      cpu: Math.round(slot.cpu * 1000) / 1000,
      units: slot.units,
      routers: slot.routers,
      saturated: this.isSaturated(slot),
    }));
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const slot of this.slots) slot.worker.close();
  }

  private async sampleCpu(): Promise<void> {
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.worker.closed) return;
        try {
          const usage = await slot.worker.getResourceUsage();
          const cpuMs = usage.ru_utime + usage.ru_stime;
          const at = performance.now();
          const last = this.lastSample.get(slot.index);
          this.lastSample.set(slot.index, { cpuMs, at });
          if (last === undefined || at <= last.at) return;
          const fraction = Math.min(1, Math.max(0, (cpuMs - last.cpuMs) / (at - last.at)));
          // Média móvel: um pico de dois segundos não deve mandar uma sala
          // inteira para outro Worker.
          slot.cpu = slot.cpu * 0.5 + fraction * 0.5;
        } catch {
          // Worker fechando no meio da leitura: o evento `died` cuida disso.
        }
      }),
    );
  }
}
