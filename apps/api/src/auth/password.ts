import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/*
 * Embrulho à mão em vez de `promisify`: o `promisify` casa com a sobrecarga de
 * três argumentos e perde a que aceita parâmetros de custo — que são
 * exatamente o que importa aqui.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });
}

/*
 * scrypt do `node:crypto`, não argon2id.
 *
 * argon2id seria a primeira escolha, mas as bibliotecas de Node são binários
 * nativos, e o repo inteiro é montado para não ter build nativo — a função da
 * Vercel foi tipada com `node:http` só para não puxar `@vercel/node`. scrypt é
 * KDF de memória dura (RFC 7914), vem embutido no runtime e custa zero
 * dependência. O formato guardado carrega os parâmetros, então trocar para
 * argon2 depois é ler o prefixo e reescrever no login seguinte.
 *
 * N=2^16 com r=8 pede ~64 MiB por verificação: caro para quem tenta força
 * bruta em GPU, tolerável num processo que atende login.
 */
const N = 2 ** 16;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** O padrão do Node é 32 MiB e estouraria com este N. */
const MAX_MEM = 192 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
/*
 * Teto porque scrypt processa a senha inteira: sem limite, um POST com um
 * megabyte de senha vira negação de serviço barata.
 */
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Comparação em tempo constante, e sempre com os parâmetros GUARDADOS, não com
 * os atuais: subir o custo depois não pode invalidar a senha de quem já tinha
 * conta.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const cost = Number(rawN);
  const blockSize = Number(rawR);
  const parallel = Number(rawP);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallel)) {
    return false;
  }

  const expected = Buffer.from(rawHash, 'base64');
  let derived: Buffer;
  try {
    derived = await scrypt(password, Buffer.from(rawSalt, 'base64'), expected.length, {
      N: cost,
      r: blockSize,
      p: parallel,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Consome o mesmo tempo de uma verificação real, para responder a e-mail
 * inexistente. Sem isso o tempo de resposta diz quais e-mails têm conta, e o
 * texto genérico da mensagem não adianta nada.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await scrypt('senha-que-nao-existe', randomBytes(SALT_BYTES), KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });
}
