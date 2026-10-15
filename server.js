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
const io = new Server(server, { cors: { origin: '*' } });
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 120 * 1024 * 1024 } });
const port = process.env.PORT || 3000;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/summarize', upload.single('audio'), async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY is not configured on the server.' });
  if (!req.file) return res.status(400).json({ error: 'Audio file is required.' });
  const filePath = req.file.path;
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'gpt-4o-mini-transcribe'
    });
    const transcript = transcription.text?.trim() || '';
    if (!transcript) return res.status(400).json({ error: 'No speech could be transcribed.' });

    const response = await openai.responses.create({
      model: process.env.SUMMARY_MODEL || 'gpt-6-luna',
      instructions: `You summarize meeting transcripts. Return ONLY valid JSON with this exact shape:\n{\n  "title": "short meeting title",\n  "summary": "clear Arabic summary",\n  "keyPoints": ["..."],\n  "decisions": ["..."],\n  "actions": [{"task":"...","owner":"...","deadline":"..."}],\n  "followUps": ["..."]\n}\nUse Arabic unless the transcript is clearly mostly another language. Never invent names, deadlines, decisions, or tasks that were not stated; use an empty string or empty list when missing.`,
      input: transcript
    });

    let raw = response.output_text?.trim() || '{}';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    let summary;
    try { summary = JSON.parse(raw); }
    catch { summary = { title: 'ملخص الاجتماع', summary: raw, keyPoints: [], decisions: [], actions: [], followUps: [] }; }

    res.json({ transcript, summary });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || 'AI processing failed.' });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

const roomHosts = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name, isHost }) => {
    if (!roomId) return;
    socket.data.roomId = roomId;
    socket.data.name = name || 'Guest';
    socket.join(roomId);
    if (isHost || !roomHosts.has(roomId)) roomHosts.set(roomId, socket.id);
    const existing = [...(io.sockets.adapter.rooms.get(roomId) || [])].filter(id => id !== socket.id);
    socket.emit('existing-users', existing.map(id => ({ id })));
    socket.to(roomId).emit('user-joined', { id: socket.id, name: socket.data.name });
    io.to(roomId).emit('room-state', { hostId: roomHosts.get(roomId), count: (io.sockets.adapter.rooms.get(roomId) || new Set()).size });
  });

  socket.on('signal', ({ target, data }) => {
    if (target) io.to(target).emit('signal', { from: socket.id, data, name: socket.data.name });
  });

  socket.on('chat-message', ({ roomId, text, name }) => {
    if (roomId && text?.trim()) io.to(roomId).emit('chat-message', { name: name || socket.data.name || 'Guest', text: text.trim(), at: Date.now() });
  });

  socket.on('end-room', ({ roomId }) => {
    if (roomHosts.get(roomId) === socket.id) io.to(roomId).emit('room-ended');
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('user-left', { id: socket.id });
    if (roomHosts.get(roomId) === socket.id) {
      const ids = [...(io.sockets.adapter.rooms.get(roomId) || [])];
      if (ids.length) roomHosts.set(roomId, ids[0]); else roomHosts.delete(roomId);
      io.to(roomId).emit('room-state', { hostId: roomHosts.get(roomId) || null, count: ids.length });
    }
  });
});

server.listen(port, () => console.log(`AI Meeting Platform running on port ${port}`));
