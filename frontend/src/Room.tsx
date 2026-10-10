import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ParticipantEvent, Room as LiveKitRoom, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { io, type Socket } from 'socket.io-client';
import { backendUrl, roomPath } from './config';
import type { Participant, ServerAck } from './types';

type JoinResult = ServerAck<{
  roomId: string;
  self: Participant;
  participants: Participant[];
  sharerId: string | null;
  audioSource: ShareAudioSource | null;
  mediaToken: string;
  mediaUrl: string;
}>;
type ShareAudioSource = 'system' | 'tab' | 'window' | 'unknown' | 'none';
type ShareSurface = 'monitor' | 'browser' | 'window' | 'unknown';
type ShareStarted = { participantId: string; audioSource: ShareAudioSource };

function waitForPublishPermission(mediaRoom: LiveKitRoom): Promise<void> {
  const participant = mediaRoom.localParticipant;
  if (participant.permissions?.canPublish) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      participant.off(ParticipantEvent.ParticipantPermissionsChanged, onPermissionsChanged);
      reject(new Error('O servidor de mídia não confirmou a permissão de publicação.'));
    }, 5000);
    const onPermissionsChanged = () => {
      if (!participant.permissions?.canPublish) return;
      window.clearTimeout(timeout);
      participant.off(ParticipantEvent.ParticipantPermissionsChanged, onPermissionsChanged);
      resolve();
    };
    participant.on(ParticipantEvent.ParticipantPermissionsChanged, onPermissionsChanged);
  });
}

function stopShareOnServer(socket: Socket | null, roomId: string): Promise<void> {
  if (!socket?.connected) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 7000);
    socket.timeout(6500).emit('stream:stop', { roomId }, () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

function discardAudioTracks(stream: MediaStream, tracks: MediaStreamTrack[]) {
  for (const track of tracks) {
    stream.removeTrack(track);
    track.stop();
  }
}

function prepareCaptureAudio(stream: MediaStream, capturedSurface?: ShareSurface) {
  const displaySurface = capturedSurface ?? stream.getVideoTracks()[0]?.getSettings().displaySurface as ShareSurface | undefined;
  const surface: ShareSurface = displaySurface === 'monitor' || displaySurface === 'browser' || displaySurface === 'window'
    ? displaySurface
    : 'unknown';
  const audioTracks = stream.getAudioTracks();
  const liveAudioTracks = audioTracks.filter((track) => track.readyState === 'live');
  discardAudioTracks(stream, audioTracks.filter((track) => !liveAudioTracks.includes(track)));
  let audioSource: ShareAudioSource = 'none';
  let message = '';

  if (surface === 'unknown') {
    audioSource = liveAudioTracks.length > 0 ? 'unknown' : 'none';
    message = liveAudioTracks.length > 0
      ? 'Áudio fornecido pelo navegador; a origem não foi identificada.'
      : 'O navegador não disponibilizou áudio; a tela será transmitida sem áudio.';
  } else if (surface === 'window') {
    const systemAudioTracks = liveAudioTracks.filter((track) => {
      const deviceId = track.getSettings().deviceId?.toLowerCase() || '';
      const label = track.label.toLowerCase();
      return deviceId === 'loopback'
        || /\b(system|desktop) audio\b|\bsystem sound\b|\bloopback\b/.test(label);
    });
    discardAudioTracks(stream, systemAudioTracks);
    const windowAudioTracks = liveAudioTracks.filter((track) => !systemAudioTracks.includes(track));
    if (windowAudioTracks.length > 0) {
      audioSource = 'window';
      message = 'Áudio da janela fornecido pelo navegador foi encaminhado.';
    } else {
      audioSource = 'none';
      message = systemAudioTracks.length > 0
        ? 'O navegador devolveu áudio geral do sistema, que foi omitido. O vídeo da janela seguirá sem áudio.'
        : 'O navegador não retornou faixa de áudio para esta janela. O vídeo seguirá sem áudio.';
    }
  } else if (liveAudioTracks.length > 0) {
    audioSource = surface === 'monitor' ? 'system' : 'tab';
    message = audioSource === 'system'
      ? 'Áudio do sistema inteiro incluído na transmissão.'
      : 'Somente o áudio da aba selecionada foi incluído.';
  } else {
    discardAudioTracks(stream, audioTracks);
    message = surface === 'monitor'
      ? 'O navegador não disponibilizou áudio do sistema; a tela seguirá sem áudio.'
      : 'O navegador não disponibilizou áudio da aba; o vídeo seguirá sem áudio.';
  }

  return { audioSource, message };
}

function describeAudioSource(source: ShareAudioSource | null) {
  switch (source) {
    case 'system': return 'Áudio do sistema inteiro incluído na transmissão.';
    case 'tab': return 'Somente o áudio da aba selecionada foi incluído.';
    case 'window': return 'Áudio da janela encaminhado conforme a faixa fornecida pelo navegador.';
    case 'unknown': return 'Áudio fornecido pelo navegador; origem não identificada.';
    case 'none': return 'Esta origem não disponibilizou áudio isolado; a transmissão está sem áudio.';
    default: return 'O áudio depende da origem selecionada e do que o navegador disponibilizar.';
  }
}

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
  const [localSharing, setLocalSharing] = useState(false);
  const [audioSource, setAudioSource] = useState<ShareAudioSource | null>(null);
  const [localAudioNotice, setLocalAudioNotice] = useState('');
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
  const mediaRoomRef = useRef<LiveKitRoom | null>(null);
  const stoppingShareRef = useRef(false);
  const pendingRemoteTracksRef = useRef(new Set<RemoteTrack>());
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioEnabledRef = useRef(audioEnabled);
  audioEnabledRef.current = audioEnabled;

  const sharer = useMemo(() => participants.find((person) => person.id === sharerId), [participants, sharerId]);
  const isSharing = joined && localSharing;
  const shareUrl = `${window.location.origin}${roomPath(roomId)}`;

  const clearRemoteMedia = useCallback(() => {
    pendingRemoteTracksRef.current.clear();
    const video = remoteVideoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    const audio = remoteAudioRef.current;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    setRemoteHasAudio(false);
    setPlaybackBlocked(false);
  }, []);

  const attachRemoteTrack = useCallback((track: RemoteTrack) => {
    if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
      const video = remoteVideoRef.current;
      if (!video) {
        pendingRemoteTracksRef.current.add(track);
        return;
      }
      pendingRemoteTracksRef.current.delete(track);
      video.muted = true;
      track.attach(video);
      void video.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    } else if (track.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
      setRemoteHasAudio(true);
      const audio = remoteAudioRef.current;
      if (!audio) {
        pendingRemoteTracksRef.current.add(track);
        return;
      }
      pendingRemoteTracksRef.current.delete(track);
      audio.muted = !audioEnabledRef.current;
      track.attach(audio);
      void audio.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
  }, []);

  const disconnectMediaRoom = useCallback(async () => {
    const mediaRoom = mediaRoomRef.current;
    mediaRoomRef.current = null;
    if (mediaRoom) await mediaRoom.disconnect();
    clearRemoteMedia();
  }, [clearRemoteMedia]);

  const stopLocalTracks = useCallback(async () => {
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    const mediaRoom = mediaRoomRef.current;
    if (stream && mediaRoom) {
      await Promise.allSettled(stream.getTracks().map((track) => mediaRoom.localParticipant.unpublishTrack(track, false)));
    }
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }, []);

  const leaveRoom = useCallback(async () => {
    const socket = socketRef.current;
    await stopLocalTracks();
    await stopShareOnServer(socket, roomId);
    await disconnectMediaRoom();
    socket?.emit('room:leave', { roomId });
    socket?.disconnect();
    socketRef.current = null;
    joinedRef.current = false;
    setParticipants([]);
    setJoined(false);
    setSharerId(null);
    setLocalSharing(false);
    setAudioSource(null);
    onHome();
  }, [disconnectMediaRoom, onHome, roomId, stopLocalTracks]);

  const connectMediaRoom = useCallback(async (url: string, token: string) => {
    if (!url || !token) throw new Error('O servidor não forneceu acesso ao serviço de mídia.');
    await disconnectMediaRoom();
    const mediaRoom = new LiveKitRoom({ adaptiveStream: true, dynacast: true });
    mediaRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity === selfIdRef.current) return;
      attachRemoteTrack(track);
    });
    mediaRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      pendingRemoteTracksRef.current.delete(track);
      if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
        const video = remoteVideoRef.current;
        if (video) track.detach(video);
      } else if (track.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
        const audio = remoteAudioRef.current;
        if (audio) track.detach(audio);
        setRemoteHasAudio(false);
      }
    });
    mediaRoom.on(RoomEvent.Reconnecting, () => setConnectionLost(true));
    mediaRoom.on(RoomEvent.Reconnected, () => setConnectionLost(false));
    mediaRoom.on(RoomEvent.Disconnected, () => {
      if (mediaRoomRef.current !== mediaRoom || !mountedRef.current) return;
      mediaRoomRef.current = null;
      clearRemoteMedia();
      setConnectionLost(true);
      setLocalSharing(false);
      void stopLocalTracks();
    });
    mediaRoomRef.current = mediaRoom;
    try {
      await mediaRoom.connect(url, token);
    } catch (connectError) {
      if (mediaRoomRef.current === mediaRoom) mediaRoomRef.current = null;
      await mediaRoom.disconnect();
      throw connectError;
    }
  }, [attachRemoteTrack, clearRemoteMedia, disconnectMediaRoom, stopLocalTracks]);

  const join = useCallback((socket: Socket) => {
    setConnecting(true);
    const cleanName = nameRef.current.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
    socket.timeout(10_000).emit('room:join', { roomId, name: cleanName }, async (timeoutError: Error | null, result?: JoinResult) => {
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
      selfIdRef.current = result.self.id;
      try {
        await connectMediaRoom(result.mediaUrl, result.mediaToken);
      } catch {
        socket.emit('room:leave', { roomId });
        joinedRef.current = false;
        setJoined(false);
        setError('Não foi possível conectar ao serviço de transmissão. Tente novamente em instantes.');
        return;
      }
      if (!mountedRef.current || !socket.connected) {
        await disconnectMediaRoom();
        return;
      }
      joinedRef.current = true;
      setJoined(true);
      setError('');
      setConnectionLost(false);
      setSelfId(result.self.id);
      setParticipants(result.participants);
      setSharerId(result.sharerId);
      setAudioSource(result.sharerId ? result.audioSource : null);
      sessionStorage.setItem('screen-share-name', cleanName);
    });
  }, [connectMediaRoom, disconnectMediaRoom, roomId]);

  useEffect(() => {
    if (!joined) return;
    for (const track of pendingRemoteTracksRef.current) attachRemoteTrack(track);
  }, [attachRemoteTrack, joined]);

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
      if (joinedRef.current) void disconnectMediaRoom();
      if (nameRef.current.trim()) join(socket);
    });
    socket.on('disconnect', () => {
      if (!mountedRef.current) return;
      setConnecting(false);
      setConnectionLost(true);
      joinedRef.current = false;
      void (async () => {
        await stopLocalTracks();
        await disconnectMediaRoom();
      })();
      setSharerId(null);
      setLocalSharing(false);
      setAudioSource(null);
    });
    socket.on('connect_error', () => setConnectionLost(true));
    socket.on('participant:joined', (participant: Participant) => {
      setParticipants((current) => current.some((person) => person.id === participant.id) ? current : [...current, participant]);
    });
    socket.on('participant:left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => current.filter((person) => person.id !== participantId));
    });
    socket.on('stream:started', ({ participantId, audioSource: incomingAudioSource }: ShareStarted) => {
      setSharerId(participantId);
      setAudioSource(incomingAudioSource);
      setPlaybackBlocked(false);
      setError('');
      setRemoteHasAudio(incomingAudioSource === 'none' ? false : null);
    });
    socket.on('stream:stopped', ({ participantId }: { participantId: string }) => {
      setSharerId((current) => current === participantId ? null : current);
      setAudioSource(null);
      if (participantId === selfIdRef.current) {
        void stopLocalTracks();
        setLocalSharing(false);
        setLocalAudioNotice('');
      } else {
        clearRemoteMedia();
      }
    });

    socket.connect();
    return () => {
      mountedRef.current = false;
      if (socketRef.current === socket) socketRef.current = null;
      joinedRef.current = false;
      void (async () => {
        await stopLocalTracks();
        await stopShareOnServer(socket, roomId);
        await disconnectMediaRoom();
        socket.emit('room:leave', { roomId });
        socket.disconnect();
      })();
    };
  }, [clearRemoteMedia, disconnectMediaRoom, join, roomId, stopLocalTracks]);

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
      const options = {
        video: { cursor: 'never' },
        audio: true,
        // Offer audio from the selected tab/window, but never system loopback.
        systemAudio: 'exclude',
        windowAudio: 'window',
      } as DisplayMediaStreamOptions & {
        video: MediaTrackConstraints & { cursor: 'never' };
        systemAudio: 'exclude';
        windowAudio: 'window';
      };
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (captureError) {
      if (captureError instanceof DOMException && captureError.name === 'NotAllowedError') return;
      setError('Não foi possível iniciar a captura. Verifique as permissões do navegador e tente novamente.');
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      setError('O navegador não forneceu uma faixa de vídeo. Tente iniciar o compartilhamento novamente.');
      return;
    }
    const displaySurface = videoTrack?.getSettings().displaySurface as ShareSurface | undefined;

    console.info('[screen-share] origem escolhida pelo navegador', JSON.stringify({
      displaySurface: displaySurface ?? 'unreported',
      browserAudioTrackCount: stream.getAudioTracks().length,
      browserAudioTracks: stream.getAudioTracks().map((track) => ({
        label: track.label,
        settings: track.getSettings(),
      })),
    }));

    console.info('[screen-share] getDisplayMedia retornou', JSON.stringify({
      displaySurface,
      audioTracks: stream.getAudioTracks().map((track) => ({
        id: track.id,
        label: track.label,
        readyState: track.readyState,
        muted: track.muted,
        settings: track.getSettings(),
      })),
    }));

    const captureAudio = prepareCaptureAudio(stream, displaySurface);
    console.info('[screen-share] faixas encaminhadas ao LiveKit SFU', JSON.stringify({
      audioSource: captureAudio.audioSource,
      liveAudioTrackCount: stream.getAudioTracks().filter((track) => track.readyState === 'live').length,
      audioTracks: stream.getAudioTracks().map((track) => ({
        id: track.id,
        readyState: track.readyState,
        muted: track.muted,
        enabled: track.enabled,
      })),
    }));

    setLocalAudioNotice(captureAudio.message);
    let captureEnded = videoTrack?.readyState === 'ended';
    videoTrack?.addEventListener('ended', () => {
      captureEnded = true;
      if (localStreamRef.current === stream) void stopSharing();
    }, { once: true });

    const result = await new Promise<ServerAck>((resolve) => {
      const timer = window.setTimeout(() => resolve({ ok: false, error: 'O servidor não confirmou o início. Confira a conexão e tente novamente.' }), 8000);
      socketRef.current?.emit('stream:start', { roomId, audioSource: captureAudio.audioSource }, (acknowledgement: ServerAck) => {
        window.clearTimeout(timer);
        resolve(acknowledgement);
      });
    });
    if (!result?.ok) {
      socketRef.current?.emit('stream:stop', { roomId });
      stream.getTracks().forEach((track) => track.stop());
      setLocalAudioNotice('');
      setError(result?.error || 'Outra pessoa já está compartilhando. Aguarde a transmissão terminar.');
      return;
    }
    if (captureEnded || videoTrack?.readyState === 'ended') {
      socketRef.current?.emit('stream:stop', { roomId });
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mediaRoom = mediaRoomRef.current;
    if (!mediaRoom || mediaRoom.state !== 'connected') {
      socketRef.current?.emit('stream:stop', { roomId });
      stream.getTracks().forEach((track) => track.stop());
      setLocalAudioNotice('');
      setError('A conexão com o serviço de transmissão foi perdida. Reconecte-se à sala e tente novamente.');
      return;
    }
    localStreamRef.current = stream;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    setSharerId(selfId);
    setLocalSharing(true);
    try {
      await waitForPublishPermission(mediaRoom);
      for (const track of stream.getTracks()) {
        await mediaRoom.localParticipant.publishTrack(track, {
          source: track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          name: track.kind === 'video' ? 'screen' : 'screen-audio',
          stream: 'screen',
          ...(track.kind === 'video' ? { screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 } } : {}),
        });
      }
    } catch {
      await stopLocalTracks();
      await stopShareOnServer(socketRef.current, roomId);
      setSharerId(null);
      setLocalSharing(false);
      setLocalAudioNotice('');
      setError('Não foi possível publicar a transmissão no servidor de mídia. Tente novamente.');
    }
  }

  async function stopSharing() {
    if (stoppingShareRef.current) return;
    stoppingShareRef.current = true;
    try {
      await stopLocalTracks();
      await stopShareOnServer(socketRef.current, roomId);
      clearRemoteMedia();
      setSharerId(null);
      setLocalSharing(false);
      setAudioSource(null);
      setLocalAudioNotice('');
    } finally {
      stoppingShareRef.current = false;
    }
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
    audioEnabledRef.current = nextEnabled;
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.muted = !nextEnabled;
    if (nextEnabled) {
      void audio.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
  }

  function unlockPlayback() {
    setAudioEnabled(true);
    audioEnabledRef.current = true;
    if (remoteVideoRef.current) void remoteVideoRef.current.play();
    const audio = remoteAudioRef.current;
    if (audio) {
      audio.muted = false;
      void audio.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
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
                  <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline controls={false} muted />
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
                  {remoteHasAudio === false && sharerId !== selfId && <div className="audio-caption">Esta transmissão não tem uma faixa de áudio disponível.</div>}
                </>
              ) : (
                <div className="empty-stage">
                  <div className="empty-illustration"><div className="screen-frame"><span /><span /><span /><div className="screen-content"><i /><i /><i /></div></div><div className="spark spark-one"><Icon name="spark" /></div><div className="spark spark-two"><Icon name="spark" /></div></div>
                  <h2>Ninguém está compartilhando</h2>
                  <p>Quando alguém iniciar, a tela aparecerá aqui.</p>
                </div>
              )}
            </section>
            <audio ref={remoteAudioRef} autoPlay muted={!audioEnabled} className="remote-audio" />

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
                  <button className="button button-stop" onClick={() => void stopSharing()}><span className="stop-square" /> Parar de compartilhar</button>
                ) : (
                  <button className="button button-primary share-button" onClick={() => void startSharing()} disabled={Boolean(sharerId) || connectionLost} title={sharerId ? 'Aguarde a transmissão atual terminar' : undefined}>
                    <Icon name="screen" /> Compartilhar tela
                  </button>
                )}
                <button className="button button-leave" onClick={leaveRoom}><Icon name="leave" /> Sair</button>
              </div>
            </div>
            <p className="screen-audio-note">{isSharing ? localAudioNotice : sharerId ? describeAudioSource(audioSource) : 'O áudio depende do navegador e da origem escolhida na janela de compartilhamento.'}</p>
          </>
        )}
      </div>
    </main>
  );
}
