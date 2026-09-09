/**
 * localStorage guarda APENAS a preferência de nome (SPEC §3).
 * Modo privado e storage bloqueado não podem derrubar o app.
 */
const DISPLAY_NAME_KEY = 'telecord.displayName';

export function readStoredDisplayName(): string {
  try {
    return window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeStoredDisplayName(value: string): void {
  try {
    window.localStorage.setItem(DISPLAY_NAME_KEY, value);
  } catch {
    // Storage indisponível: o nome vale só para esta aba. Não é erro fatal.
  }
}
