import { Menu, app, type MenuItemConstructorOptions } from 'electron';

export interface MenuCallbacks {
  onCheckForUpdates: () => void;
}

/** Menu de aplicativo mínimo — o produto é o app web; este menu só cobre o essencial de um app nativo (Sair, Cmd+Q no macOS, checagem manual de atualização). */
export function buildMenu(callbacks: MenuCallbacks): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: 'Sobre o telecord' },
              { type: 'separator' as const },
              {
                label: 'Verificar atualizações',
                click: () => callbacks.onCheckForUpdates(),
              },
              { type: 'separator' as const },
              { role: 'hide' as const, label: 'Ocultar telecord' },
              { role: 'hideOthers' as const, label: 'Ocultar outros' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: 'Sair do telecord' },
            ],
          },
        ]
      : []),
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
        ...(isMac ? [{ role: 'front' as const, label: 'Trazer tudo para frente' }] : []),
      ],
    },
    ...(isMac
      ? []
      : [
          {
            label: 'Ajuda',
            submenu: [
              {
                label: 'Verificar atualizações',
                click: () => callbacks.onCheckForUpdates(),
              },
            ],
          },
        ]),
  ];

  return Menu.buildFromTemplate(template);
}
