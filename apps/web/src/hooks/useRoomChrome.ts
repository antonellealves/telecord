import { useEffect, useRef, useState } from 'react';
import type { TransportMode } from '@telecord/shared';
import { useRoomGamification } from './useRoomGamification';
import { useToasts, type ToastApi } from './useToasts';
import { applyTheme, readTheme, writeTheme, type ThemeId } from '../lib/storage';

interface Options {
  transport: TransportMode;
  roomId: string;
  isMicOn: boolean;
  isCameraOn: boolean;
  isSharing: boolean;
  participantCount: number;
}

export interface RoomChrome extends ToastApi {
  themeId: ThemeId;
  changeTheme: (id: ThemeId) => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  controlsRef: React.RefObject<HTMLDivElement>;
}

/**
 * A "moldura" comum a qualquer sala: avisos, tema, painel de configurações e a
 * gamificação. É o que faz config e progresso funcionarem IGUAL nos dois
 * modos — o que muda entre eles é só o tipo de stream, não estas peças.
 */
export function useRoomChrome(options: Options): RoomChrome {
  const { transport, roomId, isMicOn, isCameraOn, isSharing, participantCount } = options;
  const toasts = useToasts();
  const [themeId, setThemeId] = useState<ThemeId>(readTheme);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);

  // O tema mora no <html>, fora da árvore do React.
  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const changeTheme = (id: ThemeId): void => {
    setThemeId(id);
    writeTheme(id);
  };

  useRoomGamification({
    transport,
    roomId,
    isMicOn,
    isCameraOn,
    isSharing,
    isAway: false,
    isOverlayOpen: false,
    participantCount,
    themeId,
  });

  return {
    ...toasts,
    themeId,
    changeTheme,
    isSettingsOpen,
    setIsSettingsOpen,
    controlsRef,
  };
}
