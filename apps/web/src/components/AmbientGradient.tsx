import { useEffect, useRef } from 'react';
import styles from './AmbientGradient.module.css';

interface Layer {
  el: HTMLDivElement | null;
  /** 0..1 — quanto menor, mais o halo arrasta atrás do cursor. */
  ease: number;
  x: number;
  y: number;
}

/**
 * Composição de fundo: halos circulares que seguem o ponteiro com inércia.
 *
 * Três camadas com constantes de suavização diferentes — a maior e mais lenta
 * atrás, o núcleo pequeno e rápido na frente. É essa diferença que cria
 * paralaxe e faz o brilho parecer volume, e não um disco colado no cursor.
 *
 * Só `transform` é animado, então tudo fica no compositor: nenhum reflow,
 * nenhum repaint por frame. O loop também para sozinho quando o movimento
 * termina, em vez de girar rAF à toa.
 */
export function AmbientGradient(): JSX.Element {
  const haloRef = useRef<HTMLDivElement | null>(null);
  const auraRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const restX = (): number => window.innerWidth / 2;
    const restY = (): number => window.innerHeight * 0.42;

    const layers: Layer[] = [
      { el: auraRef.current, ease: 0.026, x: restX(), y: restY() },
      { el: haloRef.current, ease: 0.062, x: restX(), y: restY() },
      { el: coreRef.current, ease: 0.125, x: restX(), y: restY() },
    ];

    const place = (layer: Layer): void => {
      if (layer.el !== null) {
        layer.el.style.transform = `translate3d(${layer.x.toFixed(1)}px, ${layer.y.toFixed(1)}px, 0)`;
      }
    };

    for (const layer of layers) {
      place(layer);
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    let targetX = restX();
    let targetY = restY();
    let pointerSeen = false;
    let frame = 0;
    let running = false;

    const tick = (): void => {
      let moving = false;
      for (const layer of layers) {
        const dx = targetX - layer.x;
        const dy = targetY - layer.y;
        if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
          layer.x += dx * layer.ease;
          layer.y += dy * layer.ease;
          place(layer);
          moving = true;
        }
      }
      if (moving) {
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
      pointerSeen = true;
      targetX = event.clientX;
      targetY = event.clientY;
      start();
    };

    // Sem ponteiro (toque, teclado) o brilho volta para o repouso, no centro.
    const handlePointerLeave = (): void => {
      targetX = restX();
      targetY = restY();
      start();
    };

    const handleResize = (): void => {
      if (!pointerSeen) {
        targetX = restX();
        targetY = restY();
        start();
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', handlePointerLeave);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div className={styles.root} aria-hidden="true">
      <div className={styles.bed} />
      <div className={styles.grid} />
      <div className={styles.drift}>
        <div ref={auraRef} className={`${styles.orb} ${styles.aura}`} />
      </div>
      <div ref={haloRef} className={`${styles.orb} ${styles.halo}`} />
      <div ref={coreRef} className={`${styles.orb} ${styles.core}`} />
      <div className={styles.grain} />
      <div className={styles.vignette} />
    </div>
  );
}
