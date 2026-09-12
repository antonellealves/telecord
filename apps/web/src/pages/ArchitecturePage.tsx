import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AmbientGradient } from '../components/AmbientGradient';
import styles from './ArchitecturePage.module.css';

/**
 * A página que explica como o telecord é feito.
 *
 * Existe para ser MOSTRADA a alguém — daí ser uma rota própria, e não uma
 * seção do README. O conteúdo é o mesmo que se contaria em voz alta, na ordem
 * em que se contaria: a decisão que define tudo primeiro, os números depois,
 * e as cicatrizes no fim, sem maquiar.
 *
 * ## As animações têm regra
 *
 * Só `opacity` e `transform`, que ficam no compositor — nada que force
 * recálculo de layout enquanto rola. Cada bloco aparece quando ENTRA na tela,
 * via IntersectionObserver, e some da lista de observados depois: animação que
 * refaz a cada rolagem vira enjoo, não enfeite.
 *
 * Quem pede `prefers-reduced-motion` recebe tudo já visível, sem transição
 * nenhuma — a regra está no CSS, e o observer nem chega a esconder nada.
 */

/** Um degrau da pilha, de cima para baixo. */
interface Layer {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  /** O que roda ali, com a cor da camada. */
  chips: string[];
  /** A pergunta que essa camada responde sozinha. */
  survives: string;
}

const LAYERS: Layer[] = [
  {
    id: 'sfu',
    eyebrow: 'Camada 1 · tempo real',
    title: 'Três caminhos para a mídia',
    body:
      'No servidor de mídia, um SFU recebe de todos e reenvia para todos — é o que aguenta ' +
      'sala cheia. Na conexão direta, cada navegador fala com cada outro e nenhum servidor vê ' +
      'a mídia. No Cloudflare, um SFU de borda repassa sem recodificar — a tela sobe uma vez, ' +
      'na qualidade que o navegador de quem compartilha conseguir, e chega igual a cada ' +
      'assinante. Quem escolhe é quem cria a sala, na entrada, e os três ambientes são ' +
      'visualmente distintos de propósito.',
    chips: ['LiveKit Cloud', 'WebRTC puro', 'Cloudflare Realtime', 'escolha por sala'],
    survives: 'Os três funcionam com o banco inteiro fora do ar.',
  },
  {
    id: 'cloudflare',
    eyebrow: 'Camada 2 · borda global',
    title: 'Um SFU que não recodifica',
    body:
      'O App Token do Cloudflare Realtime mora só no servidor: o navegador nunca fala direto ' +
      'com a Cloudflare, sempre por um proxy que confere a presença na sala antes de assinar a ' +
      'chamada. Como o SFU não tem conceito de sala, é o roster existente — o mesmo heartbeat ' +
      'da conexão direta — que carrega o anúncio de sessão e track de cada participante.',
    chips: ['sem recodificação', 'App Token no backend', 'roster reaproveitado'],
    survives: 'Cota de egress do free tier, avisada antes de estourar — nunca surpresa.',
  },
  {
    id: 'edge',
    eyebrow: 'Camada 3 · duas funções magras',
    title: 'O que precisa funcionar sempre',
    body:
      'Uma função assina o JWT de entrada na sala; a outra lista as salas ativas. Só isso. ' +
      'Nenhuma das duas toca o banco, exige login ou carrega framework — são as duas coisas ' +
      'que não podem cair junto com o resto.',
    chips: ['api/token.ts', 'api/rooms.ts', 'sem banco'],
    survives: 'Sem conta, sem banco, a sala continua de pé.',
  },
  {
    id: 'service',
    eyebrow: 'Camada 4 · o que precisa de memória',
    title: 'NestJS para tudo que lembra',
    body:
      'Contas, salas persistidas, canais, sons enviados, log, auditoria, painel de ' +
      'administração — e a sinalização da conexão direta e do Cloudflare, que é ' +
      'caixa-de-correio no banco em vez de WebSocket. É o único que fala com o banco, e por ' +
      'isso fica separado das camadas acima.',
    chips: ['NestJS', 'Prisma', 'TiDB (MySQL)'],
    survives: 'Se cair, o telecord vira o que era antes das contas.',
  },
];

interface Stat {
  value: string;
  label: string;
  note: string;
}

const STATS: Stat[] = [
  { value: '~58k', label: 'linhas de TypeScript', note: 'monorepo pnpm, 4 pacotes' },
  { value: '4 + 6', label: 'dependências de runtime', note: 'raiz + front, e nada mais' },
  { value: '18', label: 'tabelas no banco', note: '66 rotas HTTP' },
  { value: '75', label: 'testes', note: 'rodam sem banco e sem rede' },
];

interface Decision {
  title: string;
  body: string;
}

const DECISIONS: Decision[] = [
  {
    title: 'Sinalização sem WebSocket',
    body:
      'O modo direto precisa que dois navegadores troquem SDP e ICE para se achar. A saída ' +
      'clássica é socket aberto, que não existe em função serverless. Aqui é caixa-de-correio ' +
      'em duas tabelas: quem escreve grava uma linha, quem espera lê por polling curto. O ' +
      'sinal é apagado na ENTREGA — lido duas vezes, ele refaz a negociação e derruba a ' +
      'conexão que acabou de subir.',
  },
  {
    title: 'Um formato de mensagem, dois canos',
    body:
      'Chat e soundboard funcionam nos dois modos sem duas cópias da lógica: no LiveKit ' +
      'viajam pelo canal de dados do SFU, no modo direto por um RTCDataChannel. A mesma ' +
      'função valida os dois lados — o canal é aberto a quem está na sala, então é entrada ' +
      'não confiável em qualquer um deles.',
  },
  {
    title: 'Sem build nativo, em lugar nenhum',
    body:
      'A senha usa scrypt do próprio Node em vez de argon2, que só existe como binário ' +
      'compilado. É o que permite o serviço inteiro caber numa função serverless sem dor.',
  },
  {
    title: 'O painel não é o controle de acesso',
    body:
      'O @Roles("ADMIN") está na classe do controller, não nos métodos: rota nova nasce ' +
      'protegida sem ninguém lembrar de anotar. A tela esconder o menu é conveniência — ' +
      'quem digitar o endereço leva 403 igual.',
  },
  {
    title: 'Moderar fala com o SFU, não com o banco',
    body:
      'Mutar alguém gravando uma coluna não calaria ninguém: o áudio continua subindo do ' +
      'navegador. Só o LiveKit interrompe de verdade — e tudo fica na auditoria, com o ' +
      'antes e o depois.',
  },
  {
    title: 'Aviso no lugar de teto',
    body:
      'A malha do modo direto cresce ao quadrado: com 6 pessoas são 15 conexões e cada ' +
      'máquina codifica o vídeo 5 vezes. Havia um limite duro de 6; virou aviso. Quem tem ' +
      'máquina e banda para tentar com mais deve poder — o que não pode é a lentidão virar ' +
      'surpresa, e a saída fica a um clique.',
  },
  {
    title: 'Terceiro transporte, zero refatoração dos outros dois',
    body:
      'O Cloudflare entrou como uma página a mais ao lado das que já existiam, reusando o ' +
      'mesmo desenho de tela e o mesmo roster do modo direto — em vez de forçar os três atrás ' +
      'de uma abstração comum que nenhum pediu. LiveKit e conexão direta continuam exatamente ' +
      'como eram; quem nunca escolhe o terceiro nem carrega o código dele.',
  },
  {
    title: 'A credencial liga o recurso — não uma flag ao lado dela',
    body:
      'A primeira versão exigia CF_REALTIME_ENABLED=true além das chaves — e uma flag separada ' +
      'é exatamente o tipo de configuração que fica pela metade: a credencial chega ao ' +
      'ambiente, a flag não, e o recurso fica desligado em silêncio. Hoje a PRESENÇA da ' +
      'credencial é o interruptor, do mesmo jeito que já valia para o LiveKit.',
  },
];

interface Scar {
  title: string;
  body: string;
}

const SCARS: Scar[] = [
  {
    title: 'O deploy levou uma tarde inteira',
    body:
      'A Vercel compila cada arquivo de api/ numa etapa separada, com instalação própria, que ' +
      'não enxerga o build do monorepo. Anunciei "causa raiz" mais vezes do que os fatos ' +
      'sustentavam. O que destravou foi parar de teorizar e fazer a função reportar o próprio ' +
      'erro — hoje o Nest inteiro vai empacotado num .cjs de 3 MB.',
  },
  {
    title: 'A qualidade de vídeo levou três rodadas',
    body:
      'Eram quatro causas somadas, e uma delas foi introduzida tentando consertar outra: a ' +
      'dica que resolve travamento (contentHint: motion) é o oposto da que resolve nitidez. ' +
      'A que mais pesava agia do lado de quem assiste, não de quem transmite.',
  },
  {
    title: 'Uma aspa derrubou o login inteiro',
    body:
      'A chave do JWT foi colada no painel com as aspas do .env junto. O serviço subia, as ' +
      'telas carregavam, senha errada dava 401 certinho — só cadastrar e entrar quebravam, ' +
      'porque só esses caminhos assinam token. Hoje existe um teste que assina de verdade.',
  },
  {
    title: 'Sem TURN, algumas redes não conectam',
    body:
      'Isto não é bug pendente, é limite assumido: TURN retransmitiria a mídia por um ' +
      'servidor, que é o oposto do que o modo direto existe para fazer. Atrás de NAT ' +
      'simétrico a conexão simplesmente não sobe — e a tela DIZ "sem rota" em vez de ficar ' +
      'tentando para sempre.',
  },
];

/** Revela um bloco quando ele entra na tela, uma vez só. */
function useReveal<T extends HTMLElement>(): {
  ref: React.RefObject<T>;
  shown: boolean;
} {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    /*
     * Sem IntersectionObserver (ou com movimento reduzido), o bloco nasce
     * visível. Animação é enfeite: sua ausência não pode esconder conteúdo.
     */
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            // Uma vez só: reanimar a cada rolagem cansa em vez de encantar.
            observer.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, shown };
}

function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}): JSX.Element {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`${styles.reveal} ${shown ? styles.revealOn : ''}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

export function ArchitecturePage(): JSX.Element {
  return (
    <>
      <AmbientGradient />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.hero}>
            <Link to="/" className={styles.back}>
              ← telecord
            </Link>
            <p className={styles.tagline}>como é feito</p>
            <h1 className={styles.title}>
              Três jeitos de transmitir,
              <br />
              <span className={styles.titleAccent}>quatro coisas rodando.</span>
            </h1>
            <p className={styles.lead}>
              Um Discord de voz enxuto: sala com tela compartilhada, chat e soundboard, onde
              entrar não exige conta. A mídia pode passar por um servidor, ir direto de um
              navegador ao outro, ou passar por um SFU de borda que não recodifica nada — e quem
              decide é quem cria a sala.
            </p>
          </header>

          {/* ---- o diagrama ---------------------------------------------- */}

          <section className={styles.stack} aria-label="As três camadas">
            {LAYERS.map((layer, index) => (
              <Reveal key={layer.id} delay={index * 90}>
                <article className={`${styles.layer} ${styles[`layer${index + 1}`]}`}>
                  <div className={styles.layerBar} aria-hidden="true" />
                  <div className={styles.layerBody}>
                    <p className={styles.eyebrow}>{layer.eyebrow}</p>
                    <h2 className={styles.layerTitle}>{layer.title}</h2>
                    <p className={styles.layerText}>{layer.body}</p>
                    <ul className={styles.chips}>
                      {layer.chips.map((chip) => (
                        <li key={chip} className={styles.chip}>
                          {chip}
                        </li>
                      ))}
                    </ul>
                    <p className={styles.survives}>
                      <span className={styles.survivesDot} aria-hidden="true" />
                      {layer.survives}
                    </p>
                  </div>
                </article>
              </Reveal>
            ))}

            {/*
              * A frase que o diagrama inteiro existe para dizer. Fica DEPOIS
              * das três camadas porque só faz sentido tendo visto as três.
              */}
            <Reveal delay={120}>
              <p className={styles.punchline}>
                As camadas 1, 2 e 3 sobrevivem à morte da 4. Sem banco e sem contas, o telecord
                continua sendo uma sala de voz que funciona.
              </p>
            </Reveal>
          </section>

          {/* ---- números -------------------------------------------------- */}

          <Reveal>
            <section className={styles.statsBlock} aria-label="Números do projeto">
              <div className={styles.stats}>
                {STATS.map((stat) => (
                  <div key={stat.label} className={styles.stat}>
                    <span className={styles.statValue}>{stat.value}</span>
                    <span className={styles.statLabel}>{stat.label}</span>
                    <span className={styles.statNote}>{stat.note}</span>
                  </div>
                ))}
              </div>
            </section>
          </Reveal>

          {/* ---- decisões -------------------------------------------------- */}

          <section aria-label="Decisões de projeto">
            <Reveal>
              <h2 className={styles.sectionTitle}>Decisões que valem contar</h2>
            </Reveal>
            <div className={styles.grid}>
              {DECISIONS.map((decision, index) => (
                <Reveal key={decision.title} delay={index * 70}>
                  <article className={styles.card}>
                    <h3 className={styles.cardTitle}>{decision.title}</h3>
                    <p className={styles.cardText}>{decision.body}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ---- cicatrizes ------------------------------------------------ */}

          <section aria-label="O que deu errado">
            <Reveal>
              <h2 className={styles.sectionTitle}>E o que deu errado</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                Todo projeto tem estas. Contar só a parte bonita é a forma mais rápida de o
                próximo tropeçar no mesmo buraco.
              </p>
            </Reveal>
            <div className={styles.scars}>
              {SCARS.map((scar, index) => (
                <Reveal key={scar.title} delay={index * 70}>
                  <article className={styles.scar}>
                    <h3 className={styles.cardTitle}>{scar.title}</h3>
                    <p className={styles.cardText}>{scar.body}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>

          <Reveal>
            <footer className={styles.footer}>
              <Link to="/" className={styles.cta}>
                criar uma sala
              </Link>
            </footer>
          </Reveal>
        </div>
      </div>
    </>
  );
}
