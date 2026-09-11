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
    let lift = 0;
    let tone = 0.5;
    let targetGlow = REST_GLOW;
    let targetSway = 0;
    let targetLift = 0;
    let targetTone = 0.5;
    let frame = 0;
    let running = false;

    const apply = (): void => {
      root.style.setProperty('--glow', glow.toFixed(3));
      root.style.setProperty('--sway', sway.toFixed(3));
      root.style.setProperty('--lift', lift.toFixed(3));
      root.style.setProperty('--tone', tone.toFixed(3));
    };

    apply();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const tick = (): void => {
      const deltaGlow = targetGlow - glow;
      const deltaSway = targetSway - sway;
      const deltaLift = targetLift - lift;
      const deltaTone = targetTone - tone;
      if (
        Math.abs(deltaGlow) > 0.0015 ||
        Math.abs(deltaSway) > 0.0015 ||
        Math.abs(deltaLift) > 0.0015 ||
        Math.abs(deltaTone) > 0.0015
      ) {
        glow += deltaGlow * 0.085;
        sway += deltaSway * 0.12;
        lift += deltaLift * 0.12;
        tone += deltaTone * 0.07;
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

      targetGlow = 1 - distance * 0.7;
      targetSway = horizontal;
      // O eixo vertical passa a mover o campo também, e não só trocar a cor.
      targetLift = (event.clientY - height / 2) / (height / 2);
      // O que mais se percebe não é o brilho, é a COR: subir o cursor puxa o
      // campo para o roxo, descer puxa para o azul. Intensidade sozinha, num
      // degradê que cobre a tela inteira, é mudança fácil de não notar.
      targetTone = Math.max(0, Math.min(1, event.clientY / height));
      start();
    };

    const handlePointerLeave = (): void => {
      targetGlow = REST_GLOW;
      targetSway = 0;
      targetLift = 0;
      targetTone = 0.5;
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
        <div className={`${styles.tint} ${styles.tintCool}`} />
        <div className={`${styles.tint} ${styles.tintWarm}`} />
      </div>
      <div className={styles.sheen} />
      <div className={styles.grid} />
      <div className={styles.grain} />
    </div>
  );
}
