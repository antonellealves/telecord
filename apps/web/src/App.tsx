import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { StatusScreen } from './components/StatusScreen';
import statusStyles from './components/StatusScreen.module.css';
import { JoinPage } from './pages/JoinPage';
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
        <Route path="/sala/:roomId" element={<RoomPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
