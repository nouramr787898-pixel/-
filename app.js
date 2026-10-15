const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const socket = io();
const qs = new URLSearchParams(location.search);
let roomId = qs.get('room');
let isHost = qs.get('host') === '1';
let localStream = null, screenStream = null, displayName = '', recorder = null, recordChunks = [], audioCtx = null, audioDest = null;
const peers = new Map();
const remoteStreams = new Map();
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

function show(id){ ['landing','prejoin','meeting','processing','summary'].forEach(x=>$('#'+x)?.classList.add('hidden')); $('#'+id)?.classList.remove('hidden'); }
function toast(t){ const el=$('#toast'); el.textContent=t; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2200); }
function makeRoom(){ return crypto.randomUUID().replaceAll('-','').slice(0,12); }
function meetingUrl(id,host=false){ const u=new URL(location.origin+location.pathname); u.searchParams.set('room',id); if(host)u.searchParams.set('host','1'); return u.toString(); }
function cleanHostUrl(){ const u=new URL(location.href); u.searchParams.delete('host'); return u.toString(); }

$$('[data-scroll]').forEach(b=>b.onclick=()=>$('#'+b.dataset.scroll).scrollIntoView({behavior:'smooth'}));
function createMeeting(){ roomId=makeRoom(); isHost=true; history.pushState({},'',meetingUrl(roomId,true)); openPrejoin(); }
$('#createMeeting').onclick=createMeeting; $('#headerCreate').onclick=createMeeting;
$('#joinByCode').onclick=()=>{ const link=prompt('الصق رابط الاجتماع هنا'); if(link){ try{ location.href=new URL(link).href }catch{ toast('الرابط غير صحيح'); } } };

async function openPrejoin(){ show('prejoin'); $('#roomCodeText').textContent='رمز الاجتماع: '+roomId; await getMedia(); }
async function getMedia(){ try{ localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true}); $('#previewVideo').srcObject=localStream; $('#previewPlaceholder').style.display='none'; }catch(e){ try{ localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true}); }catch{} $('#previewPlaceholder').style.display='grid'; toast('يمكنك الدخول حتى لو الكاميرا غير متاحة'); } }
function setTrack(kind,on){ localStream?.getTracks().filter(t=>t.kind===kind).forEach(t=>t.enabled=on); }
$('#preMic').onclick=()=>{ const b=$('#preMic'); b.classList.toggle('active'); setTrack('audio',b.classList.contains('active')); };
$('#preCam').onclick=()=>{ const b=$('#preCam'); b.classList.toggle('active'); setTrack('video',b.classList.contains('active')); $('#previewPlaceholder').style.display=b.classList.contains('active')?'none':'grid'; };

$('#enterRoom').onclick=async()=>{ displayName=$('#displayName').value.trim()||'مشارك'; if(!localStream) await getMedia(); enterMeeting(); };
function enterMeeting(){ show('meeting'); $('#meetingRoomId').textContent='غرفة '+roomId; $('#shareUrl').textContent=cleanHostUrl(); addVideo('local',localStream,displayName,true); socket.emit('join-room',{roomId,name:displayName,isHost}); if(isHost){ $('#endBtn').classList.remove('hidden'); startRecording(); } }

function addVideo(id,stream,name,local=false){ let tile=document.getElementById('v-'+id); if(!tile){ tile=document.createElement('div'); tile.id='v-'+id; tile.className='video-tile'+(local?' local':''); tile.innerHTML='<video autoplay playsinline '+(local?'muted':'')+'></video><span class="label"></span>'; $('#videoGrid').appendChild(tile); } tile.querySelector('video').srcObject=stream; tile.querySelector('.label').textContent=name||'مشارك'; }
function removeVideo(id){ document.getElementById('v-'+id)?.remove(); }

function createPeer(target,initiator=false,name='مشارك'){
  if(peers.has(target)) return peers.get(target);
  const pc=new RTCPeerConnection(rtcConfig); peers.set(target,pc);
  localStream?.getTracks().forEach(track=>pc.addTrack(track,localStream));
  if(screenStream){ const vt=screenStream.getVideoTracks()[0]; const sender=pc.getSenders().find(s=>s.track?.kind==='video'); if(sender&&vt)sender.replaceTrack(vt); }
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit('signal',{target,data:{candidate:e.candidate}}); };
  pc.ontrack=e=>{ const s=e.streams[0]; remoteStreams.set(target,s); addVideo(target,s,name,false); connectRemoteToRecorder(s,target); };
  pc.onconnectionstatechange=()=>{ if(['failed','closed','disconnected'].includes(pc.connectionState)){ removeVideo(target); peers.delete(target); remoteStreams.delete(target); } };
  if(initiator){ pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>socket.emit('signal',{target,data:{sdp:pc.localDescription}})); }
  return pc;
}
socket.on('existing-users',users=>users.forEach(u=>createPeer(u.id,true)));
socket.on('user-joined',({id,name})=>{ if(!peers.has(id)) createPeer(id,false,name); });
socket.on('signal',async({from,data,name})=>{ const pc=createPeer(from,false,name); if(data.sdp){ await pc.setRemoteDescription(data.sdp); if(data.sdp.type==='offer'){ const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); socket.emit('signal',{target:from,data:{sdp:pc.localDescription}}); } } if(data.candidate){ try{ await pc.addIceCandidate(data.candidate); }catch{} } });
socket.on('user-left',({id})=>{ peers.get(id)?.close(); peers.delete(id); remoteStreams.delete(id); removeVideo(id); });
socket.on('room-state',({hostId,count})=>{ $('#participantCount').textContent=count+' مشارك'; if(hostId===socket.id){ isHost=true; $('#endBtn').classList.remove('hidden'); if(!recorder)startRecording(); } });
socket.on('room-ended',()=>{ if(!isHost){ toast('تم إنهاء الاجتماع بواسطة المضيف'); leave(false); } });

$('#micBtn').onclick=()=>{ const tr=localStream?.getAudioTracks()[0]; if(!tr)return; tr.enabled=!tr.enabled; $('#micBtn').classList.toggle('off',!tr.enabled); };
$('#camBtn').onclick=()=>{ const tr=localStream?.getVideoTracks()[0]; if(!tr)return; tr.enabled=!tr.enabled; $('#camBtn').classList.toggle('off',!tr.enabled); };
$('#screenBtn').onclick=async()=>{ try{ if(!screenStream){ screenStream=await navigator.mediaDevices.getDisplayMedia({video:true}); const st=screenStream.getVideoTracks()[0]; peers.forEach(pc=>pc.getSenders().find(s=>s.track?.kind==='video')?.replaceTrack(st)); st.onended=stopScreen; $('#screenBtn').classList.add('off'); }else stopScreen(); }catch{} };
function stopScreen(){ const cam=localStream?.getVideoTracks()[0]; if(cam)peers.forEach(pc=>pc.getSenders().find(s=>s.track?.kind==='video')?.replaceTrack(cam)); screenStream?.getTracks().forEach(t=>t.stop()); screenStream=null; $('#screenBtn').classList.remove('off'); }
async function copyLink(){ await navigator.clipboard.writeText(cleanHostUrl()); toast('تم نسخ رابط الاجتماع'); }
$('#copyBtn').onclick=copyLink; $('#copySide').onclick=copyLink;
$('#leaveBtn').onclick=()=>leave(true);
function leave(goHome=true){ peers.forEach(pc=>pc.close()); localStream?.getTracks().forEach(t=>t.stop()); screenStream?.getTracks().forEach(t=>t.stop()); socket.disconnect(); if(goHome) location.href=location.pathname; else show('landing'); }

$$('.tab').forEach(t=>t.onclick=()=>{ $$('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); $('#chatTab').classList.toggle('hidden',t.dataset.tab!=='chat'); $('#infoTab').classList.toggle('hidden',t.dataset.tab!=='info'); });
$('#chatForm').onsubmit=e=>{ e.preventDefault(); const text=$('#chatInput').value.trim(); if(text){ socket.emit('chat-message',{roomId,text,name:displayName}); $('#chatInput').value=''; } };
socket.on('chat-message',m=>{ const d=document.createElement('div'); d.className='message'; d.innerHTML='<b></b><p></p>'; d.querySelector('b').textContent=m.name; d.querySelector('p').textContent=m.text; $('#messages').appendChild(d); $('#messages').scrollTop=$('#messages').scrollHeight; });

function initRecorderGraph(){ if(audioCtx) return; audioCtx=new AudioContext(); audioDest=audioCtx.createMediaStreamDestination(); const at=localStream?.getAudioTracks()[0]; if(at){ const only=new MediaStream([at]); audioCtx.createMediaStreamSource(only).connect(audioDest); } remoteStreams.forEach((s,id)=>connectRemoteToRecorder(s,id)); }
const connectedSources=new Set();
function connectRemoteToRecorder(stream,id){ if(!isHost||!audioDest||connectedSources.has(id))return; const ats=stream.getAudioTracks(); if(!ats.length)return; try{ audioCtx.createMediaStreamSource(new MediaStream(ats)).connect(audioDest); connectedSources.add(id); }catch{} }
function startRecording(){ if(!isHost||recorder)return; try{ initRecorderGraph(); recordChunks=[]; recorder=new MediaRecorder(audioDest.stream,{mimeType:MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'}); recorder.ondataavailable=e=>{ if(e.data.size)recordChunks.push(e.data); }; recorder.start(1000); $('#recordBadge').classList.remove('hidden'); }catch(e){ console.warn(e); toast('تعذر بدء تسجيل صوت الملخص على هذا المتصفح'); } }
$('#endBtn').onclick=async()=>{ if(!isHost)return; socket.emit('end-room',{roomId}); if(!recorder||recorder.state==='inactive'){ toast('لا يوجد تسجيل متاح للتلخيص'); return; } show('processing'); recorder.onstop=async()=>{ const blob=new Blob(recordChunks,{type:'audio/webm'}); await summarize(blob); }; recorder.stop(); };
async function summarize(blob){ try{ const fd=new FormData(); fd.append('audio',blob,'meeting.webm'); const r=await fetch('/api/summarize',{method:'POST',body:fd}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'فشل التلخيص'); renderSummary(data); }catch(e){ alert('تعذر إنشاء الملخص: '+e.message+'\n\nتأكد من إضافة OPENAI_API_KEY في إعدادات الاستضافة.'); location.href=location.pathname; } }
function fillList(sel,items,empty='لا يوجد شيء محدد في الاجتماع.'){ const ul=$(sel); ul.innerHTML=''; (items?.length?items:[empty]).forEach(x=>{ const li=document.createElement('li'); li.textContent=x; ul.appendChild(li); }); }
function renderSummary(data){ const s=data.summary||{}; show('summary'); $('#summaryTitle').textContent=s.title||'ملخص الاجتماع'; $('#summaryText').textContent=s.summary||'لم يتوفر ملخص.'; fillList('#keyPoints',s.keyPoints); fillList('#decisions',s.decisions); fillList('#followUps',s.followUps); $('#actions').innerHTML=''; if(s.actions?.length){ s.actions.forEach(a=>{ const d=document.createElement('div'); d.className='task-card'; const meta=[a.owner&&('المسؤول: '+a.owner),a.deadline&&('الموعد: '+a.deadline)].filter(Boolean).join(' • '); d.innerHTML='<b></b><div class="task-meta"></div>'; d.querySelector('b').textContent=a.task||'مهمة'; d.querySelector('.task-meta').textContent=meta||'لم يذكر مسؤول أو موعد'; $('#actions').appendChild(d); }); }else $('#actions').textContent='لم تُذكر مهام واضحة.'; $('#transcript').textContent=data.transcript||''; }
$('#newMeeting').onclick=()=>location.href=location.pathname;

if(roomId) openPrejoin();
