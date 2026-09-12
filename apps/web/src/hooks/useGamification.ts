import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe, type GamSnapshot } from '../lib/gamification';

/**
 * Liga a interface ao store de gamificação.
 *
 * `useSyncExternalStore` é o caminho certo para um estado que vive FORA do
 * React: o store é único no módulo, muitos componentes o leem, e este hook
 * garante que cada um rerenderize quando o snapshot troca — sem contexto, sem
 * provider, sem prop drilling.
 */
export function useGamification(): GamSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
