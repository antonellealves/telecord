/**
 * Configuração do processo mediasoup-sfu, lida uma vez no boot.
 *
 * Mesmo princípio do `apps/api/src/common/config.ts`: falha cedo, com uma
 * mensagem que lista tudo que falta de uma vez.
 *
 * ## O que aqui é infraestrutura, e por isso é variável de ambiente
 *
 * A meta do desenho é que capacidade seja assunto de máquina, não de código:
 * uma VM com mais núcleos sobe mais Workers sozinha, e nada abaixo precisa
 * ser tocado para isso. As variáveis existem para CONTRARIAR o automático
 * quando a máquina é dividida com outra coisa — como hoje, com o LiveKit ao
 * lado —, não para ligá-lo.
 */
import { availableParallelism } from 'node:os';

export class ConfigError extends Error {}

export interface SfuConfig {
  port: number;
  /**
   * Credencial compartilhada com `apps/api`, usada de duas formas: (1) as
   * rotas `/rooms/*` deste processo exigem `Authorization: Bearer
   * <internalSecret>`, tráfego servidor-servidor via o proxy `/api/mediasoup/*`;
   * (2) o MESMO segredo assina/verifica o token de curta duração dos canais
   * `/presence` e `/signal` (ver `presenceToken.ts` em `@telecord/shared`),
   * que esses sim são expostos ao navegador — reuso deliberado, sem segredo
   * novo, porque verificar o token não exige o Bearer completo, só recalcular
   * o HMAC.
   */
  internalSecret: string;
  /**
   * IP público da VM, anunciado como candidato ICE. Mesma necessidade do
   * `LIVEKIT_NODE_IP` em `livekit.yaml`: sem isto, o mediasoup só anuncia o IP
   * interno do container, e nenhum cliente fora da VM consegue estabelecer o
   * caminho de mídia.
   */
  announcedIp: string;
  /** Onde os sockets de mídia escutam. `0.0.0.0` no contêiner; `127.0.0.1` em teste. */
  listenIp: string;
  /**
   * Portas de mídia. Deixaram de ser uma faixa sorteada POR TRANSPORTE: cada
   * Worker escuta numa porta fixa (`rtcMinPort + índice`) e todos os
   * transportes dele dividem essa porta — ver `workers.ts`. A faixa agora só
   * limita quantos Workers cabem, não quantas pessoas.
   */
  rtcMinPort: number;
  rtcMaxPort: number;
  /** Um Worker por núcleo é o que o mediasoup pede; ver `loadConfig` para o padrão. */
  workers: number;
  /** Quanta carga um Worker aceita antes de a sala transbordar para outro — ver `LOAD_UNITS` em `rooms.ts`. */
  workerCapacity: number;
  /**
   * Portas das pontes entre Workers, só em 127.0.0.1. Nunca saem da máquina,
   * então não precisam de firewall — só não podem colidir com as de cima.
   */
  pipeMinPort: number;
  pipeMaxPort: number;
  /** De quanto em quanto tempo o canal de mídia confere se o outro lado ainda existe. */
  heartbeatIntervalMs: number;
  /**
   * Quanto tempo a sessão de mídia de um par sobrevive sem NENHUM canal de
   * controle aberto. É a folga que deixa uma queda breve de rede terminar em
   * retomada, em vez de derrubar a voz de quem só trocou de Wi-Fi.
   */
  resumeGraceMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') missing.push(name);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} precisa ser um inteiro positivo (valor: ${raw}).`);
  }
  return parsed;
}

/**
 * `cores` entra como parâmetro só para o teste poder simular outra máquina.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): SfuConfig {
  const missing: string[] = [];
  const internalSecret = required(env, 'MEDIASOUP_INTERNAL_SECRET', missing);
  const announcedIp = required(env, 'MEDIASOUP_ANNOUNCED_IP', missing);

  if (missing.length > 0) {
    throw new ConfigError(`Faltam variáveis de ambiente: ${missing.join(', ')}.`);
  }

  // Faixa PRÓPRIA, fora da 40000-40100/udp que o livekit.yaml já reserva
  // nesta mesma VM — as duas faixas nunca podem se sobrepor.
  const rtcMinPort = integer(env, 'MEDIASOUP_RTC_MIN_PORT', 40101);
  const rtcMaxPort = integer(env, 'MEDIASOUP_RTC_MAX_PORT', 40200);
  if (rtcMaxPort < rtcMinPort) {
    throw new ConfigError('MEDIASOUP_RTC_MAX_PORT não pode ser menor que MEDIASOUP_RTC_MIN_PORT.');
  }
  const portsAvailable = rtcMaxPort - rtcMinPort + 1;

  /*
   * Sem `MEDIASOUP_WORKERS`, um Worker por núcleo que o sistema entrega a
   * este processo (`availableParallelism` respeita a afinidade de CPU, então
   * num contêiner restrito o número é o do contêiner). Trocar a VM por uma
   * maior é o que aumenta a capacidade; nada aqui muda.
   *
   * `auto` diz o mesmo por extenso — existe para quem precisa VOLTAR ao
   * automático num lugar onde o padrão foi fixado, como o compose de
   * produção, que hoje prende em 1 por causa da VM pequena.
   *
   * Pedir MAIS Workers do que portas é erro, não ajuste silencioso: quem
   * escreveu o número espera aquela quantidade, e descobrir depois que subiu
   * menos é pior que não subir.
   */
  const requested = env.MEDIASOUP_WORKERS?.trim().toLowerCase() ?? '';
  const workers =
    requested === '' || requested === 'auto'
      ? Math.max(1, Math.min(cores, portsAvailable))
      : integer(env, 'MEDIASOUP_WORKERS', 1);
  if (workers > portsAvailable) {
    throw new ConfigError(
      `MEDIASOUP_WORKERS=${workers} não cabe na faixa ${rtcMinPort}-${rtcMaxPort}: cada Worker usa uma porta.`,
    );
  }

  const pipeMinPort = integer(env, 'MEDIASOUP_PIPE_MIN_PORT', 41000);
  const pipeMaxPort = integer(env, 'MEDIASOUP_PIPE_MAX_PORT', 41999);
  if (pipeMaxPort < pipeMinPort) {
    throw new ConfigError('MEDIASOUP_PIPE_MAX_PORT não pode ser menor que MEDIASOUP_PIPE_MIN_PORT.');
  }
  if (pipeMinPort <= rtcMaxPort && rtcMinPort <= pipeMaxPort) {
    throw new ConfigError(
      'A faixa MEDIASOUP_PIPE_* se sobrepõe à MEDIASOUP_RTC_*: as duas disputariam as mesmas portas.',
    );
  }

  return {
    port: integer(env, 'PORT', 3100),
    internalSecret,
    announcedIp,
    listenIp: env.MEDIASOUP_LISTEN_IP?.trim() || '0.0.0.0',
    rtcMinPort,
    rtcMaxPort,
    workers,
    workerCapacity: integer(env, 'MEDIASOUP_WORKER_CAPACITY', 500),
    pipeMinPort,
    pipeMaxPort,
    heartbeatIntervalMs: 15_000,
    resumeGraceMs: 10_000,
  };
}
