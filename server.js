const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();

// Страницы лежат в корне репозитория, а не в папке public
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/bots.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'bots.html'));
});

app.get('/online.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'online.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime())
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const waiting = [];
const rooms = new Map();
const players = new Map();
const MAX_PLAYERS = 2;

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

function removeFromQueue(id) {
  const index = waiting.indexOf(id);
  if (index >= 0) waiting.splice(index, 1);
}

function leaveRoom(socket, notify = true) {
  const player = players.get(socket.id);
  if (!player || !player.room) return;

  const roomId = player.room;
  const room = rooms.get(roomId);

  if (room) {
    if (notify) {
      socket.to(roomId).emit('match:opponent-left');
    }

    room.ids = room.ids.filter(id => id !== socket.id);

    if (room.ids.length === 0) {
      rooms.delete(roomId);
    } else {
      const other = players.get(room.ids[0]);
      if (other) other.room = null;
      rooms.delete(roomId);
    }
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

    if (
      !a || !b ||
      !a.socket.connected ||
      !b.socket.connected
    ) {
      if (a && a.socket.connected) waiting.unshift(aId);
      if (b && b.socket.connected) waiting.unshift(bId);
      continue;
    }

    const roomId = 'match-' + crypto.randomBytes(5).toString('hex');

    const room = {
      id: roomId,
      ids: [aId, bId]
    };

    rooms.set(roomId, room);

    a.room = roomId;
    b.room = roomId;

    a.x = -5;
    a.z = 0;
    a.hp = 100;

    b.x = 5;
    b.z = 0;
    b.hp = 100;

    a.socket.join(roomId);
    b.socket.join(roomId);

    io.to(roomId).emit('match:found', {
      roomId,
      players: [publicPlayer(a), publicPlayer(b)],
      tickRate: 20
    });
  }

  io.emit('server:stats', {
    online: players.size,
    waiting: waiting.length
  });
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

  socket.on('queue:join', data => {
    player.name = safeName(data && data.name);
    player.hero = Math.max(
      0,
      Math.min(2, Number(data && data.hero) || 0)
    );

    if (player.room) {
      return socket.emit('queue:error', {
        message: 'Ты уже в матче.'
      });
    }

    if (waiting.includes(socket.id)) {
      return socket.emit('queue:waiting', {
        position: waiting.indexOf(socket.id) + 1
      });
    }

    waiting.push(socket.id);

    socket.emit('queue:waiting', {
      position: waiting.length
    });

    matchmake();
  });

  socket.on('queue:cancel', () => {
    removeFromQueue(socket.id);

    socket.emit('queue:cancelled');

    io.emit('server:stats', {
      online: players.size,
      waiting: waiting.length
    });
  });

  socket.on('player:move', data => {
    if (!player.room || !data) return;

    const now = Date.now();
    if (now - player.lastMove < 35) return;
    player.lastMove = now;

    const x = Number(data.x);
    const z = Number(data.z);

    if (!Number.isFinite(x) || !Number.isFinite(z)) return;

    player.x = Math.max(-17, Math.min(17, x));
    player.z = Math.max(-9, Math.min(9, z));

    player.hero = Math.max(
      0,
      Math.min(2, Number(data.hero) || 0)
    );

    socket.to(player.room).emit(
      'player:moved',
      publicPlayer(player)
    );
  });

  socket.on('player:shot', data => {
    if (!player.room || !data) return;

    const now = Date.now();
    if (now - player.lastShot < 220) return;
    player.lastShot = now;

    const x = Number(data.x);
    const z = Number(data.z);
    const vx = Number(data.vx);
    const vz = Number(data.vz);

    if (![x, z, vx, vz].every(Number.isFinite)) return;

    socket.to(player.room).emit('player:shot', {
      id: player.id,
      x,
      z,
      vx,
      vz
    });
  });

  socket.on('player:damage', data => {
    if (!player.room || !data) return;

    const room = rooms.get(player.room);
    if (!room || !room.ids.includes(data.targetId)) return;
    if (data.targetId === player.id) return;

    const target = players.get(data.targetId);
    if (!target || target.hp <= 0) return;

    const amount = Math.max(
      1,
      Math.min(20, Number(data.amount) || 10)
    );

    target.hp = Math.max(0, target.hp - amount);

    io.to(player.room).emit('player:health', {
      id: target.id,
      hp: target.hp
    });

    if (target.hp <= 0) {
      io.to(player.room).emit('match:ended', {
        winnerId: player.id,
        loserId: target.id
      });
    }
  });

  socket.on('match:leave', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
    players.delete(socket.id);

    io.emit('server:stats', {
      online: players.size,
      waiting: waiting.length
    });
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`STAR CLASH server listening on ${PORT}`);
});
