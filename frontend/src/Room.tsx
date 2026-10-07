import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { backendUrl, getIceServers, roomPath } from './config';
import type { Participant, ServerAck } from './types';

type JoinResult = ServerAck<{
  roomId: string;
  self: Participant;
  participants: Participant[];
  sharerId: string | null;
  audioSource: ShareAudioSource | null;
}>;
type PeerSignal = { from: string; signal: { type: 'offer' | 'answer' | 'candidate'; value: RTCSessionDescriptionInit | RTCIceCandidateInit } };
type ShareAudioSource = 'system' | 'tab' | 'window' | 'none';
type ShareSurface = 'monitor' | 'browser' | 'window' | 'unknown';
type ShareStarted = { participantId: string; audioSource: ShareAudioSource };
type WebRtcStatsItem = { id?: string; type: string; [key: string]: unknown };
type PeerDiagnostic = {
  peerId: string;
  connectionState: string;
  iceState: string;
  sentBitrate: number;
  receivedBitrate: number;
  availableOutgoingBitrate?: number;
  roundTripTime?: number;
  jitter?: number;
  packetLoss?: number;
  fps?: number;
  width?: number;
  height?: number;
  framesSent?: number;
  framesLost?: number;
  framesDecoded?: number;
  framesDropped?: number;
  codec?: string;
  encoder?: string;
  encodeMillisecondsPerFrame?: number;
  qualityReason?: string;
  adaptationLevel?: number;
  bitrateLimit?: number;
};
type PreviousPeerCounters = { sampledAt: number; bytesSent: number; bytesReceived: number };
type AdaptiveQualityState = {
  level: number;
  healthySamples: number;
  appliedBitrate?: number;
  appliedFramerate?: number;
  appliedScale?: number;
};

const MAX_PEER_VIDEO_BITRATE = 4_000_000;
const TOTAL_MESH_VIDEO_BUDGET = 12_000_000;
const MIN_PEER_VIDEO_BITRATE = 250_000;
const CAPTURE_FRAME_RATE = 30;
const DEBUG_WEBRTC = new URLSearchParams(window.location.search).get('debug') === 'webrtc';
const ADAPTATION_LEVELS = [
  { factor: 1, framerate: 30, scale: 1 },
  { factor: 0.8, framerate: 30, scale: 1.2 },
  { factor: 0.66, framerate: 24, scale: 1.35 },
  { factor: 0.5, framerate: 15, scale: 1.6 },
];

function numberStat(stat: WebRtcStatsItem | undefined, key: string) {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringStat(stat: WebRtcStatsItem | undefined, key: string) {
  const value = stat?.[key];
  return typeof value === 'string' ? value : undefined;
}

function initialVideoBitrateForMesh(peerCount: number) {
  return Math.max(MIN_PEER_VIDEO_BITRATE, Math.min(MAX_PEER_VIDEO_BITRATE, Math.floor(TOTAL_MESH_VIDEO_BUDGET / Math.max(1, peerCount))));
}

async function applyVideoSenderProfile(sender: RTCRtpSender, bitrate: number, framerate: number, scale: number) {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return false;
  parameters.degradationPreference = 'maintain-framerate';
  parameters.encodings[0].maxBitrate = bitrate;
  parameters.encodings[0].maxFramerate = framerate;
  parameters.encodings[0].scaleResolutionDownBy = scale;
  await sender.setParameters(parameters);
  return true;
}

function normalizedAudioTrackLabel(track: MediaStreamTrack) {
  return track.label.trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isApplicationAudioTrack(track: MediaStreamTrack) {
  const label = normalizedAudioTrackLabel(track);
  if (isSystemAudioTrack(track)) return false;
  return /(?:application|app|window|janela|aplicativo|aplicacao).*(?:audio|sound|som)|(?:audio|sound|som).*(?:application|app|window|janela|aplicativo|aplicacao)/.test(label);
}

function isSystemAudioTrack(track: MediaStreamTrack) {
  const label = normalizedAudioTrackLabel(track);
  return /system audio|desktop audio|audio do sistema|audio do computador|som do sistema|som do computador|audio geral/.test(label);
}

function supportsChromiumWindowAudioPreference() {
  const chromiumVersion = navigator.userAgent.match(/(?:Edg|Chrome)\/(\d+)/)?.[1];
  return Number(chromiumVersion) >= 141;
}

function discardAudioTracks(stream: MediaStream, tracks: MediaStreamTrack[]) {
  for (const track of tracks) {
    stream.removeTrack(track);
    track.stop();
  }
}

function prepareCaptureAudio(stream: MediaStream) {
  const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface as ShareSurface | undefined;
  const surface: ShareSurface = displaySurface === 'monitor' || displaySurface === 'browser' || displaySurface === 'window'
    ? displaySurface
    : 'unknown';
  const audioTracks = stream.getAudioTracks();
  const liveAudioTracks = audioTracks.filter((track) => track.readyState === 'live');
  let audioSource: ShareAudioSource = 'none';
  let message = '';

  if (surface === 'unknown') {
    discardAudioTracks(stream, audioTracks);
    message = 'Não foi possível identificar a origem da captura. A tela está sendo transmitida sem áudio por segurança.';
  } else if (surface === 'window') {
    const isolatedWindowAudio = liveAudioTracks.filter(isApplicationAudioTrack);
    const audioTrackLabel = liveAudioTracks.map((track) => track.label.trim()).filter(Boolean).join(', ');
    const hasSystemAudio = liveAudioTracks.some(isSystemAudioTrack);
    // Chromium 141+ supports windowAudio:'window'. Some builds return a generic
    // track label for app loopback; accept one such track only on those builds,
    // while still rejecting a track explicitly identified as system audio.
    const unclassifiedWindowAudio = isolatedWindowAudio.length === 0
      && liveAudioTracks.length === 1
      && !hasSystemAudio
      && supportsChromiumWindowAudioPreference()
      ? liveAudioTracks
      : [];
    const acceptedWindowAudio = isolatedWindowAudio.length > 0 ? isolatedWindowAudio : unclassifiedWindowAudio;
    discardAudioTracks(stream, audioTracks.filter((track) => !acceptedWindowAudio.includes(track)));

    if (isolatedWindowAudio.length > 0) {
      audioSource = 'window';
      const acceptedLabels = isolatedWindowAudio.map((track) => track.label.trim()).filter(Boolean).join(', ');
      message = `Áudio da janela recebido${acceptedLabels ? ` (${acceptedLabels})` : ''}. O navegador pode capturar outras janelas do mesmo aplicativo.`;
    } else if (unclassifiedWindowAudio.length > 0) {
      audioSource = 'window';
      message = `O navegador entregou uma faixa de áudio para a janela${audioTrackLabel ? ` (“${audioTrackLabel}”)` : ''}. Ela foi encaminhada com a preferência windowAudio:"window"; o navegador não identificou a faixa pelo rótulo, então o isolamento depende do suporte dele.`;
    } else if (hasSystemAudio) {
      message = `O navegador forneceu “${audioTrackLabel || 'áudio do sistema'}” para esta janela. Essa faixa foi bloqueada para não transmitir sons de outros aplicativos; a janela seguirá sem áudio.`;
    } else if (liveAudioTracks.length > 0) {
      message = `O navegador forneceu uma faixa${audioTrackLabel ? ` (“${audioTrackLabel}”)` : ''}, mas não identificou que ela pertence à janela. Ela foi bloqueada por segurança; a janela seguirá sem áudio.`;
    } else {
      message = 'O navegador não disponibilizou uma faixa de áudio isolada para esta janela. Confira se a opção de compartilhar áudio da janela está marcada no seletor do navegador e se o Edge/Chrome está atualizado; áudio do sistema inteiro continuará bloqueado neste modo.';
    }
  } else if (liveAudioTracks.length > 0) {
    audioSource = surface === 'monitor' ? 'system' : 'tab';
    message = audioSource === 'system'
      ? 'Áudio do sistema inteiro incluído na transmissão.'
      : 'Somente o áudio da aba selecionada foi incluído.';
  } else {
    discardAudioTracks(stream, audioTracks);
    message = surface === 'monitor'
      ? 'A tela está sendo transmitida sem áudio do sistema; o navegador não disponibilizou uma faixa de áudio.'
      : 'A aba está sendo transmitida sem áudio; o navegador não disponibilizou uma faixa separada para ela.';
  }

  return { audioSource, message };
}

function describeAudioSource(source: ShareAudioSource | null) {
  switch (source) {
    case 'system': return 'Áudio do sistema inteiro incluído na transmissão.';
    case 'tab': return 'Somente o áudio da aba selecionada foi incluído.';
    case 'window': return 'Áudio específico do aplicativo associado à janela selecionada incluído; o navegador pode capturar outras janelas do mesmo aplicativo.';
    case 'none': return 'Esta origem não disponibilizou áudio isolado; a transmissão está sem áudio.';
    default: return 'O áudio depende da origem selecionada e do que o navegador disponibilizar.';
  }
}

function Icon({ name }: { name: 'screen' | 'copy' | 'leave' | 'sound' | 'users' | 'lock' | 'spark' | 'fullscreen' | 'exitFullscreen' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'screen') return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>;
  if (name === 'leave') return <svg {...common}><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>;
  if (name === 'sound') return <svg {...common}><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>;
  if (name === 'lock') return <svg {...common}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3"/></svg>;
  if (name === 'spark') return <svg {...common}><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"/></svg>;
  if (name === 'fullscreen') return <svg {...common}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>;
  if (name === 'exitFullscreen') return <svg {...common}><path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3"/></svg>;
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
  const [peerDiagnostics, setPeerDiagnostics] = useState<PeerDiagnostic[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const nameRef = useRef(name);
  const selfIdRef = useRef('');
  const sharerIdRef = useRef<string | null>(null);
  const audioEnabledRef = useRef(audioEnabled);
  nameRef.current = name;
  sharerIdRef.current = sharerId;
  audioEnabledRef.current = audioEnabled;
  const mountedRef = useRef(true);
  const joinedRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef(new Map<string, RTCPeerConnection>());
  const peerCreations = useRef(new Map<string, Promise<RTCPeerConnection>>());
  const peerEpochs = useRef(new Map<string, number>());
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
  const previousPeerCounters = useRef(new Map<string, PreviousPeerCounters>());
  const adaptiveQuality = useRef(new Map<string, AdaptiveQualityState>());
  const recoveryTimers = useRef(new Map<string, number>());
  const recoveryAttempts = useRef(new Map<string, number>());
  const schedulePeerRecoveryRef = useRef<(peerId: string) => void>(() => undefined);
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);

  const sharer = useMemo(() => participants.find((person) => person.id === sharerId), [participants, sharerId]);
  const isSharing = joined && localSharing;
  const shareUrl = `${window.location.origin}${roomPath(roomId)}`;

  useEffect(() => {
    const updateFullscreenState = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', updateFullscreenState);
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);

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
    previousPeerCounters.current.delete(peerId);
    adaptiveQuality.current.delete(peerId);
    const recoveryTimer = recoveryTimers.current.get(peerId);
    if (recoveryTimer !== undefined) {
      window.clearTimeout(recoveryTimer);
      recoveryTimers.current.delete(peerId);
    }
  }, []);

  const closeAllPeers = useCallback(() => {
    const peerIds = new Set([...peerConnections.current.keys(), ...peerCreations.current.keys()]);
    for (const peerId of peerIds) closePeer(peerId);
    recoveryAttempts.current.clear();
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
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setParticipants([]);
    setJoined(false);
    setSharerId(null);
    setLocalSharing(false);
    setAudioSource(null);
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
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        const video = remoteVideoRef.current;
        if (!video) return;

        video.muted = true;
        video.srcObject = remoteStream;
        const updateAudio = () => {
          const liveAudioTracks = remoteStream.getAudioTracks().filter((track) => track.readyState === 'live');
          const audio = remoteAudioRef.current;
          setRemoteHasAudio(liveAudioTracks.length > 0);
          if (!audio) return;
          audio.srcObject = liveAudioTracks.length > 0 ? new MediaStream(liveAudioTracks) : null;
          if (liveAudioTracks.length > 0 && audioEnabledRef.current) {
            audio.muted = false;
            void audio.play().then(
              () => setPlaybackBlocked(false),
              () => setPlaybackBlocked(true),
            );
          }
        };
        updateAudio();
        remoteStream.addEventListener('addtrack', updateAudio);
        remoteStream.addEventListener('removetrack', updateAudio);
        event.track.addEventListener('ended', updateAudio, { once: true });
        void video.play().catch(() => setPlaybackBlocked(true));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          recoveryAttempts.current.delete(peerId);
          const retryTimer = recoveryTimers.current.get(peerId);
          if (retryTimer !== undefined) {
            window.clearTimeout(retryTimer);
            recoveryTimers.current.delete(peerId);
          }
        } else if (pc.connectionState === 'disconnected') {
          if (!recoveryTimers.current.has(peerId)) {
            const disconnectTimer = window.setTimeout(() => {
              recoveryTimers.current.delete(peerId);
              if (pc.connectionState !== 'disconnected') return;
              if (stream && localStreamRef.current === stream) {
                schedulePeerRecoveryRef.current(peerId);
              } else {
                socketRef.current?.emit('rtc:restart-request', { roomId });
                closePeer(peerId);
              }
            }, 5_000);
            recoveryTimers.current.set(peerId, disconnectTimer);
          }
        } else if (pc.connectionState === 'failed') {
          const disconnectTimer = recoveryTimers.current.get(peerId);
          if (disconnectTimer !== undefined) {
            window.clearTimeout(disconnectTimer);
            recoveryTimers.current.delete(peerId);
          }
          if (stream && localStreamRef.current === stream) {
            schedulePeerRecoveryRef.current(peerId);
          } else {
            socketRef.current?.emit('rtc:restart-request', { roomId });
            closePeer(peerId);
          }
        } else if (pc.connectionState === 'closed') {
          closePeer(peerId);
        }
      };

      try {
        if (stream) {
          const senders = stream.getTracks().map((track) => pc.addTrack(track, stream));
          const videoSender = senders.find((sender) => sender.track?.kind === 'video');
          if (videoSender) {
            const peerCount = Math.max(1, participantsRef.current.length - 1);
            try {
              await applyVideoSenderProfile(videoSender, initialVideoBitrateForMesh(peerCount), CAPTURE_FRAME_RATE, 1);
            } catch {
              // The browser's native congestion controller remains the fallback when sender limits are unsupported.
            }
            adaptiveQuality.current.set(peerId, { level: 0, healthySamples: 0 });
          }
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

  const schedulePeerRecovery = useCallback((peerId: string) => {
    if (recoveryTimers.current.has(peerId)) return;
    const attempts = recoveryAttempts.current.get(peerId) || 0;
    if (attempts >= 5) {
      setError('A conexão com um participante caiu. A transmissão continua, mas pode ser necessário entrar novamente na sala.');
      return;
    }
    recoveryAttempts.current.set(peerId, attempts + 1);
    const delay = Math.min(8_000, 750 * (2 ** attempts));
    const timer = window.setTimeout(() => {
      recoveryTimers.current.delete(peerId);
      closePeer(peerId);
      if (localStreamRef.current && joinedRef.current) {
        void createPeer(peerId, true).catch(() => {
          if ((recoveryAttempts.current.get(peerId) || 0) >= 5) {
            setError('Não foi possível restabelecer a conexão de vídeo com um participante.');
          } else {
            schedulePeerRecoveryRef.current(peerId);
          }
        });
      }
    }, delay);
    recoveryTimers.current.set(peerId, timer);
  }, [closePeer, createPeer]);
  schedulePeerRecoveryRef.current = schedulePeerRecovery;

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
      setAudioSource(result.sharerId ? result.audioSource : null);
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
      setLocalSharing(false);
      setAudioSource(null);
    });
    socket.on('connect_error', () => setConnectionLost(true));
    socket.on('participant:joined', (participant: Participant) => {
      setParticipants((current) => current.some((person) => person.id === participant.id) ? current : [...current, participant]);
      if (localStreamRef.current && joinedRef.current) void negotiateWith(participant.id);
    });
    socket.on('participant:left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => current.filter((person) => person.id !== participantId));
      recoveryAttempts.current.delete(participantId);
      closePeer(participantId);
    });
    socket.on('stream:started', ({ participantId, audioSource: incomingAudioSource }: ShareStarted) => {
      setSharerId(participantId);
      setAudioSource(incomingAudioSource);
      setRemoteHasAudio(null);
      setPlaybackBlocked(false);
      setError('');
      if (participantId !== selfIdRef.current) {
        closeAllPeers();
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      }
    });
    socket.on('stream:stopped', ({ participantId }: { participantId: string }) => {
      setSharerId((current) => current === participantId ? null : current);
      setAudioSource(null);
      setRemoteHasAudio(false);
      setPlaybackBlocked(false);
      if (participantId === selfIdRef.current) {
        closeAllPeers();
        stopLocalTracks();
        setLocalSharing(false);
        setLocalAudioNotice('');
      } else {
        closePeer(participantId);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      }
    });
    socket.on('rtc:signal', (signal: PeerSignal) => void handleSignal(signal));
    socket.on('rtc:restart-request', ({ from }: { from: string }) => {
      if (from && localStreamRef.current && selfIdRef.current === sharerIdRef.current) {
        schedulePeerRecoveryRef.current(from);
      }
    });

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

  useEffect(() => {
    if (!joined || (!localSharing && !DEBUG_WEBRTC)) {
      setPeerDiagnostics([]);
      previousPeerCounters.current.clear();
      return;
    }

    let cancelled = false;
    let polling = false;
    const pollStats = async () => {
      if (polling || cancelled) return;
      polling = true;
      const rows: PeerDiagnostic[] = [];
      try {
        const peers = [...peerConnections.current.entries()];
        await Promise.all(peers.map(async ([peerId, pc]) => {
          if (pc.connectionState === 'closed') return;
          try {
            const report = await pc.getStats();
            const stats = [...report.values()] as WebRtcStatsItem[];
            const outbound = stats.filter((stat) => stat.type === 'outbound-rtp');
            const inbound = stats.filter((stat) => stat.type === 'inbound-rtp');
            const outboundVideo = outbound.find((stat) => stringStat(stat, 'kind') === 'video' || stringStat(stat, 'mediaType') === 'video');
            const inboundVideo = inbound.find((stat) => stringStat(stat, 'kind') === 'video' || stringStat(stat, 'mediaType') === 'video');
            const remoteInbound = stats.find((stat) => stat.type === 'remote-inbound-rtp' && (stringStat(stat, 'kind') === 'video' || stringStat(stat, 'mediaType') === 'video'));
            const totalBytesSent = outbound.reduce((total, stat) => total + (numberStat(stat, 'bytesSent') || 0), 0);
            const totalBytesReceived = inbound.reduce((total, stat) => total + (numberStat(stat, 'bytesReceived') || 0), 0);
            const now = performance.now();
            const previous = previousPeerCounters.current.get(peerId);
            const seconds = previous ? Math.max(0.001, (now - previous.sampledAt) / 1000) : 0;
            const sentBitrate = previous ? Math.round(((totalBytesSent - previous.bytesSent) * 8) / seconds) : 0;
            const receivedBitrate = previous ? Math.round(((totalBytesReceived - previous.bytesReceived) * 8) / seconds) : 0;
            previousPeerCounters.current.set(peerId, { sampledAt: now, bytesSent: totalBytesSent, bytesReceived: totalBytesReceived });

            const selectedPairId = stats.find((stat) => stat.type === 'transport' && stringStat(stat, 'selectedCandidatePairId'));
            const selectedPair = (selectedPairId && stats.find((stat) => stat.id === stringStat(selectedPairId, 'selectedCandidatePairId')))
              || stats.find((stat) => stat.type === 'candidate-pair' && stat.selected === true)
              || stats.find((stat) => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated === true);
            const availableOutgoingBitrate = numberStat(selectedPair, 'availableOutgoingBitrate');
            const roundTripTime = numberStat(remoteInbound, 'roundTripTime') ?? numberStat(selectedPair, 'currentRoundTripTime');
            const jitter = numberStat(inboundVideo, 'jitter') ?? numberStat(inbound[0], 'jitter');
            const lost = numberStat(remoteInbound, 'packetsLost') ?? numberStat(inboundVideo, 'packetsLost');
            const received = numberStat(remoteInbound, 'packetsReceived') ?? numberStat(inboundVideo, 'packetsReceived');
            const packetLoss = numberStat(remoteInbound, 'fractionLost')
              ?? (lost !== undefined && received !== undefined && lost + received > 0 ? lost / (lost + received) : undefined);
            const codecId = stringStat(outboundVideo, 'codecId') ?? stringStat(inboundVideo, 'codecId');
            const codecStat = codecId ? stats.find((stat) => stat.id === codecId) : undefined;
            const framesEncoded = numberStat(outboundVideo, 'framesEncoded');
            const totalEncodeTime = numberStat(outboundVideo, 'totalEncodeTime');
            const qualityState = adaptiveQuality.current.get(peerId) || { level: 0, healthySamples: 0 };
            const diagnostic: PeerDiagnostic = {
              peerId,
              connectionState: pc.connectionState,
              iceState: pc.iceConnectionState,
              sentBitrate,
              receivedBitrate,
              availableOutgoingBitrate,
              roundTripTime,
              jitter,
              packetLoss,
              fps: numberStat(outboundVideo, 'framesPerSecond') ?? numberStat(inboundVideo, 'framesPerSecond'),
              width: numberStat(outboundVideo, 'frameWidth') ?? numberStat(inboundVideo, 'frameWidth'),
              height: numberStat(outboundVideo, 'frameHeight') ?? numberStat(inboundVideo, 'frameHeight'),
              framesSent: numberStat(outboundVideo, 'framesSent'),
              framesLost: numberStat(inboundVideo, 'framesLost'),
              framesDecoded: numberStat(inboundVideo, 'framesDecoded'),
              framesDropped: numberStat(inboundVideo, 'framesDropped'),
              codec: stringStat(codecStat, 'mimeType'),
              encoder: stringStat(outboundVideo, 'encoderImplementation'),
              encodeMillisecondsPerFrame: framesEncoded && totalEncodeTime ? (totalEncodeTime / framesEncoded) * 1000 : undefined,
              qualityReason: stringStat(outboundVideo, 'qualityLimitationReason'),
              adaptationLevel: qualityState.level,
              bitrateLimit: qualityState.appliedBitrate,
            };

            const videoSender = localSharing ? pc.getSenders().find((sender) => sender.track?.kind === 'video') : undefined;
            if (videoSender && outboundVideo) {
              const activeState = adaptiveQuality.current.get(peerId) || { level: 0, healthySamples: 0 };
              const reason = diagnostic.qualityReason;
              const congested = (packetLoss !== undefined && packetLoss >= 0.06)
                || (roundTripTime !== undefined && roundTripTime > 0.45)
                || (jitter !== undefined && jitter > 0.08)
                || (availableOutgoingBitrate !== undefined && availableOutgoingBitrate < (activeState.appliedBitrate || 800_000) * 0.7)
                || reason === 'cpu'
                || reason === 'bandwidth';
              if (congested) {
                activeState.level = Math.min(ADAPTATION_LEVELS.length - 1, activeState.level + 1);
                activeState.healthySamples = 0;
              } else if (activeState.level > 0) {
                activeState.healthySamples += 1;
                if (activeState.healthySamples >= 5) {
                  activeState.level -= 1;
                  activeState.healthySamples = 0;
                }
              }

              const profile = ADAPTATION_LEVELS[activeState.level];
              const recipientCount = Math.max(1, participantsRef.current.filter((person) => person.id !== selfIdRef.current).length);
              const fairShare = initialVideoBitrateForMesh(recipientCount);
              const pathLimit = availableOutgoingBitrate === undefined ? MAX_PEER_VIDEO_BITRATE : Math.max(MIN_PEER_VIDEO_BITRATE, availableOutgoingBitrate * 0.8);
              const targetBitrate = Math.max(MIN_PEER_VIDEO_BITRATE, Math.floor(Math.min(fairShare, MAX_PEER_VIDEO_BITRATE, pathLimit) * profile.factor));
              const changed = activeState.appliedBitrate === undefined
                || Math.abs(targetBitrate - activeState.appliedBitrate) / activeState.appliedBitrate > 0.1
                || activeState.appliedFramerate !== profile.framerate
                || activeState.appliedScale !== profile.scale;
              if (changed) {
                try {
                  await applyVideoSenderProfile(videoSender, targetBitrate, profile.framerate, profile.scale);
                  activeState.appliedBitrate = targetBitrate;
                  activeState.appliedFramerate = profile.framerate;
                  activeState.appliedScale = profile.scale;
                } catch {
                  // Leave codec selection and congestion control to the browser if sender limits are unavailable.
                }
              }
              adaptiveQuality.current.set(peerId, activeState);
              diagnostic.adaptationLevel = activeState.level;
              diagnostic.bitrateLimit = activeState.appliedBitrate;
            }
            rows.push(diagnostic);
          } catch {
            // A peer can close while getStats is being collected; the next poll will drop it.
          }
        }));
        if (!cancelled && DEBUG_WEBRTC) setPeerDiagnostics(rows.sort((a, b) => a.peerId.localeCompare(b.peerId)));
      } finally {
        polling = false;
      }
    };

    void pollStats();
    const timer = window.setInterval(() => void pollStats(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [joined, localSharing]);

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
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: CAPTURE_FRAME_RATE, max: CAPTURE_FRAME_RATE },
        },
        audio: true,
        systemAudio: 'include',
        windowAudio: 'window',
      } as DisplayMediaStreamOptions & { systemAudio: 'include'; windowAudio: 'window' };
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (captureError) {
      if (captureError instanceof DOMException && captureError.name === 'NotAllowedError') return;
      setError('Não foi possível iniciar a captura. Verifique as permissões do navegador e tente novamente.');
      return;
    }

    const captureAudio = prepareCaptureAudio(stream);
    setLocalAudioNotice(captureAudio.message);
    const videoTrack = stream.getVideoTracks()[0];
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
      await stopSharing();
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    localStreamRef.current = stream;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    setSharerId(selfId);
    setLocalSharing(true);
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
    setLocalSharing(false);
    setAudioSource(null);
    setLocalAudioNotice('');
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
    audioEnabledRef.current = nextEnabled;
    setAudioEnabled(nextEnabled);
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
    const video = remoteVideoRef.current;
    const audio = remoteAudioRef.current;
    if (!video) return;
    audioEnabledRef.current = true;
    setAudioEnabled(true);
    video.muted = true;
    if (audio && remoteHasAudio) {
      audio.muted = false;
      void Promise.all([video.play(), audio.play()]).then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    } else {
      void video.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
  }

  async function toggleFullscreen() {
    const stage = stageRef.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch {
      setError('Não foi possível abrir a transmissão em tela cheia neste navegador.');
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
      <audio ref={remoteAudioRef} className="remote-audio" autoPlay muted={!audioEnabled} aria-hidden="true" />

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
            <section ref={stageRef} className={`stage ${sharerId ? 'stage-live' : ''}`}>
              {sharerId ? (
                <>
                  <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline controls={false} muted />
                  {sharerId === selfId ? (
                    <div className="self-preview"><Icon name="screen" /><span>Sua tela está sendo compartilhada</span><small>Os participantes da sala podem assistir</small></div>
                  ) : (
                    <>
                      <div className="live-tag"><i /> AO VIVO</div>
                      <button className="fullscreen-button" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? 'Sair da tela cheia' : 'Assistir em tela cheia'} title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
                        <Icon name={isFullscreen ? 'exitFullscreen' : 'fullscreen'} /><span>{isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</span>
                      </button>
                    </>
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

            {DEBUG_WEBRTC && (
              <section className="webrtc-debug" aria-label="Diagnóstico WebRTC">
                <div className="webrtc-debug-heading">
                  <strong>Diagnóstico WebRTC</strong>
                  <span>{peerConnections.current.size} conexão(ões) · amostra a cada 2 s</span>
                </div>
                {peerDiagnostics.length === 0 ? (
                  <p>Nenhuma conexão de mídia ativa para medir.</p>
                ) : peerDiagnostics.map((peer) => {
                  const person = participants.find((participant) => participant.id === peer.peerId);
                  return (
                    <div className="webrtc-peer" key={peer.peerId}>
                      <strong>{person?.name || peer.peerId.slice(0, 8)}</strong>
                      <span>PC {peer.connectionState} · ICE {peer.iceState}</span>
                      <span>TX {Math.round(peer.sentBitrate / 1000)} kbps · RX {Math.round(peer.receivedBitrate / 1000)} kbps</span>
                      <span>Disponível {peer.availableOutgoingBitrate === undefined ? '—' : `${Math.round(peer.availableOutgoingBitrate / 1000)} kbps`}</span>
                      <span>RTT {peer.roundTripTime === undefined ? '—' : `${Math.round(peer.roundTripTime * 1000)} ms`} · jitter {peer.jitter === undefined ? '—' : `${Math.round(peer.jitter * 1000)} ms`}</span>
                      <span>Perda {peer.packetLoss === undefined ? '—' : `${(peer.packetLoss * 100).toFixed(1)}%`} · FPS {peer.fps === undefined ? '—' : Math.round(peer.fps)}</span>
                      <span>{peer.width && peer.height ? `${peer.width}×${peer.height}` : 'Resolução —'} · quadros enviados/perdidos/decodificados/descartados {peer.framesSent ?? '—'}/{peer.framesLost ?? '—'}/{peer.framesDecoded ?? '—'}/{peer.framesDropped ?? '—'}</span>
                      <span>Codec {peer.codec || '—'} · encoder {peer.encoder || '—'} · encode {peer.encodeMillisecondsPerFrame === undefined ? '—' : `${peer.encodeMillisecondsPerFrame.toFixed(1)} ms/quadro`}</span>
                      <span>Limite {peer.bitrateLimit === undefined ? '—' : `${Math.round(peer.bitrateLimit / 1000)} kbps`} · adaptação {peer.adaptationLevel ?? 0}/3 · motivo {peer.qualityReason || '—'}</span>
                    </div>
                  );
                })}
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
