import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { LocalAudioTrack, Room, RoomEvent, Track, supportsAudioOutputSelection } from 'livekit-client';
import { describeMicrophoneError } from '../lib/errors';
import { readNoiseSuppression, writeNoiseSuppression } from '../lib/storage';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDeviceSettings {
  audioInputs: DeviceOption[];
  audioOutputs: DeviceOption[];
  activeAudioInput: string;
  activeAudioOutput: string;
  /** Firefox e Safari não expõem escolha de saída de áudio. */
  outputSelectionSupported: boolean;
  /** O navegador só revela os nomes depois da permissão de microfone. */
  labelsHidden: boolean;
  isSwitching: boolean;
  noiseSuppression: boolean;
  setNoiseSuppression: (enabled: boolean) => void;
  selectAudioInput: (deviceId: string) => void;
  selectAudioOutput: (deviceId: string) => void;
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
  const room = useRoomContext();
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [activeAudioInput, setActiveAudioInput] = useState(DEFAULT_DEVICE);
  const [activeAudioOutput, setActiveAudioOutput] = useState(DEFAULT_DEVICE);
  const [labelsHidden, setLabelsHidden] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [noiseSuppression, setNoiseSuppressionState] = useState(() => readNoiseSuppression());

  const outputSelectionSupported = supportsAudioOutputSelection();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const inputs = await Room.getLocalDevices('audioinput', false);
      const outputs = outputSelectionSupported
        ? await Room.getLocalDevices('audiooutput', false)
        : [];

      setAudioInputs(toOptions(inputs, 'Microfone'));
      setAudioOutputs(toOptions(outputs, 'Saída de áudio'));
      setLabelsHidden(inputs.length > 0 && inputs.every((device) => device.label === ''));
      setActiveAudioInput(room.getActiveDevice('audioinput') ?? DEFAULT_DEVICE);
      setActiveAudioOutput(room.getActiveDevice('audiooutput') ?? DEFAULT_DEVICE);
    } catch {
      onErrorRef.current('Não foi possível listar os dispositivos de áudio deste navegador.');
    }
  }, [room, outputSelectionSupported]);

  useEffect(() => {
    void refresh();

    const handleDevicesChanged = (): void => {
      void refresh();
    };
    const handleActiveChanged = (kind: MediaDeviceKind, deviceId: string): void => {
      if (kind === 'audioinput') setActiveAudioInput(deviceId);
      if (kind === 'audiooutput') setActiveAudioOutput(deviceId);
    };

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

  const selectAudioInput = useCallback((deviceId: string) => select('audioinput', deviceId), [select]);
  const selectAudioOutput = useCallback((deviceId: string) => select('audiooutput', deviceId), [select]);

  /**
   * Supressão de ruído.
   *
   * Duas frentes, porque o ajuste precisa valer nos dois momentos: os defaults
   * do Room governam a PRÓXIMA publicação (o app entra mutado, então quase
   * sempre é esse o caso), e `restartTrack` reabre a captura quando já existe
   * microfone no ar. Só o primeiro deixaria a mudança sem efeito para quem já
   * está falando.
   */
  const setNoiseSuppression = useCallback(
    (enabled: boolean) => {
      setNoiseSuppressionState(enabled);
      writeNoiseSuppression(enabled);

      const defaults = {
        ...room.options.audioCaptureDefaults,
        noiseSuppression: enabled,
      };
      room.options.audioCaptureDefaults = defaults;

      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
      if (track instanceof LocalAudioTrack) {
        void track.restartTrack(defaults).catch((error: unknown) => {
          onErrorRef.current(describeMicrophoneError(error));
        });
      }
    },
    [room],
  );

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
    activeAudioInput,
    activeAudioOutput,
    outputSelectionSupported,
    labelsHidden,
    isSwitching,
    noiseSuppression,
    setNoiseSuppression,
    selectAudioInput,
    selectAudioOutput,
    revealLabels,
  };
}
