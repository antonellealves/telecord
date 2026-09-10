/**
 * Cursor e montagem de página.
 *
 * A aritmética aqui é pequena e o erro nela é invisível: uma página que
 * devolve `nextCursor` de uma linha que ela não entregou faz a próxima pular
 * um registro, e ninguém percebe olhando a tela. Num log de auditoria, o
 * registro pulado é justamente o que alguém foi procurar.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  keysetBefore,
  parseLimit,
} from '../src/common/pagination';
import { fillSeries, startOfWindow, windowDays } from '../src/admin/metrics-series';

describe('cursor', () => {
  it('vai e volta sem perder milissegundo', () => {
    // Truncar milissegundo faria duas linhas do mesmo segundo se atropelarem.
    const at = new Date('2026-09-10T13:45:12.345Z');
    const decoded = decodeCursor(encodeCursor(at, 'clx123'));

    assert.equal(decoded?.at.toISOString(), at.toISOString());
    assert.equal(decoded?.id, 'clx123');
  });

  it('ausente é começo da lista, não erro', () => {
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(''), null);
  });

  it('inválido é erro, e não a primeira página em silêncio', () => {
    // Devolver a primeira página deixaria quem paginou errado num laço.
    assert.throws(() => decodeCursor('nada-disso'));
    assert.throws(() => decodeCursor(Buffer.from('sem-separador').toString('base64url')));
    assert.throws(() => decodeCursor(Buffer.from('data-ruim|id').toString('base64url')));
  });
});

describe('limite', () => {
  it('tem padrão e teto, e recusa lixo', () => {
    assert.equal(parseLimit(undefined), 50);
    assert.equal(parseLimit('10'), 10);
    // Teto em vez de erro: quem pede 5.000 quer todas, e a resposta certa é
    // dar 100 e o cursor.
    assert.equal(parseLimit('5000'), 100);
    assert.throws(() => parseLimit('0'));
    assert.throws(() => parseLimit('-3'));
    assert.throws(() => parseLimit('abc'));
  });
});

describe('condição de keyset', () => {
  it('sem cursor não acrescenta cláusula', () => {
    assert.equal(keysetBefore(null, 'createdAt'), undefined);
  });

  it('compara o par (campo, id), e não só o campo', () => {
    /*
     * O `id` no desempate é o que impede duas escritas no mesmo milissegundo
     * de se atropelarem. Sem ele, `createdAt < cursor` pularia a segunda linha
     * do milissegundo; `createdAt <= cursor` repetiria a primeira.
     */
    const at = new Date('2026-09-10T00:00:00.000Z');
    const where = keysetBefore({ at, id: 'b' }, 'createdAt') as {
      OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }];
    };

    assert.equal(where.OR.length, 2);
    assert.deepEqual(where.OR[0], { createdAt: { lt: at } });
    assert.deepEqual(where.OR[1], { createdAt: at, id: { lt: 'b' } });
  });
});

describe('montagem da página', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ id: `id${n}`, at: new Date(2026, 0, n) }));

  it('com linha sobrando, corta e aponta para a ÚLTIMA entregue', () => {
    // O cursor tem que sair da última linha DEVOLVIDA. Saindo da linha extra,
    // a página seguinte pularia um registro.
    const page = buildPage(rows, 3, (row) => row.id, (row) => encodeCursor(row.at, row.id));

    assert.deepEqual(page.items, ['id1', 'id2', 'id3']);
    assert.equal(decodeCursor(page.nextCursor ?? undefined)?.id, 'id3');
  });

  it('sem linha sobrando, é o fim', () => {
    const page = buildPage(rows, 4, (row) => row.id, (row) => encodeCursor(row.at, row.id));
    assert.equal(page.items.length, 4);
    assert.equal(page.nextCursor, null);
  });

  it('lista vazia não inventa cursor', () => {
    const page = buildPage([], 10, (row: { id: string }) => row.id, () => 'x');
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
  });
});

describe('séries diárias do painel', () => {
  const now = new Date('2026-09-10T18:30:00.000Z');

  it('a janela tem o tamanho pedido e termina hoje', () => {
    const days = windowDays(now, 7);
    assert.equal(days.length, 7);
    assert.equal(days[0], '2026-09-04', 'começa seis dias antes, não sete');
    assert.equal(days[6], '2026-09-10');
    assert.equal(startOfWindow(now, 7).toISOString(), '2026-09-04T00:00:00.000Z');
  });

  it('dia sem evento vira zero, e não some do gráfico', () => {
    /*
     * O ponto do preenchimento. Sem ele, o gráfico ligaria 08 a 10 com um
     * traço reto e esconderia que o dia 09 foi zero — que é exatamente o que
     * alguém abre o painel para descobrir.
     */
    const series = fillSeries(windowDays(now, 3), [
      { day: '2026-09-08', value: 5 },
      { day: '2026-09-10', value: 2 },
    ]);

    assert.deepEqual(series, [
      { date: '2026-09-08', value: 5 },
      { date: '2026-09-09', value: 0 },
      { date: '2026-09-10', value: 2 },
    ]);
  });

  it('linha fora da janela é descartada, não empurrada para dentro', () => {
    const series = fillSeries(windowDays(now, 2), [{ day: '2026-01-01', value: 99 }]);
    assert.deepEqual(series.map((point) => point.value), [0, 0]);
  });

  it('atravessa a virada do mês sem pular dia', () => {
    // Aritmética de calendário é onde erro de um dia se esconde.
    const days = windowDays(new Date('2026-03-02T05:00:00.000Z'), 4);
    assert.deepEqual(days, ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});
