/**
 * Teto para `connection.publish` (produce) resolver. Sem isto, um ICE/DTLS
 * que nunca fecha (rede ruim, TURN inacessível) deixa a promise de
 * `transport.produce()` pendurada pra sempre — e como quem chama só limpa o
 * estado de "ocupado" no `.finally()`, o botão (mic, câmera ou compartilhar
 * tela) ficava desabilitado PARA SEMPRE, sem erro nenhum na tela.
 * `msProduce`/`msConnectTransport` já têm timeout de 5s do lado do proxy
 * HTTP (ver `mediasoup-sfu.client.ts`), mas isso só cobre a chamada HTTP — o
 * handshake DTLS/ICE em si acontece fora dela, dentro do `mediasoup-client`,
 * sem teto próprio.
 */
export const PUBLISH_TIMEOUT_MS = 10_000;

export function withPublishTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), PUBLISH_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
