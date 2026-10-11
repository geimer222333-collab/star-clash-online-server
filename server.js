const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bots.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'bots.html')));
app.get('/online.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'online.html')));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const waiting = [];
const rooms = new Map();
const players = new Map();
const MAX_PLAYERS = 2;

function safeName(v) {
  return String(v || 'Игрок').replace(/[<>\\u0000-\\u001f]/g, '').trim().slice(0, 16) || 'Игрок';
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, z: p.z, hp: p.hp, hero: p.hero, alive: p.hp > 0 };
}
function removeFromQueue(id) {
  const i = waiting.indexOf(id);
  if (i >= 0) waiting.splice(i, 1);
}
function leaveRoom(socket, notify = true) {
  const p = players.get(socket.id);
  if (!p || !p.room) return;
  const room = rooms.get(p.room);
  if (room) {
    if (notify) socket.to(p.room).emit('match:opponent-left');
    room.ids = room.ids.filter(id => id !== socket.id);
    if (room.ids.length === 0) rooms.delete(p.room);
    else {
      const other = players.get(room.ids[0]);
      if (other) other.room = null;
      rooms.delete(p.room);
    }
  }
  socket.leave(p.room);
  p.room = null;
}
function matchmake() {
  while (waiting.length >= MAX_PLAYERS) {
    const aId = waiting.shift(), bId = waiting.shift();
    const a = players.get(aId), b = players.get(bId);
    if (!a || !b || !a.socket.connected || !b.socket.connected) {
      if (a && a.socket.connected) waiting.unshift(aId);
      if (b && b.socket.connected) waiting.unshift(bId);
      continue;
    }
    const roomId = 'match-' + crypto.randomBytes(5).toString('hex');
    const room = { id: roomId, ids: [aId, bId] };
    rooms.set(roomId, room);
    a.room = b.room = roomId;
    a.x = -5; a.z = 0; a.hp = 100;
    b.x = 5; b.z = 0; b.hp = 100;
    a.socket.join(roomId); b.socket.join(roomId);
    io.to(roomId).emit('match:found', {
      roomId, players: [publicPlayer(a), publicPlayer(b)], tickRate: 20
    });
  }
}
io.on('connection', socket => {
  const p = { id: socket.id, socket, name: 'Игрок', room: null, x: 0, z: 0, hp: 100, hero: 0, lastMove: 0, lastShot: 0 };
  players.set(socket.id, p);
  socket.emit('server:ready', { serverTime: Date.now(), online: players.size, waiting: waiting.length });

  socket.on('queue:join', data => {
    p.name = safeName(data && data.name);
    p.hero = Math.max(0, Math.min(2, Number(data && data.hero) || 0));
    if (p.room) return socket.emit('queue:error', { message: 'Ты уже в матче.' });
    if (waiting.includes(socket.id)) return socket.emit('queue:waiting', { position: waiting.indexOf(socket.id) + 1 });
    waiting.push(socket.id);
    socket.emit('queue:waiting', { position: waiting.length });
    io.emit('server:stats', { online: players.size, waiting: waiting.length });
    matchmake();
  });
  socket.on('queue:cancel', () => {
    removeFromQueue(socket.id);
    socket.emit('queue:cancelled');
    io.emit('server:stats', { online: players.size, waiting: waiting.length });
  });
  socket.on('player:move', data => {
    if (!p.room || !data) return;
    const now = Date.now();
    if (now - p.lastMove < 35) return;
    p.lastMove = now;
    const x = Number(data.x), z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    p.x = Math.max(-17, Math.min(17, x));
    p.z = Math.max(-9, Math.min(9, z));
    p.hero = Math.max(0, Math.min(2, Number(data.hero) || 0));
    socket.to(p.room).emit('player:moved', publicPlayer(p));
  });
  socket.on('player:shot', data => {
    if (!p.room || !data) return;
    const now = Date.now();
    if (now - p.lastShot < 220) return;
    p.lastShot = now;
    const x = Number(data.x), z = Number(data.z), vx = Number(data.vx), vz = Number(data.vz);
    if ([x, z, vx, vz].some(n => !Number.isFinite(n))) return;
    socket.to(p.room).emit('player:shot', { id: p.id, x, z, vx, vz });
  });
  socket.on('player:damage', data => {
    if (!p.room || !data) return;
    const room = rooms.get(p.room);
    if (!room || !room.ids.includes(data.targetId) || data.targetId === p.id) return;
    const target = players.get(data.targetId);
    if (!target || target.hp <= 0) return;
    target.hp = Math.max(0, target.hp - Math.max(1, Math.min(20, Number(data.amount) || 10)));
    io.to(p.room).emit('player:health', { id: target.id, hp: target.hp });
    if (target.hp <= 0) io.to(p.room).emit('match:ended', { winnerId: p.id, loserId: target.id });
  });
  socket.on('match:leave', () => { removeFromQueue(socket.id); leaveRoom(socket); });
  socket.on('disconnect', () => {
    removeFromQueue(socket.id); leaveRoom(socket); players.delete(socket.id);
    io.emit('server:stats', { online: players.size, waiting: waiting.length });
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`STAR CLASH server listening on ${PORT}`));
