/**
 * Quanto tempo o destaque de "falando" fica aceso depois de a voz parar.
 *
 * O mesmo valor, e pelo mesmo motivo, de `SUSTENTAR_MS` em
 * `useSpeakingDetector`: fala normal tem pausas de 100-200 ms entre palavras,
 * e sem sustentar a marca pisca no ritmo das sílabas.
 */
export const SPEAKING_HOLD_MS = 420;

/**
 * Transforma a lista crua de quem fala, que o SFU manda a cada mudança, no
 * conjunto que a tela mostra: acende na hora, apaga com atraso.
 *
 * Acender não espera nada — é o que faz o destaque acompanhar a primeira
 * sílaba. Só o apagar é segurado, e é cancelado se a pessoa volta a falar
 * antes de o prazo vencer.
 */
export class SpeakerHold {
  private readonly lit = new Set<string>();
  private readonly fading = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (speaking: string[]) => void,
    private readonly holdMs: number = SPEAKING_HOLD_MS,
  ) {}

  /** `peerIds` é a lista INTEIRA de quem fala agora, não um delta. */
  update(peerIds: readonly string[]): void {
    const speaking = new Set(peerIds);
    let changed = false;

    for (const peerId of speaking) {
      const timer = this.fading.get(peerId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.fading.delete(peerId);
      }
      if (!this.lit.has(peerId)) {
        this.lit.add(peerId);
        changed = true;
      }
    }

    for (const peerId of this.lit) {
      if (speaking.has(peerId) || this.fading.has(peerId)) continue;
      this.fading.set(
        peerId,
        setTimeout(() => {
          this.fading.delete(peerId);
          this.lit.delete(peerId);
          this.onChange([...this.lit]);
        }, this.holdMs),
      );
    }

    if (changed) this.onChange([...this.lit]);
  }

  /** Apaga tudo sem esperar — a sessão caiu, ou a sala ficou para trás. */
  clear(): void {
    for (const timer of this.fading.values()) clearTimeout(timer);
    this.fading.clear();
    if (this.lit.size === 0) return;
    this.lit.clear();
    this.onChange([]);
  }
}
