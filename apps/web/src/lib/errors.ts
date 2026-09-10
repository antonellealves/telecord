import { MediaDeviceFailure } from 'livekit-client';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** Mensagem útil para falha de microfone — nunca um crash (SPEC §9 / entregável 5). */
export function describeMicrophoneError(error: unknown): string {
  switch (MediaDeviceFailure.getFailure(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'Permissão de microfone negada. Libere o acesso no cadeado da barra de endereços e tente de novo.';
    case MediaDeviceFailure.NotFound:
      return 'Nenhum microfone encontrado. Conecte um dispositivo de entrada e tente de novo.';
    case MediaDeviceFailure.DeviceInUse:
      return 'O microfone está ocupado por outro aplicativo. Feche o outro programa e tente de novo.';
    default:
      return 'Não foi possível ligar o microfone.';
  }
}

/**
 * Falha de screen share. Devolve `null` quando a pessoa simplesmente cancelou
 * o seletor de tela — isso não é erro e não merece aviso.
 *
 * O navegador usa NotAllowedError tanto para "cancelei" quanto para "o sistema
 * bloqueou"; só a mensagem separa os dois casos.
 */
export function describeScreenShareError(error: unknown): string | null {
  const name = errorName(error);
  const message = errorMessage(error).toLowerCase();

  if (name === 'NotAllowedError') {
    if (message.includes('system') || message.includes('sistema')) {
      return 'O sistema operacional bloqueou a captura de tela. Autorize o navegador nas permissões de gravação de tela e tente de novo.';
    }
    return null;
  }
  if (name === 'AbortError') {
    return null;
  }
  if (name === 'NotFoundError') {
    return 'Nenhuma tela disponível para compartilhar.';
  }
  if (name === 'NotReadableError') {
    return 'O sistema não conseguiu capturar a tela. Feche outros programas de captura e tente de novo.';
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return 'Este navegador não permite compartilhar tela. Use Chrome, Edge ou Firefox no computador.';
  }
  return 'Não foi possível compartilhar a tela.';
}

/** `getDisplayMedia` não existe no iOS Safari nem em contexto inseguro. */
export function isScreenShareSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Mesmas falhas do microfone, com o substantivo certo. */
export function describeCameraError(error: unknown): string {
  switch (MediaDeviceFailure.getFailure(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'Permissão de câmera negada. Libere o acesso no cadeado da barra de endereços e tente de novo.';
    case MediaDeviceFailure.NotFound:
      return 'Nenhuma câmera encontrada. Conecte uma e tente de novo.';
    case MediaDeviceFailure.DeviceInUse:
      return 'A câmera está ocupada por outro aplicativo. Feche o outro programa e tente de novo.';
    default:
      return 'Não foi possível ligar a câmera.';
  }
}
