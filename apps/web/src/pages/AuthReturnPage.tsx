import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusScreen } from '../components/StatusScreen';
import statusStyles from '../components/StatusScreen.module.css';
import { useAuth } from '../hooks/useAuth';

/**
 * Aterrissagem do login com o Google.
 *
 * O callback do serviço manda o navegador para cá com o cookie de refresh já
 * gravado, e nada mais. O access token NÃO viaja pela URL de propósito:
 * endereço fica no histórico, vai no `Referer` e aparece no log de qualquer
 * proxy no caminho. Aqui a SPA troca o cookie por um access chamando
 * `/auth/refresh`, que é uma requisição comum.
 */
export function AuthReturnPage(): JSX.Element {
  const navigate = useNavigate();
  const { reload, status } = useAuth();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void reload().then(() => {
      if (cancelled) return;
      setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (status === 'autenticado') {
      // `replace` para o botão de voltar não trazer a pessoa de volta a esta
      // tela intermediária, que não tem o que mostrar duas vezes.
      navigate('/', { replace: true });
    }
  }, [status, navigate]);

  if (failed && status === 'anonimo') {
    return (
      <StatusScreen
        title="Não deu para entrar"
        message="O login não completou. Tente de novo — ou entre numa sala sem conta."
      >
        <Link className={`${statusStyles.button} ${statusStyles.primary}`} to="/entrar">
          Tentar de novo
        </Link>
        <Link className={statusStyles.button} to="/">
          Entrar sem conta
        </Link>
      </StatusScreen>
    );
  }

  return <StatusScreen title="Entrando…" message="Confirmando sua conta." />;
}
