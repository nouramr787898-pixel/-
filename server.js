import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000,
});

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 120 * 1024 * 1024 } });
const port = process.env.PORT || 3000;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// The browser asks the server for ICE/TURN settings so credentials do not need to live in app.js.
app.get('/api/rtc-config', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const turnUrls = (process.env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  } else {
    // Fallback relay entries for the MVP. Production should use your own TURN credentials.
    iceServers.push(
      { urls: 'stun:openrelay.metered.ca:80' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    );
  }

  res.json({ iceServers, iceCandidatePoolSize: 8 });
});

app.post('/api/summarize', upload.single('audio'), async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
  if (!req.file) return res.status(400).json({ error: 'Audio file is required.' });
  const p = req.file.path;
  try {
    const tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(p),
      model: 'gpt-4o-mini-transcribe',
    });
    const transcript = tr.text?.trim() || '';
    if (!transcript) return res.status(400).json({ error: 'No speech could be transcribed.' });

    const out = await openai.responses.create({
      model: process.env.SUMMARY_MODEL || 'gpt-4.1-mini',
      instructions: 'لخص نص الاجتماع وأعد JSON صالح فقط بالشكل التالي: {"title":"عنوان قصير","summary":"ملخص واضح بالعربية","keyPoints":[""],"decisions":[""],"actions":[{"task":"","owner":"","deadline":""}],"followUps":[""]}. لا تخترع أي أسماء أو قرارات أو مواعيد لم تُذكر.',
      input: transcript,
    });

    let raw = out.output_text?.trim() || '{}';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    let summary;
    try { summary = JSON.parse(raw); }
    catch { summary = { title: 'ملخص الاجتماع', summary: raw, keyPoints: [], decisions: [], actions: [], followUps: [] }; }
    res.json({ transcript, summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || 'AI processing failed.' });
  } finally {
    fs.unlink(p, () => {});
  }
});

const rooms = new Map();
function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { hostId: null, participants: new Map(), pending: new Map() });
  return rooms.get(roomId);
}
function publicParticipant(id, p) {
  return { id, name: p.name, mic: p.mic, cam: p.cam };
}
function roomParticipants(room) {
  return [...room.participants.entries()].map(([id, p]) => publicParticipant(id, p));
}
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room-state', { hostId: room.hostId, participants: roomParticipants(room) });
}
function removeSocketFromRoom(socket, roomId, notify = true) {
  const room = rooms.get(roomId);
  if (!room) return;
  const existed = room.participants.delete(socket.id);
  socket.leave(roomId);
  if (existed && notify) socket.to(roomId).emit('user-left', { id: socket.id });
  if (room.hostId === socket.id) {
    io.to(roomId).emit('room-ended');
    for (const id of room.pending.keys()) io.to(id).emit('room-unavailable');
    rooms.delete(roomId);
  } else {
    broadcastState(roomId);
  }
}

io.on('connection', socket => {
  socket.on('host-join', ({ roomId, name }) => {
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (room.hostId && room.hostId !== socket.id) {
      socket.emit('room-unavailable');
      return;
    }
    room.hostId = socket.id;
    room.participants.set(socket.id, { name: name || 'صاحب الاجتماع', mic: true, cam: true });
    socket.data.roomId = roomId;
    socket.data.name = name || 'صاحب الاجتماع';
    socket.data.approved = true;
    socket.join(roomId);
    socket.emit('host-ready', { roomId });
    broadcastState(roomId);
  });

  socket.on('request-join', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room || !room.hostId) {
      socket.emit('room-unavailable');
      return;
    }
    const cleanName = (name || 'مشارك').trim().slice(0, 40) || 'مشارك';
    room.pending.set(socket.id, { name: cleanName });
    socket.data.requestedRoom = roomId;
    socket.data.name = cleanName;
    io.to(room.hostId).emit('join-request', { id: socket.id, name: cleanName });
  });

  socket.on('cancel-join', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.pending.delete(socket.id) && room.hostId) {
      io.to(room.hostId).emit('join-request-cancelled', { id: socket.id });
    }
  });

  // Approval is completed fully on the server. The guest no longer needs a second "approved-join" round trip.
  socket.on('approve-join', ({ roomId, target }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const pending = room.pending.get(target);
    const guest = io.sockets.sockets.get(target);
    if (!pending || !guest) return;

    const existingUsers = roomParticipants(room);
    room.pending.delete(target);
    room.participants.set(target, { name: pending.name, mic: true, cam: true });
    guest.data.roomId = roomId;
    guest.data.name = pending.name;
    guest.data.approved = true;
    guest.data.requestedRoom = null;
    guest.join(roomId);

    // Guest receives the full current room and initiates one offer to each existing user.
    guest.emit('join-approved', { roomId, existingUsers });
    guest.to(roomId).emit('user-joined', { id: target, name: pending.name });
    broadcastState(roomId);
  });

  socket.on('reject-join', ({ roomId, target }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.pending.delete(target);
    io.to(target).emit('join-rejected');
  });

  socket.on('media-state', ({ roomId, mic, cam }) => {
    const room = rooms.get(roomId);
    const p = room?.participants.get(socket.id);
    if (!p) return;
    p.mic = !!mic;
    p.cam = !!cam;
    broadcastState(roomId);
  });

  socket.on('signal', ({ target, data }) => {
    if (!target || !socket.data.approved) return;
    const targetSocket = io.sockets.sockets.get(target);
    if (!targetSocket?.data.approved || targetSocket.data.roomId !== socket.data.roomId) return;
    io.to(target).emit('signal', { from: socket.id, data, name: socket.data.name });
  });

  socket.on('leave-room', ({ roomId }) => removeSocketFromRoom(socket, roomId));

  socket.on('end-room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.hostId !== socket.id) return;
    io.to(roomId).emit('room-ended');
    for (const id of room.pending.keys()) io.to(id).emit('room-unavailable');
    rooms.delete(roomId);
  });

  socket.on('disconnect', () => {
    const requested = socket.data.requestedRoom;
    if (requested) {
      const r = rooms.get(requested);
      if (r?.pending.delete(socket.id) && r.hostId) io.to(r.hostId).emit('join-request-cancelled', { id: socket.id });
    }
    if (socket.data.roomId) removeSocketFromRoom(socket, socket.data.roomId);
  });
});

server.listen(port, () => console.log(`AI Meeting Platform running on port ${port}`));
