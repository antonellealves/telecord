import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ROOM_ID_MAX_LENGTH,
  normalizeDisplayName,
  slugifyRoomId,
  validateDisplayName,
  validateRoomId,
  type TransportMode,
} from '@telecord/shared';
import { ActiveRoomsList } from '../components/ActiveRoomsList';
import { AmbientGradient } from '../components/AmbientGradient';
import { ChannelsList } from '../components/ChannelsList';
import { GamificationCenter } from '../components/GamificationCenter';
import { useActiveRooms } from '../hooks/useActiveRooms';
import { useChannelDirectory } from '../hooks/useChannelDirectory';
import { useRoomDirectory } from '../hooks/useRoomDirectory';
import { TransportPicker } from '../components/TransportPicker';
import { useAuth } from '../hooks/useAuth';
import { useDisplayName } from '../hooks/useDisplayName';
import { useMicrophonePermission } from '../hooks/useMicrophonePermission';
import { trackEvent } from '../lib/gamification';
import { generateRoomId } from '../lib/media';
import { fetchCfSfuConfig } from '../lib/cfsfu';
import { BITRATE_CEILINGS } from '../lib/cfsfuQuality';
import {
  readCfSfuBitrate,
  readLastRoom,
  readTransport,
  writeCfSfuBitrate,
  writeLastRoom,
  writeTransport,
  type CfSfuBitrateId,
} from '../lib/storage';
import type { CfSfuUsage } from '@telecord/shared';
import styles from './JoinPage.module.css';

const NOTES = ['entra mutado', 'várias telas', 'servidor ou direto'];

export function JoinPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [storedName, storeName] = useDisplayName();
  const { status: authStatus, user, enabled: authEnabled, signOut } = useAuth();

  const [name, setName] = useState(storedName);
  const [room, setRoom] = useState(() => searchParams.get('sala') ?? '');
  const [error, setError] = useState<string | null>(null);

  /*
   * Com conta, o nome vem dela e o campo sai de cena. Não é enfeite: o
   * `/api/token` ignora o nome mandado pelo cliente quando há sessão, então um
   * campo editável aqui exibiria um valor que o servidor descarta.
   */
  const isSignedIn = authStatus === 'autenticado' && user !== null;
  useEffect(() => {
    if (user !== null) {
      setName(user.displayName);
    }
  }, [user]);

  const activeRooms = useActiveRooms();
  /*
   * O nome das salas vem do banco; quem está online, do LiveKit. A lista
   * abaixo casa as duas — e sem serviço de contas o diretório chega vazio e a
   * lista fica idêntica à de antes.
   */
  const directory = useRoomDirectory();
  const channels = useChannelDirectory();
  const microphone = useMicrophonePermission();
  const [lastRoom] = useState(() => readLastRoom());
  const [transport, setTransport] = useState<TransportMode>(readTransport);

  /*
   * Cloudflare só aparece quando o servidor confirma que está ligado — o
   * cartão nasce escondido e entra se `enabled`. Junto vem a cota do mês, que
   * avisa perto do teto e bloqueia criar sala cfsfu ao estourar.
   */
  const [cfEnabled, setCfEnabled] = useState(false);
  const [cfUsage, setCfUsage] = useState<CfSfuUsage | null>(null);
  const [bitrate, setBitrate] = useState<CfSfuBitrateId>(readCfSfuBitrate);
  useEffect(() => {
    let vivo = true;
    void fetchCfSfuConfig()
      .then((config) => {
        if (!vivo) return;
        setCfEnabled(config.enabled);
        setCfUsage(config.usage);
        // Estourou a cota: não deixa entrar já escolhido no modo bloqueado.
        if (config.enabled && config.usage.blocked && readTransport() === 'cfsfu') {
          setTransport('livekit');
          writeTransport('livekit');
        }
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  const cfBlocked = cfUsage?.blocked === true;

  const previewSlug = room.trim() === '' ? '' : slugifyRoomId(room);

  /** Caminho comum de entrada: valida o nome, guarda e navega. */
  const enterRoom = useCallback(
    (slug: string): void => {
      const displayName = normalizeDisplayName(name);
      const nameError = validateDisplayName(displayName);
      if (nameError !== null) {
        setError(nameError);
        return;
      }
      const roomError = validateRoomId(slug);
      if (roomError !== null) {
        setError(roomError);
        return;
      }
      storeName(displayName);
      writeLastRoom(slug);
      setError(null);
      navigate(`/sala/${slug}`);
    },
    [name, storeName, navigate],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const blank = room.trim() === '';
    // Nome em branco significa sala nova, criada por quem entra: é a missão do
    // anfitrião. Entrar numa sala existente pela lista não conta.
    if (blank) {
      trackEvent({ type: 'room.create' });
    }
    enterRoom(blank ? generateRoomId() : slugifyRoomId(room));
  }

  return (
    <>
      <AmbientGradient />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.hero}>
            <h1 className={styles.wordmark}>Telecord</h1>
            <p className={styles.tagline}>criar sala</p>
            <p className={styles.title}>
              Entre, fale e
              <span className={styles.titleAccent}>mostre a tela.</span>
            </p>
            <p className={styles.lead}>
              Suprasumo do entretenimento de dota 2
            </p>
          </header>

          <form className={styles.card} onSubmit={handleSubmit}>
            {error !== null ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            <label className={styles.field}>
              <span className={styles.label}>Nome da sala</span>
              <input
                className={styles.input}
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                placeholder="reuniao-do-time"
                maxLength={ROOM_ID_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={styles.hint}>
                {previewSlug === '' ? (
                  'Em branco cria uma sala nova com nome aleatório.'
                ) : (
                  <>
                    Você entra em <span className={styles.hintSlug}>/sala/{previewSlug}</span>
                  </>
                )}
              </p>
            </label>

            {/*
              * A escolha fica AQUI, ao lado do nome da sala, e não escondida
              * nas configurações: ela muda o que a sala é — quantas pessoas
              * cabem e por onde a mídia anda —, então é decisão de quem cria,
              * no momento de criar.
              */}
            <div className={styles.field}>
              <span className={styles.label}>Como a transmissão viaja</span>
              <TransportPicker
                value={transport}
                hidden={cfEnabled && !cfBlocked ? [] : ['cfsfu']}
                onChange={(mode) => {
                  setTransport(mode);
                  writeTransport(mode);
                }}
              />
              {transport === 'cfsfu' ? (
                <div className={styles.cfsfuOptions}>
                  <span className={styles.hint}>Teto de bitrate do vídeo</span>
                  <div className={styles.bitrateRow} role="radiogroup" aria-label="Teto de bitrate">
                    {BITRATE_CEILINGS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={bitrate === option.id}
                        className={`${styles.bitrate} ${bitrate === option.id ? styles.bitrateOn : ''}`}
                        onClick={() => {
                          setBitrate(option.id);
                          writeCfSfuBitrate(option.id);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {cfUsage !== null && cfUsage.fraction >= 0.8 ? (
                    <p className={styles.hint}>
                      Cota do mês em {Math.round(cfUsage.fraction * 100)}% ({Math.round(cfUsage.usedGb)} de{' '}
                      {cfUsage.monthlyLimitGb} GB). Perto do teto, considere o Servidor de mídia.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {lastRoom !== '' && lastRoom !== previewSlug ? (
              <button type="button" className={styles.recall} onClick={() => setRoom(lastRoom)}>
                voltar para <span className={styles.hintSlug}>{lastRoom}</span>
              </button>
            ) : null}

            {isSignedIn ? (
              <div className={styles.account}>
                <span className={styles.label}>Seu nome</span>
                <p className={styles.accountName}>
                  {user.displayName}
                  <span className={styles.accountBadge}>confirmado</span>
                </p>
                <p className={styles.hint}>
                  Vem da sua conta ({user.email}).{' '}
                  {/*
                    * O atalho para o painel só aparece para quem tem o cargo,
                    * e isso é conveniência de navegação — a rota `/painel`
                    * existe para todo mundo e é o SERVIDOR que recusa quem não
                    * for administrador, com 403 em cada chamada.
                    */}
                  {user.role === 'ADMIN' ? (
                    <>
                      <Link className={styles.link} to="/painel">
                        painel
                      </Link>
                      {' · '}
                    </>
                  ) : null}
                  <button type="button" className={styles.linkButton} onClick={() => void signOut()}>
                    sair da conta
                  </button>
                </p>
              </div>
            ) : (
              <label className={styles.field}>
                <span className={styles.label}>Seu nome</span>
                <input
                  className={styles.input}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Como as pessoas vão te ver"
                  maxLength={DISPLAY_NAME_MAX_LENGTH}
                  autoComplete="nickname"
                />
                <p className={styles.hint}>
                  Fica salvo neste navegador para a próxima vez.
                  {authEnabled ? (
                    <>
                      {' '}
                      Com <Link className={styles.link} to="/entrar">uma conta</Link>, ele fica
                      igual em toda sala e ninguém pode usá-lo.
                    </>
                  ) : null}
                </p>
              </label>
            )}

            <div className={styles.permission}>
              {microphone.status === 'granted' ? (
                <p className={styles.permissionOk}>
                  <span className={styles.dot} aria-hidden="true" />
                  Microfone já autorizado neste navegador.
                </p>
              ) : microphone.status === 'denied' ? (
                <p className={styles.permissionWarn}>
                  Microfone bloqueado. Libere no cadeado da barra de endereços — dá para entrar
                  assim mesmo, só não vai dar para falar.
                </p>
              ) : (
                <>
                  <p className={styles.permissionAsk}>
                    Autorize o microfone uma vez e o navegador não pergunta mais neste
                    dispositivo.
                  </p>
                  <button
                    type="button"
                    className={styles.permissionButton}
                    onClick={microphone.request}
                    disabled={microphone.isRequesting}
                  >
                    {microphone.isRequesting ? 'Aguardando…' : 'Autorizar microfone'}
                  </button>
                </>
              )}
              {microphone.error !== null ? (
                <p className={styles.permissionWarn}>{microphone.error}</p>
              ) : null}
            </div>

            <button type="submit" className={styles.submit}>
              Entrar na sala
            </button>
          </form>

          <ChannelsList channels={channels.channels} />

          <ActiveRoomsList
            rooms={activeRooms.rooms}
            directory={directory.rooms}
            isLoading={activeRooms.isLoading}
            error={activeRooms.error}
            onEnter={enterRoom}
            onRefresh={activeRooms.refresh}
          />

          <ul className={styles.notes}>
            {NOTES.map((note) => (
              <li key={note} className={styles.note}>
                <span className={styles.dot} aria-hidden="true" />
                {note}
              </li>
            ))}
          </ul>

          {/*
            * Navegação discreta, no rodapé e no tom mais apagado da tela: quem
            * chega aqui quer criar uma sala, não ler sobre o projeto.
            *
            * O painel só aparece para quem tem o papel — e isso é conveniência
            * de navegação, não controle de acesso: as rotas de administração
            * respondem 403 por conta própria para quem digitar o endereço.
            */}
          <div className={styles.progressRow}>
            <GamificationCenter variant="hero" />
          </div>

          <nav className={styles.footerNav} aria-label="Sobre o projeto">
            <Link to="/arquitetura" className={styles.footerLink}>
              como é feito
            </Link>
            {isSignedIn && user.role === 'ADMIN' ? (
              <Link to="/painel" className={styles.footerLink}>
                painel
              </Link>
            ) : null}
          </nav>

          <p className={styles.signature}>feito com carinho para a galera do dota teleton</p>
        </div>
      </div>
    </>
  );
}
