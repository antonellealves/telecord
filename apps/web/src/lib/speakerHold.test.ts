/**
 * O destaque de "falando": acende na hora, apaga com atraso.
 *
 * Um indicador que pisca no ritmo das sílabas deixa de indicar quem fala; um
 * que demora a acender indica a pessoa errada. As duas metades ficam aqui.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEAKING_HOLD_MS, SpeakerHold } from './speakerHold';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(): { hold: SpeakerHold; changes: string[][] } {
  const changes: string[][] = [];
  const hold = new SpeakerHold((speaking) => changes.push([...speaking].sort()));
  return { hold, changes };
}

describe('destaque de quem fala', () => {
  it('acende no mesmo instante em que a pessoa aparece na lista', () => {
    const { hold, changes } = setup();
    hold.update(['ana']);
    expect(changes).toEqual([['ana']]);
  });

  it('só apaga depois do prazo de sustentação', () => {
    const { hold, changes } = setup();
    hold.update(['ana']);
    hold.update([]);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS - 1);
    expect(changes).toEqual([['ana']]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([['ana'], []]);
  });

  it('a pausa entre duas palavras não chega a apagar', () => {
    const { hold, changes } = setup();
    hold.update(['ana']);
    hold.update([]);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS / 2);
    hold.update(['ana']);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS * 3);
    // Uma única mudança: acendeu e ficou.
    expect(changes).toEqual([['ana']]);
  });

  it('cada pessoa tem o próprio prazo', () => {
    const { hold, changes } = setup();
    hold.update(['ana', 'bia']);
    hold.update(['bia']);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS);
    expect(changes).toEqual([['ana', 'bia'], ['bia']]);
  });

  it('a mesma lista repetida não gera aviso novo', () => {
    const { hold, changes } = setup();
    hold.update(['ana']);
    hold.update(['ana']);
    hold.update(['ana']);
    expect(changes).toEqual([['ana']]);
  });

  it('limpar apaga tudo na hora e cancela o que estava para apagar', () => {
    const { hold, changes } = setup();
    hold.update(['ana', 'bia']);
    hold.update(['bia']);
    hold.clear();
    expect(changes).toEqual([['ana', 'bia'], []]);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS * 2);
    expect(changes).toEqual([['ana', 'bia'], []]);
  });
});
