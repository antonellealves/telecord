import { useCallback, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { validatePassword } from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { AuthError, resetPassword } from '../lib/auth';
import styles from './LoginPage.module.css';

/** Destino do link de "esqueci a senha". O token vem na URL e é de uso único. */
export function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);

      const passwordError = validatePassword(password);
      if (passwordError !== null) {
        setError(passwordError);
        return;
      }
      if (password !== confirmation) {
        setError('As duas senhas não são iguais.');
        return;
      }

      setBusy(true);
      try {
        await resetPassword(token, password);
        setDone(true);
      } catch (failure) {
        setError(
          failure instanceof AuthError ? failure.message : 'Não deu para falar com o servidor.',
        );
      } finally {
        setBusy(false);
      }
    },
    [token, password, confirmation],
  );

  if (token === '') {
    return (
      <>
        <AmbientGradient />
        <div className={styles.page}>
          <div className={styles.card}>
            <h1 className={styles.title}>Link incompleto</h1>
            <p className={styles.message}>
              Abra o link direto do e-mail, sem copiar só um pedaço dele.
            </p>
            <Link className={styles.secondary} to="/entrar">
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
          <h1 className={styles.title}>Nova senha</h1>

          {done ? (
            <>
              <p className={styles.message}>
                Senha trocada. Todas as sessões anteriores foram encerradas — inclusive as de quem
                tivesse entrado com a senha antiga.
              </p>
              <button
                type="button"
                className={styles.submit}
                onClick={() => navigate('/entrar', { replace: true })}
              >
                Entrar
              </button>
            </>
          ) : (
            <form className={styles.form} onSubmit={submit} noValidate>
              <label className={styles.field}>
                <span className={styles.label}>Senha nova</span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <span className={styles.hint}>Pelo menos 10 caracteres.</span>
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Repita a senha</span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                />
              </label>

              {error !== null ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}

              <button type="submit" className={styles.submit} disabled={busy}>
                {busy ? 'Trocando…' : 'Trocar a senha'}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
