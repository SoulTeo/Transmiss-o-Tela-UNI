import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { backendUrl, getIceServers, roomPath } from './config';
import type { Participant, ServerAck } from './types';

type JoinResult = ServerAck<{
  roomId: string;
  self: Participant;
  participants: Participant[];
  sharerId: string | null;
}>;
type PeerSignal = { from: string; signal: { type: 'offer' | 'answer' | 'candidate'; value: RTCSessionDescriptionInit | RTCIceCandidateInit } };

function Icon({ name }: { name: 'screen' | 'copy' | 'leave' | 'sound' | 'users' | 'lock' | 'spark' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'screen') return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>;
  if (name === 'leave') return <svg {...common}><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>;
  if (name === 'sound') return <svg {...common}><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>;
  if (name === 'lock') return <svg {...common}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3"/></svg>;
  if (name === 'spark') return <svg {...common}><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"/></svg>;
  return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}

export function Room({ roomId, onHome }: { roomId: string; onHome: () => void }) {
  const [name, setName] = useState(() => sessionStorage.getItem('screen-share-name') || '');
  const [joined, setJoined] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selfId, setSelfId] = useState('');
  const [sharerId, setSharerId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [remoteHasAudio, setRemoteHasAudio] = useState<boolean | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const nameRef = useRef(name);
  const selfIdRef = useRef('');
  nameRef.current = name;
  const mountedRef = useRef(true);
  const joinedRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef(new Map<string, RTCPeerConnection>());
  const peerCreations = useRef(new Map<string, Promise<RTCPeerConnection>>());
  const peerEpochs = useRef(new Map<string, number>());
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const sharer = useMemo(() => participants.find((person) => person.id === sharerId), [participants, sharerId]);
  const isSharing = joined && sharerId === selfId && Boolean(localStreamRef.current);
  const shareUrl = `${window.location.origin}${roomPath(roomId)}`;

  const closePeer = useCallback((peerId: string, clearCandidates = true) => {
    peerEpochs.current.set(peerId, (peerEpochs.current.get(peerId) || 0) + 1);
    peerCreations.current.delete(peerId);
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peerConnections.current.delete(peerId);
    }
    if (clearCandidates) pendingCandidates.current.delete(peerId);
  }, []);

  const closeAllPeers = useCallback(() => {
    const peerIds = new Set([...peerConnections.current.keys(), ...peerCreations.current.keys()]);
    for (const peerId of peerIds) closePeer(peerId);
  }, [closePeer]);

  const stopLocalTracks = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  }, []);

  const leaveRoom = useCallback(() => {
    const socket = socketRef.current;
    socket?.emit('room:leave', { roomId });
    socket?.disconnect();
    socketRef.current = null;
    joinedRef.current = false;
    closeAllPeers();
    stopLocalTracks();
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setParticipants([]);
    setJoined(false);
    setSharerId(null);
    onHome();
  }, [closeAllPeers, onHome, roomId, stopLocalTracks]);

  const sendSignal = useCallback((to: string, signal: PeerSignal['signal']) => {
    socketRef.current?.emit('rtc:signal', { roomId, to, signal });
  }, [roomId]);

  const createPeer = useCallback((peerId: string, offer: boolean): Promise<RTCPeerConnection> => {
    const existing = peerConnections.current.get(peerId);
    if (existing) return Promise.resolve(existing);
    const pending = peerCreations.current.get(peerId);
    if (pending) return pending;

    const epoch = peerEpochs.current.get(peerId) || 0;
    const creation = (async () => {
      const iceServers = await getIceServers();
      if (!mountedRef.current || (peerEpochs.current.get(peerId) || 0) !== epoch) throw new Error('Peer connection was cancelled');
      const stream = offer ? localStreamRef.current : null;
      if (offer && !stream) throw new Error('Screen sharing has stopped');
      const pc = new RTCPeerConnection({ iceServers });
      peerConnections.current.set(peerId, pc);
      pc.onicecandidate = (event) => {
        if (event.candidate) sendSignal(peerId, { type: 'candidate', value: event.candidate.toJSON() });
      };
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (remoteVideoRef.current && remoteStream) {
          remoteVideoRef.current.srcObject = remoteStream;
          const updateAudio = () => setRemoteHasAudio(remoteStream.getAudioTracks().some((track) => track.readyState === 'live'));
          updateAudio();
          remoteStream.addEventListener('addtrack', updateAudio);
          remoteStream.addEventListener('removetrack', updateAudio);
          event.track.addEventListener('ended', updateAudio, { once: true });
          void remoteVideoRef.current.play().then(
            () => setPlaybackBlocked(false),
            () => setPlaybackBlocked(true),
          );
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(peerId);
      };

      try {
        if (stream) {
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          const description = await pc.createOffer();
          await pc.setLocalDescription(description);
          sendSignal(peerId, { type: 'offer', value: pc.localDescription!.toJSON() });
        }
        return pc;
      } catch (creationError) {
        closePeer(peerId);
        throw creationError;
      }
    })();

    peerCreations.current.set(peerId, creation);
    void creation.then(
      () => { if (peerCreations.current.get(peerId) === creation) peerCreations.current.delete(peerId); },
      () => { if (peerCreations.current.get(peerId) === creation) peerCreations.current.delete(peerId); },
    );
    return creation;
  }, [closePeer, sendSignal]);

  const flushCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const candidates = pendingCandidates.current.get(peerId) || [];
    pendingCandidates.current.delete(peerId);
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate); } catch { /* Ignore candidates invalidated by a restarted connection. */ }
    }
  }, []);

  const negotiateWith = useCallback(async (peerId: string) => {
    try { await createPeer(peerId, true); }
    catch { setError('Não foi possível iniciar a conexão de vídeo com um participante.'); }
  }, [createPeer]);

  const handleSignal = useCallback(async ({ from, signal }: PeerSignal) => {
    try {
      if (signal.type === 'offer') {
        closePeer(from, false);
        const pc = await createPeer(from, false);
        await pc.setRemoteDescription(signal.value as RTCSessionDescriptionInit);
        await flushCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, { type: 'answer', value: pc.localDescription!.toJSON() });
      } else if (signal.type === 'answer') {
        const pc = peerConnections.current.get(from);
        if (!pc) return;
        await pc.setRemoteDescription(signal.value as RTCSessionDescriptionInit);
        await flushCandidates(from, pc);
      } else {
        const candidate = signal.value as RTCIceCandidateInit;
        const pc = peerConnections.current.get(from);
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          const pending = pendingCandidates.current.get(from) || [];
          pending.push(candidate);
          pendingCandidates.current.set(from, pending);
        }
      }
    } catch {
      setError('A conexão de mídia foi interrompida. Tente parar e iniciar o compartilhamento novamente.');
    }
  }, [closePeer, createPeer, flushCandidates, sendSignal]);

  const join = useCallback((socket: Socket) => {
    setConnecting(true);
    const cleanName = nameRef.current.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
    socket.timeout(10_000).emit('room:join', { roomId, name: cleanName }, (timeoutError: Error | null, result?: JoinResult) => {
      if (!mountedRef.current) return;
      setConnecting(false);
      if (timeoutError || !result) {
        joinedRef.current = false;
        setError('O servidor não respondeu. Confira a conexão e tente entrar novamente.');
        setJoined(false);
        return;
      }
      if (!result.ok) {
        joinedRef.current = false;
        setError(result.error);
        setJoined(false);
        return;
      }
      joinedRef.current = true;
      setJoined(true);
      setError('');
      setConnectionLost(false);
      selfIdRef.current = result.self.id;
      setSelfId(result.self.id);
      setParticipants(result.participants);
      setSharerId(result.sharerId);
      sessionStorage.setItem('screen-share-name', cleanName);
    });
  }, [roomId]);

  useEffect(() => {
    mountedRef.current = true;
    const socket = io(backendUrl || window.location.origin, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 750,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnectionLost(false);
      if (joinedRef.current) closeAllPeers();
      if (nameRef.current.trim()) join(socket);
    });
    socket.on('disconnect', () => {
      if (!mountedRef.current) return;
      setConnecting(false);
      setConnectionLost(true);
      joinedRef.current = false;
      closeAllPeers();
      stopLocalTracks();
      setSharerId(null);
    });
    socket.on('connect_error', () => setConnectionLost(true));
    socket.on('participant:joined', (participant: Participant) => {
      setParticipants((current) => current.some((person) => person.id === participant.id) ? current : [...current, participant]);
      if (localStreamRef.current && joinedRef.current) void negotiateWith(participant.id);
    });
    socket.on('participant:left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => current.filter((person) => person.id !== participantId));
      closePeer(participantId);
    });
    socket.on('stream:started', ({ participantId }: { participantId: string }) => {
      setSharerId(participantId);
      setRemoteHasAudio(null);
      setPlaybackBlocked(false);
      setError('');
      if (participantId !== selfIdRef.current) {
        closeAllPeers();
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      }
    });
    socket.on('stream:stopped', ({ participantId }: { participantId: string }) => {
      setSharerId((current) => current === participantId ? null : current);
      setRemoteHasAudio(false);
      setPlaybackBlocked(false);
      if (participantId === selfIdRef.current) {
        closeAllPeers();
        stopLocalTracks();
      } else {
        closePeer(participantId);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      }
    });
    socket.on('rtc:signal', (signal: PeerSignal) => void handleSignal(signal));

    socket.connect();
    return () => {
      mountedRef.current = false;
      socket.emit('room:leave', { roomId });
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      joinedRef.current = false;
      closeAllPeers();
      stopLocalTracks();
    };
  }, [closeAllPeers, closePeer, handleSignal, join, negotiateWith, roomId, stopLocalTracks]);

  function enter(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
    if (!cleanName) {
      setError('Informe um apelido para entrar na sala.');
      return;
    }
    nameRef.current = cleanName;
    setName(cleanName);
    setError('');
    socketRef.current?.connect();
    const socket = socketRef.current;
    if (socket?.connected) join(socket);
  }

  async function startSharing() {
    setError('');
    if (!joined || !socketRef.current?.connected) {
      setError('Aguarde a conexão com a sala antes de compartilhar.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este navegador não permite compartilhar a tela. Experimente a versão mais recente do Chrome, Edge ou Firefox no computador.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (captureError) {
      if (captureError instanceof DOMException && captureError.name === 'NotAllowedError') return;
      setError('Não foi possível iniciar a captura. Verifique as permissões do navegador e tente novamente.');
      return;
    }

    const result = await new Promise<ServerAck>((resolve) => {
      const timer = window.setTimeout(() => resolve({ ok: false, error: 'O servidor não confirmou o início. Confira a conexão e tente novamente.' }), 8000);
      socketRef.current?.emit('stream:start', { roomId }, (acknowledgement: ServerAck) => {
        window.clearTimeout(timer);
        resolve(acknowledgement);
      });
    });
    if (!result?.ok) {
      stream.getTracks().forEach((track) => track.stop());
      setError(result?.error || 'Outra pessoa já está compartilhando. Aguarde a transmissão terminar.');
      return;
    }
    localStreamRef.current = stream;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    setSharerId(selfId);
    stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopSharing());
    for (const participant of participants) {
      if (participant.id !== selfId) void negotiateWith(participant.id);
    }
  }

  async function stopSharing() {
    const socket = socketRef.current;
    socket?.emit('stream:stop', { roomId });
    closeAllPeers();
    stopLocalTracks();
    setSharerId(null);
    setPlaybackBlocked(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2200);
  }

  function toggleAudio() {
    const nextEnabled = !audioEnabled;
    setAudioEnabled(nextEnabled);
    const video = remoteVideoRef.current;
    if (!video) return;
    video.muted = !nextEnabled;
    if (nextEnabled) {
      void video.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
  }

  function unlockPlayback() {
    const video = remoteVideoRef.current;
    if (!video) return;
    setAudioEnabled(true);
    video.muted = false;
    void video.play().then(
      () => setPlaybackBlocked(false),
      () => setPlaybackBlocked(true),
    );
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <button className="room-brand" onClick={onHome} aria-label="Voltar ao início">
          <span className="mini-mark"><i /><i /><i /></span><span>partilha</span>
        </button>
        <div className="room-heading">
          <span className="room-label">SALA</span>
          <strong>{roomId}</strong>
        </div>
        <div className="header-actions">
          <span className={`connection-pill ${connectionLost ? 'connection-offline' : joined ? 'connection-online' : ''}`}>
            <i />{connectionLost ? 'Reconectando' : joined ? 'Conectado' : 'Aguardando'}
          </span>
          <button
            className={`button button-secondary copy-button ${copyState === 'idle' ? '' : `copy-${copyState}`}`}
            onClick={copyLink}
            aria-label={copyState === 'copied' ? 'Link copiado' : copyState === 'failed' ? 'Não foi possível copiar o link' : 'Copiar link'}
            title={copyState === 'failed' ? 'Copie o endereço pela barra do navegador' : undefined}
          >
            <Icon name="copy" /><span className="copy-label">{copyState === 'copied' ? 'Copiado!' : copyState === 'failed' ? 'Falhou' : 'Copiar link'}</span>
          </button>
        </div>
      </header>

      <div className="room-content">
        {!joined ? (
          <section className="join-card">
            <div className="join-icon"><Icon name="users" /></div>
            <h1>Entre na sala <span>{roomId}</span></h1>
            <p className="muted-copy">Escolha como quer aparecer para seus amigos.</p>
            <form onSubmit={enter} className="name-form">
              <label htmlFor="display-name">Seu nome</label>
              <input id="display-name" autoFocus value={name} maxLength={24} onChange={(event) => setName(event.target.value)} placeholder="Como podemos te chamar?" />
              <button className="button button-primary" disabled={connecting || connectionLost}>
                {connecting ? <><span className="spinner" /> Conectando…</> : connectionLost ? 'Reconectando…' : 'Entrar na sala'}
              </button>
            </form>
            {error && <p className="error-message" role="alert">{error}</p>}
            <p className="small-note">Sua tela só será compartilhada quando você escolher iniciar.</p>
          </section>
        ) : (
          <>
            {connectionLost && <div className="reconnect-banner"><span className="spinner" /> Conexão perdida. Tentando reconectar à sala…</div>}
            {error && <div className="room-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
            <section className={`stage ${sharerId ? 'stage-live' : ''}`}>
              {sharerId ? (
                <>
                  <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline controls={false} muted={!audioEnabled || sharerId === selfId} />
                  {sharerId === selfId ? (
                    <div className="self-preview"><Icon name="screen" /><span>Sua tela está sendo compartilhada</span><small>Os participantes da sala podem assistir</small></div>
                  ) : (
                    <div className="live-tag"><i /> AO VIVO</div>
                  )}
                  {playbackBlocked && sharerId !== selfId && (
                    <button className="playback-button" onClick={unlockPlayback}>
                      {remoteHasAudio ? 'Ativar áudio da transmissão' : 'Reproduzir transmissão'}
                    </button>
                  )}
                  {remoteHasAudio === false && sharerId !== selfId && <div className="audio-caption">Áudio não disponibilizado pelo navegador de quem está compartilhando.</div>}
                </>
              ) : (
                <div className="empty-stage">
                  <div className="empty-illustration"><div className="screen-frame"><span /><span /><span /><div className="screen-content"><i /><i /><i /></div></div><div className="spark spark-one"><Icon name="spark" /></div><div className="spark spark-two"><Icon name="spark" /></div></div>
                  <h2>Ninguém está compartilhando</h2>
                  <p>Quando alguém iniciar, a tela aparecerá aqui.</p>
                </div>
              )}
            </section>

            <section className="people-strip">
              <div className="people-title"><Icon name="users" /><h2>Na sala</h2><span>{participants.length}<b>/20</b></span></div>
              <div className="people-list">
                {participants.map((person, index) => (
                  <div className="person-chip" key={person.id}>
                    <span className={`avatar avatar-${index % 5}`}>{person.name.slice(0, 1).toUpperCase()}</span>
                    <span className="person-name">{person.name}{person.id === selfId ? ' (você)' : ''}</span>
                    {person.id === sharerId && <span className="sharing-badge">transmitindo</span>}
                  </div>
                ))}
                {participants.length === 0 && <span className="muted-copy">Carregando participantes…</span>}
              </div>
            </section>

            <div className="controls-bar">
              <div className="controls-context">{isSharing ? <><i className="red-dot" /> Você está ao vivo</> : sharer ? <><i className="red-dot" /> {sharer.name} está ao vivo</> : 'Pronto para compartilhar'}</div>
              <div className="controls-actions">
                {sharerId && sharerId !== selfId && remoteHasAudio && <button className={`control-button audio-control ${audioEnabled ? '' : 'control-muted'}`} onClick={toggleAudio}><Icon name="sound" /><span>{audioEnabled ? 'Áudio ligado' : 'Áudio desligado'}</span></button>}
                {isSharing ? (
                  <button className="button button-stop" onClick={() => void stopSharing()}><span className="stop-square" /> Parar compartilhamento</button>
                ) : (
                  <button className="button button-primary share-button" onClick={() => void startSharing()} disabled={Boolean(sharerId) || connectionLost} title={sharerId ? 'Aguarde a transmissão atual terminar' : undefined}>
                    <Icon name="screen" /> Compartilhar tela
                  </button>
                )}
                <button className="button button-leave" onClick={leaveRoom}><Icon name="leave" /> Sair</button>
              </div>
            </div>
            <p className="screen-audio-note">O áudio da tela depende do navegador, do sistema e da opção selecionada na janela de compartilhamento.</p>
          </>
        )}
      </div>
    </main>
  );
}
