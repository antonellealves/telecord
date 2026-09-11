import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, User } from '../generated/prisma';
import {
  normalizeDisplayName,
  normalizeEmail,
  type AuthSessionResponse,
  type AuthUser,
} from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, forbidden, serviceUnavailable, unauthorized } from '../common/errors';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { decideAccountLink } from './account-linking';
import { buildAuthorizeUrl, createPkcePair, createState, exchangeCode } from './google';
import { fakeVerifyDelay, hashPassword, verifyPassword } from './password';
import { generateRefreshToken, hashOpaqueToken, signAccessToken } from './tokens';

export interface ClientInfo {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface IssuedSession {
  response: AuthSessionResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** Mesmo texto para senha errada e e-mail inexistente: a diferença enumeraria contas. */
const GENERIC_LOGIN_ERROR = 'E-mail ou senha incorretos.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Sessão
  // -------------------------------------------------------------------------

  private toAuthUser(user: User): AuthUser {
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  }

  /**
   * Emite o par access + refresh, guardando só o hash do refresh.
   *
   * `replacedById` nasce nulo; quem preenche é a rotação em `refresh()`, e é
   * esse encadeamento que permite detectar reuso depois.
   */
  private async issueSession(user: User, client: ClientInfo): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt: refreshExpiresAt,
        ip: client.ip?.slice(0, 45) ?? null,
        userAgent: client.userAgent?.slice(0, 255) ?? null,
      },
    });

    const accessToken = await signAccessToken(
      this.config.jwtPrivateKey,
      this.config.accessTtlSeconds,
      { userId: user.id, role: user.role, displayName: user.displayName },
    );

    return {
      response: {
        user: this.toAuthUser(user),
        accessToken,
        expiresIn: this.config.accessTtlSeconds,
      },
      refreshToken,
      refreshExpiresAt,
    };
  }

  /** Conta suspensa ou banida não abre sessão, e perde as que já tinha. */
  private async assertUsable(user: User): Promise<void> {
    if (user.deletedAt !== null) {
      throw unauthorized('unauthorized', GENERIC_LOGIN_ERROR);
    }
    if (user.status !== 'ACTIVE') {
      await this.revokeAllFor(user.id);
      throw forbidden('account_blocked', 'Esta conta está bloqueada.');
    }
  }

  private async revokeAllFor(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Cadastro e login por senha
  // -------------------------------------------------------------------------

  /**
   * Nome de usuário derivado do e-mail, com sufixo aleatório na colisão.
   *
   * Aleatório e não sequencial: `joao-2` diz que existe um `joao`, e varrer
   * `joao-1..joao-9` mapearia quem tem conta.
   */
  private async uniqueUsername(seed: string): Promise<string> {
    const base =
      seed
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || 'pessoa';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      const taken = await this.prisma.user.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (taken === null) return candidate;
    }
    return `${base}-${randomBytes(8).toString('hex')}`;
  }

  /**
   * Cria usuário e `UserSettings` na mesma transação.
   *
   * Juntos porque metade do cadastro é pior que nenhum: usuário sem settings
   * quebraria toda leitura de preferência depois, num caminho que ninguém
   * testa. O documento pede que settings nunca seja nulo — a transação é o que
   * garante isso, não a boa vontade de quem chama.
   */
  private async createUser(
    tx: Prisma.TransactionClient,
    data: {
      email: string;
      username: string;
      displayName: string;
      passwordHash: string | null;
      avatarUrl: string | null;
      emailVerifiedAt: Date | null;
    },
  ): Promise<User> {
    const user = await tx.user.create({ data });
    await tx.userSettings.create({ data: { userId: user.id } });
    return user;
  }

  async register(
    input: { email: string; password: string; displayName: string },
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing !== null) {
      /*
       * Não dá para responder "e-mail já cadastrado": isso confirma a conta
       * para quem estiver sondando. O caminho honesto é avisar o DONO do
       * endereço, que é quem tem a caixa — quem sonda não aprende nada, e o
       * texto devolvido é o mesmo do cadastro que deu certo.
       */
      await this.mail.send({
        to: email,
        subject: 'Tentativa de cadastro no Telecord',
        text:
          'Alguém tentou criar uma conta no Telecord com este e-mail, que já tem conta.\n' +
          'Se foi você, entre normalmente ou use "esqueci a senha".\n' +
          'Se não foi, pode ignorar: nada mudou na sua conta.',
      });
      throw badRequest(
        'registration_pending',
        'Se este e-mail estiver livre, a conta foi criada. Confira a caixa de entrada.',
      );
    }

    const passwordHash = await hashPassword(input.password);
    const username = await this.uniqueUsername(email.split('@')[0] ?? 'pessoa');

    const user = await this.prisma.$transaction((tx) =>
      this.createUser(tx, {
        email,
        username,
        displayName,
        passwordHash,
        avatarUrl: null,
        // Nasce NÃO verificado. É essa marca que impede o Google de adotar a
        // conta depois (PLANO.md §3).
        emailVerifiedAt: null,
      }),
    );

    await this.sendEmailToken(user, 'VERIFY');
    return this.issueSession(user, client);
  }

  async login(
    input: { email: string; password: string },
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null || user.passwordHash === null || user.deletedAt !== null) {
      // Gasta o tempo de uma verificação real: sem isto a resposta rápida
      // denuncia que o e-mail não existe, e o texto genérico não adianta nada.
      await fakeVerifyDelay();
      throw unauthorized('invalid_credentials', GENERIC_LOGIN_ERROR);
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw unauthorized('invalid_credentials', GENERIC_LOGIN_ERROR);
    }

    await this.assertUsable(user);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });
    return this.issueSession(user, client);
  }

  // -------------------------------------------------------------------------
  // Tokens de e-mail (verificação e reset)
  // -------------------------------------------------------------------------

  private async sendEmailToken(user: User, purpose: 'VERIFY' | 'RESET'): Promise<void> {
    const token = generateRefreshToken();
    const ttl = purpose === 'VERIFY' ? VERIFY_TTL_MS : RESET_TTL_MS;

    await this.prisma.emailToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(token),
        purpose,
        expiresAt: new Date(Date.now() + ttl),
      },
    });

    const link =
      purpose === 'VERIFY'
        ? `${this.config.apiUrl}/auth/verify?token=${token}`
        : `${this.config.appUrl}/entrar/nova-senha?token=${token}`;

    await this.mail.send({
      to: user.email,
      subject: purpose === 'VERIFY' ? 'Confirme seu e-mail no Telecord' : 'Redefinir sua senha',
      text:
        purpose === 'VERIFY'
          ? `Confirme seu e-mail abrindo este link:\n\n${link}\n\nO link vale por 24 horas.`
          : `Para escolher uma senha nova, abra:\n\n${link}\n\nO link vale por 1 hora.\nSe não foi você, ignore: nada muda sem abrir o link.`,
    });
  }

  /**
   * Consome um token de e-mail. Uso único e com validade — link de reset que
   * continua valendo depois de usado é chave esquecida na fechadura.
   */
  private async consumeEmailToken(token: string, purpose: 'VERIFY' | 'RESET'): Promise<User> {
    const record = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { user: true },
    });

    if (
      record === null ||
      record.purpose !== purpose ||
      record.usedAt !== null ||
      record.expiresAt.getTime() < Date.now()
    ) {
      throw badRequest('invalid_token', 'Este link é inválido ou já expirou.');
    }

    await this.prisma.emailToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    return record.user;
  }

  async verifyEmail(token: string): Promise<void> {
    const user = await this.consumeEmailToken(token, 'VERIFY');
    if (user.emailVerifiedAt === null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    // Silêncio proposital quando não existe: responder diferente aqui é a forma
    // mais fácil de enumerar as contas do sistema inteiro.
    if (user !== null && user.deletedAt === null && user.status === 'ACTIVE') {
      await this.sendEmailToken(user, 'RESET');
    }
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const user = await this.consumeEmailToken(token, 'RESET');
    const passwordHash = await hashPassword(password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          /*
           * Abrir o link prova posse da caixa, então o e-mail passa a valer
           * como verificado. É também o que destrava a vinculação com o Google
           * para quem se cadastrou por senha e nunca confirmou.
           */
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      // Trocar a senha derruba toda sessão viva: se a troca foi por suspeita de
      // invasão, deixar o invasor logado esvazia o gesto.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  private googleRedirectUri(): string {
    return `${this.config.apiUrl}/auth/google/callback`;
  }

  /** Para onde mandar a pessoa, e o que guardar no cookie de ida e volta. */
  startGoogle(): { url: string; cookie: string } {
    if (this.config.google === null) {
      throw serviceUnavailable('google_disabled', 'Login com Google não está configurado.');
    }
    const state = createState();
    const { verifier, challenge } = createPkcePair();
    return {
      url: buildAuthorizeUrl({
        config: this.config.google,
        redirectUri: this.googleRedirectUri(),
        state,
        challenge,
      }),
      cookie: `${state}.${verifier}`,
    };
  }

  async finishGoogle(
    input: { code: string; state: string; cookie: string | undefined },
    client: ClientInfo,
  ): Promise<IssuedSession> {
    if (this.config.google === null) {
      throw serviceUnavailable('google_disabled', 'Login com Google não está configurado.');
    }

    const [expectedState, verifier] = (input.cookie ?? '').split('.');
    if (
      expectedState === undefined ||
      verifier === undefined ||
      expectedState === '' ||
      expectedState !== input.state
    ) {
      // Sem o cookie que ESTE navegador recebeu, o callback aceitaria um código
      // obtido em outro lugar — que é como se força login numa conta alheia.
      throw badRequest('invalid_state', 'Sessão de login expirada. Tente de novo.');
    }

    const identity = await exchangeCode({
      config: this.config.google,
      redirectUri: this.googleRedirectUri(),
      code: input.code,
      verifier,
    });

    const user = await this.resolveGoogleUser(identity);
    await this.assertUsable(user);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });
    return this.issueSession(user, client);
  }

  /**
   * Encontra ou cria a conta do login social.
   *
   * Quem decide é `decideAccountLink`, que está isolada como função pura: é a
   * peça mais perigosa da autenticação e a única que não dá para exercitar sem
   * credencial do Google. Aqui ficam só as consultas e a escrita.
   */
  private async resolveGoogleUser(identity: {
    providerAccountId: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
    picture: string | null;
  }): Promise<User> {
    const linked = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: 'google',
          providerAccountId: identity.providerAccountId,
        },
      },
      include: { user: true },
    });

    const byEmail =
      linked === null
        ? await this.prisma.user.findUnique({ where: { email: identity.email } })
        : null;

    const decision = decideAccountLink({
      hasLinkedAccount: linked !== null,
      existingUser:
        byEmail === null
          ? null
          : { emailVerified: byEmail.emailVerifiedAt !== null, deleted: byEmail.deletedAt !== null },
      providerEmailVerified: identity.emailVerified,
    });

    switch (decision.kind) {
      case 'usar-vinculada':
        // `linked` não é nulo: é o que fez a decisão sair assim.
        return (linked as NonNullable<typeof linked>).user;

      case 'vincular-existente': {
        const user = byEmail as NonNullable<typeof byEmail>;
        await this.prisma.oAuthAccount.create({
          data: {
            userId: user.id,
            provider: 'google',
            providerAccountId: identity.providerAccountId,
          },
        });
        return user;
      }

      case 'recusar':
        throw decision.reason === 'conta-nao-confirmada'
          ? badRequest(
              'link_requires_verification',
              'Já existe uma conta com este e-mail que ainda não foi confirmada. ' +
                'Confirme o e-mail dessa conta — ou use "esqueci a senha" — antes de entrar com o Google.',
            )
          : badRequest('email_not_verified', 'Sua conta Google não tem o e-mail confirmado.');

      case 'criar': {
        const displayName = normalizeDisplayName(
          identity.name ?? identity.email.split('@')[0] ?? '',
        );
        const username = await this.uniqueUsername(identity.email.split('@')[0] ?? 'pessoa');

        return this.prisma.$transaction(async (tx) => {
          const created = await this.createUser(tx, {
            email: identity.email,
            username,
            displayName: displayName === '' ? username : displayName,
            passwordHash: null,
            avatarUrl: identity.picture,
            emailVerifiedAt: new Date(),
          });
          await tx.oAuthAccount.create({
            data: {
              userId: created.id,
              provider: 'google',
              providerAccountId: identity.providerAccountId,
            },
          });
          return created;
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rotação e encerramento
  // -------------------------------------------------------------------------

  /**
   * Rotaciona o refresh: cada uso queima o token e emite outro.
   *
   * Reapresentar um token JÁ substituído significa cópia em circulação — ou o
   * dono ficou com uma cópia velha, ou alguém roubou. Não dá para distinguir,
   * então a família inteira cai e todo mundo refaz login. É a detecção de reuso
   * do BCP de OAuth 2.0, e é o que limita o estrago de um refresh vazado.
   */
  async refresh(rawToken: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    if (rawToken === undefined || rawToken === '') {
      throw unauthorized('no_session', 'Sem sessão.');
    }

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(rawToken) },
      include: { user: true },
    });
    if (record === null) {
      throw unauthorized('invalid_session', 'Sessão inválida.');
    }

    if (record.replacedById !== null || record.revokedAt !== null) {
      this.logger.warn(`reuso de refresh token do usuário ${record.userId}: família revogada`);
      await this.revokeAllFor(record.userId);
      throw unauthorized(
        'session_reused',
        'Sua sessão foi encerrada por segurança. Entre de novo.',
      );
    }

    if (record.expiresAt.getTime() < Date.now()) {
      throw unauthorized('session_expired', 'Sessão expirada. Entre de novo.');
    }

    await this.assertUsable(record.user);

    const issued = await this.issueSession(record.user, client);
    const replacement = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(issued.refreshToken) },
      select: { id: true },
    });
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedById: replacement?.id ?? null },
    });
    return issued;
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken === undefined || rawToken === '') return;
    // `updateMany` e não `update`: token desconhecido não pode virar 404 no
    // logout. Sair sempre "funciona".
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashOpaqueToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (user === null) {
      throw unauthorized('unauthorized', 'Sessão inválida.');
    }
    return this.toAuthUser(user);
  }

  /** Quais provedores estão utilizáveis. O cliente esconde o botão do que não está. */
  availableProviders(): { password: boolean; google: boolean } {
    return { password: true, google: this.config.google !== null };
  }
}
