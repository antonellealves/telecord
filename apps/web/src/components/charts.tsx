import { useId } from 'react';
import type { MetricPoint } from '@telecord/shared';
import styles from './charts.module.css';

/**
 * Gráficos do painel, desenhados à mão em SVG.
 *
 * Sem biblioteca, e a escolha é deliberada. As de gráfico são das maiores
 * dependências que um app deste tamanho pode adotar — a mais comum passa de
 * 300 KB — e este projeto tem uma lista curta de dependências permitidas, um
 * guarda de bundle no build e um chunk do LiveKit que já é o peso da página.
 * O que o painel precisa são três formas: uma área para série temporal, barras
 * verticais para contagem por dia e barras horizontais para um ranque. Isso é
 * aritmética de `map`, não motivo para trazer um mecanismo de plotagem.
 *
 * Todos usam `viewBox` com escala uniforme e `width: 100%`: o desenho se
 * adapta à coluna sem recalcular nada em JavaScript, e sem `ResizeObserver`.
 *
 * ## Acessibilidade
 *
 * Cada gráfico é uma `<figure>` com legenda em texto, e o SVG carrega um
 * `aria-label` que resume o que a forma diz — total, pico e último valor.
 * Quem não enxerga o desenho recebe a mesma informação em palavras, em vez de
 * um "imagem" sem conteúdo. Cada ponto tem `<title>`, o que também dá a dica
 * flutuante nativa ao passar o mouse, sem estado nem JavaScript.
 */

const WIDTH = 320;
const HEIGHT = 90;

export type ChartTone = 'accent' | 'accent2' | 'danger' | 'warn';

interface SeriesProps {
  points: MetricPoint[];
  label: string;
  tone?: ChartTone;
  /** Sufixo do valor no resumo falado e nas dicas: "min", "erros"… */
  unit?: string;
}

/*
 * `?? ''` em cada ramo porque o tipo gerado para módulo CSS devolve
 * `string | undefined`: uma classe removida do arquivo .css vira `undefined`
 * aqui em vez de erro de compilação, e sem o padrão o React escreveria
 * `class="undefined"` no elemento.
 */
function toneClass(tone: ChartTone | undefined): string {
  switch (tone) {
    case 'accent2':
      return styles.toneAccent2 ?? '';
    case 'danger':
      return styles.toneDanger ?? '';
    case 'warn':
      return styles.toneWarn ?? '';
    default:
      return styles.toneAccent ?? '';
  }
}

/** Rótulo curto de data: `2026-09-10` vira `10/09`. */
function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

function summarize(points: MetricPoint[], label: string, unit: string): string {
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const peak = points.reduce(
    (best, point) => (point.value > best.value ? point : best),
    points[0] ?? { date: '', value: 0 },
  );
  const last = points[points.length - 1];
  return (
    `${label}: ${total} ${unit} em ${points.length} dias. ` +
    `Pico de ${peak.value} em ${shortDate(peak.date)}. ` +
    `Último dia: ${last?.value ?? 0}.`
  );
}

/**
 * Série temporal como área preenchida.
 *
 * O eixo Y começa SEMPRE em zero, e o topo é o maior valor da série. Escala
 * que começa no mínimo — comum em biblioteca de gráfico — transforma uma
 * variação de 100 para 102 numa montanha, e é a forma mais fácil de um painel
 * mentir sem que ninguém tenha mentido.
 */
export function AreaChart({ points, label, tone, unit = '' }: SeriesProps): JSX.Element {
  const gradientId = useId();
  const max = Math.max(1, ...points.map((point) => point.value));

  const coords = points.map((point, index) => {
    const x = points.length === 1 ? WIDTH / 2 : (index / (points.length - 1)) * WIDTH;
    const y = HEIGHT - (point.value / max) * (HEIGHT - 8) - 4;
    return { x, y, point };
  });

  const line = coords.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  // Fecha na linha de base, e não no fim do `viewBox`: fechar embaixo dela
  // faria o preenchimento vazar quatro pixels por baixo do eixo, e a mancha
  // apareceria mesmo num dia de valor zero.
  const area = `${line} L${WIDTH} ${HEIGHT - 4} L0 ${HEIGHT - 4} Z`;

  return (
    <figure className={`${styles.chart} ${toneClass(tone)}`}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={styles.canvas}
        role="img"
        aria-label={summarize(points, label, unit)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Linha do zero: sem ela, uma série toda em zero fica invisível e o
            gráfico parece quebrado em vez de vazio. */}
        <line className={styles.baseline} x1="0" y1={HEIGHT - 4} x2={WIDTH} y2={HEIGHT - 4} />
        <path d={area} fill={`url(#${gradientId})`} />
        <path className={styles.line} d={line} />
        {coords.map(({ x, y, point }) => (
          <circle key={point.date} className={styles.dot} cx={x} cy={y} r="6">
            <title>{`${shortDate(point.date)}: ${point.value}${unit === '' ? '' : ` ${unit}`}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className={styles.caption}>
        <span>{label}</span>
        <span className={styles.captionRange}>
          {points.length > 0 ? `${shortDate(points[0]?.date ?? '')} – ${shortDate(points[points.length - 1]?.date ?? '')}` : ''}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Contagem por dia como barras.
 *
 * Barra e não área quando o que se conta é evento discreto — erro, por
 * exemplo. Área sugere continuidade entre os pontos, e não há nada acontecendo
 * entre a meia-noite de terça e a de quarta.
 */
export function BarChart({ points, label, tone, unit = '' }: SeriesProps): JSX.Element {
  const max = Math.max(1, ...points.map((point) => point.value));
  const slot = WIDTH / Math.max(1, points.length);
  const barWidth = Math.max(2, slot * 0.62);

  return (
    <figure className={`${styles.chart} ${toneClass(tone)}`}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={styles.canvas}
        role="img"
        aria-label={summarize(points, label, unit)}
      >
        <line className={styles.baseline} x1="0" y1={HEIGHT - 4} x2={WIDTH} y2={HEIGHT - 4} />
        {points.map((point, index) => {
          // Altura mínima de 2px para o dia com valor 1 não sumir; zero fica
          // zero, e é a ausência da barra que informa.
          const height = point.value === 0 ? 0 : Math.max(2, (point.value / max) * (HEIGHT - 10));
          return (
            <rect
              key={point.date}
              className={styles.bar}
              x={index * slot + (slot - barWidth) / 2}
              y={HEIGHT - 4 - height}
              width={barWidth}
              height={height}
              rx={Math.min(2, barWidth / 2)}
            >
              <title>{`${shortDate(point.date)}: ${point.value}${unit === '' ? '' : ` ${unit}`}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className={styles.caption}>
        <span>{label}</span>
      </figcaption>
    </figure>
  );
}

export interface BarListItem {
  label: string;
  value: number;
  /** Texto à direita: "12 min", "3 sessões". Cai no valor cru se ausente. */
  detail?: string;
  tone?: ChartTone;
}

/**
 * Ranque como barras horizontais dentro das próprias linhas.
 *
 * Escolhido no lugar de uma rosca para as distribuições: nome de sala não cabe
 * numa fatia, e comparar ângulo é notoriamente pior do que comparar
 * comprimento. A barra vive ATRÁS do texto, então a linha continua legível e a
 * proporção aparece sem custar uma legenda à parte.
 */
export function BarList({ items, empty }: { items: BarListItem[]; empty: string }): JSX.Element {
  if (items.length === 0) {
    return <p className={styles.empty}>{empty}</p>;
  }
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.label} className={`${styles.row} ${toneClass(item.tone)}`}>
          <span
            className={styles.rowFill}
            style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
            aria-hidden="true"
          />
          <span className={styles.rowLabel}>{item.label}</span>
          <span className={styles.rowValue}>{item.detail ?? String(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}
