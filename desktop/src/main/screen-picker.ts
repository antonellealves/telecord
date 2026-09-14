import { BrowserWindow, desktopCapturer, ipcMain, type DesktopCapturerSource } from 'electron';
import { join } from 'node:path';

const PICKER_HTML = join(__dirname, '..', 'renderer', 'picker.html');
const PICKER_PRELOAD = join(__dirname, '..', 'preload', 'picker-preload.js');

interface PickerSource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}

/**
 * Abre a janela modal própria de escolha de fonte, para quando o seletor
 * nativo do sistema (`useSystemPicker`) não está disponível na plataforma.
 *
 * Devolve `null` quando a pessoa cancela — quem chama decide o que fazer
 * (normalmente negar o `getDisplayMedia` com um erro claro).
 */
export async function pickScreenSource(parent: BrowserWindow): Promise<DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: { width: 320, height: 180 },
  });

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 720,
      height: 520,
      parent,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolher tela ou janela',
      webPreferences: {
        preload: PICKER_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = (chosen: DesktopCapturerSource | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('picker:list');
      ipcMain.removeListener('picker:choose', onChoose);
      ipcMain.removeListener('picker:cancel', onCancel);
      if (!picker.isDestroyed()) picker.close();
      resolve(chosen);
    };

    // Canal próprio deste picker: como pode haver, em teoria, mais de um
    // pedido em sequência, o handler é registrado e removido a cada
    // chamada — nunca fica um handler "fantasma" de uma janela já fechada.
    ipcMain.handle('picker:list', (): PickerSource[] =>
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        isScreen: source.id.startsWith('screen:'),
      })),
    );

    const onChoose = (_event: Electron.IpcMainEvent, id: string): void => {
      const chosen = sources.find((source) => source.id === id) ?? null;
      finish(chosen);
    };
    const onCancel = (): void => finish(null);

    ipcMain.on('picker:choose', onChoose);
    ipcMain.on('picker:cancel', onCancel);

    picker.once('ready-to-show', () => picker.show());
    picker.on('closed', () => finish(null));
    void picker.loadFile(PICKER_HTML);
  });
}
