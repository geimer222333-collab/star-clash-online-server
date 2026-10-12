const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket', 'polling'] });
const PORT = process.env.PORT || 3000;
const players = new Map();
const queue = [];
const MATCH_SIZE = 2;

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size, queued: queue.length, uptime: Math.round(process.uptime()) }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function publicPlayer(p) { return { id: p.id, name: p.name, x: p.x, z: p.z, angle: p.angle, hp: p.hp, mode: p.mode }; }
function broadcastState(room) {
  const ids = io.sockets.adapter.rooms.get(room);
  if (!ids) return;
  const list = [...ids].map(id => players.get(id)).filter(Boolean).map(publicPlayer);
  io.to(room).emit('state', { players: list });
}
function removeFromQueue(id) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
}
function tryMatch() {
  while (queue.length >= MATCH_SIZE) {
    const a = queue.shift(), b = queue.shift();
    if (!players.has(a.id) || !players.has(b.id)) continue;
    const room = `match-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const pa = players.get(a.id), pb = players.get(b.id);
    pa.room = room; pb.room = room;
    pa.x = -7; pa.z = 0; pa.hp = 100; pb.x = 7; pb.z = 0; pb.hp = 100;
    io.sockets.sockets.get(a.id)?.join(room);
    io.sockets.sockets.get(b.id)?.join(room);
    io.to(room).emit('match-found', { room, players: [publicPlayer(pa), publicPlayer(pb)] });
    io.to(room).emit('match-message', { message: 'СОПЕРНИК НАЙДЕН! ПОБЕДИ ЕГО!' });
    broadcastState(room);
  }
}
io.on('connection', socket => {
  players.set(socket.id, { id: socket.id, name: 'Игрок', x: 0, z: 0, angle: 0, hp: 100, mode: 'online', room: null, lastMove: 0 });
  socket.emit('welcome', { id: socket.id });
  socket.on('join-queue', data => {
    const p = players.get(socket.id); if (!p) return;
    p.name = String(data?.name || 'Игрок').slice(0, 18);
    p.mode = 'online'; p.hp = 100;
    if (p.room) { socket.leave(p.room); p.room = null; }
    removeFromQueue(socket.id);
    if (!queue.some(q => q.id === socket.id)) queue.push({ id: socket.id, joined: Date.now() });
    socket.emit('queue-status', { message: `ПОИСК СОПЕРНИКА… В ОЧЕРЕДИ: ${queue.length}` });
    tryMatch();
  });
  socket.on('player-ready', data => {
    const p = players.get(socket.id); if (!p) return;
    p.name = String(data?.name || 'Игрок').slice(0, 18);
    p.x = Number.isFinite(data?.x) ? Math.max(-30, Math.min(30, data.x)) : 0;
    p.z = Number.isFinite(data?.z) ? Math.max(-30, Math.min(30, data.z)) : 0;
  });
  socket.on('move', data => {
    const p = players.get(socket.id); if (!p || !p.room) return;
    const now = Date.now(); if (now - p.lastMove < 25) return; p.lastMove = now;
    if (Number.isFinite(data?.x)) p.x = Math.max(-30, Math.min(30, data.x));
    if (Number.isFinite(data?.z)) p.z = Math.max(-30, Math.min(30, data.z));
    if (Number.isFinite(data?.angle)) p.angle = data.angle;
    broadcastState(p.room);
  });
  socket.on('shoot', data => {
    const p = players.get(socket.id); if (!p || !p.room || p.hp <= 0) return;
    const dx = Number(data?.dx) || 0, dz = Number(data?.dz) || 0;
    const length = Math.hypot(dx, dz) || 1, ux = dx / length, uz = dz / length;
    socket.to(p.room).emit('remote-shot', { id: socket.id, x: p.x, z: p.z, dx: ux, dz: uz });
    const ids = io.sockets.adapter.rooms.get(p.room);
    if (!ids) return;
    for (const id of ids) {
      if (id === socket.id) continue;
      const target = players.get(id); if (!target || target.hp <= 0) continue;
      const vx = target.x - p.x, vz = target.z - p.z;
      const dist = Math.hypot(vx, vz);
      const along = vx * ux + vz * uz;
      const cross = Math.abs(vx * uz - vz * ux);
      if (along > 0 && along < 11 && cross < 1.45) {
        target.hp = Math.max(0, target.hp - 20);
        broadcastState(p.room);
        if (target.hp <= 0) {
          io.to(p.room).emit('match-ended', { winnerId: socket.id, loserId: target.id, winnerName: p.name });
        }
        break;
      }
    }
  });
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const p = players.get(socket.id);
    if (p?.room) { socket.to(p.room).emit('player-left', { id: socket.id }); socket.to(p.room).emit('match-message', { message: 'Соперник отключился' }); }
    players.delete(socket.id);
    tryMatch();
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`STAR CLASH server listening on ${PORT}`));
