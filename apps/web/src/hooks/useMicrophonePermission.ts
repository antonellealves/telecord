import { useCallback, useEffect, useState } from 'react';
import { describeMicrophoneError } from '../lib/errors';
import { readMicrophoneGranted, writeMicrophoneGranted } from '../lib/storage';

export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface MicrophonePermissionState {
  status: MicrophonePermission;
  isRequesting: boolean;
  error: string | null;
  request: () => void;
}

/**
 * Permissão de microfone: consulta e pedido único por dispositivo.
 *
 * O navegador é quem guarda a permissão — nenhum site pode "salvar" isso por
 * conta própria. O que dá para fazer é PERGUNTAR, pela Permissions API, e não
 * incomodar de novo quem já autorizou.
 *
 * O localStorage entra só como dica para o primeiro render, antes de a
 * consulta assíncrona responder, e para os navegadores que não implementam
 * `permissions.query` com o nome 'microphone' (Firefox, por um tempo). A
 * resposta do navegador sempre vence a dica.
 */
export function useMicrophonePermission(): MicrophonePermissionState {
  const [status, setStatus] = useState<MicrophonePermission>(() =>
    readMicrophoneGranted() ? 'granted' : 'unknown',
  );
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;

    const sync = (state: PermissionState): void => {
      if (cancelled) return;
      setStatus(state);
      writeMicrophoneGranted(state === 'granted');
    };

    void navigator.permissions
      // O nome 'microphone' não está em todos os navegadores; o cast existe
      // porque o tipo padrão de PermissionName é mais estreito do que a
      // realidade das implementações.
      ?.query({ name: 'microphone' as PermissionName })
      .then((result) => {
        sync(result.state);
        // Revogar a permissão nas configurações do navegador dispara isto:
        // a interface volta a oferecer o pedido sem precisar recarregar.
        const onChange = (): void => sync(result.state);
        result.addEventListener('change', onChange);
        detach = () => result.removeEventListener('change', onChange);
      })
      .catch(() => {
        // Sem Permissions API: fica com a dica do localStorage.
      });

    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);

  const request = useCallback(() => {
    if (isRequesting) return;
    setIsRequesting(true);
    setError(null);
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Só queríamos a permissão: soltar as tracks na hora evita ficar com
        // o microfone aberto e a luzinha acesa sem motivo.
        stream.getTracks().forEach((track) => track.stop());
        setStatus('granted');
        writeMicrophoneGranted(true);
      })
      .catch((cause: unknown) => {
        setStatus('denied');
        writeMicrophoneGranted(false);
        setError(describeMicrophoneError(cause));
      })
      .finally(() => setIsRequesting(false));
  }, [isRequesting]);

  return { status, isRequesting, error, request };
}
