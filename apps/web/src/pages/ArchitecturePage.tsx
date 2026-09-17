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
 * ## Por que esta página conta cinco transportes e não um
 *
 * O telecord testou CINCO formas de transmitir mídia, e duas sobreviveram.
 * Contar só as duas que deram certo seria contar a metade menos útil da
 * história: o que ensina é o motivo de as outras três não terem servido, e
 * esse motivo é diferente em cada uma. A página existe para guardar isso —
 * as três descontinuadas continuam no repositório, documentadas, em vez de
 * sumirem num `git rm` que apagaria o aprendizado junto com o código.
 *
 * ## As animações têm regra
 *
 * Só `opacity` e `transform`, que ficam no compositor — nada que force
 * recálculo de layout enquanto rola.
 *
 * Cada bloco aparece quando ENTRA na tela e VOLTA a esconder quando sai, de
 * modo que subir a página e descer de novo toca a revelação outra vez. A
 * versão anterior desconectava o observer no primeiro disparo; a diferença
 * é que aquilo tratava a animação como um evento de carregamento, e isto
 * trata como um comportamento da página — quem rola para cima para reler
 * uma seção vê o bloco se remontar, em vez de encontrar um cartão estático.
 *
 * O bloco só se esconde ao sair pela BORDA DE BAIXO (`boundingClientRect.top`
 * maior que zero). Sem essa checagem, tudo que ficou acima da dobra também se
 * apagaria, e uma rolagem longa de volta ao topo passaria por uma cascata de
 * blocos sumindo — efeito de página quebrada, não de página viva.
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
    title: 'Cinco caminhos testados, dois de pé',
    body:
      'Um SFU recebe de todos e reenvia para todos — é o que aguenta sala cheia sem exigir ' +
      'que cada máquina codifique o vídeo uma vez por pessoa. O telecord tem dois: o LiveKit ' +
      'Cloud, que é serviço gerenciado e continua sendo o padrão, e um mediasoup próprio ' +
      'rodando numa VM nossa, onde o servidor de mídia é código do projeto e não caixa-preta ' +
      'de terceiro. Outros três caminhos foram construídos inteiros e não se sustentaram; ' +
      'estão logo abaixo, com o motivo de cada um.',
    chips: ['LiveKit Cloud', 'mediasoup próprio', 'escolha por sala'],
    survives: 'Os dois funcionam com o banco inteiro fora do ar.',
  },
  {
    id: 'mediasoup',
    eyebrow: 'Camada 2 · SFU próprio',
    title: 'O servidor de mídia é nosso código',
    body:
      'Um processo Node com a biblioteca mediasoup, na mesma VM que hospeda o LiveKit. O ' +
      'navegador nunca fala com ele para criar transporte ou publicar — isso passa por um ' +
      'proxy que confere a participação na sala. O que fala direto é um Socket.IO de presença, ' +
      'autenticado por token curto: é ele que entrega roster, chat e descoberta de faixas ao ' +
      'vivo, sem nenhum polling sobrando. Ser código próprio é o que permitiu empurrar áudio e ' +
      'vídeo para bem além do preset de videoconferência.',
    chips: ['mediasoup na VM', 'Socket.IO de presença', 'proxy confere a sala'],
    survives: 'Reiniciar o processo derrota as salas ativas — trade-off assumido, igual ao LiveKit.',
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
      'administração — e o proxy do mediasoup, que guarda o segredo interno e confere ' +
      'presença antes de repassar qualquer chamada ao SFU. É o único que fala com o banco, e ' +
      'por isso fica separado das camadas acima.',
    chips: ['NestJS', 'Prisma', 'TiDB (MySQL)'],
    survives: 'Se cair, o telecord vira o que era antes das contas.',
  },
];

/** Um transporte testado, com o veredito. */
interface Transport {
  id: string;
  name: string;
  tech: string;
  status: 'mantido' | 'descontinuado';
  /** Uma linha: o que ele se propunha a ser. */
  promise: string;
  /** O que realmente aconteceu. */
  verdict: string;
}

const TRANSPORTS: Transport[] = [
  {
    id: 'livekit',
    name: 'Servidor',
    tech: 'LiveKit Cloud · WebSocket + WebRTC',
    status: 'mantido',
    promise: 'Um SFU gerenciado, com SDK maduro e simulcast pronto.',
    verdict:
      'Performou desde o primeiro dia e virou o padrão. O SDK resolve sozinho o que nos custou ' +
      'semanas no mediasoup: reconexão, simulcast, detecção de quem está falando, mudo de ' +
      'verdade imposto pelo servidor. O preço é depender de um terceiro para o que mais ' +
      'importa — e o teto de qualidade ser o que o serviço decidir oferecer.',
  },
  {
    id: 'mediasoup',
    name: 'mediasoup',
    tech: 'SFU próprio em VM · WebRTC + Socket.IO',
    status: 'mantido',
    promise: 'O mesmo que o LiveKit faz, mas com o servidor sendo código nosso.',
    verdict:
      'Demorou a ficar de pé — a seção de cicatrizes abaixo é quase toda dele — mas é onde o ' +
      'projeto deve continuar. Ter o servidor na mão foi o que permitiu negociar Opus a 256 ' +
      'kbps com banda cheia de 48 kHz e oferecer AV1 antes de VP9, coisas que num serviço ' +
      'fechado a gente só aceitaria se viesse pronto.',
  },
  {
    id: 'p2p',
    name: 'Direto',
    tech: 'WebRTC puro, malha entre navegadores',
    status: 'descontinuado',
    promise: 'Latência mínima e nenhum servidor vendo a mídia.',
    verdict:
      'Funciona, e é honestamente bom em sala pequena — o problema é matemático. As conexões ' +
      'crescem com o QUADRADO das pessoas e cada máquina codifica o próprio vídeo uma vez ' +
      'para CADA par: com 6 são 15 conexões e 5 codificações por máquina; com 10, são 45 e 9. ' +
      'Some a isso não ter TURN por princípio (retransmitir por servidor seria negar o motivo ' +
      'de existir), então atrás de NAT simétrico simplesmente não conecta.',
  },
  {
    id: 'cfsfu',
    name: 'Cloudflare',
    tech: 'Cloudflare Realtime · SFU de borda',
    status: 'descontinuado',
    promise: 'SFU global que repassa sem recodificar, na borda, com free tier.',
    verdict:
      'A mídia era ótima — passthrough puro, sem perda de recodificação. O que não fechou foi ' +
      'tudo em volta: o SFU não tem conceito de sala nem descoberta, então foi preciso ' +
      'construir isso por fora num heartbeat de 2,5 s (com o atraso correspondente). Não tem ' +
      'trickle ICE, então a oferta precisa sair com os candidatos já dentro, esperando a ' +
      'coleta terminar. E usar uma RTCPeerConnection só para publicar e assinar criou colisão ' +
      'de negociação, resolvida com uma fila de serialização escrita à mão.',
  },
  {
    id: 'vercel-relay',
    name: 'Vercel Relay',
    tech: 'WebCodecs + WebSocket binário',
    status: 'descontinuado',
    promise: 'Compartilhar tela em HD com R$0 de infraestrutura — tudo na Vercel.',
    verdict:
      'A ideia mais divertida e a que menos se sustenta. Sem WebRTC: a tela é codificada no ' +
      'navegador com WebCodecs, vira pacote binário num WebSocket e a função da Vercel só ' +
      'repassa, sem nunca decodificar. O furo é a premissa: um WebSocket fica preso a UMA ' +
      'instância serverless, e nada garante que quem transmite e quem assiste caiam na mesma. ' +
      'Em app de tráfego baixo costuma funcionar por acidente. Além disso, a conexão morre no ' +
      'teto de duração da função (30 s) e reabre, só aceita um transmissor por sala, não roda ' +
      'local e exige navegador Chromium recente.',
  },
];

interface Stat {
  value: string;
  label: string;
  note: string;
}

const STATS: Stat[] = [
  { value: '~39k', label: 'linhas de TypeScript', note: 'monorepo pnpm, 4 pacotes' },
  { value: '5 → 2', label: 'transportes de mídia', note: 'três construídos e aposentados' },
  { value: '20', label: 'tabelas no banco', note: '79 rotas HTTP' },
  { value: '118', label: 'testes', note: 'rodam sem banco e sem rede' },
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
    title: 'Transporte novo, zero refatoração dos que já existiam',
    body:
      'Cada transporte entrou como uma página a mais ao lado das anteriores, reusando os ' +
      'componentes de tela — em vez de forçar todos atrás de uma abstração comum que nenhum ' +
      'pediu. Cheguei a desenhar essa abstração para o mediasoup e desisti: os hooks do ' +
      'LiveKit fazem instanceof em classes concretas do SDK dele, impossíveis de satisfazer ' +
      'com um objeto parecido. Generalizar à força arriscaria quebrar o transporte que estava ' +
      'em produção para beneficiar o experimental. É também o que torna barato aposentar três ' +
      'deles agora: ninguém mais depende do código que vai sair.',
  },
  {
    title: 'A credencial liga o recurso — não uma flag ao lado dela',
    body:
      'A primeira versão exigia CF_REALTIME_ENABLED=true além das chaves — e uma flag separada ' +
      'é exatamente o tipo de configuração que fica pela metade: a credencial chega ao ' +
      'ambiente, a flag não, e o recurso fica desligado em silêncio. Hoje a PRESENÇA da ' +
      'credencial é o interruptor, do mesmo jeito que já valia para o LiveKit.',
  },
  {
    title: 'Por que um servidor próprio e não a próxima API',
    body:
      'Depois de dois serviços gerenciados, a tentação era procurar um terceiro. Não fazia ' +
      'sentido: o problema nunca foi qual API, foi depender de cota alheia para a coisa mais ' +
      'básica do produto. Num serviço, o teto de qualidade é o que ele decidir oferecer e o ' +
      'teto de uso é o que a fatura permitir. Numa máquina própria que só roteia — sem gravar ' +
      'nada, sem guardar nada — o custo é fixo e o teto é a banda da máquina. Trocar de ' +
      'biblioteca resolveria a API; não resolveria o dono da conta.',
  },
  {
    title: 'Qualidade é uma corrente: a camada mais fraca decide',
    body:
      'Para o áudio sair de 32 kbps "de telefone" e chegar a 256 kbps com banda cheia, três ' +
      'camadas tiveram que concordar — captura, codec e envio. Elevar só uma não muda nada: o ' +
      'navegador ignora o teto alto do codec se o sender continuar no preset dele, e o melhor ' +
      'sender do mundo não recupera o que a captura já jogou fora. Cada número está num ' +
      'arquivo de perfil, com o motivo escrito ao lado, porque em seis meses ninguém lembra ' +
      'por que 510 kbps e não 512.',
  },
  {
    title: 'O processamento de voz é quem mais estraga a voz',
    body:
      'Cancelamento de eco, supressão de ruído e controle automático de ganho existem para ' +
      'salvar notebook no viva-voz, e fazem isso destruindo fidelidade: o AEC derruba a banda ' +
      'alta junto com o eco, a supressão apaga respiração e cauda de consoante junto com o ' +
      'ruído, o AGC achata a dinâmica. No mediasoup os três estão desligados. É uma escolha ' +
      'com dono: assume fone de ouvido, e quem usar caixa aberta vai ouvir eco.',
  },
];

/** Uma passagem da travessia de infraestrutura. */
interface Station {
  id: string;
  /** O rótulo curto que fica na órbita. */
  marker: string;
  title: string;
  body: string;
  /** O dado duro, sem adjetivo. */
  metric: string;
}

/**
 * A parte que ninguém mostra em print de portfólio.
 *
 * Cada item aqui é uma coisa que quebrou de verdade e que não estava no
 * código — estava na conta, no console do provedor ou no firewall.
 */
const STATIONS: Station[] = [
  {
    id: 'cartao',
    marker: 'T-0',
    title: 'Coragem de pôr o cartão',
    body:
      'Infraestrutura gratuita não começa gratuita: começa com um formulário pedindo cartão de ' +
      'crédito e a promessa de que nada será cobrado enquanto você ficar dentro da cota. A ' +
      'parte difícil não é técnica — é abrir a conta, cadastrar o cartão e depois voltar toda ' +
      'semana conferir que o número continua zerado. O telecord roda em quatro camadas ' +
      'gratuitas empilhadas, e cada uma tem um teto diferente, medido numa unidade diferente.',
    metric: 'Oracle Cloud · Vercel · TiDB Serverless · Cloudflare — todos free tier',
  },
  {
    id: 'cota',
    marker: 'T-1',
    title: 'Contar bytes para não tomar susto',
    body:
      'A cota de tráfego é o tipo de limite que só se descobre estourado. Para o SFU da ' +
      'Cloudflare foi preciso escrever um contador próprio: quem assiste reporta a cada 15 ' +
      'segundos quanto baixou, e o backend soma num único campo por mês. A conta é grosseira ' +
      'de propósito — mede o egresso de quem assiste, que é o que custa, e ignora quem publica, ' +
      'que é grátis. Aos 80% a interface avisa; aos 100% ela recusa criar sala nesse modo e ' +
      'troca sozinha para outro transporte.',
    metric: '1.000 GB/mês ≈ 46 h de sala cheia · aviso em 80%, bloqueio em 100%',
  },
  {
    id: 'porta',
    marker: 'T-2',
    title: 'A porta UDP que não estava no código',
    body:
      'A dor mais cara do projeto. Mídia em tempo real precisa de uma faixa larga de portas ' +
      'UDP aberta, e num provedor de nuvem existem DOIS firewalls: o da máquina e o da rede. ' +
      'Liberei o da máquina. O da rede continuou fechado. O sintoma foi cruel porque tudo ' +
      'parecia funcionar: entrar na sala, ver os participantes, mandar mensagem — tudo isso ' +
      'passa pela porta 443, que já estava aberta. Só a mídia não chegava. Horas procurando no ' +
      'código um bug que estava no console do provedor.',
    metric: '40000-40100/udp LiveKit · 40101-40200/udp mediasoup · 443 nunca foi o problema',
  },
  {
    id: 'ram',
    marker: 'T-3',
    title: 'Meio giga de RAM, dois SFUs',
    body:
      'A máquina gratuita anuncia 1 GB e entrega cerca de 498 MB ao sistema. Nela rodam o ' +
      'proxy, o LiveKit e o mediasoup. Duas descobertas custaram deploys inteiros: o Docker ' +
      'cria um processo por porta publicada — e 201 portas de mídia derrubaram a máquina no ' +
      'primeiro deploy real, resolvido desligando o proxy em espaço de usuário; e compilar o ' +
      'mediasoup em paralelo com a subida do LiveKit esgota a memória e derruba os dois. Hoje o ' +
      'deploy é serial de propósito: custa alguns minutos, evita perder tudo.',
    metric: '~498 MB reais + 3 GB de swap · build observado em 10m32s',
  },
  {
    id: 'socket',
    marker: 'T-4',
    title: 'Trocar perguntas repetidas por avisos',
    body:
      'O mediasoup não vem com sinalização: ele roteia mídia e nada mais. A primeira versão ' +
      'perguntava por HTTP, em laço — quem está na sala a cada 2,5 s, quem publicou faixa nova ' +
      'a cada 4 s. Funcionava e era ruim em tudo: alguém que fechava a aba continuava na lista ' +
      'por até 20 segundos, e uma tela compartilhada podia perder a janela de descoberta e ' +
      'ficar preta do outro lado. A troca por um socket próprio eliminou o laço inteiro. Nada ' +
      'de porta nova: ele sobe na mesma porta do SFU, atrás do mesmo proxy.',
    metric: 'de 2,5 s e 4 s de polling para zero · saída detectada na hora',
  },
];

/** Um elo da corrente de qualidade, da captura à reprodução. */
interface QualityLink {
  stage: string;
  body: string;
  /** Os números concretos, para quem quiser conferir. */
  numbers: string;
}

const QUALITY_CHAIN: QualityLink[] = [
  {
    stage: 'Captura',
    body:
      'O que o navegador entrega antes de qualquer codificação. Aqui o inimigo não é a falta ' +
      'de recurso, é o excesso: o processamento de voz ligado por padrão apaga justamente o ' +
      'que dá naturalidade. Na tela, a armadilha foi mais boba — pedir resolução num formato ' +
      'que a API ignorava em silêncio.',
    numbers: 'voz 48 kHz mono sem AEC/NS/AGC · tela até 4K a 60 fps',
  },
  {
    stage: 'Codec',
    body:
      'O que se negocia com o outro lado. No áudio, os parâmetros do Opus decidem se a banda ' +
      'vai inteira ou cortada em 16 kHz. No vídeo, a ordem da lista decide tudo: o navegador ' +
      'pega o primeiro que sabe codificar. Havia um VP9 configurado num perfil de 10 bits que ' +
      'quase nenhum navegador codifica — na prática ele nunca era escolhido e tudo caía no ' +
      'VP8, o mais fraco.',
    numbers: 'Opus 48 kHz, FEC, sem DTX · AV1 → VP9 → H.264 → VP8',
  },
  {
    stage: 'Envio',
    body:
      'O teto real, aplicado a quem transmite. É a camada que mais engana: dá para configurar ' +
      'tudo certo nas outras duas e o navegador continuar mandando no preset dele. Precisa ser ' +
      'reaplicado depois que a conexão existe, senão não pega. É aqui também que se escolhe o ' +
      'que sacrificar sob pressão — tela prefere perder quadro a perder nitidez; câmera, o ' +
      'contrário.',
    numbers: 'voz 256 kbps · tela 20–50 Mbps · câmera 8 Mbps',
  },
  {
    stage: 'Reprodução',
    body:
      'O elo esquecido, e o que causou o pior bug do projeto. Se o contexto de áudio nasce na ' +
      'taxa da placa de som e não na do stream, tudo é reamostrado em tempo real com filtro ' +
      'barato — comendo exatamente a banda alta que as três camadas anteriores preservaram.',
    numbers: 'contexto fixo em 48 kHz · ganho por participante até 200%',
  },
];

/** Um horizonte: o que ainda não existe, e por que cabe. */
interface Horizon {
  title: string;
  body: string;
  tag: string;
}

const HORIZONS: Horizon[] = [
  {
    tag: 'em estudo',
    title: 'Clipes e replay',
    body:
      'Hoje nada é gravado, e isso é decisão, não falta: o servidor de gravação do LiveKit ' +
      'existe e está deliberadamente desligado, então nenhum byte de mídia toca disco em ' +
      'lugar nenhum. Clipe é o primeiro recurso que exigiria rever isso — mas rever de um ' +
      'jeito específico: gravar só o que alguém pediu explicitamente, pelos segundos ' +
      'anteriores ao clique, e não a sala inteira o tempo todo. Um buffer curto em memória ' +
      'que só vira arquivo quando alguém aperta o botão é diferente de uma sala gravada.',
  },
  {
    tag: 'depende de clipes',
    title: 'Repetição instantânea',
    body:
      'O mesmo buffer que gera um clipe pode voltar alguns segundos para quem chegou atrasado ' +
      'na piada. A parte difícil não é o vídeo: é deixar visível, em toda sala, que existe um ' +
      'buffer — porque uma sala onde qualquer um pode salvar o que você acabou de dizer é uma ' +
      'sala diferente de uma onde nada fica. Se entrar, entra anunciado.',
  },
];

/** Uma garantia verificável do app de desktop. */
interface DesktopGuarantee {
  claim: string;
  body: string;
}

const DESKTOP_GUARANTEES: DesktopGuarantee[] = [
  {
    claim: 'Ele não instala um programa — instala uma janela',
    body:
      'O aplicativo de desktop é uma casca que abre o mesmo site que você usaria no navegador. ' +
      'Não existe uma segunda versão do telecord dentro dele: a lógica, as salas e a mídia são ' +
      'exatamente as mesmas, carregadas do mesmo endereço. O que a casca acrescenta é o que só ' +
      'um programa nativo consegue — atalho global para falar, seletor de tela do sistema, ' +
      'ícone na bandeja.',
  },
  {
    claim: 'A página não alcança o seu computador',
    body:
      'Os três interruptores que separam uma janela de navegador de um programa com acesso à ' +
      'máquina estão todos na posição segura: isolamento de contexto ligado, integração com o ' +
      'sistema desligada, caixa de areia ativa. Na prática, o código do site roda com os mesmos ' +
      'poderes que teria numa aba comum — não lê seus arquivos, não executa comandos.',
  },
  {
    claim: 'Permissão só para quem é de casa',
    body:
      'Microfone, câmera, tela e notificação são concedidos automaticamente — e só se o pedido ' +
      'vier do endereço oficial do telecord. Qualquer outra origem que por algum motivo abrisse ' +
      'ali dentro é recusada mesmo pedindo uma permissão da lista. É a diferença entre "o app ' +
      'pode usar o microfone" e "qualquer página aberta no app pode usar o microfone".',
  },
  {
    claim: 'O alerta que você vai ver não é sobre vírus',
    body:
      'O Windows e o macOS vão avisar que o programa é de desenvolvedor não identificado. Isso ' +
      'não significa que encontraram algo — significa que ninguém pagou pelo certificado de ' +
      'assinatura, que é uma taxa anual, não um exame de segurança. O instalador é montado ' +
      'publicamente pelo próprio repositório a partir do código que está aberto ali. É o caso ' +
      'em que a desconfiança é saudável e a resposta é verificável.',
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
  {
    title: 'A porta que faltava não estava no código',
    body:
      'No mediasoup, vídeo e voz não saíam: sala entrava, chat funcionava, participantes ' +
      'apareciam, e nenhum pacote de mídia passava. Passei horas no código. A causa era a ' +
      'faixa de portas UDP liberada no firewall DA VM mas não no da NUVEM — sinalização ia ' +
      'por HTTPS na 443, que já estava aberta, e por isso tudo PARECIA conectado. A lição ' +
      'ficou no roteiro de setup: quando só a mídia falha e o resto anda, o suspeito é a rede, ' +
      'não a lógica.',
  },
  {
    title: 'O áudio chegava, e mesmo assim era silêncio',
    body:
      'Com as portas abertas, o vídeo voltou. A voz não. E o mais desconcertante: as ' +
      'estatísticas do navegador mostravam os pacotes de áudio CHEGANDO, com o nível de ' +
      'volume cravado em zero. A causa: a sala não tinha nenhum elemento <audio>. O Chrome só ' +
      'entrega amostras de uma faixa de áudio do WebRTC quando existe um elemento de mídia ' +
      'consumindo aquele stream — o roteamento por Web Audio sozinho fica ligado a uma fonte ' +
      'que nunca produz nada. O vídeo nunca sofreu disso porque o <video> já servia de ' +
      'âncora. A correção foi um <audio> mudo e escondido por faixa.',
  },
  {
    title: 'Cinco diagnósticos errados antes do certo',
    body:
      'Nessa mesma caçada eu acusei, em sequência: o DTX do Opus, um produtor duplicado, o ' +
      'produtor nascendo pausado, a taxa de amostragem do contexto de áudio. Todas eram ' +
      'melhorias reais — nenhuma era A causa. O que finalmente resolveu veio de olhar as ' +
      'estatísticas de WebRTC do navegador em vez de teorizar, exatamente como no deploy que ' +
      'só destravou quando a função passou a reportar o próprio erro. O padrão se repete: ' +
      'medir cedo custa menos que deduzir bem.',
  },
  {
    title: 'Um bug de fechamento, escondido em cast de tipo',
    body:
      'O mediasoup pedia a captura de tela passando um objeto no formato do SDK do LiveKit — ' +
      'com resolução e dica de conteúdo em campos que a API do navegador não conhece e ' +
      'ignora em silêncio. Resultado: nenhuma resolução nem taxa de quadros era pedida, por ' +
      'mais alto que fosse o nível escolhido na interface. No modo direto o mesmo bug estava ' +
      'mascarado por um "as" de TypeScript, que é justamente o que desliga o compilador de ' +
      'avisar que aqueles campos não existem ali.',
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
          } else if (entry.boundingClientRect.top > 0) {
            // Saiu por BAIXO: rearma, para que descer de novo reanime.
            // Saiu por cima (top <= 0) fica como está — ver docstring.
            setShown(false);
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

/**
 * Campo de estrelas, em três planos de profundidade.
 *
 * Tudo é CSS: cada plano é um `radial-gradient` repetido, e o paralaxe vem de
 * animar cada um numa velocidade diferente. Sem imagem para baixar, sem
 * canvas, sem biblioteca — e como só `transform` e `opacity` são animados, os
 * três planos ficam no compositor e não custam nada ao rolar.
 *
 * `aria-hidden` porque é puro enfeite: quem usa leitor de tela não perde
 * informação nenhuma ao não ouvir "campo de estrelas".
 */
function Starfield(): JSX.Element {
  return (
    <div className={styles.starfield} aria-hidden="true">
      <div className={`${styles.stars} ${styles.starsFar}`} />
      <div className={`${styles.stars} ${styles.starsMid}`} />
      <div className={`${styles.stars} ${styles.starsNear}`} />
      <div className={styles.nebula} />
    </div>
  );
}

export function ArchitecturePage(): JSX.Element {
  return (
    <>
      {/*
        * `subtle` e não `full`: o degradê padrão acende a base da tela com
        * força suficiente para apagar as estrelas justamente onde o conteúdo
        * está. Aqui ele vira só a cor de fundo, e o céu é quem decora.
        */}
      <AmbientGradient variant="subtle" />
      <Starfield />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.hero}>
            <Link to="/" className={styles.back}>
              ← telecord
            </Link>
            <p className={styles.tagline}>como é feito</p>
            <h1 className={styles.title}>
              Cinco jeitos de transmitir,
              <br />
              <span className={styles.titleAccent}>dois que sobreviveram.</span>
            </h1>
            <p className={styles.lead}>
              Um Discord de voz enxuto: sala com tela compartilhada, chat e soundboard, onde
              entrar não exige conta. A parte difícil sempre foi a mídia — e a resposta não veio
              de escolher certo na primeira vez, e sim de construir cinco caminhos inteiros e
              descobrir, um a um, onde cada um quebra. Abaixo está a travessia toda: o que
              funcionou, o que custou caro, e o que ainda é só horizonte.
            </p>
          </header>

          {/* ---- o diagrama ---------------------------------------------- */}

          <section className={styles.stack} aria-label="As camadas">
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
              * das camadas porque só faz sentido tendo visto todas.
              */}
            <Reveal delay={120}>
              <p className={styles.punchline}>
                As camadas 1, 2 e 3 sobrevivem à morte da 4. Sem banco e sem contas, o telecord
                continua sendo uma sala de voz que funciona.
              </p>
            </Reveal>
          </section>

          {/* ---- os cinco transportes -------------------------------------- */}

          <section aria-label="Os cinco transportes testados">
            <Reveal>
              <h2 className={styles.sectionTitle}>Cinco transportes, um veredito cada</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                Nenhum destes foi protótipo de fim de semana: os cinco foram construídos
                inteiros, com sala, chat, tela compartilhada e controle de qualidade. Três serão
                aposentados — o código e a documentação ficam guardados numa branch, porque o
                que eles ensinaram vale mais que o que eles entregavam.
              </p>
            </Reveal>
            <div className={styles.transports}>
              {TRANSPORTS.map((transport, index) => (
                <Reveal key={transport.id} delay={index * 70}>
                  <article
                    className={`${styles.transport} ${
                      transport.status === 'descontinuado' ? styles.transportRetired : ''
                    }`}
                  >
                    <header className={styles.transportHead}>
                      <div>
                        <h3 className={styles.transportName}>{transport.name}</h3>
                        <p className={styles.transportTech}>{transport.tech}</p>
                      </div>
                      <span
                        className={`${styles.badge} ${
                          transport.status === 'mantido' ? styles.badgeKeep : styles.badgeRetire
                        }`}
                      >
                        {transport.status === 'mantido' ? 'mantido' : 'a descontinuar'}
                      </span>
                    </header>
                    <p className={styles.transportPromise}>
                      <span className={styles.transportLabel}>A promessa</span>
                      {transport.promise}
                    </p>
                    <p className={styles.cardText}>
                      <span className={styles.transportLabel}>O que aconteceu</span>
                      {transport.verdict}
                    </p>
                  </article>
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <p className={styles.punchline}>
                O caminho adiante é o mediasoup. Ter o servidor de mídia como código próprio é o
                que permite continuar subindo o teto de qualidade em vez de esperar que um
                terceiro suba por nós.
              </p>
            </Reveal>
          </section>

          {/* ---- a travessia de infraestrutura ----------------------------- */}

          <section aria-label="A travessia da infraestrutura">
            <Reveal>
              <h2 className={styles.sectionTitle}>A parte que ninguém mostra</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                Escrever o código foi a parte previsível. O que consumiu noites foi tudo que
                mora fora dele: contas gratuitas com cartão cadastrado, cotas medidas em
                unidades diferentes, dois firewalls onde eu achava que havia um, e meio giga de
                RAM para segurar dois servidores de mídia.
              </p>
            </Reveal>
            <ol className={styles.journey}>
              {STATIONS.map((station, index) => (
                <Reveal key={station.id} delay={index * 80}>
                  <li className={styles.station}>
                    <span className={styles.stationMarker} aria-hidden="true">
                      {station.marker}
                    </span>
                    <div className={styles.stationBody}>
                      <h3 className={styles.cardTitle}>{station.title}</h3>
                      <p className={styles.cardText}>{station.body}</p>
                      <p className={styles.stationMetric}>{station.metric}</p>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ol>
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

          {/* ---- a busca por qualidade ------------------------------------- */}

          <section aria-label="A busca por qualidade máxima">
            <Reveal>
              <h2 className={styles.sectionTitle}>Onde a qualidade se perde</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                A descoberta mais útil do projeto inteiro: o padrão de qualquer navegador é
                videoconferência, não fidelidade. Sem configurar nada, a voz sai a 32 kbps com o
                espectro cortado na metade, e a tela em ~2,5 Mbps. Chegar ao topo exigiu tratar
                cada elo da corrente — porque basta um apertado para os outros não adiantarem.
              </p>
            </Reveal>
            <div className={styles.chain}>
              {QUALITY_CHAIN.map((link, index) => (
                <Reveal key={link.stage} delay={index * 70}>
                  <article className={styles.link}>
                    <span className={styles.linkStep} aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className={styles.cardTitle}>{link.stage}</h3>
                      <p className={styles.cardText}>{link.body}</p>
                      <p className={styles.linkNumbers}>{link.numbers}</p>
                    </div>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>

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

          {/* ---- o app de desktop ------------------------------------------ */}

          <section aria-label="O aplicativo de desktop">
            <Reveal>
              <h2 className={styles.sectionTitle}>“Isso não é vírus?”</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                É a pergunta certa a se fazer diante de qualquer executável baixado da internet,
                e merece resposta verificável em vez de garantia de boca. Aqui estão as quatro
                que dá para conferir sozinho — três estão no código aberto, e a quarta explica o
                susto que o sistema operacional vai te dar.
              </p>
            </Reveal>
            <div className={styles.grid}>
              {DESKTOP_GUARANTEES.map((guarantee, index) => (
                <Reveal key={guarantee.claim} delay={index * 70}>
                  <article className={`${styles.card} ${styles.guarantee}`}>
                    <h3 className={styles.cardTitle}>{guarantee.claim}</h3>
                    <p className={styles.cardText}>{guarantee.body}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ---- horizontes ------------------------------------------------ */}

          <section aria-label="O que vem depois">
            <Reveal>
              <h2 className={styles.sectionTitle}>O que ainda não existe</h2>
            </Reveal>
            <Reveal delay={60}>
              <p className={styles.sectionLead}>
                Duas ideias que só fazem sentido agora que o servidor de mídia é código próprio
                — e que mexem na promessa mais forte do projeto, a de que nada é guardado.
              </p>
            </Reveal>
            <div className={styles.horizons}>
              {HORIZONS.map((horizon, index) => (
                <Reveal key={horizon.title} delay={index * 80}>
                  <article className={styles.horizon}>
                    <span className={styles.horizonTag}>{horizon.tag}</span>
                    <h3 className={styles.cardTitle}>{horizon.title}</h3>
                    <p className={styles.cardText}>{horizon.body}</p>
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
