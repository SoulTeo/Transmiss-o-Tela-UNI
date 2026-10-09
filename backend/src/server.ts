import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, type Socket } from 'socket.io';

type Participant = { id: string; name: string };
type ShareAudioSource = 'system' | 'tab' | 'window' | 'unknown' | 'none';
type IceServer = { urls: string | string[]; username?: string; credential?: string };
type Room = {
  participants: Map<string, Participant>;
  sharerId: string | null;
  audioSource: ShareAudioSource | null;
  emptyUntil: number | null;
};
type Ack = (response: Record<string, unknown>) => void;

const PORT = Number(process.env.PORT || 10000);
const MAX_PARTICIPANTS = 20;
const MAX_ACTIVE_ROOMS = 2_000;
const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map<string, Room>();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    return callback(null, !origin || allowedOrigins.includes(origin));
  },
}));
app.get('/healthz', (_request, response) => response.json({ ok: true }));

function iceServers() {
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((url) => url.trim()).filter(Boolean);
  const servers: IceServer[] = stunUrls.map((url) => ({ urls: url }));
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET;
  let turnConfigured = false;

  if (turnUrls.length && secret) {
    const requestedTtl = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
    const ttlSeconds = Number.isFinite(requestedTtl)
      ? Math.min(86_400, Math.max(300, requestedTtl))
      : 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiry}:${randomBytes(8).toString('hex')}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
    turnConfigured = true;
  }

  return { iceServers: servers, turnConfigured };
}

app.get('/api/ice-servers', (_request, response) => response.json(iceServers()));
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
    room = { participants: new Map(), sharerId: null, audioSource: null, emptyUntil: null };
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
  io.to(roomId).emit('participant:left', { participantId: socket.id });

  if (room.sharerId === socket.id) {
    room.sharerId = null;
    room.audioSource = null;
    io.to(roomId).emit('stream:stopped', { participantId: socket.id });
  }

  socket.leave(roomId);
  if (room.participants.size === 0) {
    room.emptyUntil = Date.now() + 15 * 60_000;
    room.sharerId = null;
    room.audioSource = null;
  }
}

io.on('connection', (socket) => {
  socket.on('room:create', (_payload: unknown, callback: unknown) => {
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
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
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
      audioSource: room.audioSource,
    });
    socket.to(roomId).emit('participant:joined', participant);
    if (room.sharerId) {
      socket.emit('stream:started', { participantId: room.sharerId, audioSource: room.audioSource || 'none' });
    }
  });

  socket.on('room:leave', (_payload: unknown, callback: unknown) => {
    leaveCurrentRoom(socket);
    ack(callback, { ok: true });
  });

  socket.on('stream:start', (payload: unknown, callback: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!roomId || input.roomId !== roomId || !room || !room.participants.has(socket.id)) {
      ack(callback, { ok: false, error: 'Entre na sala antes de compartilhar.' });
      return;
    }
    if (room.sharerId && room.sharerId !== socket.id) {
      ack(callback, { ok: false, error: 'Outra pessoa já está compartilhando. Aguarde a transmissão terminar.' });
      return;
    }
    const audioSources: ShareAudioSource[] = ['system', 'tab', 'window', 'unknown', 'none'];
    const audioSource = audioSources.includes(input.audioSource as ShareAudioSource)
      ? input.audioSource as ShareAudioSource
      : 'none';
    room.sharerId = socket.id;
    room.audioSource = audioSource;
    io.to(roomId).emit('stream:started', { participantId: socket.id, audioSource });
    ack(callback, { ok: true });
  });

  socket.on('stream:stop', (payload: unknown, callback: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const room = roomId ? rooms.get(roomId) : undefined;
    if (roomId && room && input.roomId === roomId && room.sharerId === socket.id) {
      room.sharerId = null;
      room.audioSource = null;
      io.to(roomId).emit('stream:stopped', { participantId: socket.id });
    }
    ack(callback, { ok: true });
  });

  socket.on('rtc:signal', (payload: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const room = roomId ? rooms.get(roomId) : undefined;
    const targetId = typeof input.to === 'string' ? input.to : '';
    const signal = input.signal && typeof input.signal === 'object' ? input.signal as Record<string, unknown> : {};
    const kind = signal.type;
    if (!room || input.roomId !== roomId || !room.participants.has(socket.id) || !room.participants.has(targetId)) return;
    if (!['offer', 'answer', 'candidate'].includes(String(kind))) return;
    if (kind === 'offer' && room.sharerId !== socket.id) return;
    if (kind === 'answer' && room.sharerId !== targetId) return;
    if (kind === 'candidate' && room.sharerId !== socket.id && room.sharerId !== targetId) return;
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(signal)); } catch { return; }
    if (size > 64 * 1024 || !signal.value || typeof signal.value !== 'object') return;
    io.to(targetId).emit('rtc:signal', { from: socket.id, signal });
  });

  socket.on('rtc:restart-request', (payload: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const room = roomId ? rooms.get(roomId) : undefined;
    const sharerId = room?.sharerId;
    if (!room || input.roomId !== roomId || !room.participants.has(socket.id) || !sharerId || sharerId === socket.id) return;
    if (!room.participants.has(sharerId)) return;
    io.to(sharerId).emit('rtc:restart-request', { from: socket.id });
  });

  socket.on('disconnecting', () => leaveCurrentRoom(socket));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Screen-share signaling server listening on ${PORT}`);
});
