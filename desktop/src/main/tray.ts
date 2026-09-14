import { Tray, Menu, nativeImage, app, type BrowserWindow } from 'electron';
import { join } from 'node:path';

export interface TrayCallbacks {
  onToggleMute: () => void;
  isMuted: () => boolean;
  onToggleAutoLaunch: () => Promise<void>;
  isAutoLaunchEnabled: () => boolean;
  onCheckForUpdates: () => void;
}

const ICON_PATH = join(__dirname, '..', '..', 'build', 'icon.png');

/**
 * Ícone na bandeja com o menu descrito no requisito: Abrir, Mudo,
 * Iniciar com o sistema, Verificar atualizações, Sair. Recriado a cada
 * clique porque os itens de checkbox (mudo, auto-início) precisam refletir
 * o estado atual no momento em que o menu abre — um menu estático mostraria
 * o estado de quando o tray foi criado, não o de agora.
 */
export function createTray(window: BrowserWindow, callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromPath(ICON_PATH);
  const tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('telecord');

  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Abrir',
        click: () => {
          window.show();
          window.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Mudo',
        type: 'checkbox',
        checked: callbacks.isMuted(),
        click: () => callbacks.onToggleMute(),
      },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: callbacks.isAutoLaunchEnabled(),
        click: () => void callbacks.onToggleAutoLaunch().then(rebuildMenu),
      },
      { type: 'separator' },
      {
        label: 'Verificar atualizações',
        click: () => callbacks.onCheckForUpdates(),
      },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on('click', () => {
    window.show();
    window.focus();
  });

  return tray;
}
