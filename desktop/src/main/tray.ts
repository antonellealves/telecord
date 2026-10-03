import { Tray, Menu, nativeImage, app, type BrowserWindow } from 'electron';
import { join } from 'node:path';

export interface TrayCallbacks {
  onToggleMute: () => void;
  isMuted: () => boolean;
  onToggleAutoLaunch: () => Promise<void>;
  isAutoLaunchEnabled: () => boolean;
  onCheckForUpdates: () => void;
}

/**
 * `assets/`, e não `build/`: o `build/` é lido pelo electron-builder para
 * montar o instalador e NÃO entra no pacote — apontando para lá, a bandeja do
 * app instalado ficava com um ícone vazio. `assets/` vai dentro do asar (ver
 * `files` em electron-builder.yml).
 *
 * No Windows vai o .ico, que carrega 16, 20, 24 e 32 px e deixa o sistema
 * escolher conforme a escala do monitor. Nas demais, o .png — o Electron acha
 * o `tray@2x.png` ao lado sozinho.
 */
const ICON_PATH = join(
  __dirname,
  '..',
  '..',
  'assets',
  process.platform === 'win32' ? 'tray.ico' : 'tray.png',
);

/**
 * Ícone na bandeja com o menu descrito no requisito: Abrir, Mudo,
 * Iniciar com o sistema, Verificar atualizações, Sair. Recriado a cada
 * clique porque os itens de checkbox (mudo, auto-início) precisam refletir
 * o estado atual no momento em que o menu abre — um menu estático mostraria
 * o estado de quando o tray foi criado, não o de agora.
 */
export function createTray(window: BrowserWindow, callbacks: TrayCallbacks): Tray {
  // Sem `resize`: os arquivos já vêm no tamanho certo, e redimensionar o .ico
  // jogaria fora as outras resoluções que ele carrega.
  const tray = new Tray(nativeImage.createFromPath(ICON_PATH));
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
