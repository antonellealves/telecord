/// <reference lib="dom" />

/**
 * Roda dentro da MESMA janela principal (é carregada por `loadFile` na
 * troca de `did-fail-load`), então tem o mesmo preload — mas só usa o
 * canal de retry, que existe independente de estar autenticado ou não.
 */
interface OfflineBridge {
  retryNow: () => void;
}

declare global {
  interface Window {
    telecordOffline?: OfflineBridge;
  }
}

export {};

document.getElementById('retry')?.addEventListener('click', () => {
  window.telecordOffline?.retryNow();
});
