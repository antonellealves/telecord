import type { MetricPoint } from '@telecord/shared';

/**
 * Montagem das séries diárias do painel.
 *
 * Duas coisas que parecem detalhe e não são:
 *
 * **1. Dia sem evento precisa aparecer como zero.** O banco só devolve as
 * linhas que existem. Um gráfico desenhado direto do resultado ligaria terça a
 * sexta com um traço reto, escondendo que quarta e quinta foram zero — e
 * "zero" é exatamente o que alguém abre um painel para descobrir. Preencher os
 * buracos é o que faz a forma do gráfico dizer a verdade.
 *
 * **2. Os dias são UTC.** É o fuso em que as datas estão gravadas, e converter
 * para o de quem olha exigiria decidir o fuso de quem olha — o que muda o
 * recorte de cada dia e faria dois administradores verem números diferentes
 * para a mesma pergunta. O painel diz que é UTC em vez de fingir precisão que
 * não tem.
 *
 * Funções puras, aqui, porque a aritmética de calendário é onde erro de um dia
 * se esconde: a série de 30 dias tem que ter 30 pontos, terminar hoje e
 * começar 29 dias atrás — e isso é fácil de provar com teste e difícil de
 * enxergar num gráfico.
 */

/** `YYYY-MM-DD` em UTC. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Meia-noite UTC de `days - 1` dias atrás — o começo do recorte. */
export function startOfWindow(now: Date, days: number): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      (days - 1) * 24 * 60 * 60 * 1000,
  );
  return start;
}

/** Os `days` dias do recorte, em ordem, terminando em hoje. */
export function windowDays(now: Date, days: number): string[] {
  const start = startOfWindow(now, days);
  const keys: string[] = [];
  for (let index = 0; index < days; index += 1) {
    keys.push(dayKey(new Date(start.getTime() + index * 24 * 60 * 60 * 1000)));
  }
  return keys;
}

/**
 * Junta o que o banco devolveu com o calendário do recorte.
 *
 * Linha de dia fora da janela é descartada em silêncio: ela só apareceria por
 * desencontro de fuso entre o filtro e o agrupamento, e enfiá-la no gráfico
 * criaria um ponto no lugar errado.
 */
export function fillSeries(
  days: string[],
  rows: readonly { day: string; value: number }[],
): MetricPoint[] {
  const found = new Map(rows.map((row) => [row.day, row.value]));
  return days.map((day) => ({ date: day, value: found.get(day) ?? 0 }));
}
