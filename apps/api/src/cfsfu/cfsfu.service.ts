import { Inject, Injectable } from '@nestjs/common';
import type {
  CfCloseBody,
  CfRenegotiateBody,
  CfSessionResult,
  CfSfuClientConfig,
  CfSfuUsage,
  CfSimpleResult,
  CfTracksBody,
  CfTracksResult,
} from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import { forbidden } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { CloudflareRealtimeClient } from './cloudflare-realtime.client';

/**
 * Só quem renovou presença nos últimos 20 s conta como dentro da sala. Mesma
 * janela do modo P2P (o cliente renova a cada poucos segundos).
 */
const PRESENCE_TTL_MS = 20_000;

/**
 * Teto por reporte de uso. Uma janela de 15 s a 20 Mbps são ~37 MB; 1 GB é
 * folga larga que ainda impede um cliente adulterado de inflar a cota de uma vez.
 */
const MAX_REPORT_BYTES = 1_000_000_000;

/** STUN da Cloudflare — gratuito e ilimitado, recomendado para o Realtime. */
const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';

/**
 * Orquestra o Cloudflare Realtime SFU para o telecord.
 *
 * Fica ENTRE o controller e o cliente HTTP: valida que quem chama pertence à
 * sala (o SFU não tem sala; a portaria é aqui), repassa a chamada e cuida da
 * contabilidade de egress. O controller não fala com a Cloudflare direto, e o
 * cliente HTTP não conhece o banco — cada um com uma responsabilidade.
 */
@Injectable()
export class CfsfuService {
  constructor(
    private readonly client: CloudflareRealtimeClient,
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async createSession(roomSlug: string, peerId: string): Promise<CfSessionResult> {
    await this.assertMember(roomSlug, peerId);
    return this.client.createSession();
  }

  async newTracks(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    body: CfTracksBody,
  ): Promise<CfTracksResult> {
    await this.assertMember(roomSlug, peerId);
    return this.client.newTracks(sessionId, body);
  }

  async renegotiate(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    body: CfRenegotiateBody,
  ): Promise<CfSimpleResult> {
    await this.assertMember(roomSlug, peerId);
    return this.client.renegotiate(sessionId, body);
  }

  async closeTracks(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    body: CfCloseBody,
  ): Promise<CfTracksResult> {
    await this.assertMember(roomSlug, peerId);
    return this.client.closeTracks(sessionId, body);
  }

  /**
   * Soma o egress reportado por um assinante ao acumulado do mês.
   *
   * O que se conta é o `bytesReceived` de quem ASSISTE (egress do SFU para o
   * cliente) — o ingress de quem publica é grátis. É a medida mais próxima do
   * real sem falar com a API de billing; o número oficial fica no dashboard.
   */
  async reportUsage(roomSlug: string, peerId: string, bytes: number): Promise<void> {
    await this.assertMember(roomSlug, peerId);
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const delta = BigInt(Math.min(Math.round(bytes), MAX_REPORT_BYTES));
    const yearMonth = currentYearMonth();
    await this.prisma.cfsfuUsage.upsert({
      where: { yearMonth },
      create: { yearMonth, egressBytes: delta },
      update: { egressBytes: { increment: delta } },
    });
  }

  /** Config pública do transporte: STUN, flag de ligado e cota atual. */
  async clientConfig(): Promise<CfSfuClientConfig> {
    if (!this.client.enabled) {
      return {
        enabled: false,
        iceServers: [],
        usage: { monthlyLimitGb: 0, usedGb: 0, fraction: 0, blocked: true },
      };
    }
    return {
      enabled: true,
      iceServers: [{ urls: [CF_STUN_URL] }],
      usage: await this.usage(),
    };
  }

  /** Consumo estimado do mês corrente. */
  async usage(): Promise<CfSfuUsage> {
    const monthlyLimitGb = this.config.cfsfu?.monthlyLimitGb ?? 0;
    const row = await this.prisma.cfsfuUsage.findUnique({
      where: { yearMonth: currentYearMonth() },
      select: { egressBytes: true },
    });
    // Number é seguro: 1.000 GB são ~1e12 bytes, bem abaixo de 2^53.
    const usedGb = row === null ? 0 : Number(row.egressBytes) / 1_000_000_000;
    const fraction = monthlyLimitGb > 0 ? Math.min(1, usedGb / monthlyLimitGb) : 0;
    return { monthlyLimitGb, usedGb, fraction, blocked: fraction >= 1 };
  }

  /**
   * Recusa quem não está na sala.
   *
   * O SFU repassaria a chamada de qualquer um com o `sessionId`; a portaria é
   * esta. Presença é o mesmo sinal do roster — quem entrou na sala renovou
   * `PeerPresence`, e é isso que se confere antes de gastar cota da Cloudflare.
   */
  private async assertMember(roomSlug: string, peerId: string): Promise<void> {
    const presente = await this.prisma.peerPresence.findFirst({
      where: {
        roomSlug,
        peerId,
        lastSeenAt: { gte: new Date(Date.now() - PRESENCE_TTL_MS) },
      },
      select: { id: true },
    });
    if (presente === null) {
      throw forbidden('fora_da_sala', 'Entre na sala antes de usar o Edge global.');
    }
  }
}

/** 'YYYY-MM' em UTC — a chave de competência do mês. */
function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
