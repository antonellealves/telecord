import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { P2P_COMFORT_PEERS, parseRoomMessage } from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { ChatPanel } from '../components/ChatPanel';
import { DeviceSettings } from '../components/DeviceSettings';
import { Soundboard } from '../components/Soundboard';
import { ParticipantOverlay } from '../components/ParticipantOverlay';
import { ToastStack } from '../components/ToastStack';
import { TransportPicker } from '../components/TransportPicker';
import {
  CameraIcon,
  CameraOffIcon,
  ChatIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  ExpandIcon,
  ScreenIcon,
  ShrinkIcon,
  SlidersIcon,
  SoundIcon,
} from '../components/icons';
import { useP2PMesh, type RemotePeer } from '../hooks/useP2PMesh';
import { useP2PVolume } from '../hooks/useP2PVolume';
import { useRoomSounds } from '../hooks/useRoomSounds';
import { useTileLayout } from '../hooks/useTileLayout';
import { useOverlay } from '../hooks/useOverlay';
import { useSpeakingDetector } from '../hooks/useSpeakingDetector';
import { useToasts } from '../hooks/useToasts';
import { useAuth } from '../hooks/useAuth';
import { useSoundVolume } from '../hooks/useSoundVolume';
import { screenQuality, screenShareCaptureOptions, type ScreenQualityId } from '../lib/media';
import {
  readParticipantsOpen,
  readScreenQuality,
  readTalkMode,
  writeParticipantsOpen,
  writeScreenQuality,
  writeTalkMode,
  writeTransport,
  applyTheme,
  readTheme,
  writeTheme,
  type TalkMode,
  type ThemeId,
} from '../lib/storage';
import styles from './P2PRoom.module.css';

interface Props {
  roomId: string;
  displayName: string;
  peerId: string;
  onLeave: () => void;
}

const ESTADO_TEXTO: Record<RemotePeer['state'], string> = {
  novo: 'conectando',
  ligando: 'negociando',
  ligado: 'direto',
  falhou: 'sem rota',
};

interface TileProps {
  peerId: string;
  displayName: string;
  stream: MediaStream | null;
  badge: string;
  isSelf: boolean;
  isBad: boolean;
  isDragging: boolean;
  isMaximized: boolean;
  position: { x: number; y: number; w: number; h: number } | undefined;
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  onToggleMaximized: () => void;
}

function Tile({
  displayName,
  stream,
  badge,
  isSelf,
  isBad,
  isDragging,
  isMaximized,
  position,
  onDragStart,
  onResizeStart,
  onToggleMaximized,
}: TileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    // `srcObject` não existe como atributo JSX: precisa ser atribuído.
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const temVideo = stream?.getVideoTracks().some((t) => t.readyState === 'live') ?? false;

  /*
   * Posição salva vira `position: absolute` em porcentagem; sem ela, o quadro
   * fica no fluxo da grade automática. Os dois modos convivem: quem nunca
   * arrastou vê a grade, quem arrastou vê a própria arrumação.
   */
  const style =
    position === undefined
      ? undefined
      : {
          position: 'absolute' as const,
          left: `${position.x * 100}%`,
          top: `${position.y * 100}%`,
          width: `${position.w * 100}%`,
          height: `${position.h * 100}%`,
        };

  return (
    <article
      className={[
        styles.tile,
        isSelf ? styles.tileSelf : '',
        isBad ? styles.tileBad : '',
        isDragging ? styles.tileDragging : '',
        isMaximized ? styles.tileMax : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      onPointerDown={onDragStart}
      title="Arraste para mover este quadro"
    >
      <video ref={videoRef} className={styles.video} autoPlay playsInline muted={isSelf} />
      {!temVideo ? (
        <div className={styles.tilePlaceholder}>
          <span className={styles.initials}>{displayName.slice(0, 2).toUpperCase()}</span>
        </div>
      ) : null}
      <span className={styles.tileLabel}>
        <span className={styles.tileName}>{isSelf ? 'você' : displayName}</span>
        <span className={`${styles.tileBadge} ${isBad ? styles.tileBadgeBad : ''}`}>{badge}</span>
      </span>

      <button
        type="button"
        className={styles.tileZoom}
        onClick={onToggleMaximized}
        title={isMaximized ? 'Voltar ao tamanho (Esc)' : 'Ocupar o palco inteiro'}
        aria-label={isMaximized ? 'Voltar ao tamanho' : 'Maximizar'}
      >
        {isMaximized ? <ShrinkIcon /> : <ExpandIcon />}
      </button>

      {/*
        * O punho só existe quando o quadro JÁ tem posição própria: no modo
        * grade quem manda no tamanho é o CSS, e um punho ali prometeria um
        * arrasto que o layout desfaria no próximo quadro.
        */}
      {position !== undefined && !isMaximized ? (
        <span
          className={styles.tileResize}
          onPointerDown={onResizeStart}
          role="separator"
          aria-label="Redimensionar"
          title="Arraste para redimensionar"
        />
      ) : null}
    </article>
  );
}

/**
 * Sala no modo de conexão direta.
 *
 * ## O mesmo que a sala do LiveKit tem, por outro caminho
 *
 * Voz, câmera, tela, chat, soundboard, lista de gente, volume por pessoa,
 * aperte-para-falar e configurações — tudo existe aqui. O que muda é o cano:
 * a mídia vai direto de navegador para navegador, e chat e sons viajam num
 * `RTCDataChannel` em vez do canal de dados do SFU. O formato da mensagem é o
 * mesmo dos dois lados (`parseRoomMessage`), então a lógica é compartilhada.
 *
 * ## E o desenho é deliberadamente outro
 *
 * Fundo mais fechado, marcação em âmbar, quadros arrastáveis em vez de grade
 * fixa. Alguém que entra numa sala precisa saber EM QUAL MODO está sem ler
 * etiqueta: os dois ambientes têm limitações diferentes (aqui cabem 6 pessoas,
 * e rede difícil não conecta), e confundi-los é o que gera a queixa errada.
 */
export function P2PRoom({ roomId, displayName, peerId, onLeave }: Props): JSX.Element {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const { status: authStatus } = useAuth();
  const sound = useSoundVolume();

  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const [talkMode, setTalkMode] = useState<TalkMode>(readTalkMode);
  const [screenQualityId, setScreenQualityId] = useState<ScreenQualityId>(readScreenQuality);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPeopleOpen, setIsPeopleOpen] = useState(readParticipantsOpen);
  const [themeId, setThemeId] = useState<ThemeId>(readTheme);
  const overlay = useOverlay();

  const controlsRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  /* --- mensagens pelo canal de dados ----------------------------------- */

  const [chat, setChat] = useState<
    { id: string; author: string; authorIdentity: string; body: string; sentAt: number; isLocal: boolean }[]
  >([]);
  const [unread, setUnread] = useState(0);

  const roomSounds = useRoomSounds({
    roomId,
    isSignedIn: authStatus === 'autenticado',
    notify: push,
  });

  /** Toca um som localmente, no volume do soundboard. */
  const tocar = useCallback(
    (soundId: string) => {
      const encontrado = roomSounds.find(soundId);
      if (encontrado === undefined) return;
      const audio = new Audio(encontrado.file);
      audio.volume = Math.max(0, Math.min(1, sound.effective));
      void audio.play().catch(() => undefined);
    },
    [roomSounds, sound],
  );

  const nomesRef = useRef<Map<string, string>>(new Map());

  const aoReceberDados = useCallback(
    (fromPeer: string, raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      // MESMA validação do modo LiveKit: o canal é aberto a quem está na sala,
      // então o conteúdo é entrada não confiável nos dois casos.
      const message = parseRoomMessage(parsed);
      if (message === null) return;

      if (message.type === 'sound') {
        tocar(message.soundId);
        return;
      }
      if (message.type === 'sound-stop') return;

      setChat((atual) =>
        [
          ...atual,
          {
            id: message.id,
            author: nomesRef.current.get(fromPeer) ?? 'alguém',
            authorIdentity: fromPeer,
            body: message.body,
            sentAt: message.sentAt,
            isLocal: false,
          },
        ].slice(-200),
      );
      setUnread((n) => n + 1);
    },
    [tocar],
  );

  const mesh = useP2PMesh({
    roomSlug: roomId,
    peerId,
    displayName,
    localStream,
    enabled: true,
    onData: aoReceberDados,
  });

  // O mapa de nomes alimenta o autor das mensagens que chegam.
  useEffect(() => {
    for (const p of mesh.peers) nomesRef.current.set(p.peerId, p.displayName);
  }, [mesh.peers]);

  const peerVolume = useP2PVolume(mesh.streams);

  /*
   * Quem está falando. No modo LiveKit o SFU calcula e manda por evento; aqui
   * não há SFU, então cada navegador mede os streams que recebe — inclusive o
   * próprio, para a pessoa se ver falando no overlay.
   */
  const streamsComLocal = useMemo(() => {
    const todos = new Map(mesh.streams);
    if (localStream !== null) todos.set(peerId, localStream);
    return todos;
  }, [mesh.streams, localStream, peerId]);
  const falando = useSpeakingDetector(streamsComLocal);
  const layout = useTileLayout(roomId, peerId);

  useEffect(() => {
    if (isChatOpen) setUnread(0);
  }, [isChatOpen, chat.length]);

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const enviarChat = useCallback(
    (body: string) => {
      const trimmed = body.trim().slice(0, 500);
      if (trimmed === '') return;
      const message = { type: 'chat' as const, id: crypto.randomUUID(), body: trimmed, sentAt: Date.now() };
      mesh.broadcast(JSON.stringify(message));
      // Aparece na hora para quem escreveu: o canal não devolve o próprio eco.
      setChat((atual) =>
        [
          ...atual,
          { id: message.id, author: displayName, authorIdentity: peerId, body: trimmed, sentAt: message.sentAt, isLocal: true },
        ].slice(-200),
      );
    },
    [mesh, displayName, peerId],
  );

  const tocarSom = useCallback(
    (soundId: string) => {
      mesh.broadcast(JSON.stringify({ type: 'sound', soundId, sentAt: Date.now() }));
      tocar(soundId);
    },
    [mesh, tocar],
  );

  /* --- mídia local ------------------------------------------------------ */

  const trocarFaixas = useCallback((novas: MediaStreamTrack[], tipo: 'audio' | 'video') => {
    setLocalStream((atual) => {
      const proximo = new MediaStream(atual?.getTracks() ?? []);
      for (const track of proximo.getTracks()) {
        if (track.kind === tipo) {
          track.stop();
          proximo.removeTrack(track);
        }
      }
      for (const track of novas) proximo.addTrack(track);
      return proximo.getTracks().length === 0 ? null : proximo;
    });
  }, []);

  const abrirMicrofone = useCallback(async (): Promise<MediaStreamTrack[]> => {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        // Mesmo pedido do modo LiveKit: sem isto o navegador pode entregar
        // 16 kHz e a voz chega sem as frequências altas.
        sampleRate: 48000,
      },
    });
    return s.getAudioTracks();
  }, []);

  const alternarMic = useCallback(async () => {
    if (micOn) {
      trocarFaixas([], 'audio');
      setMicOn(false);
      return;
    }
    try {
      trocarFaixas(await abrirMicrofone(), 'audio');
      setMicOn(true);
    } catch {
      push('error', 'Não deu para abrir o microfone.');
    }
  }, [micOn, trocarFaixas, abrirMicrofone, push]);

  /* Aperte-para-falar: a faixa fica, o que muda é `enabled`. */
  const definirFala = useCallback(
    (ligado: boolean) => {
      const faixa = localStream?.getAudioTracks()[0];
      if (faixa === undefined) return;
      faixa.enabled = ligado;
      setMicOn(ligado);
    },
    [localStream],
  );

  useEffect(() => {
    if (talkMode !== 'push') return;
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body) {
        e.preventDefault();
        definirFala(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') definirFala(false);
    };
    // Perder o foco corta: alt-tab com a tecla apertada nunca gera keyup.
    const blur = (): void => definirFala(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [talkMode, definirFala]);

  const alternarCam = useCallback(async () => {
    if (camOn) {
      trocarFaixas([], 'video');
      setCamOn(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      trocarFaixas(s.getVideoTracks(), 'video');
      setCamOn(true);
      setScreenOn(false);
    } catch {
      push('error', 'Não deu para abrir a câmera.');
    }
  }, [camOn, trocarFaixas, push]);

  const alternarTela = useCallback(
    async (quality?: ScreenQualityId) => {
      if (screenOn && quality === undefined) {
        trocarFaixas([], 'video');
        setScreenOn(false);
        return;
      }
      try {
        const s = await navigator.mediaDevices.getDisplayMedia(
          screenShareCaptureOptions(quality ?? screenQualityId) as DisplayMediaStreamOptions,
        );
        const video = s.getVideoTracks();
        video[0]?.addEventListener('ended', () => {
          trocarFaixas([], 'video');
          setScreenOn(false);
        });
        trocarFaixas(video, 'video');
        setScreenOn(true);
        setCamOn(false);
      } catch {
        // Cancelar o seletor do navegador não é erro.
      }
    },
    [screenOn, trocarFaixas, screenQualityId],
  );

  const sair = useCallback(() => {
    for (const track of localStream?.getTracks() ?? []) track.stop();
    onLeave();
  }, [localStream, onLeave]);

  const conectados = useMemo(
    () => mesh.peers.filter((p) => p.state === 'ligado').length,
    [mesh.peers],
  );

  const temArrumacao = layout.isCustom;

  return (
    <>
      <AmbientGradient variant="subtle" />

      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>{roomId}</h1>
            <span className={styles.modeTag}>conexão direta</span>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.counter}>
              {conectados}/{mesh.peers.length} direto
            </span>
            {temArrumacao ? (
              <button type="button" className={styles.ghost} onClick={layout.reset}>
                desfazer arrumação
              </button>
            ) : null}
          </div>
        </header>

        {mesh.error !== null ? <p className={styles.warn}>{mesh.error}</p> : null}
        {/*
          * Aviso, e não bloqueio: a sala aceita quem chegar. Quem tem máquina
          * e banda para uma malha grande deve poder tentar — o que não pode é
          * a lentidão virar surpresa.
          */}
        {mesh.isCrowded ? (
          <p className={styles.warn}>
            Mais de {P2P_COMFORT_PEERS} pessoas no modo direto: cada navegador mantém uma
            conexão com cada outro, então isso pesa rápido. Se travar, o servidor de mídia
            aguenta sala grande sem esforço.
          </p>
        ) : null}

        <div className={styles.body}>
          {isPeopleOpen ? (
            <aside className={styles.people} aria-label="Quem está na sala">
              <div className={styles.peopleHead}>
                <h2 className={styles.peopleTitle}>
                  Pessoas <span className={styles.count}>{mesh.peers.length + 1}</span>
                </h2>
                <button
                  type="button"
                  className={styles.close}
                  onClick={() => {
                    setIsPeopleOpen(false);
                    writeParticipantsOpen(false);
                  }}
                  aria-label="Esconder a lista"
                >
                  ×
                </button>
              </div>
              <ul className={styles.peopleList}>
                <li className={styles.person}>
                  <span className={styles.personName}>{displayName} (você)</span>
                </li>
                {mesh.peers.map((p) => {
                  const entry = peerVolume.get(p.peerId);
                  return (
                    <li key={p.peerId} className={styles.person}>
                      <span className={styles.personName}>{p.displayName}</span>
                      <span
                        className={`${styles.personState} ${p.state === 'falhou' ? styles.personStateBad : ''}`}
                      >
                        {ESTADO_TEXTO[p.state]}
                      </span>
                      <div className={styles.volumeRow}>
                        <button
                          type="button"
                          className={styles.mini}
                          onClick={() => peerVolume.toggleMuted(p.peerId)}
                          title={entry.muted ? 'Ouvir' : 'Silenciar para mim'}
                        >
                          {entry.muted ? <MicOffIcon /> : <MicIcon />}
                        </button>
                        <input
                          className={styles.slider}
                          type="range"
                          min={0}
                          max={200}
                          value={Math.round(entry.volume * 100)}
                          onChange={(e) =>
                            peerVolume.setVolume(p.peerId, Number(e.target.value) / 100)
                          }
                          aria-label={`Volume de ${p.displayName}`}
                        />
                        <span className={styles.volumeValue}>
                          {Math.round(entry.volume * 100)}%
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </aside>
          ) : null}

          {/*
            * O palco. Quem arrastou algum quadro vira `position: relative` com
            * quadros absolutos; quem não arrastou continua na grade.
            */}
          <div
            ref={stageRef}
            className={`${styles.stage} ${temArrumacao ? styles.stageFree : ''}`}
          >
            <Tile
              peerId={peerId}
              displayName={displayName}
              stream={localStream}
              badge={micOn ? 'no ar' : 'mudo'}
              isSelf
              isBad={false}
              isDragging={layout.dragging === peerId}
              isMaximized={layout.maximized === peerId}
              position={layout.tiles[peerId]}
              onDragStart={(e) => layout.beginDrag(peerId, e)}
              onResizeStart={(e) => layout.beginResize(peerId, e)}
              onToggleMaximized={() => layout.toggleMaximized(peerId)}
            />

            {mesh.peers.map((p) => (
              <Tile
                key={p.peerId}
                peerId={p.peerId}
                displayName={p.displayName}
                stream={p.stream}
                badge={ESTADO_TEXTO[p.state]}
                isSelf={false}
                isBad={p.state === 'falhou'}
                isDragging={layout.dragging === p.peerId}
                isMaximized={layout.maximized === p.peerId}
                position={layout.tiles[p.peerId]}
                onDragStart={(e) => layout.beginDrag(p.peerId, e)}
                onResizeStart={(e) => layout.beginResize(p.peerId, e)}
                onToggleMaximized={() => layout.toggleMaximized(p.peerId)}
              />
            ))}

            {mesh.peers.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>Ninguém mais por aqui</p>
                <p className={styles.emptyHint}>
                  Mande o endereço desta sala para alguém. No modo direto, cada pessoa conecta
                  com cada outra — sem servidor no meio da mídia.
                </p>
              </div>
            ) : null}
          </div>

          {isChatOpen ? (
            <ChatPanel
              messages={chat}
              onSend={enviarChat}
              onClose={() => setIsChatOpen(false)}
              peerVolume={peerVolume}
            />
          ) : null}
        </div>

        <div className={styles.controls} ref={controlsRef}>
          {isSettingsOpen ? (
            <DeviceSettings
              containerRef={controlsRef}
              talkMode={talkMode}
              onChangeTalkMode={(mode) => {
                setTalkMode(mode);
                writeTalkMode(mode);
              }}
              onClose={() => setIsSettingsOpen(false)}
              notify={push}
              screenQualityId={screenQualityId}
              onChangeScreenQuality={(id) => {
                setScreenQualityId(id);
                writeScreenQuality(id);
                if (screenOn) void alternarTela(id);
              }}
              isSharingScreen={screenOn}
              themeId={themeId}
              onChangeTheme={(id) => {
                setThemeId(id);
                writeTheme(id);
              }}
              isOverlaySupported={overlay.isSupported}
              isOverlayOpen={overlay.isOpen}
              onToggleOverlay={overlay.toggle}
            />
          ) : null}

          {isSoundboardOpen ? (
            <Soundboard
              containerRef={controlsRef}
              sounds={roomSounds.sounds}
              isLoading={roomSounds.isLoading}
              error={roomSounds.error}
              canUpload={roomSounds.canUpload}
              isUploading={roomSounds.isUploading}
              onUpload={roomSounds.upload}
              onDelete={roomSounds.remove}
              onPlay={tocarSom}
              onClose={() => setIsSoundboardOpen(false)}
              playing={null}
              onStop={() => undefined}
              volume={sound.volume}
              onVolumeChange={sound.setVolume}
              muted={sound.muted}
              onToggleMute={sound.toggleMuted}
            />
          ) : null}

          {talkMode === 'push' ? (
            <button
              type="button"
              className={`${styles.button} ${micOn ? styles.active : ''}`}
              onPointerDown={() => definirFala(true)}
              onPointerUp={() => definirFala(false)}
              onPointerCancel={() => definirFala(false)}
              disabled={localStream?.getAudioTracks().length === undefined}
              title="Segure para falar — ou segure a barra de espaço"
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
              <span className={styles.text}>{micOn ? 'Falando…' : 'Segure para falar'}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.button} ${micOn ? styles.active : ''}`}
              onClick={() => void alternarMic()}
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
              <span className={styles.text}>{micOn ? 'Microfone ligado' : 'Falar'}</span>
            </button>
          )}

          <button
            type="button"
            className={`${styles.button} ${camOn ? styles.active : ''}`}
            onClick={() => void alternarCam()}
          >
            {camOn ? <CameraIcon /> : <CameraOffIcon />}
            <span className={styles.text}>{camOn ? 'Câmera ligada' : 'Câmera'}</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${screenOn ? styles.active : ''}`}
            onClick={() => void alternarTela()}
            title={screenQuality(screenQualityId).label}
          >
            <ScreenIcon />
            <span className={styles.text}>
              {screenOn ? 'Parar de compartilhar' : 'Compartilhar tela'}
            </span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${isSoundboardOpen ? styles.toggled : ''}`}
            onClick={() => setIsSoundboardOpen((o) => !o)}
            aria-expanded={isSoundboardOpen}
          >
            <SoundIcon />
            <span className={styles.text}>Sons</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${isPeopleOpen ? styles.toggled : ''}`}
            onClick={() =>
              setIsPeopleOpen((o) => {
                writeParticipantsOpen(!o);
                return !o;
              })
            }
            aria-expanded={isPeopleOpen}
          >
            <PeopleIcon />
            <span className={styles.text}>Pessoas</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${isChatOpen ? styles.toggled : ''}`}
            onClick={() => setIsChatOpen((o) => !o)}
            aria-expanded={isChatOpen}
          >
            <ChatIcon />
            <span className={styles.text}>Chat</span>
            {!isChatOpen && unread > 0 ? (
              <span className={styles.badge}>{unread > 9 ? '9+' : unread}</span>
            ) : null}
          </button>

          <button
            type="button"
            className={`${styles.button} ${isSettingsOpen ? styles.toggled : ''}`}
            onClick={() => setIsSettingsOpen((o) => !o)}
            aria-expanded={isSettingsOpen}
            aria-haspopup="dialog"
          >
            <SlidersIcon />
            <span className={styles.text}>Configurações</span>
          </button>

          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={sair}>
            <LeaveIcon />
            <span className={styles.text}>Sair</span>
          </button>
        </div>

        <footer className={styles.footer}>
          <p className={styles.status}>
            Arraste qualquer quadro para arrumar a sua visão — fica salvo para a próxima vez.
            {mesh.peers.some((p) => p.state === 'falhou')
              ? ' Quem aparece como "sem rota" está numa rede que bloqueia o caminho direto.'
              : ''}
          </p>

          <div className={styles.switcher}>
            <TransportPicker
              value="p2p"
              compact
              onChange={(mode) => {
                if (mode === 'p2p') return;
                writeTransport(mode);
                for (const track of localStream?.getTracks() ?? []) track.stop();
                navigate(0);
              }}
            />
          </div>
        </footer>
      </div>

      <ParticipantOverlay
        container={overlay.container}
        roomId={roomId}
        variant="p2p"
        people={[
          {
            id: peerId,
            displayName,
            isSpeaking: falando.has(peerId),
            isMuted: !micOn,
            isLocal: true,
            isAway: false,
          },
          ...mesh.peers.map((p) => ({
            id: p.peerId,
            displayName: p.displayName,
            isSpeaking: falando.has(p.peerId),
            isMuted: (mesh.streams.get(p.peerId)?.getAudioTracks().length ?? 0) === 0,
            isLocal: false,
            isAway: false,
          })),
        ]}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
