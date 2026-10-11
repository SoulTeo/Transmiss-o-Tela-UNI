import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { backendUrl, roomPath } from './config';
import { PeerMesh, type PeerMetric } from './PeerMesh';
import type { Participant, ServerAck } from './types';

type AudioSource = 'window' | 'tab' | 'system' | 'none';
type ShareSurface = 'monitor' | 'browser' | 'window' | 'unknown';
type JoinResult = ServerAck<{
  roomId: string;
  self: Participant;
  participants: Participant[];
  sharerId: string | null;
  audioSource: AudioSource | null;
  hasAudio: boolean;
}>;
type PendingSignal = { event: 'signal:offer' | 'signal:answer' | 'signal:ice' | 'signal:restart'; payload: Record<string, unknown> };
type CaptureAudioResult = { audioSource: AudioSource; audioTracks: MediaStreamTrack[] };
type CaptureDebug = { browser: string; platform: string; surface: string; audioLabels: string[]; viewerCount: number };
const REACTIONS = [
  { emoji: '❤️', label: 'Coração' },
  { emoji: '👍', label: 'Gostei' },
  { emoji: '👎', label: 'Não gostei' },
  { emoji: '💀', label: 'Caveira' },
  { emoji: '🍂', label: 'Folha de outono' },
  { emoji: '😃', label: 'Feliz' },
  { emoji: '👏', label: 'Palmas' },
] as const;
type ReactionEmoji = (typeof REACTIONS)[number]['emoji'];
type FloatingReaction = { id: string; emoji: ReactionEmoji };

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const SYSTEM_AUDIO_PATTERN = /(?:\b(?:system|desktop|loopback)\s*[- ]?\s*(?:audio|sound)\b|\b(?:audio|sound)\s*(?:of\s*)?(?:the\s*)?(?:system|desktop)\b|\bentire\s+system\b|áudio.{0,18}do\s+sistema|som.{0,18}do\s+sistema|áudio\s+geral|\bloopback\b)/iu;
const MICROPHONE_PATTERN = /\b(?:microphone|microfone|mic input)\b/iu;

function emitAck<T extends Record<string, unknown> = Record<string, never>>(
  socket: Socket,
  event: string,
  payload: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<ServerAck<T>> {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (timeoutError: Error | null, response?: ServerAck<T>) => {
      resolve(timeoutError || !response ? { ok: false, error: 'O servidor não respondeu. Confira a conexão e tente novamente.' } : response);
    });
  });
}

async function loadIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch(`${backendUrl || window.location.origin}/api/ice-servers`, { cache: 'no-store' });
    if (!response.ok) return DEFAULT_ICE_SERVERS;
    const data = await response.json() as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

function discardTracks(stream: MediaStream, tracks: MediaStreamTrack[]) {
  for (const track of tracks) {
    stream.removeTrack(track);
    track.stop();
  }
}

function prepareCaptureAudio(stream: MediaStream, surface: 'window' | 'browser'): CaptureAudioResult {
  const audioTracks = stream.getAudioTracks();
  const discarded: MediaStreamTrack[] = [];
  const candidateTracks: MediaStreamTrack[] = [];
  const systemTracks: MediaStreamTrack[] = [];
  for (const track of audioTracks) {
    const settings = track.getSettings();
    const metadata = `${track.label} ${track.contentHint} ${JSON.stringify(settings)}`;
    const deviceId = settings.deviceId?.toLowerCase() || '';
    const isSystemAudio = deviceId === 'loopback' || SYSTEM_AUDIO_PATTERN.test(metadata);
    if (track.readyState !== 'live' || MICROPHONE_PATTERN.test(metadata) || (surface === 'browser' && isSystemAudio)) {
      discarded.push(track);
    } else {
      candidateTracks.push(track);
      if (isSystemAudio) systemTracks.push(track);
    }
  }

  // A window capture may provide system loopback. Prefer and forward it instead of filtering it.
  // Tab sharing keeps its existing behavior and excludes any explicitly identified system track.
  const selected = surface === 'window' ? systemTracks[0] || candidateTracks[0] : candidateTracks[0];
  const kept = selected ? [selected] : [];
  discarded.push(...candidateTracks.filter((track) => track !== selected));
  discardTracks(stream, discarded);

  if (kept.length) {
    const settings = kept[0].getSettings();
    const metadata = `${kept[0].label} ${kept[0].contentHint} ${JSON.stringify(settings)}`;
    const isSystemAudio = surface === 'window' && (settings.deviceId?.toLowerCase() === 'loopback' || SYSTEM_AUDIO_PATTERN.test(metadata));
    const source: AudioSource = isSystemAudio ? 'system' : surface === 'window' ? 'window' : 'tab';
    return {
      audioSource: source,
      audioTracks: kept,
    };
  }
  return { audioSource: 'none', audioTracks: [] };
}

function describeAudioSource(source: AudioSource | null) {
  switch (source) {
    case 'window': return 'Áudio encaminhado conforme a faixa fornecida pelo navegador para esta janela.';
    case 'tab': return 'Somente o áudio da guia selecionada foi incluído.';
    case 'system': return 'Áudio de loopback do sistema fornecido pelo navegador foi incluído e pode conter sons de outros aplicativos.';
    case 'none': return 'O navegador não forneceu áudio isolado. A transmissão segue somente com vídeo.';
    default: return 'O navegador pode não fornecer áudio isolado para todas as janelas.';
  }
}

function formatMetric(value: number | null, suffix = '') {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value}${suffix}`;
}

function Icon({ name }: { name: 'screen' | 'copy' | 'leave' | 'sound' | 'users' | 'spark' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'screen') return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>;
  if (name === 'leave') return <svg {...common}><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>;
  if (name === 'sound') return <svg {...common}><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>;
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
  const [audioSource, setAudioSource] = useState<AudioSource | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [remoteHasAudio, setRemoteHasAudio] = useState<boolean | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [peerMetrics, setPeerMetrics] = useState<Record<string, PeerMetric>>({});
  const [captureDebug, setCaptureDebug] = useState<CaptureDebug | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewerControlsVisible, setViewerControlsVisible] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const nameRef = useRef(name);
  const selfIdRef = useRef('');
  const sharerIdRef = useRef<string | null>(null);
  const participantsRef = useRef<Participant[]>([]);
  const mountedRef = useRef(true);
  const joinedRef = useRef(false);
  const joinInFlightRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerMeshRef = useRef<PeerMesh | null>(null);
  const pendingSignalsRef = useRef<PendingSignal[]>([]);
  const startingShareRef = useRef(false);
  const stoppingShareRef = useRef(false);
  const pendingRemoteTracksRef = useRef<MediaStreamTrack[]>([]);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const viewerControlsTimerRef = useRef<number | null>(null);
  const reactionTimersRef = useRef<Map<string, number>>(new Map());
  const reactionSequenceRef = useRef(0);
  const lastReactionAtRef = useRef(0);
  const audioEnabledRef = useRef(audioEnabled);
  nameRef.current = name;
  participantsRef.current = participants;
  audioEnabledRef.current = audioEnabled;

  const sharer = useMemo(() => participants.find((person) => person.id === sharerId), [participants, sharerId]);
  const isSharing = joined && localSharing;
  const debugEnabled = new URLSearchParams(window.location.search).get('debug') === 'webrtc';
  const shareUrl = `${window.location.origin}${roomPath(roomId)}`;

  const clearRemoteMedia = useCallback(() => {
    pendingRemoteTracksRef.current = [];
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

  const attachRemoteTrack = useCallback((track: MediaStreamTrack) => {
    if (track.kind === 'video') {
      const video = remoteVideoRef.current;
      if (!video) {
        pendingRemoteTracksRef.current.push(track);
        return;
      }
      video.muted = true;
      video.srcObject = new MediaStream([track]);
      void video.play().then(() => setPlaybackBlocked(false), () => setPlaybackBlocked(true));
    } else if (track.kind === 'audio') {
      setRemoteHasAudio(true);
      const audio = remoteAudioRef.current;
      if (!audio) {
        pendingRemoteTracksRef.current.push(track);
        return;
      }
      audio.muted = !audioEnabledRef.current;
      audio.srcObject = new MediaStream([track]);
      void audio.play().then(() => setPlaybackBlocked(false), () => setPlaybackBlocked(true));
    }
  }, []);

  const createPeerMesh = useCallback((socket: Socket, participantId: string, iceServers: RTCIceServer[]) => new PeerMesh({
    socket,
    participantId,
    iceServers,
    onTrack: (track) => {
      if (mountedRef.current) attachRemoteTrack(track);
    },
    onTrackEnded: (track) => {
      if (!mountedRef.current) return;
      if (track.kind === 'audio') {
        const audio = remoteAudioRef.current;
        if (audio) audio.srcObject = null;
        setRemoteHasAudio(false);
      } else {
        const video = remoteVideoRef.current;
        if (video) video.srcObject = null;
      }
    },
    onPeerRemoved: (peerId) => {
      if (mountedRef.current) setPeerMetrics((current) => {
        const next = { ...current };
        delete next[peerId];
        return next;
      });
    },
    onMetric: (metric) => {
      if (mountedRef.current && debugEnabled) setPeerMetrics((current) => ({ ...current, [metric.peerId]: metric }));
    },
    onRecoveryLimit: (peerId) => {
      if (mountedRef.current) {
        const person = participantsRef.current.find((item) => item.id === peerId);
        setError(`A conexão WebRTC com ${person?.name || 'um participante'} não foi recuperada. Peça para entrar novamente na sala.`);
      }
    },
  }), [attachRemoteTrack, debugEnabled]);

  const closePeerMesh = useCallback(() => {
    peerMeshRef.current?.dispose();
    peerMeshRef.current = null;
    pendingSignalsRef.current = [];
    setPeerMetrics({});
    clearRemoteMedia();
  }, [clearRemoteMedia]);

  const stopLocalCapture = useCallback(() => {
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }, []);

  const stopSharing = useCallback(async () => {
    if (stoppingShareRef.current) return;
    if (!localStreamRef.current && !localSharing) return;
    stoppingShareRef.current = true;
    const socket = socketRef.current;
    try {
      stopLocalCapture();
      const mesh = peerMeshRef.current;
      mesh?.setSharer(null);
      mesh?.stopSharing();
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      sharerIdRef.current = null;
      setSharerId(null);
      setLocalSharing(false);
      setAudioSource(null);
      setCaptureDebug((current) => current ? { ...current, viewerCount: 0 } : null);
      if (socket?.connected) await emitAck(socket, 'broadcast:stop', { roomId }, 6_500);
    } finally {
      stoppingShareRef.current = false;
    }
  }, [localSharing, roomId, stopLocalCapture]);

  const leaveRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (localStreamRef.current) await stopSharing();
    closePeerMesh();
    if (socket?.connected) {
      await emitAck(socket, 'room:leave', { roomId }, 3_000);
      socket.disconnect();
    }
    socketRef.current = null;
    joinedRef.current = false;
    setParticipants([]);
    participantsRef.current = [];
    setJoined(false);
    setSharerId(null);
    sharerIdRef.current = null;
    setLocalSharing(false);
    setAudioSource(null);
    onHome();
  }, [closePeerMesh, onHome, roomId, stopSharing]);

  const handleSignal = useCallback((event: PendingSignal['event'], payload: Record<string, unknown>) => {
    const mesh = peerMeshRef.current;
    if (!mesh) {
      if (pendingSignalsRef.current.length < 32) pendingSignalsRef.current.push({ event, payload });
      return;
    }
    const from = typeof payload.fromParticipantId === 'string' ? payload.fromParticipantId : '';
    if (event === 'signal:offer' && payload.description && typeof payload.description === 'object') {
      void mesh.receiveOffer(from, payload.description as RTCSessionDescriptionInit);
    } else if (event === 'signal:answer' && payload.description && typeof payload.description === 'object') {
      void mesh.receiveAnswer(from, payload.description as RTCSessionDescriptionInit);
    } else if (event === 'signal:ice' && payload.description && typeof payload.description === 'object') {
      void mesh.receiveIce(from, payload.description as RTCIceCandidateInit);
    } else if (event === 'signal:restart') {
      mesh.receiveRestart(from);
    }
  }, []);

  const join = useCallback((socket: Socket) => {
    if (joinInFlightRef.current || joinedRef.current) return;
    joinInFlightRef.current = true;
    setConnecting(true);
    const cleanName = nameRef.current.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
    socket.timeout(10_000).emit('room:join', { roomId, name: cleanName }, async (timeoutError: Error | null, result?: JoinResult) => {
      joinInFlightRef.current = false;
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
      const iceServers = await loadIceServers();
      if (!mountedRef.current || !socket.connected) return;
      const mesh = createPeerMesh(socket, result.self.id, iceServers);
      mesh.setSharer(result.sharerId);
      peerMeshRef.current?.dispose();
      peerMeshRef.current = mesh;
      const pendingSignals = pendingSignalsRef.current;
      pendingSignalsRef.current = [];
      for (const pending of pendingSignals) handleSignal(pending.event, pending.payload);
      joinedRef.current = true;
      setJoined(true);
      setError('');
      setConnectionLost(false);
      setSelfId(result.self.id);
      selfIdRef.current = result.self.id;
      setParticipants(result.participants);
      participantsRef.current = result.participants;
      setSharerId(result.sharerId);
      sharerIdRef.current = result.sharerId;
      setAudioSource(result.sharerId ? result.audioSource : null);
      setRemoteHasAudio(result.sharerId ? result.hasAudio : null);
      sessionStorage.setItem('screen-share-name', cleanName);
    });
  }, [createPeerMesh, handleSignal, roomId]);

  useEffect(() => {
    if (!joined) return;
    const pending = pendingRemoteTracksRef.current;
    pendingRemoteTracksRef.current = [];
    pending.forEach(attachRemoteTrack);
  }, [attachRemoteTrack, joined]);

  useEffect(() => {
    if (sharerId !== selfId || !localStreamRef.current || !remoteVideoRef.current) return;
    remoteVideoRef.current.muted = true;
    remoteVideoRef.current.srcObject = localStreamRef.current;
    void remoteVideoRef.current.play().catch(() => undefined);
  }, [localSharing, selfId, sharerId]);

  useEffect(() => {
    if (sharerId === selfId && localStreamRef.current) {
      setCaptureDebug((current) => current ? { ...current, viewerCount: participants.filter((person) => person.id !== selfId).length } : current);
    }
  }, [participants, selfId, sharerId]);

  useEffect(() => {
    mountedRef.current = true;
    const socket = io(backendUrl || window.location.origin, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 750,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnectionLost(false);
      if (nameRef.current.trim()) join(socket);
    });
    socket.on('disconnect', () => {
      if (!mountedRef.current) return;
      setConnecting(false);
      setConnectionLost(true);
      joinedRef.current = false;
      joinInFlightRef.current = false;
      stopLocalCapture();
      closePeerMesh();
      setSharerId(null);
      sharerIdRef.current = null;
      setLocalSharing(false);
      setAudioSource(null);
      setFloatingReactions([]);
    });
    socket.on('connect_error', () => setConnectionLost(true));
    socket.on('participant:joined', (participant: Participant) => {
      setParticipants((current) => {
        const next = current.some((person) => person.id === participant.id) ? current : [...current, participant];
        participantsRef.current = next;
        return next;
      });
      if (sharerIdRef.current === selfIdRef.current && localStreamRef.current) void peerMeshRef.current?.addParticipant(participant.id);
    });
    socket.on('participant:left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => {
        const next = current.filter((person) => person.id !== participantId);
        participantsRef.current = next;
        return next;
      });
    });
    socket.on('peer:left', ({ participantId }: { participantId: string }) => peerMeshRef.current?.removeParticipant(participantId));
    socket.on('reaction:show', ({ participantId, emoji }: { participantId: string; emoji: string }) => {
      if (!REACTIONS.some((reaction) => reaction.emoji === emoji)) return;
      const id = `${participantId}-${Date.now()}-${++reactionSequenceRef.current}`;
      setFloatingReactions((current) => [...current.slice(-11), { id, emoji: emoji as ReactionEmoji }]);
      const timer = window.setTimeout(() => {
        setFloatingReactions((current) => current.filter((reaction) => reaction.id !== id));
        reactionTimersRef.current.delete(id);
      }, 3_000);
      reactionTimersRef.current.set(id, timer);
    });
    socket.on('room:state', (state: { participants: Participant[]; sharerId: string | null; audioSource: AudioSource | null; hasAudio: boolean }) => {
      setParticipants(state.participants);
      participantsRef.current = state.participants;
      const priorSharer = sharerIdRef.current;
      sharerIdRef.current = state.sharerId;
      setSharerId(state.sharerId);
      setAudioSource(state.sharerId ? state.audioSource : null);
      if (state.sharerId && state.sharerId !== selfIdRef.current) setRemoteHasAudio(state.hasAudio);
      if (!state.sharerId && priorSharer) {
        peerMeshRef.current?.setSharer(null);
        peerMeshRef.current?.closeAllPeers();
        clearRemoteMedia();
      } else {
        peerMeshRef.current?.setSharer(state.sharerId);
      }
    });
    socket.on('broadcast:started', ({ participantId, audioSource: source, hasAudio }: { participantId: string; audioSource: AudioSource; hasAudio: boolean }) => {
      sharerIdRef.current = participantId;
      setSharerId(participantId);
      setAudioSource(source);
      setRemoteHasAudio(participantId === selfIdRef.current ? null : hasAudio);
      setPlaybackBlocked(false);
      setError('');
      peerMeshRef.current?.setSharer(participantId);
    });
    socket.on('broadcast:stopped', ({ participantId }: { participantId: string }) => {
      if (sharerIdRef.current !== participantId) return;
      sharerIdRef.current = null;
      setSharerId(null);
      setAudioSource(null);
      setFloatingReactions([]);
      peerMeshRef.current?.setSharer(null);
      peerMeshRef.current?.closeAllPeers();
      if (participantId === selfIdRef.current) {
        stopLocalCapture();
        setLocalSharing(false);
      } else {
        clearRemoteMedia();
      }
    });
    socket.on('signal:offer', (payload: Record<string, unknown>) => handleSignal('signal:offer', payload));
    socket.on('signal:answer', (payload: Record<string, unknown>) => handleSignal('signal:answer', payload));
    socket.on('signal:ice', (payload: Record<string, unknown>) => handleSignal('signal:ice', payload));
    socket.on('signal:restart', (payload: Record<string, unknown>) => handleSignal('signal:restart', payload));

    socket.connect();
    return () => {
      mountedRef.current = false;
      if (socketRef.current === socket) socketRef.current = null;
      joinedRef.current = false;
      joinInFlightRef.current = false;
      stopLocalCapture();
      peerMeshRef.current?.dispose();
      peerMeshRef.current = null;
      if (socket.connected) {
        void (async () => {
          await emitAck(socket, 'broadcast:stop', { roomId }, 3_000);
          await emitAck(socket, 'room:leave', { roomId }, 3_000);
          socket.disconnect();
        })();
      } else {
        socket.disconnect();
      }
    };
  }, [clearRemoteMedia, closePeerMesh, handleSignal, join, roomId, stopLocalCapture]);

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
    if (startingShareRef.current) return;
    startingShareRef.current = true;
    setError('');
    if (!joined || !socketRef.current?.connected) {
      setError('Aguarde a conexão com a sala antes de compartilhar.');
      startingShareRef.current = false;
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este navegador não permite compartilhar a tela. Experimente a versão mais recente do Chrome, Edge ou Firefox no computador.');
      startingShareRef.current = false;
      return;
    }

    let stream: MediaStream;
    try {
      // This call must remain synchronous with the click gesture so the native picker is allowed to open.
      const options = {
        video: {
          displaySurface: 'window',
          cursor: 'never',
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1_280, max: 1_920 },
          height: { ideal: 720, max: 1_080 },
        },
        audio: {
          suppressLocalAudioPlayback: true,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        systemAudio: 'include',
        monitorTypeSurfaces: 'exclude',
        windowAudio: 'window',
      } as unknown as DisplayMediaStreamOptions;
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (captureError) {
      if (!(captureError instanceof DOMException && captureError.name === 'NotAllowedError')) {
        setError('Não foi possível iniciar a captura. Verifique as permissões do navegador e tente novamente.');
      }
      startingShareRef.current = false;
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      setError('O navegador não forneceu uma faixa de vídeo. Tente iniciar o compartilhamento novamente.');
      startingShareRef.current = false;
      return;
    }
    const displaySurface = videoTrack.getSettings().displaySurface as ShareSurface | undefined;
    console.info('[screen-share] captura selecionada', JSON.stringify({
      browser: navigator.userAgent,
      platform: navigator.platform || 'unknown',
      displaySurface: displaySurface || 'unreported',
      audioTrackCount: stream.getAudioTracks().length,
      audioTracks: stream.getAudioTracks().map((track) => ({ label: track.label, contentHint: track.contentHint, settings: track.getSettings() })),
    }));

    if (displaySurface === 'monitor') {
      stream.getTracks().forEach((track) => track.stop());
      setError('Escolha uma janela, não a tela inteira. A transmissão não foi iniciada.');
      startingShareRef.current = false;
      return;
    }
    if (displaySurface !== 'window' && displaySurface !== 'browser') {
      stream.getTracks().forEach((track) => track.stop());
      setError('O navegador não confirmou que a origem é uma janela ou guia. Escolha uma janela no seletor e tente novamente.');
      startingShareRef.current = false;
      return;
    }

    const captureAudio = prepareCaptureAudio(stream, displaySurface);
    const capturedAudioLabels = captureAudio.audioTracks.map((track) => track.label || '—');
    console.info('[screen-share] faixas validadas para WebRTC', JSON.stringify({
      displaySurface,
      audioSource: captureAudio.audioSource,
      videoTrackCount: stream.getVideoTracks().length,
      audioTrackCount: captureAudio.audioTracks.length,
      audioLabels: capturedAudioLabels,
    }));
    setAudioSource(captureAudio.audioSource);
    localStreamRef.current = stream;
    videoTrack.addEventListener('ended', () => {
      if (localStreamRef.current === stream) void stopSharing();
    }, { once: true });

    const socket = socketRef.current;
    if (!socket?.connected) {
      stream.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      setError('A conexão com a sala foi perdida. Reconecte-se antes de compartilhar.');
      startingShareRef.current = false;
      return;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    const result = await emitAck(socket, 'broadcast:start', {
      roomId,
      audioSource: captureAudio.audioSource,
      hasAudio: captureAudio.audioTracks.length > 0,
    });
    if (!result.ok) {
      stream.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      setAudioSource(null);
      setError(result.error || 'Outra pessoa já está compartilhando. Aguarde a transmissão terminar.');
      startingShareRef.current = false;
      return;
    }
    if (videoTrack.readyState !== 'live' || localStreamRef.current !== stream) {
      stream.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      await emitAck(socket, 'broadcast:stop', { roomId }, 3_000);
      startingShareRef.current = false;
      return;
    }

    sharerIdRef.current = selfIdRef.current;
    setSharerId(selfIdRef.current);
    setLocalSharing(true);
    const mesh = peerMeshRef.current;
    mesh?.setSharer(selfIdRef.current);
    const viewers = participantsRef.current.filter((person) => person.id !== selfIdRef.current).map((person) => person.id);
    if (mesh) await mesh.startSharing(stream, viewers);
    setCaptureDebug({
      browser: navigator.userAgent,
      platform: navigator.platform || '—',
      surface: displaySurface,
      audioLabels: capturedAudioLabels,
      viewerCount: viewers.length,
    });
    startingShareRef.current = false;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2_200);
  }

  function toggleAudio() {
    const nextEnabled = !audioEnabled;
    setAudioEnabled(nextEnabled);
    audioEnabledRef.current = nextEnabled;
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.muted = !nextEnabled;
    if (nextEnabled) void audio.play().then(() => setPlaybackBlocked(false), () => setPlaybackBlocked(true));
  }

  function unlockPlayback() {
    setAudioEnabled(true);
    audioEnabledRef.current = true;
    if (remoteVideoRef.current) void remoteVideoRef.current.play();
    const audio = remoteAudioRef.current;
    if (audio) {
      audio.muted = false;
      void audio.play().then(() => setPlaybackBlocked(false), () => setPlaybackBlocked(true));
    }
  }

  function revealViewerControls() {
    setViewerControlsVisible(true);
    if (viewerControlsTimerRef.current !== null) window.clearTimeout(viewerControlsTimerRef.current);
    viewerControlsTimerRef.current = window.setTimeout(() => {
      setViewerControlsVisible(false);
      viewerControlsTimerRef.current = null;
    }, 2800);
  }

  function hideViewerControls() {
    if (viewerControlsTimerRef.current !== null) window.clearTimeout(viewerControlsTimerRef.current);
    viewerControlsTimerRef.current = null;
    setViewerControlsVisible(false);
  }

  function sendReaction(emoji: ReactionEmoji) {
    const socket = socketRef.current;
    const now = Date.now();
    if (!joinedRef.current || !socket?.connected || now - lastReactionAtRef.current < 350) return;
    lastReactionAtRef.current = now;
    socket.emit('reaction:send', { emoji });
  }

  async function toggleFullscreen() {
    const video = remoteVideoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    }) | null;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (video?.webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.();
        return;
      }
      if (stageRef.current?.requestFullscreen) {
        await stageRef.current.requestFullscreen();
        return;
      }
      if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        return;
      }
      setError('Este navegador não oferece tela cheia para a transmissão.');
    } catch {
      setError('Não foi possível abrir a transmissão em tela cheia. Tente novamente.');
    }
  }

  useEffect(() => {
    const video = remoteVideoRef.current as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null;
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement || video?.webkitDisplayingFullscreen));
    const enterVideoFullscreen = () => setIsFullscreen(true);
    const exitVideoFullscreen = () => setIsFullscreen(false);
    document.addEventListener('fullscreenchange', updateFullscreen);
    video?.addEventListener('webkitbeginfullscreen', enterVideoFullscreen);
    video?.addEventListener('webkitendfullscreen', exitVideoFullscreen);
    updateFullscreen();
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreen);
      video?.removeEventListener('webkitbeginfullscreen', enterVideoFullscreen);
      video?.removeEventListener('webkitendfullscreen', exitVideoFullscreen);
    };
  }, [joined, sharerId]);

  useEffect(() => () => {
    if (viewerControlsTimerRef.current !== null) window.clearTimeout(viewerControlsTimerRef.current);
    for (const timer of reactionTimersRef.current.values()) window.clearTimeout(timer);
    reactionTimersRef.current.clear();
  }, []);

  const participantNames = new Map(participants.map((person) => [person.id, person.name]));

  return (
    <main className="room-shell">
      <header className="room-header">
        <button className="room-brand" onClick={onHome} aria-label="Voltar ao início">
          <span className="mini-mark"><i /><i /><i /></span><span className="room-wordmark"><strong>Carpe Diem</strong><small>RPG</small></span>
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
            <section
              ref={stageRef}
              className={`stage ${sharerId ? 'stage-live' : ''} ${viewerControlsVisible ? 'stage-controls-visible' : ''}`}
              onPointerMove={revealViewerControls}
              onPointerDown={revealViewerControls}
              onPointerLeave={(event) => { if (event.pointerType === 'mouse') hideViewerControls(); }}
            >
              {sharerId ? (
                <>
                  <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline controls={false} muted />
                  <div className="viewer-overlay">
                    {sharerId === selfId && (
                      <div className="self-preview"><Icon name="screen" /><span>Sua janela está sendo compartilhada</span><small>Os participantes da sala podem assistir</small></div>
                    )}
                    {sharerId !== selfId && (
                      <>
                        <div className="live-tag"><i /> AO VIVO</div>
                        <button
                          className="fullscreen-button"
                          onClick={() => void toggleFullscreen()}
                          aria-label={isFullscreen ? 'Sair da tela cheia' : 'Assistir em tela cheia'}
                          aria-pressed={isFullscreen}
                          title={isFullscreen ? 'Sair da tela cheia' : 'Assistir em tela cheia'}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={isFullscreen ? 'M8 3v5H3M16 3v5h5M8 21v-5H3m13 5v-5h5' : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'} /></svg>
                          <span>{isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</span>
                        </button>
                        {playbackBlocked && (
                          <button className="playback-button" onClick={unlockPlayback}>
                            {remoteHasAudio ? 'Ativar áudio da transmissão' : 'Reproduzir transmissão'}
                          </button>
                        )}
                        {remoteHasAudio === false && <div className="audio-caption">{describeAudioSource(audioSource)}</div>}
                      </>
                    )}
                    <div className="reaction-picker" role="group" aria-label="Enviar reação">
                      {REACTIONS.map(({ emoji, label }) => (
                        <button key={emoji} className="reaction-button" onClick={() => sendReaction(emoji)} aria-label={`Enviar reação: ${label}`} title={label}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="floating-reactions" aria-hidden="true">
                    {floatingReactions.map((reaction, index) => (
                      <span key={reaction.id} className="floating-reaction" style={{ right: `${12 + (index % 5) * 32}px` }}>{reaction.emoji}</span>
                    ))}
                  </div>
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

            {debugEnabled && (
              <section className="webrtc-debug" aria-label="Diagnóstico WebRTC">
                <div className="webrtc-debug-heading"><strong>Diagnóstico WebRTC</strong><span>{captureDebug ? `${captureDebug.viewerCount} espectador(es)` : `${Object.keys(peerMetrics).length} conexão(ões)`}</span></div>
                {captureDebug && <p>Agente: {captureDebug.browser || '—'} · SO: {captureDebug.platform || '—'} · Origem: {captureDebug.surface || '—'} · Faixas de áudio: {captureDebug.audioLabels.length ? captureDebug.audioLabels.join(', ') : '—'}</p>}
                {Object.values(peerMetrics).length ? Object.values(peerMetrics).map((metric) => (
                  <div className="webrtc-peer" key={metric.peerId}>
                    <strong>{participantNames.get(metric.peerId) || metric.peerId}</strong>
                    <span>PC {metric.connectionState || '—'} · ICE {metric.iceState || '—'}</span>
                    <span>Bitrate {metric.bitrate === null ? '—' : `${(metric.bitrate / 1_000_000).toFixed(2)} Mbps`}</span>
                    <span>RTT {metric.rtt === null ? '—' : `${(metric.rtt * 1_000).toFixed(0)} ms`} · jitter {metric.jitter === null ? '—' : `${(metric.jitter * 1_000).toFixed(1)} ms`}</span>
                    <span>Perda {metric.loss === null ? '—' : `${(metric.loss * 100).toFixed(1)}%`} · FPS {formatMetric(metric.fps)}</span>
                    <span>Resolução {metric.resolution || '—'} · codec {metric.codec || '—'}</span>
                    <span>Encoder {metric.encoder || '—'} · limitação {metric.qualityLimitationReason || '—'}</span>
                  </div>
                )) : <p>Os dados dos peers aparecerão quando houver conexão WebRTC. Métricas não expostas pelo navegador aparecem como —.</p>}
              </section>
            )}

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
                  <button className="button button-primary share-button" onClick={() => void startSharing()} disabled={Boolean(sharerId) || connectionLost} title={sharerId ? 'Aguarde a transmissão terminar' : undefined}>
                    <Icon name="screen" /> Compartilhar janela
                  </button>
                )}
                <button className="button button-leave" onClick={() => void leaveRoom()}><Icon name="leave" /> Sair</button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
