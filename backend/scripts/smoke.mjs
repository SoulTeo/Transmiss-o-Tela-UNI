import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const origin = process.env.SMOKE_SERVER_URL || 'http://localhost:10000';
const sockets = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(origin, { transports: ['websocket'], reconnection: false, timeout: 5_000 });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out connecting to signaling server'));
    }, 6_000);
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
    socket.timeout(5_000).emit(event, payload, (error, response) => {
      if (error) reject(new Error(`${event} acknowledgement timed out`));
      else resolve(response);
    });
  });
}

function waitFor(socket, event, predicate = () => true, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function listener(value) {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(value);
    }
    socket.on(event, listener);
  });
}

async function assertNoEvent(socket, event, predicate, durationMs = 150) {
  let received = false;
  const listener = (value) => { if (predicate(value)) received = true; };
  socket.on(event, listener);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  socket.off(event, listener);
  assert.equal(received, false, `${event} should only be routed to its intended recipient`);
}

try {
  const healthResponse = await fetch(`${origin}/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await healthResponse.json()).ok, true);
  const deniedOrigin = await fetch(`${origin}/health`, { headers: { Origin: 'https://unapproved.invalid' } });
  assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal((await (await fetch(`${origin}/healthz`)).json()).ok, true);
  const ice = await (await fetch(`${origin}/api/ice-servers`)).json();
  assert.ok(ice.iceServers.some((server) => String(server.urls).startsWith('stun:')));
  assert.ok(!JSON.stringify(ice).includes(process.env.TURN_SECRET || 'not-configured-secret'));

  const first = await connect();
  const created = await emitAck(first, 'room:create', {});
  assert.equal(created.ok, true);
  assert.match(created.roomId, /^[A-HJ-NP-Z2-9]{6}$/);
  const roomId = created.roomId;
  assert.equal((await emitAck(first, 'room:create', {})).ok, false);
  assert.equal((await emitAck(first, 'room:join', { roomId: '000000', name: 'Teste' })).ok, false);

  const joined = [];
  joined.push({ socket: first, result: await emitAck(first, 'room:join', { roomId, name: 'Pessoa 1' }) });
  assert.equal(joined[0].result.ok, true);
  assert.equal(joined[0].result.mediaToken, undefined);
  assert.equal(joined[0].result.mediaUrl, undefined);
  const second = await connect();
  joined.push({ socket: second, result: await emitAck(second, 'room:join', { roomId, name: 'Pessoa 2' }) });
  const third = await connect();
  joined.push({ socket: third, result: await emitAck(third, 'room:join', { roomId, name: 'Pessoa 3' }) });
  assert.ok(joined.every((entry) => entry.result.ok));

  const rejectedSystemAudio = await emitAck(first, 'broadcast:start', { roomId, audioSource: 'system', hasAudio: true });
  assert.equal(rejectedSystemAudio.ok, false);
  const watcherState = waitFor(second, 'room:state', (state) => state.sharerId === first.id);
  const started = await emitAck(first, 'broadcast:start', { roomId, audioSource: 'window', hasAudio: true });
  assert.equal(started.ok, true);
  await watcherState;
  const duplicateStart = await emitAck(second, 'broadcast:start', { roomId, audioSource: 'none', hasAudio: false });
  assert.equal(duplicateStart.ok, false);
  assert.match(duplicateStart.error, /Outra pessoa já está compartilhando/);

  const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  assert.equal((await emitAck(first, 'signal:offer', { targetId: second.id, description: { type: 'offer', sdp: `${'v='.repeat(60_000)}x` } })).ok, false);
  const offerForSecond = waitFor(second, 'signal:offer', (value) => value.fromParticipantId === first.id);
  const offerForThird = assertNoEvent(third, 'signal:offer', (value) => value.fromParticipantId === first.id, 250);
  const offerAck = await emitAck(first, 'signal:offer', { targetId: second.id, description: offer });
  assert.equal(offerAck.ok, true);
  const deliveredOffer = await offerForSecond;
  assert.equal(deliveredOffer.description.type, 'offer');
  await offerForThird;
  const answerForFirst = waitFor(first, 'signal:answer', (value) => value.fromParticipantId === second.id);
  assert.equal((await emitAck(second, 'signal:answer', { targetId: first.id, description: { type: 'answer', sdp: offer.sdp } })).ok, true);
  assert.equal((await answerForFirst).description.type, 'answer');
  const iceForFirst = waitFor(first, 'signal:ice', (value) => value.fromParticipantId === second.id);
  assert.equal((await emitAck(second, 'signal:ice', { targetId: first.id, description: { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 54400 typ host', sdpMid: '0', sdpMLineIndex: 0 } })).ok, true);
  assert.equal((await iceForFirst).description.sdpMid, '0');
  assert.equal((await emitAck(third, 'signal:offer', { targetId: second.id, description: offer })).ok, false);

  const late = await connect();
  const lateJoin = await emitAck(late, 'room:join', { roomId, name: 'Pessoa que chegou depois' });
  assert.equal(lateJoin.ok, true);
  assert.equal(lateJoin.sharerId, first.id);
  const offerForLate = waitFor(late, 'signal:offer', (value) => value.fromParticipantId === first.id);
  assert.equal((await emitAck(first, 'signal:offer', { targetId: late.id, description: offer })).ok, true);
  await offerForLate;

  const stoppedNotice = waitFor(second, 'broadcast:stopped', (event) => event.participantId === first.id);
  const stoppedState = waitFor(second, 'room:state', (state) => state.sharerId === null);
  assert.equal((await emitAck(first, 'broadcast:stop', { roomId })).ok, true);
  await Promise.all([stoppedNotice, stoppedState]);

  assert.equal((await emitAck(second, 'broadcast:start', { roomId, audioSource: 'none', hasAudio: false })).ok, true);
  const secondId = second.id;
  const peerLeft = waitFor(first, 'peer:left', (event) => event.participantId === secondId);
  const disconnectStop = waitFor(first, 'broadcast:stopped', (event) => event.participantId === secondId);
  second.disconnect();
  await Promise.all([peerLeft, disconnectStop]);

  for (let index = 4; index <= 20; index += 1) {
    const socket = await connect();
    const result = await emitAck(socket, 'room:join', { roomId, name: `Pessoa ${index}` });
    assert.equal(result.ok, true);
    joined.push({ socket, result });
  }
  assert.equal(joined.at(-1).result.participants.length, 20);
  const overflowSocket = await connect();
  const overflow = await emitAck(overflowSocket, 'room:join', { roomId, name: 'Pessoa 21' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /limite máximo/);
  assert.equal((await emitAck(overflowSocket, 'signal:offer', { targetId: first.id, description: offer })).ok, false);

  const roomStateAfterDisconnect = await emitAck(first, 'room:join', { roomId, name: 'Pessoa 1 atualizada' });
  assert.equal(roomStateAfterDisconnect.ok, true);
  assert.equal(roomStateAfterDisconnect.sharerId, null);
  assert.equal(roomStateAfterDisconnect.participants.length, 20);

  console.log('Smoke test passou: health/CORS, ICE STUN, sala e limite de 20, broadcast exclusivo, SDP/ICE endereçados, entrada durante transmissão, stop e disconnect.');
} finally {
  for (const socket of sockets) socket.disconnect();
}
