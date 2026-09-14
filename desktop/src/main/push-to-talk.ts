import { globalShortcut, type BrowserWindow } from 'electron';
import log from 'electron-log/main';

/**
 * Push-to-talk sem dependência nativa extra — só `globalShortcut` do
 * próprio Electron, que dispara em keydown (inclusive nas repetições
 * automáticas do SO enquanto a tecla continua pressionada) e NUNCA avisa o
 * keyup diretamente.
 *
 * A solução: cada keydown emite `pressed: true` e (re)agenda um timeout
 * curto. Enquanto a pessoa mantém a tecla presa, o SO continua repetindo o
 * keydown antes do timeout estourar, então o timer é sempre adiado. Ao
 * soltar de verdade, os keydowns param e o timeout finalmente dispara
 * `pressed: false`.
 *
 * Não é um keyup real — é uma aproximação deliberada para não trazer uma
 * dependência nativa (`node-gyp`, build por plataforma) só para isto. Na
 * prática, a taxa de repetição do teclado do SO (tipicamente 20-30ms) é
 * bem menor que o timeout escolhido, então o efeito percebido é o mesmo de
 * um press-and-hold.
 */
const RELEASE_TIMEOUT_MS = 250;

export class PushToTalk {
  private timer: NodeJS.Timeout | null = null;
  private pressed = false;
  private currentShortcut = '';

  constructor(private readonly window: BrowserWindow) {}

  register(shortcut: string): boolean {
    this.unregister();

    const ok = globalShortcut.register(shortcut, () => this.handleKeydown());
    if (!ok) {
      log.warn(`[push-to-talk] atalho "${shortcut}" já está em uso por outro aplicativo`);
      return false;
    }
    this.currentShortcut = shortcut;
    return true;
  }

  unregister(): void {
    if (this.currentShortcut !== '') {
      globalShortcut.unregister(this.currentShortcut);
      this.currentShortcut = '';
    }
    this.clearTimer();
    this.pressed = false;
  }

  get shortcut(): string {
    return this.currentShortcut;
  }

  private handleKeydown(): void {
    if (!this.pressed) {
      this.pressed = true;
      this.emit(true);
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.pressed = false;
      this.emit(false);
    }, RELEASE_TIMEOUT_MS);
  }

  private emit(isPressed: boolean): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send('push-to-talk', { pressed: isPressed });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
