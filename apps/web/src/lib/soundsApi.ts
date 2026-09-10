/**
 * Sons enviados: listar, mandar e apagar.
 *
 * Complementa `lib/sounds.ts`, que é o catálogo montado no BUILD a partir de
 * `apps/web/src/assets/sons`. Os dois convivem, e a distinção importa:
 *
 * - o catálogo do build está em toda máquina que carregou o app, e continua
 *   funcionando sem serviço de contas e sem banco;
 * - o que está aqui é por sala, chega por rede e some se a API cair.
 *
 * `useRoomSounds` junta os dois numa lista só.
 */
import { MAX_SOUND_UPLOAD_BYTES, type RemoteSound } from '@telecord/shared';
import { ApiError, apiGet, apiJson, apiUpload, query } from './apiClient';

export async function fetchRoomSounds(
  roomSlug: string,
  signal?: AbortSignal,
): Promise<RemoteSound[]> {
  const { sounds } = await apiGet<{ sounds: RemoteSound[] }>(
    `/sounds${query({ room: roomSlug })}`,
    signal,
  );
  return sounds;
}

export async function deleteSound(id: string): Promise<void> {
  await apiJson<void>(`/sounds/${encodeURIComponent(id)}`, 'DELETE');
}

export async function uploadSound(input: {
  roomSlug: string;
  file: File;
  emoji?: string | null;
}): Promise<RemoteSound> {
  if (input.file.size > MAX_SOUND_UPLOAD_BYTES) {
    // Barra antes de subir os bytes: o servidor recusaria de qualquer forma, e
    // mandar 30 MB para receber um 413 é gastar a rede de quem está na sala.
    throw new ApiError(
      'file_too_large',
      `"${input.file.name}" tem ${formatSize(input.file.size)}. O limite é ${formatSize(MAX_SOUND_UPLOAD_BYTES)}.`,
      0,
    );
  }

  const durationMs = await readDuration(input.file);
  const bytes = await input.file.arrayBuffer();

  return apiUpload<RemoteSound>(
    `/sounds${query({
      room: input.roomSlug,
      filename: input.file.name,
      emoji: input.emoji ?? null,
      durationMs,
    })}`,
    bytes,
  );
}

/**
 * Duração medida aqui, no navegador, porque o servidor não decodifica mídia.
 *
 * É só enfeite — aparece no card e nada depende dela —, então falha vira
 * `null` em silêncio em vez de impedir o envio. O tempo-limite existe porque
 * um arquivo que o navegador não consegue abrir deixaria a promessa pendurada
 * para sempre, e com ela o botão de enviar.
 */
async function readDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio();
      const done = (value: number | null): void => {
        audio.removeAttribute('src');
        resolve(value);
      };
      const timer = window.setTimeout(() => done(null), 4000);

      audio.addEventListener(
        'loadedmetadata',
        () => {
          window.clearTimeout(timer);
          done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
        },
        { once: true },
      );
      audio.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer);
          done(null);
        },
        { once: true },
      );
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
