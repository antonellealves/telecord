import { contextBridge, ipcRenderer } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bridge exposto ao FRONT WEB (carregado de PROD_URL) e à `offline.html`
 * local. Canais nomeados e explícitos — nenhum `ipcRenderer` cru sai daqui,
 * e cada método valida o que faz sentido validar antes de repassar ao main.
 */

type PushToTalkHandler = (state: { pressed: boolean }) => void;
type DeepLinkHandler = (url: string) => void;

const pushToTalkListeners = new Set<PushToTalkHandler>();
const deepLinkListeners = new Set<DeepLinkHandler>();

ipcRenderer.on('push-to-talk', (_event, state: { pressed: boolean }) => {
  for (const handler of pushToTalkListeners) handler(state);
});

ipcRenderer.on('deep-link', (_event, url: string) => {
  for (const handler of deepLinkListeners) handler(url);
});

/**
 * Versão do próprio pacote do shell — lida direto do `package.json`
 * empacotado (fica dentro do asar, mas o preload roda em contexto Node e
 * tem acesso ao filesystem virtual do asar normalmente).
 */
function readShellVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * macOS não implementa `audio: 'loopback'` no `getDisplayMedia` — captura
 * de áudio do sistema lá depende de driver virtual externo, que o shell não
 * instala. O front usa isto para não oferecer uma opção que sempre falharia
 * silenciosamente nessa plataforma.
 */
const CAN_CAPTURE_SYSTEM_AUDIO = process.platform !== 'darwin';

const telecordBridge = {
  shellVersion: readShellVersion(),
  platform: process.platform as 'win32' | 'darwin' | 'linux',
  canCaptureSystemAudio: CAN_CAPTURE_SYSTEM_AUDIO,

  setBadge(count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return;
    ipcRenderer.send('shell:set-badge', Math.floor(count));
  },

  flashFrame(on: boolean): void {
    ipcRenderer.send('shell:flash-frame', Boolean(on));
  },

  onPushToTalk(callback: PushToTalkHandler): void {
    pushToTalkListeners.add(callback);
  },

  offPushToTalk(callback: PushToTalkHandler): void {
    pushToTalkListeners.delete(callback);
  },

  openExternal(url: string): void {
    // Só http/https — o main também valida, mas recusar aqui evita até a
    // viagem de IPC para um esquema óbvio errado.
    if (!/^https?:\/\//i.test(url)) return;
    ipcRenderer.send('shell:open-external', url);
  },

  async getAutoLaunch(): Promise<boolean> {
    return ipcRenderer.invoke('shell:get-auto-launch') as Promise<boolean>;
  },

  async setAutoLaunch(enabled: boolean): Promise<void> {
    await ipcRenderer.invoke('shell:set-auto-launch', Boolean(enabled));
  },

  onDeepLink(callback: DeepLinkHandler): void {
    deepLinkListeners.add(callback);
  },
};

contextBridge.exposeInMainWorld('telecord', telecordBridge);

// Bridge separado e mínimo para a offline.html — ver src/renderer/offline.ts.
contextBridge.exposeInMainWorld('telecordOffline', {
  retryNow(): void {
    ipcRenderer.send('shell:retry-now');
  },
});
