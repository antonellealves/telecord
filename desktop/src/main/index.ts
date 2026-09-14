import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  Menu,
  type DisplayMediaRequestHandlerHandlerRequest,
} from 'electron';
import log from 'electron-log/main';
import { join } from 'node:path';
import { loadConfig, saveConfig, type ShellConfig } from './config-store';
import { initialBounds, currentBounds, MIN_WIDTH, MIN_HEIGHT } from './window-state';
import { OfflineWatcher } from './offline-watcher';
import { pickScreenSource } from './screen-picker';
import { configurePermissions } from './permissions';
import { createTray } from './tray';
import { PushToTalk } from './push-to-talk';
import { DeepLinkRouter } from './deep-links';
import { setupAutoUpdate } from './auto-update';
import { buildMenu } from './menu';

// ---------------------------------------------------------------------------
// VARIÁVEIS — únicos 4 valores específicos deste projeto.
// ---------------------------------------------------------------------------
const PROD_URL = 'https://telecord.vercel.app';
const PROD_ORIGIN = new URL(PROD_URL).origin;
const PROD_HOST = new URL(PROD_URL).host;

log.initialize();
log.transports.file.level = 'info';

const config: ShellConfig = loadConfig();
let mainWindow: BrowserWindow | null = null;
let offlineWatcher: OfflineWatcher | null = null;
let pushToTalk: PushToTalk | null = null;
let isMuted = false;
let quitting = false;
const deepLinkRouter = new DeepLinkRouter(() => mainWindow);

// -----------------------------------------------------------------------
// Instância única — a segunda invocação foca a primeira janela e repassa
// o deep link (Windows/Linux). Precisa vir ANTES de qualquer outra coisa
// que crie janela.
// -----------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    deepLinkRouter.handleSecondInstanceArgv(argv);
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    log.error(`[boot] falha ao iniciar: ${String(error)}`);
  });
}

async function bootstrap(): Promise<void> {
  deepLinkRouter.setup();
  configurePermissions(PROD_ORIGIN);
  configureDisplayMediaHandler();

  mainWindow = createMainWindow();
  offlineWatcher = new OfflineWatcher(mainWindow, PROD_URL);

  // Só marca "pronto para deep link" quando a página carregada é de fato
  // PROD_URL — carregar a offline.html local não conta, senão um deep
  // link chegando durante uma queda de rede seria entregue para uma
  // página que ainda não tem o listener do front.
  const handleFinishLoad = (): void => {
    const currentUrl = mainWindow?.webContents.getURL() ?? '';
    if (currentUrl.startsWith(PROD_URL)) {
      deepLinkRouter.markWindowReady();
      mainWindow?.webContents.removeListener('did-finish-load', handleFinishLoad);
    }
  };
  mainWindow.webContents.on('did-finish-load', handleFinishLoad);

  registerIpcHandlers(mainWindow);

  pushToTalk = new PushToTalk(mainWindow);
  pushToTalk.register(config.pushToTalkShortcut);

  const autoUpdate = setupAutoUpdate();

  const tray = createTray(mainWindow, {
    onToggleMute: () => {
      isMuted = !isMuted;
      mainWindow?.webContents.send('push-to-talk', { pressed: false });
    },
    isMuted: () => isMuted,
    onToggleAutoLaunch: async () => {
      config.autoLaunch = !config.autoLaunch;
      applyAutoLaunch(config.autoLaunch);
      saveConfig(config);
    },
    isAutoLaunchEnabled: () => config.autoLaunch,
    onCheckForUpdates: () => autoUpdate.checkNow(),
  });
  // Referenciado só para não ser coletado pelo GC — o Tray não tem uso
  // além de existir e responder aos próprios eventos registrados nele.
  void tray;

  Menu.setApplicationMenu(buildMenu({ onCheckForUpdates: () => autoUpdate.checkNow() }));

  await mainWindow.loadURL(PROD_URL);

  app.on('activate', () => {
    // macOS: clicar no ícone do dock reabre a janela em vez de criar outra.
    if (mainWindow === null) return;
    mainWindow.show();
  });
}

function createMainWindow(): BrowserWindow {
  const bounds = initialBounds(config);

  const window = new BrowserWindow({
    x: bounds.x >= 0 ? bounds.x : undefined,
    y: bounds.y >= 0 ? bounds.y : undefined,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'telecord',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (bounds.isMaximized) window.maximize();

  window.once('ready-to-show', () => window.show());

  // Nunca sai do host de PROD_URL navegando na própria janela — qualquer
  // link externo (ex.: um link de documentação clicado dentro do app) é
  // negado aqui e tratado por `setWindowOpenHandler` como abertura externa.
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const target = safeParseUrl(targetUrl);
    if (target === null || target.host !== PROD_HOST) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeParseUrl(url);
    if (target !== null && target.host === PROD_HOST) {
      // Mesma origem pedindo uma nova janela (ex.: `target=_blank`) — deixa
      // abrir dentro do próprio app seria inconsistente com o resto da
      // navegação restrita; abre no navegador padrão como qualquer link
      // externo, para não multiplicar janelas do shell.
      shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    }
    if (target !== null && /^https?:$/.test(target.protocol)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  // Fechar minimiza para a bandeja (Windows/Linux); no macOS, fechar a
  // janela é o comportamento nativo esperado (o app continua no dock) e
  // só `Cmd+Q` ou o menu Sair encerram de verdade.
  window.on('close', (event) => {
    config.windowBounds = currentBounds(window);
    saveConfig(config);

    if (quitting) return;
    if (process.platform === 'darwin') {
      return;
    }
    event.preventDefault();
    window.hide();
  });

  return window;
}

/**
 * `setDisplayMediaRequestHandler` intercepta TODO pedido de
 * `getDisplayMedia` da página — sem isto, o Chromium embutido não sabe
 * como listar fontes de tela num app empacotado (o prompt nativo do
 * navegador não existe fora de uma aba de verdade).
 *
 * `useSystemPicker: true` só tem efeito no macOS 15+ (documentado pelo
 * próprio Electron): quando o seletor nativo do sistema está disponível
 * ali, o handler abaixo NEM CHEGA A SER CHAMADO — o SO resolve sozinho.
 * Em qualquer outro caso (Windows, Linux, macOS mais antigo), o handler
 * roda de verdade e é ele quem precisa listar as fontes e devolver uma
 * escolhida — por isso o fallback com `picker.html` não é opcional aqui,
 * é o caminho principal fora do macOS recente.
 */
function configureDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request: DisplayMediaRequestHandlerHandlerRequest, callback) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (window === undefined) {
        callback({});
        return;
      }
      const source = await pickScreenSource(window);
      if (source === null) {
        callback({});
        return;
      }
      callback({ video: { id: source.id, name: source.name }, audio: audioModeFor(request) });
    },
    { useSystemPicker: true },
  );
}

/**
 * Windows suporta capturar o áudio do sistema junto da tela
 * (`audio: 'loopback'`). macOS NÃO tem esse modo nativo — pedir
 * `loopback` lá falha; a única forma de áudio de sistema seria um driver
 * virtual externo, que o shell não instala. Por isso o parâmetro `audio`
 * simplesmente não é enviado no callback em macOS/Linux.
 */
function audioModeFor(_request: DisplayMediaRequestHandlerHandlerRequest): 'loopback' | undefined {
  return process.platform === 'win32' ? 'loopback' : undefined;
}

function registerIpcHandlers(window: BrowserWindow): void {
  ipcMain.on('shell:set-badge', (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else if (process.platform === 'win32') {
      // Windows não tem "badge" de app nativo simples sem overlay icon
      // customizado por imagem — o sinal equivalente e barato é o flash
      // da barra de tarefas, já coberto por `flash-frame`.
      window.flashFrame(count > 0);
    }
  });

  ipcMain.on('shell:flash-frame', (_event, on: boolean) => {
    window.flashFrame(on);
  });

  ipcMain.on('shell:open-external', (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
  });

  ipcMain.handle('shell:get-auto-launch', () => config.autoLaunch);

  ipcMain.handle('shell:set-auto-launch', (_event, enabled: boolean) => {
    config.autoLaunch = enabled;
    applyAutoLaunch(enabled);
    saveConfig(config);
  });

  ipcMain.on('shell:retry-now', () => {
    offlineWatcher?.retryNow();
  });
}

function applyAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

app.on('before-quit', () => {
  quitting = true;
  pushToTalk?.unregister();
});

app.on('window-all-closed', () => {
  // macOS mantém o app vivo no dock mesmo sem janelas; nas outras
  // plataformas o comportamento normal é encerrar quando não há mais
  // janela (embora, na prática, `close` já esconde em vez de fechar).
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
