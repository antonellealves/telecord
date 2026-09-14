import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';

const CHECK_AFTER_BOOT_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas

/**
 * Atualização do SHELL (o executável), via GitHub Releases — camada
 * independente da atualização do FRONT, que só recarrega a página.
 *
 * Baixa em segundo plano e instala no próximo reinício
 * (`autoInstallOnAppQuit`), nunca força o fechamento do app no meio de uma
 * chamada em andamento.
 */
export function setupAutoUpdate(): { checkNow: () => void } {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  if (!app.isPackaged) {
    log.info('[auto-update] desabilitado em desenvolvimento (app não empacotado)');
    return { checkNow: () => undefined };
  }

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Atualização pronta',
        message: `Uma nova versão do telecord (${info.version}) foi baixada.`,
        detail: 'Ela será instalada automaticamente na próxima vez que o aplicativo fechar.',
        buttons: ['OK'],
      })
      .catch(() => undefined);
  });

  autoUpdater.on('error', (error) => {
    log.error(`[auto-update] erro: ${error.message}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      log.warn(`[auto-update] checagem falhou: ${String(error)}`);
    });
  };

  setTimeout(check, CHECK_AFTER_BOOT_MS);
  setInterval(check, CHECK_INTERVAL_MS);

  return { checkNow: check };
}
