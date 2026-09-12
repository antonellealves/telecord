import { useEffect, useRef } from 'react';
import { trackEvent } from '../lib/gamification';

interface RoomGamificationInput {
  roomId: string;
  transport: 'livekit' | 'p2p';
  isMicOn: boolean;
  isCameraOn: boolean;
  isSharing: boolean;
  isAway: boolean;
  isOverlayOpen: boolean;
  participantCount: number;
  themeId: string;
}

/**
 * Traduz o ESTADO da sala em eventos de gamificação.
 *
 * Fica num hook próprio, e não espalhado por RoomShell, porque quase tudo aqui
 * é a mesma receita: guardar o valor anterior numa ref e disparar quando ele
 * cruza de desligado para ligado. Ações que não são estado — mandar mensagem,
 * tocar som — não passam por aqui; quem as executa chama o `trackEvent` no ato,
 * que é onde a intenção de fato acontece.
 *
 * Serve aos DOIS modos (LiveKit e P2P) sem duas cópias: só muda o `transport`.
 */
export function useRoomGamification(input: RoomGamificationInput): void {
  const {
    roomId,
    transport,
    isMicOn,
    isCameraOn,
    isSharing,
    isAway,
    isOverlayOpen,
    participantCount,
    themeId,
  } = input;

  // Entrada na sala: uma vez por montagem. E, se for de madrugada, a coruja.
  const entrouRef = useRef(false);
  useEffect(() => {
    if (entrouRef.current) return;
    entrouRef.current = true;
    trackEvent({ type: 'room.join', roomId, transport });
    const hora = new Date().getHours();
    if (hora >= 0 && hora < 5) {
      trackEvent({ type: 'night.owl' });
    }
  }, [roomId, transport]);

  // Tempo de sessão: um tique por minuto. O maior tempo contínuo alimenta o
  // "GG" — por isso o minuto local é contado aqui, e não derivado do relógio.
  useEffect(() => {
    let minutos = 0;
    const id = window.setInterval(() => {
      minutos += 1;
      trackEvent({ type: 'session.minute' });
      trackEvent({ type: 'session.longest', minutes: minutos });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  useTransition(isMicOn, () => trackEvent({ type: 'mic.on' }));
  useTransition(isCameraOn, () => trackEvent({ type: 'camera.on' }));
  useTransition(isSharing, () => trackEvent({ type: 'screen.share' }));
  useTransition(isAway, () => trackEvent({ type: 'away.on' }));
  useTransition(isOverlayOpen, () => trackEvent({ type: 'overlay.open' }));

  // Ameaça tripla: os três ligados ao mesmo tempo. Como é uma combinação de
  // estados (não uma transição de um só), a condição é reavaliada a cada
  // mudança — o store ignora a repetição depois de já estar concluída.
  useEffect(() => {
    if (isMicOn && isCameraOn && isSharing) {
      trackEvent({ type: 'combo.av' });
    }
  }, [isMicOn, isCameraOn, isSharing]);

  // Pico de gente na sala: o store guarda o máximo, então basta reportar o
  // número atual a cada mudança.
  useEffect(() => {
    if (participantCount > 0) {
      trackEvent({ type: 'peak.people', count: participantCount });
    }
  }, [participantCount]);

  // Tema em uso: dispara na montagem e em cada troca. O conjunto no store
  // cuida de não contar o mesmo tema duas vezes.
  useEffect(() => {
    trackEvent({ type: 'theme.use', theme: themeId });
  }, [themeId]);
}

/** Dispara `onRise` quando `value` passa de `false` para `true`. */
function useTransition(value: boolean, onRise: () => void): void {
  const anterior = useRef(value);
  const callback = useRef(onRise);
  callback.current = onRise;
  useEffect(() => {
    if (value && !anterior.current) {
      callback.current();
    }
    anterior.current = value;
  }, [value]);
}
