import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Estado persistido do shell: posição/tamanho da janela, atalho de
 * push-to-talk e preferência de auto-início. Um JSON simples em
 * `userData`, sem dependência externa (nada de `electron-store`) — o
 * volume de dados é mínimo e não justifica mais uma dependência de
 * runtime.
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface ShellConfig {
  windowBounds?: WindowBounds;
  pushToTalkShortcut: string;
  autoLaunch: boolean;
}

const DEFAULT_CONFIG: ShellConfig = {
  pushToTalkShortcut: 'CommandOrControl+Shift+K',
  autoLaunch: false,
};

function configPath(): string {
  return join(app.getPath('userData'), 'shell-config.json');
}

/** Lê o config do disco. Qualquer falha (arquivo ausente, JSON corrompido) volta ao default — nunca derruba o boot. */
export function loadConfig(): ShellConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShellConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Grava o config no disco. Falha de escrita é engolida — perder a persistência não pode travar o app. */
export function saveConfig(config: ShellConfig): void {
  try {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // Silencioso de propósito: sem espaço em disco ou sem permissão de
    // escrita, o app continua funcionando com o config em memória.
  }
}
