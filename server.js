'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'STAR CLASH online server',
    status: 'ok',
    queue: 'available',
    message: 'Connect a game client with Socket.IO to join matchmaking.'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const waiting = [];
const rooms = new Map();
const players = new Map();
const MAX_PLAYERS = 2;
const ARENA_LIMIT = 17;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeName(value) {
  return String(value || 'Игрок')
    .replace(/[<>\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 16) || 'Игрок';
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    z: player.z,
    hp: player.hp,
    hero: player.hero,
    alive: player.hp > 0
  };
}

function emitStats() {
  io.emit('server:stats', { online: players.size, waiting: waiting.length });
}

function removeFromQueue(id) {
  const index = waiting.indexOf(id);
  if (index !== -1) waiting.splice(index, 1);
}

function leaveRoom(socket, notify = true) {
  const player = players.get(socket.id);
  if (!player || !player.room) return;

  const roomId = player.room;
  const room = rooms.get(roomId);
  if (room) {
    if (notify) socket.to(roomId).emit('match:opponent-left');
    room.ids = room.ids.filter(id => id !== socket.id);
    for (const otherId of room.ids) {
      const other = players.get(otherId);
      if (other) other.room = null;
    }
    rooms.delete(roomId);
  }

  socket.leave(roomId);
  player.room = null;
}

function matchmake() {
  while (waiting.length >= MAX_PLAYERS) {
    const aId = waiting.shift();
    const bId = waiting.shift();
    const a = players.get(aId);
    const b = players.get(bId);

    if (!a || !b || !a.socket.connected || !b.socket.connected) {
      if (a && a.socket.connected) waiting.unshift(aId);
      if (b && b.socket.connected) waiting.unshift(bId);
      continue;
    }

    const roomId = `match-${crypto.randomBytes(5).toString('hex')}`;
    const room = { id: roomId, ids: [aId, bId], createdAt: Date.now() };
    rooms.set(roomId, room);

    a.room = roomId;
    b.room = roomId;
    a.x = -3;
    a.z = 0;
    b.x = 3;
    b.z = 0;
    a.hp = 100;
    b.hp = 100;

    a.socket.join(roomId);
    b.socket.join(roomId);

    io.to(roomId).emit('match:found', {
      roomId,
      players: [publicPlayer(a), publicPlayer(b)],
      tickRate: 20
    });
  }
  emitStats();
}

io.on('connection', socket => {
  const player = {
    id: socket.id,
    socket,
    name: 'Игрок',
    room: null,
    x: 0,
    z: 0,
    hp: 100,
    hero: 0,
    lastMove: 0,
    lastShot: 0
  };
  players.set(socket.id, player);

  socket.emit('server:ready', {
    serverTime: Date.now(),
    online: players.size,
    waiting: waiting.length
  });
  emitStats();

  socket.on('queue:join', data => {
    player.name = safeName(data && data.name);
    const heroValue = Number(data && data.hero);
    player.hero = clamp(Number.isFinite(heroValue) ? Math.floor(heroValue) : 0, 0, 9);

    if (player.room) {
      socket.emit('queue:error', { message: 'Ты уже в матче.' });
      return;
    }
    if (waiting.includes(socket.id)) {
      socket.emit('queue:waiting', { position: waiting.indexOf(socket.id) + 1 });
      return;
    }

    waiting.push(socket.id);
    socket.emit('queue:waiting', { position: waiting.length });
    matchmake();
  });

  socket.on('queue:cancel', () => {
    removeFromQueue(socket.id);
    socket.emit('queue:cancelled');
    emitStats();
  });

  socket.on('player:move', data => {
    if (!player.room || !data || player.hp <= 0) return;
    const now = Date.now();
    if (now - player.lastMove < 35) return;
    player.lastMove = now;

    const x = Number(data.x);
    const z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;

    player.x = clamp(x, -ARENA_LIMIT, ARENA_LIMIT);
    player.z = clamp(z, -ARENA_LIMIT, ARENA_LIMIT);
    if (data.hero !== undefined) {
      const heroValue = Number(data.hero);
      if (Number.isFinite(heroValue)) player.hero = clamp(Math.floor(heroValue), 0, 9);
    }
    socket.to(player.room).emit('player:moved', publicPlayer(player));
  });

  socket.on('player:shot', data => {
    if (!player.room || !data || player.hp <= 0) return;
    const now = Date.now();
    if (now - player.lastShot < 180) return;
    player.lastShot = now;

    const x = Number(data.x);
    const z = Number(data.z);
    const vx = Number(data.vx);
    const vz = Number(data.vz);
    if ([x, z, vx, vz].some(value => !Number.isFinite(value))) return;

    socket.to(player.room).emit('player:shot', {
      id: player.id,
      x: clamp(x, -20, 20),
      z: clamp(z, -20, 20),
      vx: clamp(vx, -20, 20),
      vz: clamp(vz, -20, 20)
    });
  });

  // Prototype-only damage event. A production game should calculate hits on the server.
  socket.on('player:damage', data => {
    if (!player.room || !data || player.hp <= 0) return;
    const room = rooms.get(player.room);
    if (!room || !room.ids.includes(data.targetId) || data.targetId === player.id) return;

    const target = players.get(data.targetId);
    if (!target || target.room !== player.room || target.hp <= 0) return;

    const requestedAmount = Number(data.amount);
    const amount = clamp(Number.isFinite(requestedAmount) ? requestedAmount : 10, 1, 20);
    target.hp = Math.max(0, target.hp - amount);
    io.to(player.room).emit('player:health', { id: target.id, hp: target.hp });

    if (target.hp <= 0) {
      io.to(player.room).emit('match:ended', { winnerId: player.id, loserId: target.id });
    }
  });

  socket.on('match:leave', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
    emitStats();
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
    players.delete(socket.id);
    emitStats();
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`STAR CLASH online server listening on ${PORT}`);
});
