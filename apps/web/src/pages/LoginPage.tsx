import { useCallback, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { validateDisplayName, validateEmail, validatePassword } from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { GoogleMark } from '../components/icons';
import { useAuth } from '../hooks/useAuth';
import { AuthError, forgotPassword, startGoogleLogin } from '../lib/auth';
import styles from './LoginPage.module.css';

type Mode = 'entrar' | 'criar' | 'esqueci';

/** Códigos que o callback do Google devolve na URL, traduzidos. */
const REDIRECT_ERRORS: Record<string, string> = {
  google_cancelado: 'Login com o Google cancelado.',
  google_desligado: 'Login com o Google não está disponível agora.',
  google_disabled: 'Login com o Google não está configurado neste servidor.',
  link_requires_verification:
    'Já existe uma conta com este e-mail que ainda não foi confirmada. Confirme o e-mail dessa conta antes de entrar com o Google.',
  email_not_verified: 'Sua conta Google não tem o e-mail confirmado.',
  invalid_state: 'A tentativa de login expirou. Tente de novo.',
  link_invalido: 'Esse link é inválido ou já expirou.',
  google_falhou: 'Não deu para entrar com o Google. Tente de novo.',
};

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signIn, signUp, providers, enabled } = useAuth();

  const [mode, setMode] = useState<Mode>('entrar');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get('erro');
    return code === null ? null : (REDIRECT_ERRORS[code] ?? 'Não deu para entrar.');
  });
  const [notice, setNotice] = useState<string | null>(() =>
    searchParams.get('verificado') === '1' ? 'E-mail confirmado. Pode entrar.' : null,
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setNotice(null);

      const emailError = validateEmail(email);
      if (emailError !== null) {
        setError(emailError);
        return;
      }
      if (mode !== 'esqueci') {
        const passwordError = validatePassword(password);
        if (passwordError !== null) {
          setError(passwordError);
          return;
        }
      }
      if (mode === 'criar') {
        const nameError = validateDisplayName(displayName);
        if (nameError !== null) {
          setError(nameError);
          return;
        }
      }

      setBusy(true);
      try {
        if (mode === 'entrar') {
          await signIn(email, password);
          navigate('/');
        } else if (mode === 'criar') {
          await signUp(email, password, displayName);
          navigate('/');
        } else {
          await forgotPassword(email);
          // Sempre a mesma mensagem, exista a conta ou não: qualquer diferença
          // aqui vira jeito de descobrir quem tem conta.
          setNotice('Se existir conta com esse e-mail, o link de troca de senha já saiu.');
        }
      } catch (failure) {
        setError(
          failure instanceof AuthError ? failure.message : 'Não deu para falar com o servidor.',
        );
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, displayName, signIn, signUp, navigate],
  );

  if (!enabled) {
    return (
      <>
        <AmbientGradient />
        <div className={styles.page}>
          <div className={styles.card}>
            <h1 className={styles.title}>Entrar</h1>
            <p className={styles.message}>
              Este servidor não tem contas configuradas. Você pode entrar numa sala sem conta.
            </p>
            <Link className={styles.secondary} to="/">
              Voltar
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <AmbientGradient />
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>
            {mode === 'entrar' ? 'Entrar' : mode === 'criar' ? 'Criar conta' : 'Esqueci a senha'}
          </h1>
          <p className={styles.lead}>
            Conta é opcional no telecord — serve para o seu nome ser confirmado e ficar igual em
            toda sala. <Link to="/">Entrar sem conta</Link>.
          </p>

          {providers.google ? (
            <>
              <button type="button" className={styles.google} onClick={startGoogleLogin}>
                <GoogleMark />
                Continuar com o Google
              </button>
              <div className={styles.divider}>
                <span>ou</span>
              </div>
            </>
          ) : null}

          <form className={styles.form} onSubmit={submit} noValidate>
            <label className={styles.field}>
              <span className={styles.label}>E-mail</span>
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            {mode === 'criar' ? (
              <label className={styles.field}>
                <span className={styles.label}>Como aparecer na sala</span>
                <input
                  className={styles.input}
                  type="text"
                  autoComplete="nickname"
                  maxLength={32}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                />
              </label>
            ) : null}

            {mode !== 'esqueci' ? (
              <label className={styles.field}>
                <span className={styles.label}>Senha</span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete={mode === 'criar' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                {mode === 'criar' ? (
                  <span className={styles.hint}>Pelo menos 10 caracteres.</span>
                ) : null}
              </label>
            ) : null}

            {error !== null ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            {notice !== null ? <p className={styles.notice}>{notice}</p> : null}

            <button type="submit" className={styles.submit} disabled={busy}>
              {busy
                ? 'Um instante…'
                : mode === 'entrar'
                  ? 'Entrar'
                  : mode === 'criar'
                    ? 'Criar conta'
                    : 'Mandar link'}
            </button>
          </form>

          <div className={styles.switcher}>
            {mode === 'entrar' ? (
              <>
                <button type="button" onClick={() => setMode('criar')}>
                  Criar uma conta
                </button>
                <button type="button" onClick={() => setMode('esqueci')}>
                  Esqueci a senha
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setMode('entrar')}>
                Já tenho conta
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
