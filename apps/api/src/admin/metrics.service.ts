import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DashboardMetrics, Kpi, LogLevel, MetricPoint } from '@telecord/shared';
import { PrismaService } from '../prisma/prisma.service';
import { fillSeries, startOfWindow, windowDays } from './metrics-series';

/** Recortes que o painel oferece. Fora disso, cai no mais próximo. */
const ALLOWED_DAYS = [7, 30, 90] as const;

interface RawDay {
  day: string;
  total: bigint | number | null;
}

/**
 * Os números do painel.
 *
 * ## De onde vem cada um
 *
 * Contas e salas saem das próprias tabelas. Sessões e minutos saem de
 * `MediaSession`, que só o webhook do LiveKit escreve — e é por isso que
 * `hasSessionData` existe: sem webhook configurado, a resposta honesta é "não
 * estou medindo isto", não um zero que se confunde com "ninguém conversou".
 *
 * ## O custo
 *
 * São cerca de quinze consultas por carregamento, e em produção
 * (`connection_limit=1`) elas se enfileiram. É caro, e é aceitável: é uma
 * tela de administrador, aberta por uma pessoa de vez em quando, não um
 * caminho de usuário. O que seria inaceitável é o contrário — uma consulta só,
 * cheia de subselects, que ninguém consegue ler nem otimizar depois.
 *
 * As séries diárias vão em SQL cru porque agrupar por dia é agrupar por uma
 * EXPRESSÃO (`DATE_FORMAT`), e nenhum ORM agrupa por expressão sem virar
 * ginástica. `DATE_FORMAT` também evita conversão de tipo no caminho: volta
 * texto `YYYY-MM-DD`, que é exatamente o que o gráfico consome.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  static normalizeDays(raw: string | undefined): number {
    const value = Number(raw ?? '30');
    const found = ALLOWED_DAYS.find((allowed) => allowed === value);
    return found ?? 30;
  }

  async dashboard(days: number): Promise<DashboardMetrics> {
    const now = new Date();
    const from = startOfWindow(now, days);
    const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    // Janela anterior, do mesmo tamanho e imediatamente antes: é ela que dá
    // sentido a "subiu" ou "caiu" no cartão de indicador.
    const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

    const range = { gte: from, lt: to };
    const previousRange = { gte: previousFrom, lt: from };

    const [
      totalUsers,
      newUsers,
      newUsersBefore,
      activeUsers,
      activeUsersBefore,
      sessions,
      sessionsBefore,
      voiceSeconds,
      voiceSecondsBefore,
      roomsCreated,
      roomsCreatedBefore,
      soundsUploaded,
      soundsUploadedBefore,
      errors,
      errorsBefore,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: range, deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: previousRange, deletedAt: null } }),
      this.prisma.user.count({ where: { lastSeenAt: range, deletedAt: null } }),
      this.prisma.user.count({ where: { lastSeenAt: previousRange, deletedAt: null } }),
      this.prisma.mediaSession.count({ where: { joinedAt: range } }),
      this.prisma.mediaSession.count({ where: { joinedAt: previousRange } }),
      this.prisma.mediaSession.aggregate({
        where: { joinedAt: range },
        _sum: { durationSeconds: true },
      }),
      this.prisma.mediaSession.aggregate({
        where: { joinedAt: previousRange },
        _sum: { durationSeconds: true },
      }),
      this.prisma.room.count({ where: { createdAt: range, deletedAt: null } }),
      this.prisma.room.count({ where: { createdAt: previousRange, deletedAt: null } }),
      this.prisma.sound.count({ where: { createdAt: range } }),
      this.prisma.sound.count({ where: { createdAt: previousRange } }),
      this.prisma.systemLog.count({ where: { createdAt: range, level: 'ERROR' } }),
      this.prisma.systemLog.count({ where: { createdAt: previousRange, level: 'ERROR' } }),
    ]);

    const [newUsersSeries, sessionsSeries, voiceMinutesSeries, errorsSeries, topRooms, levels] =
      await Promise.all([
        this.dailyCount(Prisma.sql`SELECT DATE_FORMAT(\`createdAt\`, '%Y-%m-%d') AS day, COUNT(*) AS total
          FROM \`User\` WHERE \`createdAt\` >= ${from} AND \`createdAt\` < ${to} AND \`deletedAt\` IS NULL
          GROUP BY day`, days, now),
        this.dailyCount(Prisma.sql`SELECT DATE_FORMAT(\`joinedAt\`, '%Y-%m-%d') AS day, COUNT(*) AS total
          FROM \`MediaSession\` WHERE \`joinedAt\` >= ${from} AND \`joinedAt\` < ${to}
          GROUP BY day`, days, now),
        this.dailyCount(Prisma.sql`SELECT DATE_FORMAT(\`joinedAt\`, '%Y-%m-%d') AS day,
            FLOOR(COALESCE(SUM(\`durationSeconds\`), 0) / 60) AS total
          FROM \`MediaSession\` WHERE \`joinedAt\` >= ${from} AND \`joinedAt\` < ${to}
          GROUP BY day`, days, now),
        this.dailyCount(Prisma.sql`SELECT DATE_FORMAT(\`createdAt\`, '%Y-%m-%d') AS day, COUNT(*) AS total
          FROM \`SystemLog\` WHERE \`createdAt\` >= ${from} AND \`createdAt\` < ${to} AND \`level\` = 'ERROR'
          GROUP BY day`, days, now),
        this.prisma.mediaSession.groupBy({
          by: ['roomSlug'],
          where: { joinedAt: range },
          _count: { _all: true },
          _sum: { durationSeconds: true },
          orderBy: { _count: { roomSlug: 'desc' } },
          take: 8,
        }),
        this.prisma.systemLog.groupBy({
          by: ['level'],
          where: { createdAt: range },
          _count: { _all: true },
        }),
      ]);

    const voiceMinutes = Math.round((voiceSeconds._sum.durationSeconds ?? 0) / 60);
    const voiceMinutesBefore = Math.round((voiceSecondsBefore._sum.durationSeconds ?? 0) / 60);

    return {
      days,
      generatedAt: now.toISOString(),

      totalUsers: { value: totalUsers, previous: null },
      newUsers: kpi(newUsers, newUsersBefore),
      activeUsers: kpi(activeUsers, activeUsersBefore),
      sessions: kpi(sessions, sessionsBefore),
      voiceMinutes: kpi(voiceMinutes, voiceMinutesBefore),
      roomsCreated: kpi(roomsCreated, roomsCreatedBefore),
      soundsUploaded: kpi(soundsUploaded, soundsUploadedBefore),
      errors: kpi(errors, errorsBefore),

      newUsersSeries,
      sessionsSeries,
      voiceMinutesSeries,
      errorsSeries,

      topRooms: topRooms.map((row) => ({
        slug: row.roomSlug,
        sessions: row._count._all,
        minutes: Math.round((row._sum.durationSeconds ?? 0) / 60),
      })),
      levelBreakdown: levels.map((row) => ({
        level: row.level as LogLevel,
        count: row._count._all,
      })),
      // Sem NENHUMA sessão no período, quase sempre o webhook não está
      // configurado. O painel precisa dizer isso, e não desenhar um gráfico
      // reto no zero como se fosse medição.
      hasSessionData: sessions > 0,
    };
  }

  /**
   * Executa a consulta de série e devolve os `days` pontos, com zero onde não
   * houve linha.
   *
   * `COUNT(*)` volta como `BigInt` no driver do MySQL — daí a conversão
   * explícita. `Number()` sobre uma contagem diária é seguro; o dia em que não
   * for, o problema é outro.
   */
  private async dailyCount(query: Prisma.Sql, days: number, now: Date): Promise<MetricPoint[]> {
    const rows = await this.prisma.$queryRaw<RawDay[]>(query);
    return fillSeries(
      windowDays(now, days),
      rows.map((row) => ({ day: String(row.day), value: Number(row.total ?? 0) })),
    );
  }
}

function kpi(value: number, previous: number): Kpi {
  return { value, previous };
}
