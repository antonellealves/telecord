/**
 * Qual endereço de um deployment da Vercel é o de produção — o que as pessoas
 * usam, e portanto o que o passo "Verifica o deploy" tem que testar.
 *
 * A resposta antiga era "o alias mais curto", lido no instante em que o
 * deployment ficava READY. Só que READY não quer dizer que os domínios já
 * foram atribuídos: a Vercel faz isso DEPOIS, um a um. Lida cedo demais, a
 * lista ainda não tem o domínio de produção, e o mais curto vira um endereço
 * gerado (`<projeto>-<conta>.vercel.app`), que a Deployment Protection cobre
 * com uma tela de login. Foi assim que a verificação reprovou um deploy que
 * estava no ar e funcionando: 401 e 302 em toda rota, do endereço errado.
 *
 * Por isso a escolha não confia só no nome: espera os domínios chegarem e
 * fica com o alias mais curto que RESPONDE sem a tela de login.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Atrás da proteção, a raiz responde 401 ou redireciona para o login da Vercel. */
export async function isPublic(host) {
  try {
    const res = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {{ alias?: string[], url: string, aliasAssigned?: unknown, aliasError?: unknown }} options.deployment
 *   O deployment como veio da API quando ficou READY.
 * @param {() => Promise<object | null>} options.refresh Busca o deployment de novo; `null` se a consulta falhar.
 * @returns {Promise<{ url: string, open: boolean }>} `open: false` quando nenhum alias respondeu sem a proteção.
 */
export async function pickProductionUrl({
  deployment,
  refresh,
  probe = isPublic,
  wait = sleep,
  now = Date.now,
  pollMs = 5_000,
  // A atribuição pode se dizer concluída antes de o domínio de produção
  // aparecer; este é o mínimo de insistência antes de desistir dele.
  minWaitMs = 60_000,
  timeoutMs = 3 * 60_000,
}) {
  const startedAt = now();
  let current = deployment;
  for (;;) {
    const aliases = (Array.isArray(current.alias) ? [...current.alias] : []).sort((a, b) => a.length - b.length);
    for (const alias of aliases) {
      if (await probe(alias)) return { url: `https://${alias}`, open: true };
    }

    const waited = now() - startedAt;
    const settled = Boolean(current.aliasAssigned) || Boolean(current.aliasError);
    if ((settled && waited >= minWaitMs) || waited >= timeoutMs) {
      // Nenhum endereço aberto: é o caso de um projeto com a proteção cobrindo
      // tudo, em que a verificação entra com o segredo de bypass. Vale o
      // critério antigo.
      return { url: `https://${aliases[0] ?? current.url}`, open: false };
    }

    await wait(pollMs);
    current = (await refresh()) ?? current;
  }
}
