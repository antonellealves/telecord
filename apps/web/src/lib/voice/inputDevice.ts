/**
 * Qual microfone abrir, pelo id CONCRETO.
 *
 * O Chrome lista, além dos aparelhos, duas entradas virtuais: `default` (o
 * padrão do sistema) e, no Windows, `communications` (o padrão de
 * comunicação). Abrir `default` funciona, mas amarra a captura a "o que for
 * o padrão quando o navegador olhar" — e quando o padrão muda no sistema, a
 * track continua presa ao aparelho antigo sem ninguém perceber. O Discord
 * abre sempre pelo id exato; aqui também.
 *
 * Quem não escolheu nada ("Padrão do sistema", guardado como `default`) segue
 * o padrão do SISTEMA: o id do aparelho por trás de `default` é resolvido a
 * cada captura e a cada `devicechange`, e a track é trocada se ele mudou.
 */

export const SYSTEM_DEFAULT_DEVICE = 'default';
const VIRTUAL_DEVICES = new Set(['default', 'communications']);

export type InputDeviceInfo = Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'label' | 'kind'>;

function isVirtual(device: InputDeviceInfo): boolean {
  return VIRTUAL_DEVICES.has(device.deviceId);
}

/**
 * O id a abrir, dado o que está plugado e o que a pessoa escolheu.
 *
 * 1. A escolha, se ainda estiver plugada.
 * 2. O aparelho por trás de `default`: mesmo `groupId` e o nome contido no
 *    rótulo dele ("Padrão - Microfone (USB)" contém "Microfone (USB)").
 * 3. O primeiro aparelho de verdade da lista.
 *
 * `null` quando não há microfone nenhum — ou quando, sem permissão, a lista
 * vem sem ids (aí só o navegador sabe o que abrir).
 */
export function resolveInputDevice(devices: readonly InputDeviceInfo[], preferred: string): string | null {
  const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId !== '');
  if (inputs.length === 0) return null;

  if (preferred !== '' && !VIRTUAL_DEVICES.has(preferred) && inputs.some((device) => device.deviceId === preferred)) {
    return preferred;
  }

  const real = inputs.filter((device) => !isVirtual(device));
  const systemDefault = inputs.find((device) => device.deviceId === SYSTEM_DEFAULT_DEVICE);
  if (systemDefault !== undefined) {
    const sameGroup = real.filter((device) => device.groupId !== '' && device.groupId === systemDefault.groupId);
    const byLabel = sameGroup.find((device) => device.label !== '' && systemDefault.label.includes(device.label));
    const match = byLabel ?? (sameGroup.length === 1 ? sameGroup[0] : undefined);
    if (match !== undefined) return match.deviceId;
  }

  return real[0]?.deviceId ?? null;
}

/** O valor que o seletor mostra: a escolha guardada, ou "Padrão do sistema". */
export function selectedInputOption(preferred: string): string {
  return preferred === '' ? SYSTEM_DEFAULT_DEVICE : preferred;
}
