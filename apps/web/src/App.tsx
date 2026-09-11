import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { StatusScreen } from './components/StatusScreen';
import statusStyles from './components/StatusScreen.module.css';
import { AdminPage } from './pages/AdminPage';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { AuthReturnPage } from './pages/AuthReturnPage';
import { ChannelPage } from './pages/ChannelPage';
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
        {/*
          * O painel. A rota existe para todo mundo e a própria tela decide o
          * que desenhar — quem não é administrador vê "sem acesso". Não é aqui
          * que o acesso é controlado: as rotas de `/api/admin` respondem 403
          * por conta própria, e é isso que vale.
          */}
        <Route path="/painel" element={<AdminPage />} />
        {/*
          * Canal: nome, salas dentro e membros. Não é sala, então não passa
          * pelo `LiveKitRoom` — é uma página comum, entrável mesmo sem
          * ninguém conectado a nada.
          */}
        {/*
          * Página que explica como o projeto é feito. Rota própria para poder
          * ser mandada a alguém — é conteúdo, não configuração.
          */}
        <Route path="/arquitetura" element={<ArchitecturePage />} />
        <Route path="/canal/:channelSlug" element={<ChannelPage />} />
        <Route path="/sala/:roomId" element={<RoomPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
