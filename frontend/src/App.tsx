import { useEffect, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { Room } from './Room';
import { appBase, backendUrl, roomPath } from './config';
import type { Route } from './types';

function readRoute(): Route {
  const base = appBase || '';
  const path = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length)
    : window.location.pathname;
  const match = path.match(/^\/?sala\/([A-Za-z0-9]{6})\/?$/);
  return match ? { page: 'room', roomId: match[1].toUpperCase() } : { page: 'home' };
}

function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [roomInput, setRoomInput] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  async function createRoom() {
    setError('');
    setCreating(true);
    const socket = io(backendUrl || window.location.origin, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      timeout: 8000,
    });

    const timer = window.setTimeout(() => {
      socket.disconnect();
      setCreating(false);
      setError('Não foi possível conectar ao servidor. Tente novamente em instantes.');
    }, 10000);

    socket.once('connect', () => {
      socket.emit('room:create', {}, (result: { ok: boolean; roomId?: string; error?: string }) => {
        window.clearTimeout(timer);
        socket.disconnect();
        setCreating(false);
        if (!result.ok || !result.roomId) {
          setError(result.error || 'Não foi possível criar a sala.');
          return;
        }
        navigate(roomPath(result.roomId));
      });
    });
    socket.once('connect_error', () => {
      window.clearTimeout(timer);
      socket.disconnect();
      setCreating(false);
      setError('Servidor indisponível. Confira a conexão e tente novamente.');
    });
    socket.connect();
  }

  function enterRoom(event: FormEvent) {
    event.preventDefault();
    const roomId = roomInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      setError('Digite o código de 6 letras ou números que recebeu.');
      return;
    }
    navigate(roomPath(roomId));
  }

  if (route.page === 'room') {
    return <Room roomId={route.roomId} onHome={() => navigate(appBase || '/')} />;
  }

  return (
    <main className="home-shell">
      <div className="home-card">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>Compartilhe o que está vendo.</h1>
        <p className="home-copy">Crie uma sala e convide seus amigos por link. Sem cadastro e direto no navegador.</p>

        <button className="button button-primary create-button" onClick={createRoom} disabled={creating}>
          {creating ? <><span className="spinner" /> Criando sala…</> : 'Criar uma sala'}
        </button>

        <div className="divider"><span>ou entre com um convite</span></div>
        <form className="join-form" onSubmit={enterRoom}>
          <label htmlFor="room-code">Código da sala</label>
          <div className="join-row">
            <input
              id="room-code"
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value.toUpperCase().slice(0, 6))}
              placeholder="ABC123"
              maxLength={6}
              autoComplete="off"
              aria-describedby={error ? 'home-error' : undefined}
            />
            <button className="button button-secondary" type="submit">Entrar</button>
          </div>
        </form>
        {error && <p id="home-error" className="error-message" role="alert">{error}</p>}
        <p className="privacy-note"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3"/></svg> A tela é transmitida entre os navegadores e não é gravada.</p>
      </div>
      <footer className="home-footer">Compartilhamento ponto a ponto · até 20 pessoas por sala</footer>
    </main>
  );
}
