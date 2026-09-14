/**
 * Feature detection do shell Electron (ver `desktop/`).
 *
 * `window.telecord` só existe quando o app roda DENTRO do shell empacotado
 * (Windows/macOS/Linux) — no navegador comum, `isElectronShell` é sempre
 * `false` e o app se comporta exatamente como hoje. Nada aqui importa
 * `electron` nem qualquer tipo do desktop/: é só a forma pública do
 * bridge, para o front não depender do pacote isolado do shell.
 */
export interface TelecordShellBridge {
  shellVersion: string;
  platform: 'win32' | 'darwin' | 'linux';
  canCaptureSystemAudio: boolean;
  setBadge: (count: number) => void;
  flashFrame: (on: boolean) => void;
  onPushToTalk: (callback: (state: { pressed: boolean }) => void) => void;
  offPushToTalk: (callback: (state: { pressed: boolean }) => void) => void;
  openExternal: (url: string) => void;
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<void>;
  onDeepLink: (callback: (url: string) => void) => void;
}

declare global {
  interface Window {
    telecord?: TelecordShellBridge;
  }
}

export function getShellBridge(): TelecordShellBridge | undefined {
  return typeof window !== 'undefined' ? window.telecord : undefined;
}

export const isElectronShell: boolean = typeof window !== 'undefined' && window.telecord !== undefined;

/**
 * Fora do shell (navegador comum), a captura de áudio do sistema já é
 * decidida pelo próprio prompt nativo do `getDisplayMedia` — sempre `true`
 * aqui. Dentro do shell, `window.telecord.canCaptureSystemAudio` é `false`
 * no macOS (sem driver de loopback disponível) — ver
 * `desktop/src/preload/index.ts`.
 */
export function canCaptureSystemAudio(): boolean {
  return getShellBridge()?.canCaptureSystemAudio ?? true;
}
