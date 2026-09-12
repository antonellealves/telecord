import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { IceConfig, IceServerConfig } from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';

/** Rótulo no usuário temporário, só para leitura humana nos logs do TURN. */
const TURN_USER_LABEL = 'telecord';

/**
 * Monta a lista de servidores de gelo para o modo direto.
 *
 * O STUN vai sempre; o TURN só quando configurado. Quando o TURN usa credencial
 * temporária (segredo compartilhado, formato REST do coturn), a credencial é
 * gerada AQUI, por requisição: `username = <expira>:telecord` e
 * `credential = base64(HMAC-SHA1(segredo, username))`. É o que permite entregar
 * TURN ao navegador sem colocar uma senha permanente num JavaScript público —
 * o que vaza expira sozinho em `ttlSeconds`.
 */
@Injectable()
export class IceService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  build(): IceConfig {
    const { stunUrls, turn } = this.config.ice;
    const iceServers: IceServerConfig[] = [];

    if (stunUrls.length > 0) {
      iceServers.push({ urls: stunUrls });
    }

    if (turn !== null) {
      if (turn.secret !== undefined) {
        const expiry = Math.floor(Date.now() / 1000) + turn.ttlSeconds;
        const username = `${expiry}:${TURN_USER_LABEL}`;
        const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
        iceServers.push({ urls: turn.urls, username, credential });
      } else if (turn.username !== undefined && turn.credential !== undefined) {
        iceServers.push({
          urls: turn.urls,
          username: turn.username,
          credential: turn.credential,
        });
      }
    }

    /*
     * TTL da resposta: com TURN temporário, o cliente precisa buscar de novo
     * antes de a credencial expirar — devolvemos metade do prazo para dar folga.
     * Sem TURN, a lista é estável (só STUN), e uma hora evita rebuscar à toa.
     */
    const ttlSeconds =
      turn?.secret !== undefined ? Math.max(60, Math.floor(turn.ttlSeconds / 2)) : 3600;

    return { iceServers, ttlSeconds };
  }
}
