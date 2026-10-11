STAR CLASH ONLINE — серверный прототип

Файлы:
- server.js — сервер Express + Socket.IO
- package.json — зависимости и команда запуска

Для Render:
Build Command: npm install
Start Command: npm start

После коммита файлов Render обычно начинает новое развёртывание автоматически.
Проверка сервера:
https://star-clash-online.onrender.com/health

Важно: этот сервер предоставляет очередь подбора игроков и события Socket.IO. Сам по себе он не создаёт клиент игры. Событие player:damage оставлено только для прототипа; для настоящей соревновательной игры урон и попадания нужно рассчитывать на сервере.
