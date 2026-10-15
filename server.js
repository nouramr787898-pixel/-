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

const __filename=fileURLToPath(import.meta.url); const __dirname=path.dirname(__filename);
const app=express(); const server=http.createServer(app); const io=new Server(server,{cors:{origin:'*'}});
const upload=multer({dest:os.tmpdir(),limits:{fileSize:120*1024*1024}}); const port=process.env.PORT||3000;
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
app.use(express.json({limit:'2mb'})); app.use(express.static(__dirname,{index:'index.html'}));
app.get('/health',(_q,r)=>r.json({ok:true}));

app.post('/api/summarize',upload.single('audio'),async(req,res)=>{
  if(!openai)return res.status(503).json({error:'OPENAI_API_KEY is not configured.'});
  if(!req.file)return res.status(400).json({error:'Audio file is required.'});
  const p=req.file.path;
  try{
    const tr=await openai.audio.transcriptions.create({file:fs.createReadStream(p),model:'gpt-4o-mini-transcribe'});
    const transcript=tr.text?.trim()||''; if(!transcript)return res.status(400).json({error:'No speech could be transcribed.'});
    const out=await openai.responses.create({model:process.env.SUMMARY_MODEL||'gpt-4.1-mini',instructions:`لخص نص الاجتماع. أعد JSON صالح فقط بالشكل التالي: {"title":"عنوان قصير","summary":"ملخص واضح بالعربية","keyPoints":[""],"decisions":[""],"actions":[{"task":"","owner":"","deadline":""}],"followUps":[""]}. لا تخترع أي أسماء أو قرارات أو مواعيد لم تُذكر.`,input:transcript});
    let raw=out.output_text?.trim()||'{}'; raw=raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```$/,'').trim();
    let summary; try{summary=JSON.parse(raw)}catch{summary={title:'ملخص الاجتماع',summary:raw,keyPoints:[],decisions:[],actions:[],followUps:[]}}
    res.json({transcript,summary});
  }catch(e){console.error(e);res.status(500).json({error:e?.message||'AI processing failed.'})}finally{fs.unlink(p,()=>{})}
});

const rooms=new Map();
function ensureRoom(roomId){ if(!rooms.has(roomId)) rooms.set(roomId,{hostId:null,participants:new Map(),pending:new Map()}); return rooms.get(roomId); }
function broadcastState(roomId){ const room=rooms.get(roomId); if(!room)return; const participants=[...room.participants.entries()].map(([id,p])=>({id,name:p.name,mic:p.mic,cam:p.cam})); io.to(roomId).emit('room-state',{hostId:room.hostId,participants}); }

io.on('connection',socket=>{
  socket.on('host-join',({roomId,name})=>{
    if(!roomId)return; const room=ensureRoom(roomId); room.hostId=socket.id; room.participants.set(socket.id,{name:name||'صاحب الاجتماع',mic:true,cam:true}); socket.data.roomId=roomId; socket.data.name=name||'صاحب الاجتماع'; socket.data.approved=true; socket.join(roomId); socket.emit('existing-users',[]); broadcastState(roomId);
  });

  socket.on('request-join',({roomId,name})=>{
    const room=rooms.get(roomId); if(!room||!room.hostId){ socket.emit('room-unavailable'); return; }
    room.pending.set(socket.id,{name:name||'مشارك'}); socket.data.requestedRoom=roomId; socket.data.name=name||'مشارك'; io.to(room.hostId).emit('join-request',{id:socket.id,name:socket.data.name});
  });
  socket.on('cancel-join',({roomId})=>{ const room=rooms.get(roomId); if(room?.pending.delete(socket.id)&&room.hostId) io.to(room.hostId).emit('join-request-cancelled',{id:socket.id}); });
  socket.on('approve-join',({roomId,target})=>{ const room=rooms.get(roomId); if(!room||room.hostId!==socket.id)return; const req=room.pending.get(target); if(!req)return; room.pending.delete(target); io.to(target).emit('join-approved'); });
  socket.on('reject-join',({roomId,target})=>{ const room=rooms.get(roomId); if(!room||room.hostId!==socket.id)return; room.pending.delete(target); io.to(target).emit('join-rejected'); });

  socket.on('approved-join',({roomId,name})=>{
    const room=rooms.get(roomId); if(!room||!room.hostId){socket.emit('room-unavailable');return;}
    socket.data.roomId=roomId; socket.data.name=name||socket.data.name||'مشارك'; socket.data.approved=true; socket.join(roomId);
    const existing=[...room.participants.entries()].map(([id,p])=>({id,name:p.name}));
    room.participants.set(socket.id,{name:socket.data.name,mic:true,cam:true});
    socket.emit('existing-users',existing); socket.to(roomId).emit('user-joined',{id:socket.id,name:socket.data.name}); broadcastState(roomId);
  });

  socket.on('media-state',({roomId,mic,cam})=>{ const room=rooms.get(roomId); const p=room?.participants.get(socket.id); if(!p)return; p.mic=!!mic; p.cam=!!cam; broadcastState(roomId); });
  socket.on('signal',({target,data})=>{ if(target&&socket.data.approved) io.to(target).emit('signal',{from:socket.id,data,name:socket.data.name}); });
  socket.on('leave-room',({roomId})=>{ const room=rooms.get(roomId); if(!room)return; room.participants.delete(socket.id); socket.leave(roomId); socket.to(roomId).emit('user-left',{id:socket.id}); broadcastState(roomId); });
  socket.on('end-room',({roomId})=>{ const room=rooms.get(roomId); if(room?.hostId!==socket.id)return; socket.to(roomId).emit('room-ended'); for(const id of room.pending.keys()) io.to(id).emit('room-unavailable'); rooms.delete(roomId); });

  socket.on('disconnect',()=>{
    const requested=socket.data.requestedRoom; if(requested){ const r=rooms.get(requested); if(r?.pending.delete(socket.id)&&r.hostId) io.to(r.hostId).emit('join-request-cancelled',{id:socket.id}); }
    const roomId=socket.data.roomId; if(!roomId)return; const room=rooms.get(roomId); if(!room)return; room.participants.delete(socket.id); socket.to(roomId).emit('user-left',{id:socket.id});
    if(room.hostId===socket.id){ io.to(roomId).emit('room-ended'); for(const id of room.pending.keys()) io.to(id).emit('room-unavailable'); rooms.delete(roomId); }
    else broadcastState(roomId);
  });
});
server.listen(port,()=>console.log(`AI Meeting Platform running on port ${port}`));
