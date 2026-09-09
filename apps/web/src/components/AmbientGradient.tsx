import { useEffect, useRef } from 'react';
import styles from './AmbientGradient.module.css';

interface AmbientGradientProps {
  /** `subtle` reduz a força para o fundo não competir com a tela compartilhada. */
  variant?: 'full' | 'subtle';
}

/** Estado de repouso: nem apagado, nem no máximo. */
const REST_GLOW = 0.5;

/**
 * Fundo da aplicação.
 *
 * O degradê É o fundo, não um brilho por cima de um fundo escuro — essa
 * distinção é o que separa "campo de cor" de "lanterna apontada para a tela".
 * Nenhuma camada tem borda dentro da viewport: as âncoras ficam fora dela, de
 * modo que não existe contorno de círculo para o olho encontrar.
 *
 * A posição é fixa; o que responde ao ponteiro é a INTENSIDADE. Quanto mais
 * perto o cursor chega da base, mais o degradê acende.
 *
 * `--glow` e `--sway` são suavizados por rAF e movem só `opacity` e
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

      const horizontal = (event.clientX - width / 2) / (width / 2);
      const vertical = (height - event.clientY) / height;
      const distance = Math.min(1, Math.hypot(horizontal * 0.55, vertical));

      // Faixa estreita, 0,45–1,0: com o degradê preenchendo a tela inteira,
      // variação grande de intensidade volta a parecer foco de luz.
      targetGlow = 1 - distance * 0.55;
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
      <div className={styles.drift}>
        <div className={styles.tint} />
      </div>
      <div className={styles.sheen} />
      <div className={styles.grid} />
      <div className={styles.grain} />
    </div>
  );
}
