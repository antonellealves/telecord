import { useEffect, useRef } from 'react';
import styles from './AmbientGradient.module.css';

interface AmbientGradientProps {
  /** `subtle` reduz a força para o fundo não competir com a tela compartilhada. */
  variant?: 'full' | 'subtle';
}

/** Estado de repouso: brilho baixo, fundo sem a vinheta escura. */
const REST_GLOW = 0.3;
/** Quanto tempo depois do último movimento o brilho começa a apagar. */
const IDLE_MS = 1_200;

/**
 * Fundo da aplicação.
 *
 * O degradê É o fundo, não um brilho por cima de um fundo escuro — essa
 * distinção é o que separa "campo de cor" de "lanterna apontada para a tela".
 * Nenhuma camada tem borda dentro da viewport: as âncoras ficam fora dela, de
 * modo que não existe contorno de círculo para o olho encontrar.
 *
 * O campo fica parado. O que responde ao ponteiro é o MOVIMENTO: enquanto o
 * cursor se mexe, o brilho pequeno do centro inferior acende (mais quanto
 * mais perto da base) e os tons escuros fecham em volta dele; parado por
 * `IDLE_MS`, tudo volta ao repouso. O brilho ainda acompanha o cursor na
 * horizontal, e o campo troca de cor com a altura dele.
 *
 * `--glow`, `--sway` e `--tone` são suavizados por rAF e movem só `opacity` e
 * `transform`, que ficam no compositor. O loop para sozinho ao alcançar o alvo.
 */
export function AmbientGradient({ variant = 'full' }: AmbientGradientProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }

    let glow = REST_GLOW;
    let sway = 0;
    let tone = 0.5;
    let targetGlow = REST_GLOW;
    let targetSway = 0;
    let targetTone = 0.5;
    let frame = 0;
    let running = false;
    let idleTimer = 0;

    const apply = (): void => {
      root.style.setProperty('--glow', glow.toFixed(3));
      root.style.setProperty('--sway', sway.toFixed(3));
      root.style.setProperty('--tone', tone.toFixed(3));
    };

    apply();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const tick = (): void => {
      const deltaGlow = targetGlow - glow;
      const deltaSway = targetSway - sway;
      const deltaTone = targetTone - tone;
      if (Math.abs(deltaGlow) > 0.0015 || Math.abs(deltaSway) > 0.0015 || Math.abs(deltaTone) > 0.0015) {
        // Acende rápido e apaga devagar: o destaque responde ao gesto na
        // hora, e a volta ao repouso não parece um corte.
        glow += deltaGlow * (deltaGlow > 0 ? 0.16 : 0.045);
        sway += deltaSway * 0.14;
        tone += deltaTone * 0.09;
        apply();
        frame = requestAnimationFrame(tick);
      } else {
        running = false;
      }
    };

    const start = (): void => {
      if (!running) {
        running = true;
        frame = requestAnimationFrame(tick);
      }
    };

    const rest = (): void => {
      targetGlow = REST_GLOW;
      start();
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      const horizontal = (event.clientX - width / 2) / (width / 2);
      const vertical = (height - event.clientY) / height;
      const distance = Math.min(1, Math.hypot(horizontal * 0.55, vertical));

      // Mexer sempre acende bem; perto do centro inferior, acende tudo.
      targetGlow = 1 - distance * 0.25;
      targetSway = Math.max(-1, Math.min(1, horizontal));
      // Subir o cursor puxa o campo para o roxo, descer puxa para o azul.
      targetTone = Math.max(0, Math.min(1, event.clientY / height));
      start();

      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(rest, IDLE_MS);
    };

    const handlePointerLeave = (): void => {
      window.clearTimeout(idleTimer);
      targetSway = 0;
      targetTone = 0.5;
      rest();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(idleTimer);
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${variant === 'subtle' ? styles.subtle : ''}`}
      aria-hidden="true"
    >
      <div className={styles.bed} />
      <div className={styles.drift}>
        <div className={`${styles.tint} ${styles.tintCool}`} />
        <div className={`${styles.tint} ${styles.tintWarm}`} />
      </div>
      <div className={styles.shade} />
      <div className={styles.sheen} />
      <div className={styles.grid} />
      <div className={styles.grain} />
    </div>
  );
}
