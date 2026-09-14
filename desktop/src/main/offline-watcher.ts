import { type BrowserWindow } from 'electron';
import { join } from 'node:path';
import log from 'electron-log/main';

const OFFLINE_HTML = join(__dirname, '..', 'renderer', 'offline.html');
const RETRY_STEPS_MS = [3000, 6000, 12000, 30000] as const;

/**
 * Observa falhas de carregamento e reage com a tela offline + retry com
 * backoff. Criado por janela: cada `BrowserWindow` tem seu próprio estado
 * de tentativa, para duas janelas nunca competirem pelo mesmo timer.
 */
export class OfflineWatcher {
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly prodUrl: string,
  ) {
    this.window.webContents.on('did-fail-load', this.handleFailLoad);
    this.window.webContents.on('did-finish-load', this.handleFinishLoad);
    this.window.on('closed', () => this.dispose());
  }

  private handleFailLoad = (
    _event: Electron.Event,
    errorCode: number,
    _errorDescription: string,
    validatedURL: string,
  ): void => {
    // -3 é ABORTED: acontece quando a PRÓPRIA navegação é cancelada (ex.:
    // um novo `loadURL` chamado antes do anterior terminar) — não é uma
    // falha de rede de verdade, e tratar como tal criaria um loop de
    // "falhou -> tenta de novo -> cancela a si mesmo -> falhou nulo".
    if (errorCode === -3) return;
    log.warn(`[offline] falha ao carregar ${validatedURL} (código ${errorCode})`);
    this.showOfflineAndRetry();
  };

  private handleFinishLoad = (): void => {
    // Carregou com sucesso (a própria PROD_URL ou a offline.html local) —
    // se era um retry em andamento contra a PROD_URL, ele já terminou.
  };

  private showOfflineAndRetry(): void {
    if (this.disposed) return;
    void this.window.loadFile(OFFLINE_HTML);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.window.isVisible()) return;
    const delay = RETRY_STEPS_MS[Math.min(this.attempt, RETRY_STEPS_MS.length - 1)];
    this.attempt += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      log.info(`[offline] tentando reconectar (tentativa ${this.attempt})`);
      void this.window.loadURL(this.prodUrl).catch(() => {
        this.scheduleRetry();
      });
    }, delay);
  }

  /** Chamado pelo botão "Tentar novamente" da offline.html, via IPC. */
  retryNow(): void {
    this.attempt = 0;
    this.clearTimer();
    void this.window.loadURL(this.prodUrl).catch(() => this.showOfflineAndRetry());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}
