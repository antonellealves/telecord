import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardMetrics, Kpi } from '@telecord/shared';
import { AdminAudit } from '../components/AdminAudit';
import { AdminLive } from '../components/AdminLive';
import { AdminTable, formatBytes, formatDuration } from '../components/AdminTable';
import { AdminLogs } from '../components/AdminLogs';
import { AdminUsers } from '../components/AdminUsers';
import { formatWhen } from '../components/AdminLogs';
import {
  fetchAdminChannels,
  fetchAdminLogins,
  fetchAdminRooms,
  fetchAdminSessions,
  fetchAdminSounds,
} from '../lib/admin';
import { AmbientGradient } from '../components/AmbientGradient';
import { StatusScreen } from '../components/StatusScreen';
import { AreaChart, BarChart, BarList } from '../components/charts';
import { useAuth } from '../hooks/useAuth';
import { fetchMetrics } from '../lib/admin';
import { ApiError } from '../lib/apiClient';
import styles from '../components/Admin.module.css';
import statusStyles from '../components/StatusScreen.module.css';

const PERIODS = [7, 30, 90] as const;
type Tab = 'visao' | 'aovivo' | 'salas' | 'canais' | 'sons' | 'sessoes' | 'logins' | 'log' | 'auditoria' | 'contas';

const TABS: { id: Tab; label: string }[] = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'aovivo', label: 'Ao vivo' },
  { id: 'salas', label: 'Salas' },
  { id: 'canais', label: 'Canais' },
  { id: 'sons', label: 'Sons' },
  { id: 'sessoes', label: 'Sessões' },
  { id: 'logins', label: 'Logins' },
  { id: 'log', label: 'Log' },
  { id: 'auditoria', label: 'Auditoria' },
  { id: 'contas', label: 'Contas' },
];

/**
 * Painel de administração.
 *
 * ## Esta tela não é o controle de acesso
 *
 * Ela verifica o papel para saber O QUE DESENHAR — mostrar um painel vazio
 * para quem não pode vê-lo seria uma experiência ruim, não uma brecha. Quem
 * decide é o servidor: todas as rotas abaixo de `/api/admin` carregam
 * `@Roles('ADMIN')` na classe do controller e respondem 403 para conta comum,
 * inclusive para quem digitar `/painel` na barra de endereço ou chamar a API
 * direto. Esconder botão no front nunca foi controle de acesso.
 *
 * ## Números e a honestidade deles
 *
 * Os indicadores comparam o recorte escolhido com o período anterior de mesmo
 * tamanho — é o que dá sentido a "subiu". As séries diárias vêm agrupadas em
 * UTC pelo servidor, e a tela diz isso: converter para o fuso de quem olha
 * mudaria o recorte de cada dia e faria dois administradores verem números
 * diferentes para a mesma pergunta.
 *
 * Sessões e minutos só existem com o webhook do LiveKit configurado. Sem ele a
 * tela avisa, em vez de desenhar uma linha reta no zero como se ninguém
 * estivesse conversando.
 */
export function AdminPage(): JSX.Element {
  const { status, user } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [tab, setTab] = useState<Tab>('visao');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    if (!isAdmin) return undefined;
    const controller = new AbortController();
    setIsLoading(true);

    void fetchMetrics(days, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setMetrics(data);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiError ? failure.message : 'Não deu para carregar os números.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [days, isAdmin]);

  if (status === 'carregando') {
    return <StatusScreen title="Um instante" message="Conferindo sua sessão…" />;
  }

  if (!isAdmin) {
    /*
     * Mesma tela para "não entrou" e "entrou e não é administrador". A
     * distinção só interessaria a quem está sondando quem tem o cargo.
     */
    return (
      <StatusScreen
        title="Sem acesso"
        message="Este painel é da administração do Telecord."
      >
        <Link className={`${statusStyles.button} ${statusStyles.primary}`} to="/">
          Voltar ao início
        </Link>
      </StatusScreen>
    );
  }

  return (
    <>
      <AmbientGradient variant="subtle" />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.head}>
            <div>
              <h1 className={styles.title}>Painel</h1>
              <p className={styles.subtitle}>
                Contas, salas, sons e o registro de tudo que o servidor fez.{' '}
                <Link className={styles.back} to="/">
                  voltar ao início
                </Link>
              </p>
            </div>

            <div className={styles.periods} role="group" aria-label="Período">
              {PERIODS.map((period) => (
                <button
                  key={period}
                  type="button"
                  className={`${styles.period} ${days === period ? styles.periodOn : ''}`}
                  onClick={() => setDays(period)}
                  aria-pressed={days === period}
                >
                  {period} dias
                </button>
              ))}
            </div>
          </header>

          <nav className={styles.tabs}>
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`${styles.tab} ${tab === item.id ? styles.tabOn : ''}`}
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {tab === 'visao' ? (
            <Overview metrics={metrics} isLoading={isLoading} error={error} days={days} />
          ) : null}
          {tab === 'aovivo' ? <AdminLive /> : null}
          {tab === 'salas' ? (
            <AdminTable
              fetchPage={(options, signal) => fetchAdminRooms(options, signal)}
              rowKey={(row) => row.id}
              searchPlaceholder="Buscar por slug ou nome"
              emptyLabel="Nenhuma sala registrada."
              columns={[
                { header: 'Slug', cell: (row) => row.slug },
                { header: 'Nome', cell: (row) => row.name },
                { header: 'Dono', cell: (row) => row.ownerLabel },
                { header: 'Canal', cell: (row) => row.channelSlug },
                { header: 'Visibilidade', cell: (row) => row.visibility },
                { header: 'Membros', cell: (row) => row.members },
                { header: 'Sons', cell: (row) => row.sounds },
                { header: 'Criada', cell: (row) => formatWhen(row.createdAt) },
                { header: 'Ativa', cell: (row) => formatWhen(row.lastActiveAt) },
              ]}
            />
          ) : null}
          {tab === 'canais' ? (
            <AdminTable
              fetchPage={(options, signal) => fetchAdminChannels(options, signal)}
              rowKey={(row) => row.id}
              searchPlaceholder="Buscar por slug ou nome"
              emptyLabel="Nenhum canal registrado."
              columns={[
                { header: 'Slug', cell: (row) => row.slug },
                { header: 'Nome', cell: (row) => row.name },
                { header: 'Dono', cell: (row) => row.ownerLabel },
                { header: 'Visibilidade', cell: (row) => row.visibility },
                { header: 'Salas', cell: (row) => row.rooms },
                { header: 'Membros', cell: (row) => row.members },
                { header: 'Criado', cell: (row) => formatWhen(row.createdAt) },
              ]}
            />
          ) : null}
          {tab === 'sons' ? (
            <AdminTable
              fetchPage={(options, signal) => fetchAdminSounds(options, signal)}
              rowKey={(row) => row.id}
              searchPlaceholder="Buscar pelo nome do som"
              emptyLabel="Nenhum som enviado."
              columns={[
                { header: '', cell: (row) => row.emoji },
                { header: 'Nome', cell: (row) => row.label },
                { header: 'Sala', cell: (row) => row.roomSlug ?? 'global' },
                { header: 'Enviado por', cell: (row) => row.uploadedByLabel },
                { header: 'Tamanho', cell: (row) => formatBytes(row.byteSize) },
                { header: 'Formato', cell: (row) => row.mimeType },
                { header: 'Quando', cell: (row) => formatWhen(row.createdAt) },
              ]}
            />
          ) : null}
          {tab === 'sessoes' ? (
            <AdminTable
              fetchPage={(options, signal) => fetchAdminSessions(options, signal)}
              rowKey={(row) => row.id}
              searchPlaceholder="Buscar por sala ou pessoa"
              emptyLabel="Nenhuma sessão medida. Sem o webhook do LiveKit, esta tabela fica vazia."
              columns={[
                { header: 'Sala', cell: (row) => row.roomSlug },
                { header: 'Pessoa', cell: (row) => row.participantName },
                { header: 'Entrou', cell: (row) => formatWhen(row.joinedAt) },
                { header: 'Saiu', cell: (row) => (row.leftAt === null ? 'ainda dentro' : formatWhen(row.leftAt)) },
                { header: 'Duração', cell: (row) => formatDuration(row.durationSeconds) },
              ]}
            />
          ) : null}
          {tab === 'logins' ? (
            <AdminTable
              fetchPage={(options, signal) => fetchAdminLogins(options, signal)}
              rowKey={(row) => row.id}
              emptyLabel="Nenhuma sessão de login registrada."
              columns={[
                { header: 'Pessoa', cell: (row) => row.userLabel },
                { header: 'Situação', cell: (row) => (row.revoked ? 'revogada' : 'ativa') },
                { header: 'IP', cell: (row) => row.ip },
                { header: 'Navegador', cell: (row) => row.userAgent },
                { header: 'Criada', cell: (row) => formatWhen(row.createdAt) },
                { header: 'Expira', cell: (row) => formatWhen(row.expiresAt) },
              ]}
            />
          ) : null}
          {tab === 'log' ? <AdminLogs /> : null}
          {tab === 'auditoria' ? <AdminAudit /> : null}
          {tab === 'contas' ? <AdminUsers selfId={user.id} /> : null}
        </div>
      </div>
    </>
  );
}

function Overview({
  metrics,
  isLoading,
  error,
  days,
}: {
  metrics: DashboardMetrics | null;
  isLoading: boolean;
  error: string | null;
  days: number;
}): JSX.Element {
  if (error !== null) {
    return <p className={styles.error}>{error}</p>;
  }
  if (metrics === null) {
    return <p className={styles.muted}>{isLoading ? 'Somando…' : 'Sem dados.'}</p>;
  }

  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Contas" kpi={metrics.totalUsers} />
        <KpiCard label={`Novas em ${days}d`} kpi={metrics.newUsers} />
        <KpiCard label="Ativas" kpi={metrics.activeUsers} />
        <KpiCard label="Entradas em sala" kpi={metrics.sessions} />
        <KpiCard label="Minutos de conversa" kpi={metrics.voiceMinutes} />
        <KpiCard label="Salas criadas" kpi={metrics.roomsCreated} />
        <KpiCard label="Sons enviados" kpi={metrics.soundsUploaded} />
        {/* Erro é o único indicador em que subir é ruim. */}
        <KpiCard label="Erros" kpi={metrics.errors} inverted />
      </div>

      {!metrics.hasSessionData ? (
        <p className={styles.note}>
          Nenhuma sessão registrada neste período. Entradas e minutos vêm do webhook do LiveKit —
          se ele não estiver apontado para <code>/api/livekit/webhook</code> nas configurações do
          projeto, estes dois indicadores ficam em zero mesmo com gente conversando.
        </p>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Entradas em sala</h2>
          <AreaChart
            points={metrics.sessionsSeries}
            label="Entradas por dia"
            unit="entradas"
          />
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Minutos de conversa</h2>
          <AreaChart
            points={metrics.voiceMinutesSeries}
            label="Minutos por dia"
            tone="accent2"
            unit="min"
          />
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Contas novas</h2>
          <BarChart points={metrics.newUsersSeries} label="Cadastros por dia" unit="contas" />
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Erros</h2>
          <BarChart points={metrics.errorsSeries} label="Erros por dia" tone="danger" unit="erros" />
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Salas mais movimentadas</h2>
          <BarList
            items={metrics.topRooms.map((room) => ({
              label: room.slug,
              value: room.sessions,
              detail: `${room.sessions} entradas · ${room.minutes} min`,
            }))}
            empty="Nenhuma entrada registrada no período."
          />
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Log por nível</h2>
          <BarList
            items={metrics.levelBreakdown.map((row) => ({
              label: row.level,
              value: row.count,
              tone:
                row.level === 'ERROR'
                  ? ('danger' as const)
                  : row.level === 'WARN'
                    ? ('warn' as const)
                    : ('accent' as const),
            }))}
            empty="Nada registrado no período."
          />
        </div>
      </div>

      <p className={styles.muted}>
        Séries agrupadas por dia em UTC. Gerado em {new Date(metrics.generatedAt).toLocaleString('pt-BR')}.
      </p>
    </>
  );
}

function KpiCard({
  label,
  kpi,
  inverted = false,
}: {
  label: string;
  kpi: Kpi;
  inverted?: boolean;
}): JSX.Element {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>{kpi.value.toLocaleString('pt-BR')}</span>
      <span className={`${styles.kpiDelta} ${deltaClass(kpi, inverted)}`}>{deltaText(kpi)}</span>
    </div>
  );
}

/**
 * A variação contra o período anterior.
 *
 * Sem base de comparação (previous 0), mostra o número absoluto em vez de
 * "+∞%" ou "+100%" — os dois seriam invenção, e o primeiro dia de uso de um
 * sistema novo cairia sempre nesse caso.
 */
function deltaText(kpi: Kpi): string {
  if (kpi.previous === null) return 'total acumulado';
  const difference = kpi.value - kpi.previous;
  if (difference === 0) return 'igual ao período anterior';
  if (kpi.previous === 0) return `+${difference} (nada antes)`;
  const percent = Math.round((difference / kpi.previous) * 100);
  return `${difference > 0 ? '+' : ''}${difference} (${percent > 0 ? '+' : ''}${percent}%)`;
}

function deltaClass(kpi: Kpi, inverted: boolean): string {
  if (kpi.previous === null || kpi.value === kpi.previous) return '';
  const rose = kpi.value > kpi.previous;
  const good = inverted ? !rose : rose;
  return (good ? styles.up : styles.down) ?? '';
}
