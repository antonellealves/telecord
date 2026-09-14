import { contextBridge, ipcRenderer } from 'electron';

/**
 * Bridge mínimo da janela de escolha de fonte — não tem relação com o
 * bridge principal (`preload/index.ts`), que é o que o FRONT web usa. Este
 * só serve à `picker.html`, uma página 100% local e controlada pelo shell.
 */
interface PickerSource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}

contextBridge.exposeInMainWorld('picker', {
  list: (): Promise<PickerSource[]> => ipcRenderer.invoke('picker:list'),
  choose: (id: string): void => ipcRenderer.send('picker:choose', id),
  cancel: (): void => ipcRenderer.send('picker:cancel'),
});
