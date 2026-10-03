import { Menu, app, type MenuItemConstructorOptions } from 'electron';

export interface MenuCallbacks {
  onCheckForUpdates: () => void;
}

/**
 * Menu de aplicativo — só existe no macOS.
 *
 * No Windows e no Linux o menu é uma barra DENTRO da janela (Editar, Janela,
 * Ajuda), que rouba uma faixa do app para três itens que ninguém abre. Lá a
 * função devolve `null` e a barra some: copiar, colar e desfazer continuam
 * funcionando porque são atalhos do próprio Chromium, não do menu, e
 * "Verificar atualizações" já está no menu da bandeja.
 *
 * No macOS o menu fica na barra do sistema, fora da janela, e é OBRIGATÓRIO:
 * sem ele, Cmd+C, Cmd+V e Cmd+Q deixam de funcionar.
 */
export function buildMenu(callbacks: MenuCallbacks): Menu | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'Sobre o telecord' },
        { type: 'separator' },
        {
          label: 'Verificar atualizações',
          click: () => callbacks.onCheckForUpdates(),
        },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar telecord' },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do telecord' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        { role: 'front', label: 'Trazer tudo para frente' },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
