import { app, type BrowserWindow } from 'electron';
import log from 'electron-log/main';

const PROTOCOL = 'telecord';

/**
 * Registro do protocolo `telecord://` e entrega da URL ao renderer.
 *
 * ## Por que a plataforma muda o caminho de entrega
 *
 * - **Windows/Linux**: um clique num link `telecord://` abre uma SEGUNDA
 *   instância do app, que imediatamente fecha (por causa do single-instance
 *   lock) — o SO repassa os argv dessa segunda instância para o evento
 *   `second-instance` da primeira.
 * - **macOS**: o sistema abre URLs de esquema custom via `open-url`, sem
 *   nunca criar um segundo processo.
 *
 * ## Se a janela ainda não carregou
 *
 * A URL fica guardada em `pendingDeepLink` e só é entregue quando
 * `did-finish-load` dispara — entregar antes disso enviaria a mensagem para
 * um `webContents` que o front ainda não montou o listener.
 */
export class DeepLinkRouter {
  private pendingUrl: string | null = null;
  private windowReady = false;

  constructor(private getWindow: () => BrowserWindow | null) {}

  setup(): void {
    if (!app.isDefaultProtocolClient(PROTOCOL)) {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    if (process.platform === 'darwin') {
      app.on('open-url', (event, url) => {
        event.preventDefault();
        this.deliver(url);
      });
    }
    // No Windows/Linux, quem repassa o argv da segunda instância é
    // `app.ts` (via `second-instance`), que chama `handleSecondInstanceArgv`.
  }

  /** Chamado pelo handler de `second-instance` com os argv da nova invocação. */
  handleSecondInstanceArgv(argv: string[]): void {
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url !== undefined) this.deliver(url);
  }

  /** Chamado uma vez, quando a janela principal termina o primeiro carregamento. */
  markWindowReady(): void {
    this.windowReady = true;
    if (this.pendingUrl !== null) {
      this.deliver(this.pendingUrl);
      this.pendingUrl = null;
    }
  }

  private deliver(url: string): void {
    if (!url.startsWith(`${PROTOCOL}://`)) return;
    const window = this.getWindow();
    if (!this.windowReady || window === null || window.isDestroyed()) {
      this.pendingUrl = url;
      return;
    }
    log.info(`[deep-link] entregando ${url}`);
    window.webContents.send('deep-link', url);
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}
