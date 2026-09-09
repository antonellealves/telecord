import { useEffect, useRef } from 'react';
import styles from './AmbientGradient.module.css';

interface AmbientGradientProps {
  /** `subtle` reduz a força para o fundo não competir com a tela compartilhada. */
  variant?: 'full' | 'subtle';
}

/** Estado de repouso: nem apagado, nem no máximo. */
const REST_GLOW = 0.5;

/**
 * Luz de fundo ancorada no centro inferior da tela.
 *
 * A posição é fixa; o que responde ao ponteiro é a INTENSIDADE. Quanto mais
 * perto o cursor chega da base, mais o degradê acende — e a mancha oscila
 * alguns viewport-widths na horizontal, o bastante para o fundo parecer vivo
 * sem sair do lugar.
 *
 * O ponteiro alimenta duas variáveis CSS (`--glow` e `--sway`) suavizadas por
 * rAF. Elas movem só `opacity` e `transform`, que ficam no compositor; o loop
 * para sozinho quando o valor alcança o alvo.
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
    let targetGlow = REST_GLOW;
    let targetSway = 0;
    let frame = 0;
    let running = false;

    const apply = (): void => {
      root.style.setProperty('--glow', glow.toFixed(3));
      root.style.setProperty('--sway', sway.toFixed(3));
    };

    apply();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const tick = (): void => {
      const deltaGlow = targetGlow - glow;
      const deltaSway = targetSway - sway;
      if (Math.abs(deltaGlow) > 0.0015 || Math.abs(deltaSway) > 0.0015) {
        // A intensidade sobe mais depressa do que a mancha se desloca: a luz
        // responde ao gesto, o deslocamento fica para trás.
        glow += deltaGlow * 0.085;
        sway += deltaSway * 0.05;
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

    const handlePointerMove = (event: PointerEvent): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      // Distância normalizada até a âncora (centro inferior). O eixo horizontal
      // pesa menos: a luz nasce da base, então subir o cursor apaga mais do que
      // afastá-lo para o lado.
      const horizontal = (event.clientX - width / 2) / (width / 2);
      const vertical = (height - event.clientY) / height;
      const distance = Math.min(1, Math.hypot(horizontal * 0.55, vertical));

      // Faixa 0,3–1,0: modulação perceptível, mas sem acender e apagar. O
      // contraste forte brigava com a leitura uniforme do degradê.
      targetGlow = 1 - distance * 0.7;
      targetSway = horizontal;
      start();
    };

    const handlePointerLeave = (): void => {
      targetGlow = REST_GLOW;
      targetSway = 0;
      start();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      cancelAnimationFrame(frame);
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
      <div className={styles.grid} />
      <div className={styles.drift}>
        <div className={styles.bloom} />
      </div>
      <div className={styles.halo} />
      <div className={styles.core} />
      <div className={styles.grain} />
      <div className={styles.vignette} />
    </div>
  );
}
