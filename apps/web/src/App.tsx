import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { StatusScreen } from './components/StatusScreen';
import statusStyles from './components/StatusScreen.module.css';
import { AuthReturnPage } from './pages/AuthReturnPage';
import { JoinPage } from './pages/JoinPage';
import { LoginPage } from './pages/LoginPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { RoomPage } from './pages/RoomPage';

function NotFound(): JSX.Element {
  return (
    <StatusScreen title="Página não encontrada" message="Esse endereço não existe por aqui.">
      <Link className={`${statusStyles.button} ${statusStyles.primary}`} to="/">
        Ir para o início
      </Link>
    </StatusScreen>
  );
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<JoinPage />} />
        {/*
          * Rotas de conta. Nenhuma delas fica na frente da sala: entrar sem
          * conta continua sendo o caminho principal do produto.
          */}
        <Route path="/entrar" element={<LoginPage />} />
        <Route path="/entrar/retorno" element={<AuthReturnPage />} />
        <Route path="/entrar/nova-senha" element={<ResetPasswordPage />} />
        <Route path="/sala/:roomId" element={<RoomPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
