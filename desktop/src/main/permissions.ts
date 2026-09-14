import { session } from 'electron';

const ALLOWED_PERMISSIONS = new Set([
  'media',
  'audioCapture',
  'videoCapture',
  'notifications',
  'display-capture',
]);

/**
 * Concede automaticamente só as permissões que o telecord de fato usa, e
 * SÓ quando o pedido vem da origem esperada (`prodUrl`) — qualquer outra
 * origem (uma página de terceiros que por algum motivo abrisse dentro
 * desta sessão) é sempre negada, mesmo pedindo uma permissão da lista.
 */
export function configurePermissions(prodOrigin: string): void {
  const isAllowedOrigin = (requestingUrl: string): boolean => {
    try {
      return new URL(requestingUrl).origin === prodOrigin;
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isAllowedOrigin(webContents.getURL());
    callback(allowed);
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === prodOrigin;
  });
}
