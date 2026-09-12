import { useCallback, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { LiveKitRoom } from '@livekit/components-react';
import { normalizeRoomId, validateRoomId } from '@telecord/shared';
import { StatusScreen } from '../components/StatusScreen';
import { useDisplayName } from '../hooks/useDisplayName';
import { readPeerId, readTransport } from '../lib/storage';
import { P2PRoom } from './P2PRoom';
import { CloudflareRoom } from './CloudflareRoom';
import { useToken } from '../hooks/useToken';
import { LIVEKIT_URL, getConfigError } from '../lib/config';
import { roomOptions } from '../lib/media';
import { RoomShell } from './RoomShell';
import statusStyles from '../components/StatusScreen.module.css';
import styles from './RoomPage.module.css';

export function RoomPage(): JSX.Element {
  const params = useParams<{ roomId: string }>();
  const [displayName] = useDisplayName();
  const navigate = useNavigate();
  const [peerId] = useState(readPeerId);

  const roomId = normalizeRoomId(params.roomId ?? '');
  const configError = getConfigError();
  const roomIdError = validateRoomId(roomId);

  if (configError !== null) {
    return (
      <StatusScreen variant="error" title="Configuração incompleta" message={configError}>
        <Link className={statusStyles.button} to="/">
          Voltar ao início
        </Link>
      </StatusScreen>
    );
  }

  if (roomIdError !== null) {
    return (
      <StatusScreen variant="error" title="Endereço de sala inválido" message={roomIdError}>
        <Link className={`${statusStyles.button} ${statusStyles.primary}`} to="/">
          Escolher outra sala
        </Link>
      </StatusScreen>
    );
  }

  // Sem nome salvo não dá para entrar: volta para a entrada com a sala pronta.
  if (displayName === '') {
    return <Navigate to={`/?sala=${encodeURIComponent(roomId)}`} replace />;
  }

  /*
   * O paradigma escolhido na entrada decide QUAL sala abrir. São duas pilhas
   * diferentes — uma fala com o SFU, a outra direto entre navegadores —, e a
   * troca acontece aqui, uma vez, em vez de cada componente lá dentro ter que
   * saber em qual modo está.
   */
  const transport = readTransport();
  if (transport === 'p2p') {
    return (
      <P2PRoom
        roomId={roomId}
        displayName={displayName}
        peerId={peerId}
        onLeave={() => navigate('/')}
      />
    );
  }

  if (transport === 'cfsfu') {
    return (
      <CloudflareRoom
        roomId={roomId}
        displayName={displayName}
        peerId={peerId}
        onLeave={() => navigate('/')}
      />
    );
  }

  if (transport === 'vercel-relay') {
    // O pipeline WebCodecs+relay ainda está em construção. Em vez de fingir uma
    // sala que não transmite, a tela diz a verdade e oferece a saída — sem
    // apagar a escolha nem quebrar as outras três.
    return (
      <StatusScreen
        title="Vercel Relay em construção"
        message="Esta quarta opção usa WebCodecs e um relay na Vercel — o transporte de mídia ainda está sendo montado. Enquanto isso, escolha o Servidor, o Direto ou o Cloudflare."
      >
        <button
          type="button"
          className={`${statusStyles.button} ${statusStyles.primary}`}
          onClick={() => navigate('/')}
        >
          Escolher outro modo
        </button>
      </StatusScreen>
    );
  }

  return <RoomSession roomId={roomId} displayName={displayName} />;
}

type Phase = 'live' | 'left' | 'dropped' | 'failed';

function RoomSession({
  roomId,
  displayName,
}: {
  roomId: string;
  displayName: string;
}): JSX.Element {
  const { state, retry } = useToken(roomId, displayName);
  const [phase, setPhase] = useState<Phase>('live');
  const [failureMessage, setFailureMessage] = useState('');
  const leavingRef = useRef(false);
  const connectedRef = useRef(false);

  const rejoin = useCallback(() => {
    leavingRef.current = false;
    connectedRef.current = false;
    setFailureMessage('');
    setPhase('live');
    retry();
  }, [retry]);

  if (phase === 'left') {
    return (
      <StatusScreen title="Você saiu da sala" message={`Sala: ${roomId}`}>
        <button type="button" className={`${statusStyles.button} ${statusStyles.primary}`} onClick={rejoin}>
          Entrar de novo
        </button>
        <Link className={statusStyles.button} to="/">
          Início
        </Link>
      </StatusScreen>
    );
  }

  if (phase === 'dropped') {
    return (
      <StatusScreen
        variant="error"
        title="Conexão encerrada"
        message="Você foi desconectado da sala. Isso acontece se a rede cair ou se o servidor encerrar a sessão."
      >
        <button type="button" className={`${statusStyles.button} ${statusStyles.primary}`} onClick={rejoin}>
          Reconectar
        </button>
        <Link className={statusStyles.button} to="/">
          Início
        </Link>
      </StatusScreen>
    );
  }

  if (phase === 'failed') {
    return (
      <StatusScreen
        variant="error"
        title="Erro de conexão"
        message={
          failureMessage === ''
            ? 'Não foi possível conectar ao servidor de mídia.'
            : failureMessage
        }
      >
        <button type="button" className={`${statusStyles.button} ${statusStyles.primary}`} onClick={rejoin}>
          Tentar de novo
        </button>
        <Link className={statusStyles.button} to="/">
          Início
        </Link>
      </StatusScreen>
    );
  }

  if (state.status === 'loading') {
    return <StatusScreen loading title="Entrando na sala…" message={`Obtendo acesso a ${roomId}.`} />;
  }

  if (state.status === 'error') {
    return (
      <StatusScreen variant="error" title="Não foi possível entrar" message={state.message}>
        <button type="button" className={`${statusStyles.button} ${statusStyles.primary}`} onClick={retry}>
          Tentar de novo
        </button>
        <Link className={statusStyles.button} to="/">
          Início
        </Link>
      </StatusScreen>
    );
  }

  return (
    <LiveKitRoom
      className={styles.room}
      serverUrl={LIVEKIT_URL}
      token={state.data.token}
      connect
      // Entrar sempre mutado: o microfone nem chega a ser publicado.
      audio={false}
      video={false}
      options={roomOptions}
      onConnected={() => {
        connectedRef.current = true;
      }}
      onDisconnected={() => {
        // Desconexão antes de a sessão existir não é queda: é o ciclo de
        // montagem (StrictMode remonta os efeitos em dev). Falha real de
        // conexão chega por onError.
        if (!connectedRef.current) {
          return;
        }
        setPhase(leavingRef.current ? 'left' : 'dropped');
      }}
      onError={(error: Error) => {
        setFailureMessage(error.message);
        setPhase('failed');
      }}
    >
      <RoomShell
        roomId={roomId}
        onLeaveIntent={() => {
          leavingRef.current = true;
        }}
      />
    </LiveKitRoom>
  );
}
