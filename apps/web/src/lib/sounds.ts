/**
 * Catálogo do soundboard.
 *
 * Os arquivos vivem em `apps/web/public/sons/` e são servidos como estáticos.
 * Para trocar ou acrescentar: coloque o arquivo na pasta e adicione uma linha
 * aqui — o `id` precisa bater com o nome do arquivo e só aceita minúsculas,
 * dígitos e hífen, porque é ele que trafega pelo canal de dados e é validado
 * do outro lado (`parseRoomMessage`).
 *
 * Os cinco padrão são sintetizados, não gravados: servem para o recurso
 * funcionar de saída e para você ter algo com que testar. Troque à vontade.
 */
export interface SoundEntry {
  id: string;
  label: string;
  file: string;
}

export const SOUNDS: SoundEntry[] = [
  { id: 'bip', label: 'Bip', file: '/sons/bip.wav' },
  { id: 'alerta', label: 'Alerta', file: '/sons/alerta.wav' },
  { id: 'sucesso', label: 'Sucesso', file: '/sons/sucesso.wav' },
  { id: 'erro', label: 'Erro', file: '/sons/erro.wav' },
  { id: 'tambor', label: 'Tambor', file: '/sons/tambor.wav' },
];

const byId = new Map(SOUNDS.map((sound) => [sound.id, sound]));

export function findSound(soundId: string): SoundEntry | undefined {
  return byId.get(soundId);
}
