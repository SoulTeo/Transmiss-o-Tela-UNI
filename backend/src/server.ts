import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

type Participant = { id: string; name: string };
type ShareAudioSource = 'system' | 'tab' | 'window' | 'unknown' | 'none';
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
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const liveKitAdmin = LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
  ? new RoomServiceClient(LIVEKIT_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;
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

function createMediaToken(roomId: string, participantId: string, name: string) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !liveKitAdmin) {
    throw new Error('O serviço de mídia LiveKit não está configurado.');
  }
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantId,
    name,
    ttl: '4h',
  });
  token.addGrant({
    roomJoin: true,
    room: roomId,
    canSubscribe: true,
    canPublish: false,
  });
  return token.toJwt();
}

async function setParticipantPublishPermission(roomId: string, participantId: string, canPublish: boolean) {
  if (!liveKitAdmin) throw new Error('O serviço de mídia LiveKit não está configurado.');
  await liveKitAdmin.updateParticipant(roomId, participantId, {
    permission: {
      canSubscribe: true,
      canPublish,
      canPublishData: false,
      canPublishSources: canPublish ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [],
    },
  });
}
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
    const stoppedSharerId = room.sharerId;
    room.sharerId = null;
    room.audioSource = null;
    io.to(roomId).emit('stream:stopped', { participantId: socket.id });
    void setParticipantPublishPermission(roomId, stoppedSharerId, false).catch((error) => {
      console.error('Failed to revoke LiveKit publish permission after participant left:', error);
    });
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

  socket.on('room:join', async (payload: unknown, callback: unknown) => {
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

    let mediaToken: string;
    try {
      mediaToken = await createMediaToken(roomId, socket.id, name);
    } catch (error) {
      ack(callback, { ok: false, error: error instanceof Error ? error.message : 'Não foi possível autenticar no serviço de mídia.' });
      return;
    }
    if (!socket.connected || rooms.get(roomId) !== room) {
      ack(callback, { ok: false, error: 'A conexão com a sala foi encerrada. Entre novamente.' });
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
      mediaToken,
      mediaUrl: LIVEKIT_URL,
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

  socket.on('stream:start', async (payload: unknown, callback: unknown) => {
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
    try {
      await setParticipantPublishPermission(roomId, socket.id, true);
    } catch (error) {
      if (room.sharerId === socket.id) {
        room.sharerId = null;
        room.audioSource = null;
      }
      console.error('Failed to grant LiveKit publish permission:', error);
      ack(callback, { ok: false, error: 'Não foi possível autorizar a transmissão no serviço de mídia. Tente novamente.' });
      return;
    }
    if (!socket.connected || rooms.get(roomId) !== room || room.sharerId !== socket.id || !room.participants.has(socket.id)) {
      void setParticipantPublishPermission(roomId, socket.id, false).catch((error) => {
        console.error('Failed to revoke LiveKit publish permission after canceled start:', error);
      });
      ack(callback, { ok: false, error: 'A conexão com a sala foi encerrada. Tente novamente.' });
      return;
    }
    io.to(roomId).emit('stream:started', { participantId: socket.id, audioSource });
    ack(callback, { ok: true });
  });

  socket.on('stream:stop', async (payload: unknown, callback: unknown) => {
    const roomId = socket.data.roomId as string | undefined;
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const room = roomId ? rooms.get(roomId) : undefined;
    if (roomId && room && input.roomId === roomId && room.sharerId === socket.id) {
      try {
        await setParticipantPublishPermission(roomId, socket.id, false);
      } catch (error) {
        console.error('Failed to revoke LiveKit publish permission:', error);
      }
      room.sharerId = null;
      room.audioSource = null;
      io.to(roomId).emit('stream:stopped', { participantId: socket.id });
    }
    ack(callback, { ok: true });
  });

  socket.on('disconnecting', () => leaveCurrentRoom(socket));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Partilha room backend listening on ${PORT}`);
});
