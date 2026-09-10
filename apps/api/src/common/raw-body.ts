import type { IncomingMessage } from 'node:http';

/**
 * Leitura dos bytes CRUS da requisição, sob qualquer um dos runtimes.
 *
 * Existe porque duas rotas precisam do corpo exatamente como veio, e não do
 * objeto que um parser produziu:
 *
 *  - o webhook do LiveKit assina o SHA-256 do corpo, e reserializar o JSON
 *    muda um espaço em branco e invalida a assinatura;
 *  - o envio de som são os bytes do arquivo, e passá-los por JSON custaria um
 *    terço a mais de tamanho para chegar no mesmo lugar.
 *
 * O problema é que "o corpo" chega de formas diferentes dependendo de quem
 * está na frente. O processo em Docker entrega o stream intacto; o runtime da
 * Vercel pode já ter consumido e deixado um `Buffer` em `req.body`; e o parser
 * do Nest, quando reconhece o content-type, deixa um `Buffer` em `req.rawBody`.
 * Esta função tenta as três fontes na ordem.
 *
 * Quando o corpo já virou objeto, os bytes originais não existem mais em lugar
 * nenhum — e aí ela FALHA, em vez de reserializar. Reserializar produziria uma
 * assinatura que confere por acidente ou não confere por acidente, e nenhum dos
 * dois é uma verificação.
 */

export class BodyTooLargeError extends Error {}
export class RawBodyUnavailableError extends Error {}

type MaybeParsed = IncomingMessage & { body?: unknown; rawBody?: unknown };

export async function readRawBody(request: MaybeParsed, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Corta antes de ler um byte: aceitar o upload inteiro para depois
    // recusá-lo é pagar a banda de quem está abusando.
    throw new BodyTooLargeError();
  }

  const preRead = pickBuffer(request.rawBody) ?? pickBuffer(request.body);
  if (preRead !== null) {
    if (preRead.byteLength > maxBytes) throw new BodyTooLargeError();
    return preRead;
  }

  if (request.readableEnded || request.readable === false) {
    // Alguém já consumiu o stream e não deixou os bytes em lugar acessível.
    throw new RawBodyUnavailableError();
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function pickBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    // `{}` é o que o parser de JSON do Express deixa num corpo vazio; um
    // Buffer vazio é um corpo vazio de verdade, e ambos são inúteis aqui.
    return value.byteLength === 0 ? null : value;
  }
  if (typeof value === 'string' && value !== '') {
    return Buffer.from(value, 'utf8');
  }
  return null;
}
