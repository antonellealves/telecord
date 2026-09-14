import { screen, type BrowserWindow } from 'electron';
import type { ShellConfig, WindowBounds } from './config-store';

const MIN_WIDTH = 940;
const MIN_HEIGHT = 560;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/**
 * Bounds iniciais da janela, a partir do config salvo — mas só se ainda
 * couberem em algum monitor conectado. Trocar de máquina (monitor externo
 * desconectado) não pode deixar a janela presa fora da tela visível.
 */
export function initialBounds(config: ShellConfig): WindowBounds {
  const saved = config.windowBounds;
  if (saved === undefined) {
    return { x: -1, y: -1, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, isMaximized: false };
  }

  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      saved.x < area.x + area.width &&
      saved.x + saved.width > area.x &&
      saved.y < area.y + area.height &&
      saved.y + saved.height > area.y
    );
  });

  if (!visible) {
    return { x: -1, y: -1, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, isMaximized: false };
  }
  return saved;
}

export { MIN_WIDTH, MIN_HEIGHT };

/**
 * Observa mudanças de tamanho/posição e devolve os bounds atuais sob
 * demanda — quem chama decide quando persistir (normalmente no `close`).
 */
export function currentBounds(window: BrowserWindow): WindowBounds {
  const isMaximized = window.isMaximized();
  // `getNormalBounds()` traz o tamanho de quando NÃO está maximizada — é o
  // que precisa ser restaurado depois; salvar os bounds maximizados faria
  // a janela abrir sempre gigante mesmo se o usuário desmaximizar.
  const bounds = window.getNormalBounds();
  return { ...bounds, isMaximized };
}
