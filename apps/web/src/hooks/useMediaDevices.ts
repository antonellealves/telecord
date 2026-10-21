import { useCallback, useEffect, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { Room, RoomEvent, supportsAudioOutputSelection } from 'livekit-client';
import { describeMicrophoneError } from '../lib/errors';
import {
  readEchoCancellation,
  readNoiseSuppression,
  readPreferredDevice,
  writeEchoCancellation,
  writeNoiseSuppression,
  writePreferredDevice,
} from '../lib/storage';
import { SYSTEM_DEFAULT_DEVICE, selectedInputOption } from '../lib/voice/inputDevice';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDeviceSettings {
  audioInputs: DeviceOption[];
  audioOutputs: DeviceOption[];
  videoInputs: DeviceOption[];
  activeAudioInput: string;
  activeAudioOutput: string;
  activeVideoInput: string;
  /** Firefox e Safari não expõem escolha de saída de áudio. */
  outputSelectionSupported: boolean;
  /** O navegador só revela os nomes depois da permissão de microfone. */
  labelsHidden: boolean;
  isSwitching: boolean;
  noiseSuppression: boolean;
  setNoiseSuppression: (enabled: boolean) => void;
  echoCancellation: boolean;
  setEchoCancellation: (enabled: boolean) => void;
  selectAudioInput: (deviceId: string) => void;
  selectAudioOutput: (deviceId: string) => void;
  selectVideoInput: (deviceId: string) => void;
  revealLabels: () => void;
}

const DEFAULT_DEVICE = 'default';

function toOptions(devices: MediaDeviceInfo[], fallbackLabel: string): DeviceOption[] {
  return devices
    .filter((device) => device.deviceId !== '')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label !== '' ? device.label : `${fallbackLabel} ${index + 1}`,
    }));
}

/**
 * Microfones, sempre com a opção "Padrão do sistema" no topo.
 *
 * O Chrome já lista uma entrada `default` ("Padrão - Microfone X"); Firefox e
 * Safari não. Escolher o padrão NÃO abre `default`: a sala resolve o aparelho
 * por trás dele e abre pelo id exato (`resolveInputDevice`).
 */
function inputOptions(devices: MediaDeviceInfo[]): DeviceOption[] {
  const options = toOptions(devices, 'Microfone').filter((device) => device.deviceId !== 'communications');
  if (options.length === 0 || options.some((device) => device.deviceId === SYSTEM_DEFAULT_DEVICE)) return options;
  return [{ deviceId: SYSTEM_DEFAULT_DEVICE, label: 'Padrão do sistema' }, ...options];
}

/**
 * Escolha de dispositivo de áudio.
 *
 * `switchActiveDevice` guarda a preferência no Room mesmo antes de existir
 * track publicada, então dá para escolher o microfone estando mutado: a
 * escolha vale na hora em que o microfone for ligado.
 *
 * Os rótulos ficam vazios enquanto não houver permissão de microfone — é
 * proteção do navegador contra fingerprinting. Como o app entra mutado de
 * propósito, isso é o estado normal na chegada, e não um erro: o painel
 * oferece revelar os nomes em vez de pedir permissão por conta própria.
 */
export function useMediaDevices(onError: (message: string) => void): MediaDeviceSettings {
  /*
   * `useMaybeRoomContext`, e não `useRoomContext`.
   *
   * Este painel também abre na sala do MODO DIRETO, que não tem contexto de
   * LiveKit nenhum — e `useRoomContext` LANÇA fora dele, derrubando a página
   * inteira ao abrir Configurações. Sem sala, o hook ainda lista e escolhe
   * dispositivos pela API do navegador; o que ele perde é só espelhar a
   * escolha no SFU, que ali não existe.
   */
  const room = useMaybeRoomContext();
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<DeviceOption[]>([]);
  const [activeAudioInput, setActiveAudioInput] = useState(() => selectedInputOption(readPreferredDevice('audioinput')));
  const [activeAudioOutput, setActiveAudioOutput] = useState(DEFAULT_DEVICE);
  const [activeVideoInput, setActiveVideoInput] = useState(DEFAULT_DEVICE);
  const [labelsHidden, setLabelsHidden] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [noiseSuppression, setNoiseSuppressionState] = useState(() => readNoiseSuppression());
  const [echoCancellation, setEchoCancellationState] = useState(() => readEchoCancellation());

  const outputSelectionSupported = supportsAudioOutputSelection();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /** A restauração da preferência só acontece uma vez por sessão de sala. */
  const restoredRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const inputs = await Room.getLocalDevices('audioinput', false);
      const outputs = outputSelectionSupported
        ? await Room.getLocalDevices('audiooutput', false)
        : [];
      const cameras = await Room.getLocalDevices('videoinput', false);

      setAudioInputs(inputOptions(inputs));
      setAudioOutputs(toOptions(outputs, 'Saída de áudio'));
      setVideoInputs(toOptions(cameras, 'Câmera'));
      setLabelsHidden(inputs.length > 0 && inputs.every((device) => device.label === ''));
      if (room !== undefined) {
        setActiveAudioOutput(room.getActiveDevice('audiooutput') ?? DEFAULT_DEVICE);
        setActiveVideoInput(room.getActiveDevice('videoinput') ?? DEFAULT_DEVICE);
      }
    } catch {
      onErrorRef.current('Não foi possível listar os dispositivos de áudio deste navegador.');
    }
  }, [room, outputSelectionSupported]);

  useEffect(() => {
    void refresh();

    const handleDevicesChanged = (): void => {
      void refresh();
    };
    // O microfone mostra a ESCOLHA (inclusive "Padrão do sistema"), não o id
    // concreto que a sala resolveu a partir dela.
    const handleActiveChanged = (kind: MediaDeviceKind, deviceId: string): void => {
      if (kind === 'audiooutput') setActiveAudioOutput(deviceId);
      if (kind === 'videoinput') setActiveVideoInput(deviceId);
    };

    if (room === undefined) {
      navigator.mediaDevices?.addEventListener?.('devicechange', handleDevicesChanged);
      return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDevicesChanged);
    }
    room.on(RoomEvent.MediaDevicesChanged, handleDevicesChanged);
    room.on(RoomEvent.ActiveDeviceChanged, handleActiveChanged);
    return () => {
      room.off(RoomEvent.MediaDevicesChanged, handleDevicesChanged);
      room.off(RoomEvent.ActiveDeviceChanged, handleActiveChanged);
    };
  }, [room, refresh]);

  const select = useCallback(
    (kind: MediaDeviceKind, deviceId: string) => {
      if (isSwitching) {
        return;
      }
      /*
       * Sem sala (modo direto), a escolha vale localmente: o estado guarda o
       * dispositivo e as próximas capturas o usam. O que não acontece é o SFU
       * trocar a track publicada, porque não há SFU.
       */
      if (room === undefined) {
        if (kind === 'audioinput') setActiveAudioInput(deviceId);
        if (kind === 'audiooutput') setActiveAudioOutput(deviceId);
        if (kind === 'videoinput') setActiveVideoInput(deviceId);
        return;
      }

      setIsSwitching(true);
      void room
        .switchActiveDevice(kind, deviceId)
        .then((switched) => {
          if (!switched) {
            onErrorRef.current('O navegador recusou a troca de dispositivo.');
          }
        })
        .catch((error: unknown) => {
          onErrorRef.current(describeMicrophoneError(error));
        })
        .finally(() => {
          setIsSwitching(false);
          void refresh();
        });
    },
    [room, refresh, isSwitching],
  );

  /*
   * O microfone só grava a escolha. Quem troca a track no ar é a sala
   * (`useLiveKitVoicePipeline` ou `useMediasoupTalkControls`), ouvindo o
   * evento que `writePreferredDevice` dispara: resolve o id exato e faz
   * `replaceTrack`, sem renegociar. Um dono só, como na supressão de ruído.
   */
  const selectAudioInput = useCallback((deviceId: string) => {
    setActiveAudioInput(deviceId);
    writePreferredDevice('audioinput', deviceId);
  }, []);

  const selectAudioOutput = useCallback(
    (deviceId: string) => {
      writePreferredDevice('audiooutput', deviceId);
      select('audiooutput', deviceId);
    },
    [select],
  );

  const selectVideoInput = useCallback(
    (deviceId: string) => {
      writePreferredDevice('videoinput', deviceId);
      select('videoinput', deviceId);
    },
    [select],
  );

  /**
   * Restaura a saída de áudio escolhida da última vez (o microfone é
   * restaurado pela sala, sempre montada, e não por este painel).
   *
   * Só depois de enumerar, e só se o id ainda existir: fone desconectado deixa
   * uma preferência órfã, e tentar aplicá-la daria erro de dispositivo
   * inexistente em vez de cair no padrão do sistema, que é o certo.
   */
  useEffect(() => {
    if (restoredRef.current || audioInputs.length === 0) {
      return;
    }
    restoredRef.current = true;

    const wantedOutput = readPreferredDevice('audiooutput');
    if (outputSelectionSupported && wantedOutput !== '' && wantedOutput !== activeAudioOutput) {
      if (audioOutputs.some((device) => device.deviceId === wantedOutput)) {
        select('audiooutput', wantedOutput);
      }
    }
  }, [audioInputs, audioOutputs, activeAudioOutput, outputSelectionSupported, select]);

  /*
   * Só grava a preferência. Quem aplica no microfone é `useNoiseFilter`, na
   * sala LiveKit — ele decide entre o filtro de IA e o do navegador, e ter um
   * dono só evita os dois brigando pela mesma constraint.
   */
  const setNoiseSuppression = useCallback((enabled: boolean) => {
    setNoiseSuppressionState(enabled);
    writeNoiseSuppression(enabled);
  }, []);

  // Mesmo arranjo: só a preferência; `useNoiseFilter` é quem mexe na captura.
  const setEchoCancellation = useCallback((enabled: boolean) => {
    setEchoCancellationState(enabled);
    writeEchoCancellation(enabled);
  }, []);

  const revealLabels = useCallback(() => {
    void Room.getLocalDevices('audioinput', true)
      .then(() => refresh())
      .catch((error: unknown) => {
        onErrorRef.current(describeMicrophoneError(error));
      });
  }, [refresh]);

  return {
    audioInputs,
    audioOutputs,
    videoInputs,
    activeAudioInput,
    activeAudioOutput,
    activeVideoInput,
    outputSelectionSupported,
    labelsHidden,
    isSwitching,
    noiseSuppression,
    setNoiseSuppression,
    echoCancellation,
    setEchoCancellation,
    selectAudioInput,
    selectAudioOutput,
    selectVideoInput,
    revealLabels,
  };
}
