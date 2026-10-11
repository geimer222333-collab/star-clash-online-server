
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;

const players = new Map();
const rooms = new Map();
const waiting = [];

app.get('/', (req, res) => {
  res.json({
    name: 'STAR CLASH ONLINE',
    status: 'ok',
    online: players.size,
    waiting: waiting.length,
    message: 'Game server is running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    online: players.size,
    waiting: waiting.length,
    uptime: Math.round(process.uptime())
  });
});

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

function broadcastStats() {
  io.emit('server:stats', {
    online: players.size,
    waiting: waiting.length
  });
}

function removeFromQueue(id) {
  let index;
  while ((index = waiting.indexOf(id)) !== -1) {
    waiting.splice(index, 1);
  }
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

    for (const id of room.ids) {
      const other = players.get(id);
      if (other) other.room = null;
    }

    rooms.delete(roomId);
  }

  socket.leave(roomId);
  player.room = null;
}

function matchmake() {
  while (waiting.length >= MAX_PLAYERS) {
    const firstId = waiting.shift();
    const secondId = waiting.shift();

    const first = players.get(firstId);
    const second = players.get(secondId);

    const firstReady = first && first.socket.connected &&
      !first.room;
    const secondReady = second && second.socket.connected &&
      !second.room;

    if (!firstReady && secondReady) {
      waiting.unshift(secondId);
      continue;
    }

    if (firstReady && !secondReady) {
      waiting.unshift(firstId);
      continue;
    }

    if (!firstReady || !secondReady) {
      continue;
    }

    const roomId = 'match-' +
      crypto.randomBytes(6).toString('hex');

    const room = {
      id: roomId,
      ids: [firstId, secondId],
      createdAt: Date.now()
    };

    rooms.set(roomId, room);

    first.room = roomId;
    second.room = roomId;

    first.x = -3;
    first.z = 0;
    first.hp = 100;

    second.x = 3;
    second.z = 0;
    second.hp = 100;

    first.socket.join(roomId);
    second.socket.join(roomId);

    io.to(roomId).emit('match:found', {
      roomId,
      players: [
        publicPlayer(first),
        publicPlayer(second)
      ],
      tickRate: 20
    });
  }

  broadcastStats();
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
    lastShot: 0,
    lastDamage: 0
  };

  players.set(socket.id, player);

  socket.emit('server:ready', {
    serverTime: Date.now(),
    online: players.size,
    waiting: waiting.length
  });

  broadcastStats();

  socket.on('queue:join', data => {
    player.name = safeName(data && data.name);

    const selectedHero = Number(data && data.hero);
    player.hero = Number.isFinite(selectedHero)
      ? Math.max(0, Math.min(9, Math.floor(selectedHero)))
      : 0;

    if (player.room) {
      socket.emit('queue:error', {
        message: 'Ты уже находишься в матче.'
      });
      return;
    }

    if (waiting.includes(socket.id)) {
      socket.emit('queue:waiting', {
        position: waiting.indexOf(socket.id) + 1
      });
      return;
    }

    waiting.push(socket.id);

    socket.emit('queue:waiting', {
      position: waiting.length,
      message: 'Ищем соперника...'
    });

    matchmake();
  });

  socket.on('queue:cancel', () => {
    removeFromQueue(socket.id);

    socket.emit('queue:cancelled');
    broadcastStats();
  });

  socket.on('player:move', data => {
    if (!player.room || !data) return;

    const now = Date.now();
    if (now - player.lastMove < 35) return;

    const x = Number(data.x);
    const z = Number(data.z);

    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return;
    }

    player.lastMove = now;
    player.x = Math.max(-17, Math.min(17, x));
    player.z = Math.max(-17, Math.min(17, z));

    socket.to(player.room).emit(
      'player:moved',
      publicPlayer(player)
    );
  });

  socket.on('player:shot', data => {
    if (!player.room || !data) return;

    const now = Date.now();
    if (now - player.lastShot < 180) return;

    const x = Number(data.x);
    const z = Number(data.z);
    const vx = Number(data.vx);
    const vz = Number(data.vz);

    if ([x, z, vx, vz].some(n => !Number.isFinite(n))) {
      return;
    }

    player.lastShot = now;

    socket.to(player.room).emit('player:shot', {
      id: player.id,
      x: Math.max(-20, Math.min(20, x)),
      z: Math.max(-20, Math.min(20, z)),
      vx: Math.max(-20, Math.min(20, vx)),
      vz: Math.max(-20, Math.min(20, vz))
    });
  });

  socket.on('player:damage', data => {
    if (!player.room || !data) return;

    const room = rooms.get(player.room);
    if (!room || !room.ids.includes(player.id)) return;

    const targetId = String(data.targetId || '');

    if (
      !room.ids.includes(targetId) ||
      targetId === player.id
    ) {
      return;
    }

    const target = players.get(targetId);
    if (!target || target.room !== player.room ||
        target.hp <= 0) {
      return;
    }

    const now = Date.now();
    if (now - player.lastDamage < 200) return;
    player.lastDamage = now;

    const requestedDamage = Number(data.amount);
    const damage = Number.isFinite(requestedDamage)
      ? Math.max(1, Math.min(20, requestedDamage))
      : 10;

    target.hp = Math.max(0, target.hp - damage);

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
    socket.emit('match:left');
    broadcastStats();
    matchmake();
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket, true);
    players.delete(socket.id);
    broadcastStats();
    matchmake();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `STAR CLASH ONLINE server listening on port ${PORT}`
  );
});
