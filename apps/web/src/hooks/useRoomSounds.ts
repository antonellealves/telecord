import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteSound } from '@telecord/shared';
import { ApiError } from '../lib/apiClient';
import { isAuthConfigured } from '../lib/auth';
import { BUILTIN_EMOJI, SOUNDS, pickEmoji, type SoundEntry } from '../lib/sounds';
import { deleteSound, fetchRoomSounds, uploadSound } from '../lib/soundsApi';

/** Um card do painel, venha ele do build ou do banco. */
export interface PlayableSound extends SoundEntry {
  /** Nulo para os sons versionados no repositório. */
  remote: RemoteSound | null;
  /** Só para som enviado, e decidido pelo SERVIDOR. */
  canDelete: boolean;
  uploadedBy: string | null;
}

export interface RoomSoundsState {
  sounds: PlayableSound[];
  /** Resolve qualquer id que chegue pelo canal de dados. */
  find: (soundId: string) => PlayableSound | undefined;
  isLoading: boolean;
  /** Falha ao carregar a lista da sala. Não impede tocar os sons do build. */
  error: string | null;
  /** Enviar exige conta; a tela usa isto para explicar em vez de só falhar. */
  canUpload: boolean;
  isUploading: boolean;
  upload: (files: File[]) => Promise<void>;
  remove: (soundId: string) => Promise<void>;
}

interface Options {
  roomId: string;
  isSignedIn: boolean;
  notify: (kind: 'error' | 'info', message: string) => void;
}

/**
 * O painel de sons da sala: o catálogo do build mais os enviados.
 *
 * ## Por que os dois convivem
 *
 * Os sons de `apps/web/src/assets/sons` viajam dentro do bundle: estão em toda
 * máquina que abriu o app, funcionam sem conta, sem banco e sem rede depois do
 * primeiro carregamento. Perdê-los para trocar por upload seria trocar algo
 * que nunca falha por algo que depende de três serviços.
 *
 * Os enviados resolvem o que o outro não resolve: acrescentar um clipe sem
 * abrir o repositório, e por sala em vez de para o mundo.
 *
 * ## Emoji sem repetir, dos dois lados
 *
 * O som enviado que trouxer emoji escolhido usa o dele. O que não trouxer
 * sorteia a partir do id — o mesmo algoritmo do catálogo do build, e com a
 * lista de ocupados já contendo os emojis dele. Sem isso, o primeiro clipe
 * enviado sairia com um símbolo que já está no painel.
 *
 * ## Falha não derruba o painel
 *
 * API fora do ar deixa `sounds` com os do build e escreve o motivo em `error`.
 * O soundboard continua funcionando, que é a regra do produto: contas são
 * opcionais e a queda delas não pode tirar recurso de quem nunca teve conta.
 */
export function useRoomSounds({ roomId, isSignedIn, notify }: Options): RoomSoundsState {
  const [remote, setRemote] = useState<RemoteSound[]>([]);
  const [isLoading, setIsLoading] = useState(isAuthConfigured);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!isAuthConfigured) {
        setIsLoading(false);
        return;
      }
      try {
        const list = await fetchRoomSounds(roomId, signal);
        if (signal?.aborted === true) return;
        setRemote(list);
        setError(null);
      } catch (failure) {
        if (signal?.aborted === true) return;
        setError(
          failure instanceof ApiError
            ? failure.message
            : 'Não foi possível carregar os sons desta sala.',
        );
      } finally {
        if (signal?.aborted !== true) setIsLoading(false);
      }
    },
    [roomId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const sounds = useMemo<PlayableSound[]>(() => {
    const builtin: PlayableSound[] = SOUNDS.map((sound) => ({
      ...sound,
      remote: null,
      canDelete: false,
      uploadedBy: null,
    }));

    const taken = new Set(BUILTIN_EMOJI);
    const uploaded: PlayableSound[] = [];
    for (const sound of remote) {
      /*
       * Id repetido entre o build e o banco é praticamente impossível — um é
       * slug de nome de arquivo, o outro é cuid —, mas se acontecesse, dois
       * cards responderiam ao mesmo aviso do canal de dados e a sala ouviria o
       * clipe errado. Ganha o do build, que está em todo mundo.
       */
      if (SOUNDS.some((entry) => entry.id === sound.id)) continue;

      const emoji = sound.emoji ?? pickEmoji(sound.id, taken);
      taken.add(emoji);
      uploaded.push({
        id: sound.id,
        label: sound.label,
        file: sound.url,
        emoji,
        remote: sound,
        canDelete: sound.canDelete,
        uploadedBy: sound.uploadedBy?.displayName ?? null,
      });
    }

    // Os enviados primeiro: são os que a turma acabou de pôr, e é neles que
    // alguém vai clicar. O catálogo do build está sempre lá.
    return [
      ...uploaded.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
      ...builtin,
    ];
  }, [remote]);

  const byId = useMemo(() => new Map(sounds.map((sound) => [sound.id, sound])), [sounds]);
  const find = useCallback((soundId: string) => byId.get(soundId), [byId]);

  const upload = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      setIsUploading(true);
      let enviados = 0;
      try {
        // Um de cada vez, de propósito: em paralelo, um lote de dez arquivos
        // estoura o limitador de envio e a metade que falhar não diz qual foi.
        for (const file of files) {
          try {
            const sound = await uploadSound({ roomSlug: roomId, file });
            setRemote((current) =>
              current.some((entry) => entry.id === sound.id) ? current : [...current, sound],
            );
            enviados += 1;
          } catch (failure) {
            notifyRef.current(
              'error',
              failure instanceof ApiError ? failure.message : `Não deu para enviar "${file.name}".`,
            );
          }
        }
        if (enviados > 0) {
          notifyRef.current(
            'info',
            enviados === 1 ? 'Som acrescentado à sala.' : `${enviados} sons acrescentados à sala.`,
          );
        }
      } finally {
        setIsUploading(false);
      }
    },
    [roomId],
  );

  const remove = useCallback(async (soundId: string): Promise<void> => {
    try {
      await deleteSound(soundId);
      setRemote((current) => current.filter((entry) => entry.id !== soundId));
    } catch (failure) {
      notifyRef.current(
        'error',
        failure instanceof ApiError ? failure.message : 'Não deu para apagar o som.',
      );
    }
  }, []);

  return {
    sounds,
    find,
    isLoading,
    error,
    canUpload: isAuthConfigured && isSignedIn,
    isUploading,
    upload,
    remove,
  };
}
