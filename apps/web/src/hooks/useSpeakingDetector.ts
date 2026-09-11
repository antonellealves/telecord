import { useEffect, useRef, useState } from 'react';

/**
 * Acima disto conta como fala. Abaixo, é respiração, teclado e ventilador.
 *
 * Medido em RMS de 0..1. O valor é generoso de propósito: o overlay indica
 * QUEM está falando, e um indicador que pisca com qualquer ruído deixa de
 * indicar coisa alguma.
 */
const LIMIAR = 0.045;

/**
 * Quanto tempo o indicador fica aceso depois de a voz parar.
 *
 * Sem isso, a marca pisca no ritmo das sílabas — fala normal tem pausas de
 * 100-200 ms entre palavras, e cada pausa apagaria a marca.
 */
const SUSTENTAR_MS = 420;

/**
 * Quem está falando, medido do próprio áudio.
 *
 * O modo LiveKit ganha isso de graça: o SFU calcula e manda por evento. No
 * modo direto não existe SFU para calcular, então cada navegador mede os
 * streams que recebe — inclusive o próprio, para a pessoa se ver falando.
 *
 * Usa `AnalyserNode` em vez de `getStats()`: o analisador dá o nível do sinal
 * em tempo real e barato, enquanto as estatísticas do WebRTC chegam com
 * atraso e em ritmo de segundo, tarde demais para um indicador de fala.
 */
export function useSpeakingDetector(streams: Map<string, MediaStream>): Set<string> {
  const [falando, setFalando] = useState<Set<string>>(new Set());
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (streams.size === 0) {
      setFalando((atual) => (atual.size === 0 ? atual : new Set()));
      return;
    }

    ctxRef.current ??= new AudioContext();
    const ctx = ctxRef.current;

    const analisadores = new Map<
      string,
      { node: AnalyserNode; buffer: Float32Array<ArrayBuffer> }
    >();
    const ultimaFala = new Map<string, number>();

    for (const [id, stream] of streams) {
      if (stream.getAudioTracks().length === 0) continue;
      const node = ctx.createAnalyser();
      // Janela curta: o indicador precisa reagir, não suavizar.
      node.fftSize = 1024;
      node.smoothingTimeConstant = 0.2;
      ctx.createMediaStreamSource(stream).connect(node);
      // `new ArrayBuffer` explícito: o tipo padrão do Float32Array abre para
      // SharedArrayBuffer, que o `getFloatTimeDomainData` não aceita.
      analisadores.set(id, {
        node,
        buffer: new Float32Array(new ArrayBuffer(node.fftSize * 4)),
      });
    }

    let frame = 0;
    let anterior = '';

    const medir = (): void => {
      const agora = Date.now();
      const ativos: string[] = [];

      for (const [id, { node, buffer }] of analisadores) {
        node.getFloatTimeDomainData(buffer);
        let soma = 0;
        for (const amostra of buffer) soma += amostra * amostra;
        const rms = Math.sqrt(soma / buffer.length);

        if (rms > LIMIAR) ultimaFala.set(id, agora);
        if (agora - (ultimaFala.get(id) ?? 0) < SUSTENTAR_MS) ativos.push(id);
      }

      /*
       * Só troca o estado quando o CONJUNTO muda.
       *
       * Isto roda a 60 quadros por segundo; devolver um Set novo a cada
       * quadro re-renderizaria a lista de participantes 60 vezes por segundo
       * sem nada ter mudado.
       */
      const chave = ativos.sort().join('|');
      if (chave !== anterior) {
        anterior = chave;
        setFalando(new Set(ativos));
      }

      frame = requestAnimationFrame(medir);
    };

    frame = requestAnimationFrame(medir);

    return () => {
      cancelAnimationFrame(frame);
      for (const { node } of analisadores.values()) node.disconnect();
    };
  }, [streams]);

  useEffect(
    () => () => {
      void ctxRef.current?.close();
      ctxRef.current = null;
    },
    [],
  );

  return falando;
}
