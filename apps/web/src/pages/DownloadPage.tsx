import { AmbientGradient } from '../components/AmbientGradient';
import { SiteNav } from '../components/SiteNav';
import { isElectronShell } from '../lib/shell';
import styles from './DownloadPage.module.css';

const RELEASES = 'https://github.com/antonellealves/telecord/releases';

/**
 * `latest/download/<arquivo>` é o endereço que o GitHub redireciona para a
 * versão mais recente. Os nomes dos arquivos não levam número de versão
 * (ver `desktop/electron-builder.yml`), então estes links não vencem quando
 * sai um instalador novo.
 */
const asset = (file: string): string => `${RELEASES}/latest/download/${file}`;

type SystemId = 'windows' | 'macos' | 'linux';

interface Installer {
  label: string;
  /** Para quem é este arquivo, em uma linha. */
  hint: string;
  file: string;
}

interface System {
  id: SystemId;
  name: string;
  requirement: string;
  installers: Installer[];
  /** O aviso de instalador não assinado, que é diferente em cada sistema. */
  note: string;
}

const SYSTEMS: System[] = [
  {
    id: 'windows',
    name: 'Windows',
    requirement: 'Windows 10 ou 11, 64 bits',
    installers: [
      { label: 'Instalador', hint: 'o único que existe para Windows', file: 'telecord-windows-x64-setup.exe' },
    ],
    note: 'O SmartScreen avisa de "editor desconhecido": clique em Mais informações e depois em Executar assim mesmo.',
  },
  {
    id: 'macos',
    name: 'macOS',
    requirement: 'Apple Silicon ou Intel',
    installers: [
      { label: 'Apple Silicon · dmg', hint: 'Mac com chip M1 em diante', file: 'telecord-macos-arm64.dmg' },
      { label: 'Intel · dmg', hint: 'Mac com processador Intel', file: 'telecord-macos-x64.dmg' },
      { label: 'Apple Silicon · zip', hint: 'o app sem instalador', file: 'telecord-macos-arm64.zip' },
      { label: 'Intel · zip', hint: 'o app sem instalador', file: 'telecord-macos-x64.zip' },
    ],
    note: 'Se o macOS disser que o app "está danificado", rode xattr -cr /Applications/telecord.app no Terminal e abra de novo.',
  },
  {
    id: 'linux',
    name: 'Linux',
    requirement: '64 bits',
    installers: [
      { label: 'AppImage', hint: 'roda em qualquer distribuição', file: 'telecord-linux-x64.AppImage' },
      { label: 'Pacote .deb', hint: 'Debian, Ubuntu e derivados', file: 'telecord-linux-x64.deb' },
    ],
    note: 'O AppImage precisa de permissão de execução: chmod +x telecord-linux-x64.AppImage.',
  },
];

/** Em qual sistema a página foi aberta — só para destacar um cartão. Errar aqui não esconde nada. */
function detectSystem(): SystemId | null {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('android') || agent.includes('iphone') || agent.includes('ipad')) return null;
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os')) return 'macos';
  if (agent.includes('linux')) return 'linux';
  return null;
}

/**
 * Os instaladores do app de computador.
 *
 * Todos os arquivos da versão mais recente, de todos os sistemas, sempre à
 * mostra: o sistema detectado só ganha destaque. Quem está no notebook do
 * trabalho baixando para o computador de casa precisa achar o arquivo do
 * OUTRO sistema sem caçar.
 */
export function DownloadPage(): JSX.Element {
  const detected = detectSystem();

  return (
    <>
      <AmbientGradient variant="subtle" />
      <SiteNav />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.hero}>
            <p className={styles.tagline}>app para computador</p>
            <h1 className={styles.title}>Baixar o telecord</h1>
            <p className={styles.lead}>
              O mesmo telecord do navegador numa janela própria, com o que o navegador não dá: atalho global de
              aperte-para-falar, áudio do sistema na transmissão de tela no Windows, ícone na bandeja e atualização
              automática.
            </p>
            {isElectronShell ? (
              <p className={styles.already}>Você já está no app. Ele se atualiza sozinho.</p>
            ) : null}
          </header>

          <div className={styles.grid}>
            {SYSTEMS.map((system) => (
              <section
                key={system.id}
                className={`${styles.card} ${system.id === detected ? styles.cardDetected : ''}`}
                aria-labelledby={`sistema-${system.id}`}
              >
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle} id={`sistema-${system.id}`}>
                    {system.name}
                  </h2>
                  {system.id === detected ? <span className={styles.badge}>seu sistema</span> : null}
                </div>
                <p className={styles.requirement}>{system.requirement}</p>

                <ul className={styles.list}>
                  {system.installers.map((installer) => (
                    <li key={installer.file}>
                      <a className={styles.download} href={asset(installer.file)} rel="noreferrer">
                        <span className={styles.downloadLabel}>{installer.label}</span>
                        <span className={styles.downloadHint}>{installer.hint}</span>
                        <span className={styles.downloadFile}>{installer.file}</span>
                      </a>
                    </li>
                  ))}
                </ul>

                <p className={styles.note}>{system.note}</p>
              </section>
            ))}
          </div>

          <footer className={styles.footer}>
            <p>
              Os instaladores ainda não são assinados, e é por isso que cada sistema mostra um aviso. Eles são montados
              publicamente a partir do código aberto no repositório.
            </p>
            <p>
              Os links apontam sempre para a versão mais recente.{' '}
              <a className={styles.link} href={RELEASES} target="_blank" rel="noreferrer">
                Todas as versões no GitHub
              </a>
              .
            </p>
          </footer>
        </div>
      </div>
    </>
  );
}
