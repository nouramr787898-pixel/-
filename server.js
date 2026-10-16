import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { AccessToken } from 'livekit-server-sdk';

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

app.use(express.json({ limit: '2mb' }));
app.use((req,res,next)=>{
  if (req.path.endsWith('.html') || req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/') {
    res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma','no-cache');
    res.set('Expires','0');
  }
  next();
});
app.use(express.static(__dirname, { index: 'index.html', etag: false, maxAge: 0 }));
app.get('/health', (_req, res) => res.json({ ok: true, livekit: !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) }));

const rooms = new Map();
function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { hostId: null, participants: new Map(), pending: new Map() });
  return rooms.get(roomId);
}
function publicParticipant(id, p) { return { id, name: p.name, mic: p.mic, cam: p.cam }; }
function roomParticipants(room) { return [...room.participants.entries()].map(([id,p]) => publicParticipant(id,p)); }
function broadcastState(roomId) {
  const room = rooms.get(roomId); if (!room) return;
  io.to(roomId).emit('room-state', { hostId: room.hostId, participants: roomParticipants(room) });
}
function newMediaKey() { return crypto.randomBytes(24).toString('hex'); }

app.post('/api/livekit-token', async (req, res) => {
  try {
    const { roomId, socketId, mediaKey } = req.body || {};
    const room = rooms.get(roomId);
    const participant = room?.participants.get(socketId);
    if (!room || !participant || participant.mediaKey !== mediaKey) return res.status(403).json({ error: 'Not approved for this meeting.' });
    if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      return res.status(503).json({ error: 'LiveKit is not configured on the server.' });
    }
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: socketId,
      name: participant.name,
      ttl: '2h',
    });
    at.addGrant({ roomJoin: true, room: `meet-${roomId}`, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (e) {
    console.error('token error', e);
    res.status(500).json({ error: 'Could not create media token.' });
  }
});

app.post('/api/summarize', upload.single('audio'), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });
  if (!req.file) return res.status(400).json({ error: 'Audio file is required.' });

  const p = req.file.path;
  try {
    const audioBytes = fs.readFileSync(p).toString('base64');
    const mimeType = req.file.mimetype || 'audio/webm';
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const prompt = `أنت مساعد اجتماعات محترف. استمع إلى تسجيل الاجتماع بالكامل، ثم أعد JSON صالح فقط بدون Markdown بالشكل التالي:
{
  "transcript":"النص الكامل المنطوق في الاجتماع قدر الإمكان",
  "title":"عنوان قصير للاجتماع",
  "summary":"ملخص واضح ومركز بالعربية",
  "keyPoints":["أهم نقطة"],
  "decisions":["قرار تم اتخاذه"],
  "actions":[{"task":"المهمة","owner":"المسؤول إن ذُكر وإلا فارغ","deadline":"الموعد إن ذُكر وإلا فارغ"}],
  "followUps":["نقطة متابعة"]
}
لا تخترع أسماء أو قرارات أو مواعيد لم تُذكر. إذا لم توجد عناصر في قسم معين أعد مصفوفة فارغة. إذا كانت المحادثة بالعربية فاحتفظ بالعربية، وإذا كانت بلغة أخرى فاجعل الملخص بالعربية مع الحفاظ على المعنى.`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: audioBytes } }
          ]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        }
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message || `Gemini API error (${response.status})`;
      throw new Error(message);
    }

    let raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || '';
    raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```$/,'').trim();
    if (!raw) throw new Error('Gemini returned an empty response.');

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('Gemini returned an invalid summary format. Please try again.'); }

    const transcript = parsed.transcript || '';
    const summary = {
      title: parsed.title || 'ملخص الاجتماع',
      summary: parsed.summary || '',
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
    };

    res.json({ transcript, summary, provider: 'gemini', model });
  } catch (e) {
    console.error('Gemini summarize error:', e);
    res.status(500).json({ error: e?.message || 'Gemini processing failed.' });
  } finally {
    fs.unlink(p, () => {});
  }
});

function removeSocketFromRoom(socket, roomId, notify = true) {
  const room = rooms.get(roomId); if (!room) return;
  const existed = room.participants.delete(socket.id);
  socket.leave(roomId);
  if (existed && notify) socket.to(roomId).emit('user-left', { id: socket.id });
  if (room.hostId === socket.id) {
    io.to(roomId).emit('room-ended');
    for (const id of room.pending.keys()) io.to(id).emit('room-unavailable');
    rooms.delete(roomId);
  } else broadcastState(roomId);
}

io.on('connection', socket => {
  socket.on('host-join', ({ roomId, name }) => {
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (room.hostId && room.hostId !== socket.id) return socket.emit('room-unavailable');
    const mediaKey = newMediaKey();
    room.hostId = socket.id;
    room.participants.set(socket.id, { name: name || 'صاحب الاجتماع', mic: true, cam: true, mediaKey });
    Object.assign(socket.data, { roomId, name: name || 'صاحب الاجتماع', approved: true });
    socket.join(roomId);
    socket.emit('host-ready', { roomId, mediaKey });
    broadcastState(roomId);
  });

  socket.on('request-join', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room || !room.hostId) return socket.emit('room-unavailable');
    const cleanName = (name || 'مشارك').trim().slice(0,40) || 'مشارك';
    room.pending.set(socket.id, { name: cleanName });
    Object.assign(socket.data, { requestedRoom: roomId, name: cleanName });
    io.to(room.hostId).emit('join-request', { id: socket.id, name: cleanName });
  });

  socket.on('cancel-join', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.pending.delete(socket.id) && room.hostId) io.to(room.hostId).emit('join-request-cancelled', { id: socket.id });
  });

  socket.on('approve-join', ({ roomId, target }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const pending = room.pending.get(target);
    const guest = io.sockets.sockets.get(target);
    if (!pending || !guest) return;
    const mediaKey = newMediaKey();
    room.pending.delete(target);
    room.participants.set(target, { name: pending.name, mic: true, cam: true, mediaKey });
    Object.assign(guest.data, { roomId, name: pending.name, approved: true, requestedRoom: null });
    guest.join(roomId);
    guest.emit('join-approved', { roomId, mediaKey });
    guest.to(roomId).emit('user-joined', { id: target, name: pending.name });
    broadcastState(roomId);
  });

  socket.on('reject-join', ({ roomId, target }) => {
    const room = rooms.get(roomId); if (!room || room.hostId !== socket.id) return;
    room.pending.delete(target); io.to(target).emit('join-rejected');
  });

  socket.on('media-state', ({ roomId, mic, cam }) => {
    const p = rooms.get(roomId)?.participants.get(socket.id); if (!p) return;
    p.mic = !!mic; p.cam = !!cam; broadcastState(roomId);
  });

  socket.on('leave-room', ({ roomId }) => removeSocketFromRoom(socket, roomId));
  socket.on('end-room', ({ roomId }) => {
    const room = rooms.get(roomId); if (room?.hostId !== socket.id) return;
    io.to(roomId).emit('room-ended'); for (const id of room.pending.keys()) io.to(id).emit('room-unavailable'); rooms.delete(roomId);
  });
  socket.on('disconnect', () => {
    const requested = socket.data.requestedRoom;
    if (requested) { const r=rooms.get(requested); if (r?.pending.delete(socket.id) && r.hostId) io.to(r.hostId).emit('join-request-cancelled',{id:socket.id}); }
    if (socket.data.roomId) removeSocketFromRoom(socket, socket.data.roomId);
  });
});

server.listen(port, () => console.log(`AI Meeting + LiveKit running on port ${port}`));
