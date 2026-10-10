import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, type Socket } from 'socket.io';

type Participant = { id: string; name: string };
type Room = {
  participants: Map<string, Participant>;
  sharerId: string | null;
  audioSource: 'window' | 'tab' | 'none' | null;
  hasAudio: boolean;
  emptyUntil: number | null;
};
type Ack = (response: Record<string, unknown>) => void;
type SignalKind = 'signal:offer' | 'signal:answer' | 'signal:ice';

const PORT = Number(process.env.PORT || 10000);
const MAX_PARTICIPANTS = 20;
const MAX_ACTIVE_ROOMS = 2_000;
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_SDP_CHARS = 120_000;
const ROOM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_TURN_TTL_SECONDS = 3_600;
type IceServer = { urls: string | string[]; username?: string; credential?: string };
const rooms = new Map<string, Room>();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    return callback(null, !origin || allowedOrigins.includes(origin));
  },
}));
app.get(['/health', '/healthz'], (_request, response) => response.json({ ok: true }));

function getTurnIceServers() {
  const iceServers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = (process.env.TURN_URLS || '').split(/[\s,]+/).map((url) => url.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET || '';
  if (!turnUrls.length || !secret) return iceServers;

  const rawTtl = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || DEFAULT_TURN_TTL_SECONDS);
  const ttl = Number.isFinite(rawTtl) ? Math.max(60, Math.min(86_400, Math.floor(rawTtl))) : DEFAULT_TURN_TTL_SECONDS;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${randomUUID()}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  iceServers.push({ urls: turnUrls, username, credential });
  return iceServers;
}

app.get('/api/ice-servers', (_request, response) => response.set('Cache-Control', 'no-store').json({ iceServers: getTurnIceServers() }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      return callback(null, !origin || allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 256 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

const roomCleanup = setInterval(cleanExpiredRooms, 60_000);
roomCleanup.unref();

function getRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = { participants: new Map(), sharerId: null, audioSource: null, hasAudio: false, emptyUntil: null };
    rooms.set(roomId, room);
  }
  return room;
}

function cleanExpiredRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.participants.size === 0 && room.emptyUntil !== null && room.emptyUntil <= now) rooms.delete(roomId);
  }
}

function createRoomId(): string {
  cleanExpiredRooms();
  if (rooms.size >= MAX_ACTIVE_ROOMS) throw new Error('Room capacity reached');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let id = '';
    while (id.length < 6) {
      for (const byte of randomBytes(12)) {
        if (byte >= 224) continue;
        id += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
        if (id.length === 6) break;
      }
    }
    if (!rooms.has(id)) return id;
  }
  throw new Error('Unable to allocate a room ID');
}

function ack(acknowledge: unknown, response: Record<string, unknown>) {
  if (typeof acknowledge === 'function') (acknowledge as Ack)(response);
}

function safeSignalPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_SIGNAL_BYTES;
  } catch {
    return false;
  }
}

function getSignalInput(payload: unknown) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function validDescription(kind: SignalKind, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const description = value as Record<string, unknown>;
  const expectedType = kind === 'signal:offer' ? 'offer' : kind === 'signal:answer' ? 'answer' : null;
  if (expectedType) {
    return description.type === expectedType
      && typeof description.sdp === 'string'
      && description.sdp.length > 0
      && description.sdp.length <= MAX_SDP_CHARS;
  }
  return typeof description.candidate === 'string'
    && description.candidate.length <= 4_096
    && (description.sdpMid === null || description.sdpMid === undefined || (typeof description.sdpMid === 'string' && description.sdpMid.length <= 256))
    && (description.sdpMLineIndex === null || description.sdpMLineIndex === undefined || (Number.isInteger(description.sdpMLineIndex) && Number(description.sdpMLineIndex) >= 0))
    && (description.usernameFragment === null || description.usernameFragment === undefined || (typeof description.usernameFragment === 'string' && description.usernameFragment.length <= 256));
}

function emitRoomState(roomId: string, room: Room) {
  io.to(roomId).emit('room:state', {
    participants: [...room.participants.values()],
    sharerId: room.sharerId,
    isBroadcasting: Boolean(room.sharerId),
    audioSource: room.audioSource,
    hasAudio: room.hasAudio,
  });
}

function endBroadcast(roomId: string, room: Room, participantId: string) {
  if (room.sharerId !== participantId) return;
  room.sharerId = null;
  room.audioSource = null;
  room.hasAudio = false;
  io.to(roomId).emit('broadcast:stopped', { participantId });
  emitRoomState(roomId, room);
}

function leaveCurrentRoom(socket: Socket) {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.data.roomId = undefined;
  if (!room) {
    socket.leave(roomId);
    return;
  }

  const participant = room.participants.get(socket.id);
  if (!participant) {
    socket.leave(roomId);
    return;
  }
  room.participants.delete(socket.id);
  io.to(roomId).emit('peer:left', { participantId: socket.id });
  io.to(roomId).emit('participant:left', { participantId: socket.id });
  endBroadcast(roomId, room, socket.id);
  socket.leave(roomId);
  if (room.participants.size === 0) {
    room.emptyUntil = Date.now() + 15 * 60_000;
    room.sharerId = null;
    room.audioSource = null;
    room.hasAudio = false;
  } else {
    emitRoomState(roomId, room);
  }
}

function routeSignal(socket: Socket, kind: SignalKind, payload: unknown, callback: unknown) {
  const roomId = socket.data.roomId as string | undefined;
  const room = roomId ? rooms.get(roomId) : undefined;
  const input = getSignalInput(payload);
  const targetId = typeof input?.targetId === 'string' ? input.targetId : '';
  const description = input?.description;
  if (!roomId || !room || !input || !safeSignalPayload(payload) || !room.participants.has(socket.id) || !room.participants.has(targetId) || targetId === socket.id || !validDescription(kind, description)) {
    ack(callback, { ok: false, error: 'Sinalização inválida ou participante fora da sala.' });
    return;
  }

  const isSharer = room.sharerId === socket.id;
  const targetIsSharer = room.sharerId === targetId;
  const allowed = kind === 'signal:offer'
    ? isSharer && !targetIsSharer
    : kind === 'signal:answer'
      ? targetIsSharer && !isSharer
      : (isSharer !== targetIsSharer);
  if (!room.sharerId || !allowed) {
    ack(callback, { ok: false, error: 'Sinalização não autorizada para este participante.' });
    return;
  }
  io.to(targetId).emit(kind, { fromParticipantId: socket.id, description });
  ack(callback, { ok: true });
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload: unknown, callback: unknown) => {
    if (!safeSignalPayload(payload)) {
      ack(callback, { ok: false, error: 'Pedido de criação inválido.' });
      return;
    }
    const lastRoomCreatedAt = Number(socket.data.lastRoomCreatedAt || 0);
    if (Date.now() - lastRoomCreatedAt < 2_000) {
      ack(callback, { ok: false, error: 'Aguarde um instante antes de criar outra sala.' });
      return;
    }
    try {
      const roomId = createRoomId();
      const room = getRoom(roomId);
      room.emptyUntil = Date.now() + 15 * 60_000;
      socket.data.lastRoomCreatedAt = Date.now();
      ack(callback, { ok: true, roomId });
    } catch {
      ack(callback, { ok: false, error: 'Não foi possível criar a sala. Tente novamente.' });
    }
  });

  socket.on('room:join', (payload: unknown, callback: unknown) => {
    const input = getSignalInput(payload) || {};
    if (!safeSignalPayload(payload)) {
      ack(callback, { ok: false, error: 'Pedido para entrar na sala inválido.' });
      return;
    }
    const roomId = typeof input.roomId === 'string' ? input.roomId.trim().toUpperCase() : '';
    const rawName = typeof input.name === 'string' ? input.name : '';
    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);

    if (!ROOM_ID_PATTERN.test(roomId)) {
      ack(callback, { ok: false, error: 'O código da sala é inválido.' });
      return;
    }
    if (!name) {
      ack(callback, { ok: false, error: 'Informe um nome válido para entrar.' });
      return;
    }

    leaveCurrentRoom(socket);
    cleanExpiredRooms();
    const room = rooms.get(roomId);
    if (!room) {
      ack(callback, { ok: false, error: 'Esta sala não existe ou o convite expirou. Peça um novo link.' });
      return;
    }
    if (room.participants.size >= MAX_PARTICIPANTS) {
      ack(callback, { ok: false, error: 'Esta sala atingiu o limite máximo de participantes.' });
      return;
    }

    room.emptyUntil = null;
    const participant = { id: socket.id, name };
    const existingParticipants = [...room.participants.values()];
    room.participants.set(socket.id, participant);
    socket.data.roomId = roomId;
    void socket.join(roomId);
    ack(callback, {
      ok: true,
      roomId,
      self: participant,
      participants: [...existingParticipants, participant],
      sharerId: room.sharerId,
      isBroadcasting: Boolean(room.sharerId),
      audioSource: room.audioSource,
      hasAudio: room.hasAudio,
    });
    socket.to(roomId).emit('participant:joined', participant);
    emitRoomState(roomId, room);
  });

  socket.on('room:leave', (_payload: unknown, callback: unknown) => {
    leaveCurrentRoom(socket);
    ack(callback, { ok: true });
  });

  socket.on('broadcast:start', (payload: unknown, callback: unknown) => {
    const input = getSignalInput(payload) || {};
    const roomId = socket.data.roomId as string | undefined;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!safeSignalPayload(payload) || !roomId || input.roomId !== roomId || !room || !room.participants.has(socket.id)) {
      ack(callback, { ok: false, error: 'Entre na sala antes de compartilhar.' });
      return;
    }
    if (room.sharerId && room.sharerId !== socket.id) {
      ack(callback, { ok: false, error: 'Outra pessoa já está compartilhando. Aguarde a transmissão terminar.' });
      return;
    }
    if (!room.sharerId) {
      const audioSources = ['window', 'tab', 'none'];
      if (typeof input.hasAudio !== 'boolean' || !audioSources.includes(String(input.audioSource)) || input.hasAudio !== (input.audioSource !== 'none')) {
        ack(callback, { ok: false, error: 'A origem do áudio da captura é inválida.' });
        return;
      }
      room.sharerId = socket.id;
      room.audioSource = input.audioSource as Room['audioSource'];
      room.hasAudio = input.hasAudio;
      io.to(roomId).emit('broadcast:started', { participantId: socket.id, audioSource: room.audioSource, hasAudio: room.hasAudio });
      emitRoomState(roomId, room);
    }
    ack(callback, { ok: true });
  });

  socket.on('broadcast:stop', (payload: unknown, callback: unknown) => {
    const input = getSignalInput(payload) || {};
    const roomId = socket.data.roomId as string | undefined;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (safeSignalPayload(payload) && roomId && room && input.roomId === roomId && room.sharerId === socket.id) endBroadcast(roomId, room, socket.id);
    ack(callback, { ok: true });
  });

  socket.on('signal:offer', (payload: unknown, callback: unknown) => routeSignal(socket, 'signal:offer', payload, callback));
  socket.on('signal:answer', (payload: unknown, callback: unknown) => routeSignal(socket, 'signal:answer', payload, callback));
  socket.on('signal:ice', (payload: unknown, callback: unknown) => routeSignal(socket, 'signal:ice', payload, callback));

  socket.on('signal:restart', (payload: unknown, callback: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const room = roomId ? rooms.get(roomId) : undefined;
    const input = getSignalInput(payload);
    const targetId = typeof input?.targetId === 'string' ? input.targetId : '';
    if (!roomId || !room || !safeSignalPayload(payload) || !room.participants.has(socket.id) || room.sharerId !== targetId || socket.id === targetId) {
      ack(callback, { ok: false, error: 'Pedido de recuperação inválido.' });
      return;
    }
    io.to(targetId).emit('signal:restart', { fromParticipantId: socket.id });
    ack(callback, { ok: true });
  });

  socket.on('disconnecting', () => leaveCurrentRoom(socket));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Partilha room backend listening on ${PORT}`);
});
