import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * `documentPictureInPicture` ainda não está no lib.dom do TypeScript, então os
 * tipos vêm daqui. É API padrão do Chromium 116+, não experimental atrás de
 * flag — o que falta é só a declaração.
 */
interface DocumentPiPOptions {
  width?: number;
  height?: number;
  /** Esconde o botão de "voltar para a aba" na moldura da janela. */
  disallowReturnToOpener?: boolean;
  /** Mantém a janela sempre visível, que é o ponto do overlay. */
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPiP extends EventTarget {
  requestWindow: (options?: DocumentPiPOptions) => Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPiP;
  }
}

export interface OverlayState {
  /** O navegador tem a API. Sem isso o botão explica em vez de falhar. */
  isSupported: boolean;
  isOpen: boolean;
  /** Onde montar o conteúdo do overlay; `null` enquanto fechado. */
  container: HTMLElement | null;
  open: () => Promise<void>;
  close: () => void;
  toggle: () => void;
}

/**
 * Janela flutuante que fica ACIMA de qualquer aplicativo, inclusive jogo em
 * tela cheia.
 *
 * ## Por que Document Picture-in-Picture, e não uma div na página
 *
 * Uma div com `position: fixed` e `z-index` só flutua dentro da PÁGINA. Sai da
 * frente no instante em que alguém troca para o jogo — que é exatamente o
 * momento em que o overlay serviria para alguma coisa.
 *
 * A API de picture-in-picture de DOCUMENTO abre uma janela de verdade do
 * sistema operacional, sempre-no-topo, e deixa renderizar HTML qualquer
 * dentro. É o único caminho para "acima dos aplicativos" sem instalar um
 * programa nativo.
 *
 * ## O que ela custa
 *
 * Só Chromium desktop (Chrome, Edge, Opera) a partir da versão 116. Firefox e
 * Safari não têm, e nenhum navegador de celular tem. Por isso `isSupported` é
 * parte do contrato: a interface DIZ que não dá, em vez de oferecer um botão
 * que não faz nada.
 *
 * O CSS não é herdado pela janela nova — ela é outro documento. As folhas de
 * estilo da página são copiadas na abertura, e é isso que faz o overlay ter a
 * mesma aparência do resto.
 */
export function useOverlay(): OverlayState {
  const [isOpen, setIsOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const janelaRef = useRef<Window | null>(null);

  const isSupported =
    typeof window !== 'undefined' && window.documentPictureInPicture !== undefined;

  const close = useCallback(() => {
    janelaRef.current?.close();
    janelaRef.current = null;
    setContainer(null);
    setIsOpen(false);
  }, []);

  const open = useCallback(async () => {
    const api = window.documentPictureInPicture;
    if (api === undefined || janelaRef.current !== null) return;

    const janela = await api.requestWindow({
      width: 260,
      height: 340,
      disallowReturnToOpener: true,
    });
    janelaRef.current = janela;

    /*
     * Copia as folhas de estilo da página.
     *
     * A janela é outro documento e nasce sem CSS nenhum. Copiar as regras
     * mantém os tokens de cor e as fontes; sem isso o overlay sairia em Times
     * New Roman preto no branco.
     *
     * `cssRules` pode lançar em folha de outra origem (fonte do Google, por
     * exemplo) — daí o try/catch e o fallback por `<link>`.
     */
    for (const folha of Array.from(document.styleSheets)) {
      try {
        const regras = Array.from(folha.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        const estilo = janela.document.createElement('style');
        estilo.textContent = regras;
        janela.document.head.appendChild(estilo);
      } catch {
        const href = folha.href;
        if (href === null) continue;
        const link = janela.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        janela.document.head.appendChild(link);
      }
    }

    const raiz = janela.document.createElement('div');
    raiz.id = 'overlay-root';
    janela.document.body.appendChild(raiz);

    // Fechar pela moldura da janela precisa refletir no botão da sala.
    janela.addEventListener('pagehide', () => {
      janelaRef.current = null;
      setContainer(null);
      setIsOpen(false);
    });

    setContainer(raiz);
    setIsOpen(true);
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    void open().catch(() => undefined);
  }, [isOpen, open, close]);

  // Sair da sala fecha o overlay: janela órfã sem sala é pior que nenhuma.
  useEffect(() => () => janelaRef.current?.close(), []);

  return { isSupported, isOpen, container, open, close, toggle };
}
