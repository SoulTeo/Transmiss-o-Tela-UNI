import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const origin = process.env.SMOKE_SERVER_URL || 'http://localhost:10000';
const sockets = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(origin, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out connecting to signaling server'));
    }, 6000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      sockets.push(socket);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) reject(new Error(`${event} acknowledgement timed out`));
      else resolve(response);
    });
  });
}

function waitFor(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 3000);
    function listener(value) {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(value);
    }
    socket.on(event, listener);
  });
}

try {
  const [healthResponse, iceResponse] = await Promise.all([
    fetch(`${origin}/healthz`, { headers: { Origin: 'http://localhost:5173' } }),
    fetch(`${origin}/api/ice-servers`),
  ]);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await fetch(`${origin}/healthz`, { headers: { Origin: 'https://unapproved.invalid' } })).headers.get('access-control-allow-origin'), null);
  assert.equal((await healthResponse.json()).ok, true);
  const ice = await iceResponse.json();
  assert.ok(ice.iceServers.some((server) => String(server.urls).startsWith('stun:')));

  const first = await connect();
  const created = await emitAck(first, 'room:create', {});
  assert.equal(created.ok, true);
  assert.match(created.roomId, /^[A-Z2-9]{6}$/);
  const roomId = created.roomId;
  const rateLimited = await emitAck(first, 'room:create', {});
  assert.equal(rateLimited.ok, false);

  const invalidRoom = await emitAck(first, 'room:join', { roomId: '000000', name: 'Teste' });
  assert.equal(invalidRoom.ok, false);
  assert.match(invalidRoom.error, /não existe|expirou/);

  const joined = [await emitAck(first, 'room:join', { roomId, name: 'Pessoa 1' })];
  for (let index = 2; index <= 20; index += 1) {
    const socket = await connect();
    joined.push(await emitAck(socket, 'room:join', { roomId, name: `Pessoa ${index}` }));
  }
  assert.ok(joined.every((result) => result.ok));
  assert.equal(joined.at(-1).participants.length, 20);

  const overflowSocket = await connect();
  const overflow = await emitAck(overflowSocket, 'room:join', { roomId, name: 'Pessoa 21' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /limite máximo/);

  const participantTwo = sockets[1];
  const receivedStarted = waitFor(participantTwo, 'stream:started', (event) => event.participantId === first.id);
  assert.equal((await emitAck(first, 'stream:start', { roomId, audioSource: 'window' })).ok, true);
  assert.equal((await receivedStarted).audioSource, 'window');
  assert.equal((await emitAck(participantTwo, 'stream:start', { roomId })).ok, false);

  const forwardedSignal = waitFor(first, 'rtc:signal', (message) => message.from === participantTwo.id);
  participantTwo.emit('rtc:signal', {
    roomId,
    to: first.id,
    signal: { type: 'answer', value: { type: 'answer', sdp: 'smoke-test' } },
  });
  const forwarded = await forwardedSignal;
  assert.equal(forwarded.signal.type, 'answer');

  const recoveryRequested = waitFor(first, 'rtc:restart-request', (event) => event.from === participantTwo.id);
  participantTwo.emit('rtc:restart-request', { roomId });
  await recoveryRequested;

  const receivedStopped = waitFor(participantTwo, 'stream:stopped', (event) => event.participantId === first.id);
  await emitAck(first, 'stream:stop', { roomId });
  await receivedStopped;
  const receivedSecondStarted = waitFor(sockets[2], 'stream:started', (event) => event.participantId === participantTwo.id);
  assert.equal((await emitAck(participantTwo, 'stream:start', { roomId, audioSource: 'tab' })).ok, true);
  assert.equal((await receivedSecondStarted).audioSource, 'tab');

  const participantTwoId = participantTwo.id;
  const participantLeft = waitFor(first, 'participant:left', (event) => event.participantId === participantTwoId);
  participantTwo.disconnect();
  await participantLeft;
  console.log('Sinalização validada: health/CORS/STUN, sala e limite de criação, código inexistente, 20 participantes, bloqueio de dupla transmissão, eventos WebRTC e pedido de recuperação, parada e desconexão.');
} finally {
  for (const socket of sockets) socket.disconnect();
}
