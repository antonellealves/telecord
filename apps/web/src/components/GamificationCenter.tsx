import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useGamification } from '../hooks/useGamification';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  dismissCelebration,
  markMissionsSeen,
  type Celebration,
  type MedalView,
  type MissionCategory,
  type MissionView,
} from '../lib/gamification';
import styles from './GamificationCenter.module.css';

interface Props {
  /** Muda só o tamanho/peso do gatilho conforme onde ele mora. */
  variant?: 'header' | 'hero';
}

/**
 * Central de gamificação: o gatilho (pílula com a medalha e o anel de nível),
 * o modal de progresso e a celebração animada.
 *
 * É autocontido de propósito — basta montar um em cada tela onde deva aparecer.
 * O estado real vive no store (`lib/gamification`), então dois gatilhos em telas
 * diferentes mostram o mesmo progresso, e a celebração dispara em qualquer um
 * que esteja montado quando um evento fecha uma missão.
 */
export function GamificationCenter({ variant = 'header' }: Props): JSX.Element {
  const snapshot = useGamification();
  const [isOpen, setIsOpen] = useState(false);

  const open = (): void => {
    setIsOpen(true);
    markMissionsSeen();
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.trigger} ${variant === 'hero' ? styles.triggerHero : ''}`}
        onClick={open}
        title="Missões, conquistas e nível"
        aria-label={`Progresso: ${snapshot.rank.name}, nível ${snapshot.rankIndex + 1}`}
      >
        <RankRing
          emoji={snapshot.rank.emoji}
          color={snapshot.rank.color}
          progress={snapshot.progressToNext}
        />
        <span className={styles.triggerText}>
          <span className={styles.triggerRank}>{snapshot.rank.name}</span>
          <span className={styles.triggerXp}>
            {snapshot.xp} XP · Nv {snapshot.rankIndex + 1}
          </span>
        </span>
        {snapshot.badge > 0 ? (
          <span className={styles.badge} aria-label={`${snapshot.badge} novas`}>
            {snapshot.badge}
          </span>
        ) : null}
      </button>

      {isOpen ? <ProgressModal onClose={() => setIsOpen(false)} snapshot={snapshot} /> : null}

      <CelebrationLayer celebration={snapshot.celebration} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Anel de nível
// ---------------------------------------------------------------------------

function RankRing({
  emoji,
  color,
  progress,
}: {
  emoji: string;
  color: string;
  progress: number;
}): JSX.Element {
  const style = {
    '--ring-color': color,
    '--ring-progress': `${Math.round(progress * 360)}deg`,
  } as CSSProperties;
  return (
    <span className={styles.ring} style={style} aria-hidden="true">
      <span className={styles.ringInner}>{emoji}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Modal de progresso
// ---------------------------------------------------------------------------

type Tab = 'missoes' | 'conquistas';

function ProgressModal({
  snapshot,
  onClose,
}: {
  snapshot: ReturnType<typeof useGamification>;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('missoes');

  // Esc fecha; o corpo para de rolar enquanto o modal está aberto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previo;
    };
  }, [onClose]);

  const grupos = useMemo(() => groupByCategory(snapshot.missions), [snapshot.missions]);

  return createPortal(
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Progresso e conquistas"
      >
        <header className={styles.modalHeader}>
          <RankRing
            emoji={snapshot.rank.emoji}
            color={snapshot.rank.color}
            progress={snapshot.progressToNext}
          />
          <div className={styles.headerInfo}>
            <p className={styles.headerRank}>
              {snapshot.rank.name}
              <span className={styles.headerLevel}>Nível {snapshot.rankIndex + 1}</span>
            </p>
            <div className={styles.headerBar}>
              <span
                className={styles.headerBarFill}
                style={{ width: `${Math.round(snapshot.progressToNext * 100)}%` }}
              />
            </div>
            <p className={styles.headerMeta}>
              {snapshot.nextRank !== null ? (
                <>
                  {snapshot.xpIntoRank}/{snapshot.xpForNext} XP para{' '}
                  <strong>{snapshot.nextRank.name}</strong>
                </>
              ) : (
                <>Posto máximo alcançado — {snapshot.xp} XP</>
              )}
              {' · '}
              {snapshot.completedCount}/{snapshot.totalCount} missões
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Fechar"
          >
            ×
          </button>
        </header>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'missoes'}
            className={`${styles.tab} ${tab === 'missoes' ? styles.tabActive : ''}`}
            onClick={() => setTab('missoes')}
          >
            Missões
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'conquistas'}
            className={`${styles.tab} ${tab === 'conquistas' ? styles.tabActive : ''}`}
            onClick={() => setTab('conquistas')}
          >
            Conquistas
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'missoes' ? (
            <div className={styles.missions}>
              {CATEGORY_ORDER.map((category) => {
                const missions = grupos.get(category);
                if (missions === undefined || missions.length === 0) return null;
                const feitas = missions.filter((m) => m.done).length;
                return (
                  <section key={category} className={styles.group}>
                    <h3 className={styles.groupTitle}>
                      {CATEGORY_LABEL[category]}
                      <span className={styles.groupCount}>
                        {feitas}/{missions.length}
                      </span>
                    </h3>
                    <ul className={styles.missionList}>
                      {missions.map((mission) => (
                        <MissionCard key={mission.id} mission={mission} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : (
            <MedalShelf medals={snapshot.medals} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function groupByCategory(missions: MissionView[]): Map<MissionCategory, MissionView[]> {
  const map = new Map<MissionCategory, MissionView[]>();
  for (const mission of missions) {
    const list = map.get(mission.category) ?? [];
    list.push(mission);
    map.set(mission.category, list);
  }
  return map;
}

function MissionCard({ mission }: { mission: MissionView }): JSX.Element {
  const pct = Math.round((mission.value / mission.goal) * 100);
  return (
    <li
      className={styles.mission}
      data-rarity={mission.rarity}
      data-done={mission.done ? 'true' : undefined}
    >
      <span className={styles.missionEmoji} aria-hidden="true">
        {mission.revealed ? mission.emoji : '❓'}
      </span>
      <div className={styles.missionMain}>
        <div className={styles.missionTop}>
          <span className={styles.missionTitle}>
            {mission.revealed ? mission.title : 'Missão secreta'}
          </span>
          <span className={styles.missionXp}>+{mission.xp} XP</span>
        </div>
        <p className={styles.missionDesc}>
          {mission.revealed ? mission.desc : 'Continue jogando para revelar esta missão.'}
        </p>
        <div className={styles.bar}>
          <span className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.missionFoot}>
          <span className={styles.missionCount}>
            {mission.value}/{mission.goal}
          </span>
          {mission.done ? (
            <span className={styles.doneTag}>✓ concluída</span>
          ) : mission.revealed && mission.tip !== undefined ? (
            <span className={styles.missionTip}>{mission.tip}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MedalShelf({ medals }: { medals: MedalView[] }): JSX.Element {
  return (
    <>
      <p className={styles.shelfLead}>
        Cada posto é uma medalha. Some XP concluindo missões e suba a estante.
      </p>
      <ul className={styles.medalGrid}>
        {medals.map((medal) => (
          <li
            key={medal.name}
            className={styles.medal}
            data-locked={medal.unlocked ? undefined : 'true'}
            data-current={medal.current ? 'true' : undefined}
            style={{ '--ring-color': medal.color } as CSSProperties}
          >
            <span className={styles.medalEmoji} aria-hidden="true">
              {medal.emoji}
            </span>
            <span className={styles.medalName}>{medal.name}</span>
            <span className={styles.medalReq}>
              {medal.current
                ? 'posto atual'
                : medal.unlocked
                  ? 'conquistado'
                  : `${medal.xp} XP`}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// Celebração
// ---------------------------------------------------------------------------

const CONFETTI_COLORS = ['#8ecdff', '#7256c9', '#e7c07a', '#7ec8a8', '#f0888a', '#ffffff'];

function CelebrationLayer({ celebration }: { celebration: Celebration | null }): JSX.Element | null {
  // Fecha sozinha depois de um tempo; o id na dependência reinicia o timer a
  // cada nova celebração da fila.
  useEffect(() => {
    if (celebration === null) return;
    const id = window.setTimeout(dismissCelebration, 3600);
    return () => window.clearTimeout(id);
  }, [celebration?.id]);

  const confetti = useMemo(() => {
    if (celebration === null) return [];
    return Array.from({ length: 48 }, (_, i) => ({
      key: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.6 + Math.random() * 1.4,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: 6 + Math.random() * 8,
      rotate: Math.random() * 360,
      drift: (Math.random() - 0.5) * 120,
    }));
  }, [celebration?.id]);

  if (celebration === null) return null;

  return createPortal(
    <div
      className={styles.celebration}
      onClick={dismissCelebration}
      role="alert"
      aria-live="assertive"
    >
      <div className={styles.confettiField} aria-hidden="true">
        {confetti.map((piece) => (
          <span
            key={piece.key}
            className={styles.confetti}
            style={
              {
                left: `${piece.left}%`,
                width: `${piece.size}px`,
                height: `${piece.size * 0.4}px`,
                background: piece.color,
                animationDelay: `${piece.delay}s`,
                animationDuration: `${piece.duration}s`,
                '--drift': `${piece.drift}px`,
                '--spin': `${piece.rotate}deg`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div
        className={styles.card}
        data-kind={celebration.kind}
        style={{ '--celebrate-color': celebration.color } as CSSProperties}
      >
        <span className={styles.cardGlow} aria-hidden="true" />
        <span className={styles.cardEmoji}>{celebration.emoji}</span>
        <p className={styles.cardSubtitle}>{celebration.subtitle}</p>
        <p className={styles.cardTitle}>{celebration.title}</p>
        <span className={styles.cardReward}>{celebration.reward}</span>
        <p className={styles.cardHint}>toque para continuar</p>
      </div>
    </div>,
    document.body,
  );
}
