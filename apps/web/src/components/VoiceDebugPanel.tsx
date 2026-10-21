import { useEffect, useRef, useState } from 'react';
import {
  DtxMeter,
  summarizeVoiceStream,
  toStatsMap,
  type DtxSummary,
  type StatsMap,
  type VoiceDirection,
  type VoiceStreamStats,
} from '../lib/voice/voiceStats';
import { DISCORD_REFERENCE } from '../lib/voice/voiceProfile';
import styles from './VoiceDebugPanel.module.css';

/** Um fluxo de voz que o painel sabe ler. Cada transporte fornece os seus. */
export interface VoiceStatsSource {
  id: string;
  label: string;
  direction: VoiceDirection;
  getStats: () => Promise<RTCStatsReport>;
}

interface Props {
  /** Chamado a cada leitura: a lista muda quando alguém entra, sai ou liga o microfone. */
  getSources: () => VoiceStatsSource[];
  /** O teto escolhido na sala, para comparar com o `targetBitrate`. */
  bitrate: number;
  transportLabel: string;
}

interface Row {
  source: Pick<VoiceStatsSource, 'id' | 'label' | 'direction'>;
  stats: VoiceStreamStats;
  dtx: DtxSummary | null;
}

const POLL_MS = 1_000;

function fmt(value: number | null, digits = 0, unit = ''): string {
  if (value === null) return '—';
  return `${value.toFixed(digits)}${unit}`;
}

const kbps = (bps: number | null): string => (bps === null ? '—' : `${(bps / 1000).toFixed(1)} kbps`);

const DTX_LABEL: Record<DtxSummary['verdict'], string> = {
  medindo: 'medindo — fique calado alguns segundos',
  ok: 'ok — silêncio caiu',
  'dtx-inativo': 'DTX sem efeito — silêncio gastando banda',
};

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/**
 * Painel de debug da voz (Ctrl+Shift+D), para comparar com o Discord.
 *
 * Lê `getStats()` de cada sender/receiver de voz a cada segundo e mostra os
 * campos que se olha no `chrome://webrtc-internals`. Fechado, não lê nada.
 */
export function VoiceDebugPanel({ getSources, bitrate, transportLabel }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const getSourcesRef = useRef(getSources);
  getSourcesRef.current = getSources;

  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyD' && !isTyping(event.target)) {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const previous = new Map<string, StatsMap>();
    const meters = new Map<string, DtxMeter>();

    const poll = async (): Promise<void> => {
      const sources = getSourcesRef.current();
      const next = await Promise.all(
        sources.map(async (source): Promise<Row | null> => {
          try {
            const current = toStatsMap(await source.getStats());
            const stats = summarizeVoiceStream(source.direction, current, previous.get(source.id));
            previous.set(source.id, current);
            if (stats === null) return null;
            let dtx: DtxSummary | null = null;
            if (source.direction === 'send') {
              const meter = meters.get(source.id) ?? new DtxMeter();
              meters.set(source.id, meter);
              meter.push(stats.audioLevel, stats.bitrateBps);
              dtx = meter.summary;
            }
            return { source: { id: source.id, label: source.label, direction: source.direction }, stats, dtx };
          } catch {
            return null;
          }
        }),
      );
      if (alive) setRows(next.filter((row): row is Row => row !== null));
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  return (
    <aside className={styles.panel} role="dialog" aria-label="Debug da voz">
      <header className={styles.header}>
        <h2 className={styles.heading}>Voz · {transportLabel}</h2>
        <span className={styles.hint}>Ctrl+Shift+D fecha</span>
      </header>
      <p className={styles.reference}>
        Discord nesta rede: RTT ~{DISCORD_REFERENCE.rttMs} ms · perda {DISCORD_REFERENCE.lossPercent}% · concealment &lt;
        {DISCORD_REFERENCE.concealmentPercentMax}% · ~{DISCORD_REFERENCE.speakingKbps} kbps falando · ~
        {DISCORD_REFERENCE.silenceKbps} kbps calado · teto desta sala {bitrate / 1000} kbps
      </p>
      {rows.length === 0 ? <p className={styles.empty}>Nenhum fluxo de voz no ar.</p> : null}
      {rows.map(({ source, stats, dtx }) => (
        <section key={source.id} className={styles.stream}>
          <h3 className={styles.streamTitle}>
            <span className={styles.direction}>{source.direction === 'send' ? 'envio' : 'recepção'}</span>
            {source.label}
          </h3>
          <code className={styles.codec}>{stats.codec ?? 'codec ainda não negociado'}</code>
          <dl className={styles.grid}>
            {source.direction === 'send' ? (
              <>
                <dt>targetBitrate</dt>
                <dd className={stats.targetBitrate !== null && stats.targetBitrate !== bitrate ? styles.off : undefined}>
                  {fmt(stats.targetBitrate)}
                </dd>
                <dt>bytesSent/s</dt>
                <dd>{kbps(stats.bitrateBps)}</dd>
              </>
            ) : (
              <>
                <dt>bytesReceived/s</dt>
                <dd>{kbps(stats.bitrateBps)}</dd>
              </>
            )}
            <dt>com cabeçalho</dt>
            <dd>{kbps(stats.wireBitrateBps)}</dd>
            <dt>pacotes/s</dt>
            <dd>{fmt(stats.packetsPerSecond)}</dd>
            <dt>packetsLost</dt>
            <dd>{fmt(stats.packetsLost)}</dd>
            <dt>fractionLost</dt>
            <dd>{stats.fractionLost === null ? '—' : `${(stats.fractionLost * 100).toFixed(2)}%`}</dd>
            <dt>jitter</dt>
            <dd>{fmt(stats.jitterMs, 1, ' ms')}</dd>
            <dt>roundTripTime</dt>
            <dd>{fmt(stats.rttMs, 1, ' ms')}</dd>
            <dt>nackCount</dt>
            <dd>{fmt(stats.nackCount)}</dd>
            {source.direction === 'recv' ? (
              <>
                <dt>fecPacketsReceived</dt>
                <dd>{fmt(stats.fecPacketsReceived)}</dd>
                <dt>concealed − silent</dt>
                <dd>
                  {fmt(stats.concealedNonSilentSamples)}
                  {stats.concealmentPercent === null ? '' : ` (${stats.concealmentPercent.toFixed(2)}%/s)`}
                </dd>
                <dt>jitterBufferDelay/emitted</dt>
                <dd>{fmt(stats.jitterBufferMs, 1, ' ms')}</dd>
              </>
            ) : null}
            <dt>audioLevel</dt>
            <dd>{fmt(stats.audioLevel, 3)}</dd>
          </dl>
          {dtx !== null ? (
            <p className={dtx.verdict === 'dtx-inativo' ? `${styles.dtx} ${styles.off}` : styles.dtx}>
              DTX: calado {kbps(dtx.silenceBps)} · falando {kbps(dtx.speakingBps)} · {DTX_LABEL[dtx.verdict]}
            </p>
          ) : null}
        </section>
      ))}
    </aside>
  );
}
