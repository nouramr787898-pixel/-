const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const socket = io();
const qs = new URLSearchParams(location.search);
let roomId = qs.get('room');
let isHost = qs.get('host') === '1';
let localStream = null, screenStream = null, displayName = '';
let recorder = null, recordChunks = [], audioCtx = null, audioDest = null;
let approved = false;
const peers = new Map();
const remoteStreams = new Map();
const participantNames = new Map();
const connectedSources = new Set();
const rtcConfig = { iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}] };

function show(id){ ['landing','prejoin','meeting','processing','summary','rejected','ended'].forEach(x=>$('#'+x)?.classList.add('hidden')); $('#'+id)?.classList.remove('hidden'); }
function toast(t){ const e=$('#toast'); e.textContent=t; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),2200); }
function makeRoom(){ return crypto.randomUUID().replaceAll('-','').slice(0,10); }
function meetingUrl(id,host=false){ const u=new URL(location.origin+location.pathname); u.searchParams.set('room',id); if(host)u.searchParams.set('host','1'); return u.toString(); }
function shareUrl(){ return meetingUrl(roomId,false); }

function createMeeting(){ roomId=makeRoom(); isHost=true; history.replaceState({},'',meetingUrl(roomId,true)); openPrejoin(); }
$('#createMeeting').onclick=createMeeting; $('#headerCreate').onclick=createMeeting;
$('#joinByCode').onclick=()=>{ const link=prompt('الصق رابط الاجتماع هنا'); if(!link)return; try{ location.href=new URL(link).href; }catch{ toast('الرابط غير صحيح'); } };

async function openPrejoin(){ show('prejoin'); $('#roomCodeText').textContent='رمز الاجتماع: '+roomId; $('#enterRoom').textContent=isHost?'بدء الاجتماع':'طلب الانضمام'; await getMedia(); }
async function getMedia(){
  try{ localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true}); $('#previewVideo').srcObject=localStream; $('#previewPlaceholder').style.display='none'; }
  catch{ try{ localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true}); }catch{} $('#previewPlaceholder').style.display='grid'; toast('يمكنك الدخول بدون كاميرا'); }
}
function setTrack(kind,on){ localStream?.getTracks().filter(t=>t.kind===kind).forEach(t=>t.enabled=on); }
$('#preMic').onclick=()=>{ const b=$('#preMic'); b.classList.toggle('active'); const on=b.classList.contains('active'); b.textContent='الميكروفون: '+(on?'يعمل':'مغلق'); setTrack('audio',on); };
$('#preCam').onclick=()=>{ const b=$('#preCam'); b.classList.toggle('active'); const on=b.classList.contains('active'); b.textContent='الكاميرا: '+(on?'تعمل':'مغلقة'); setTrack('video',on); $('#previewPlaceholder').style.display=on?'none':'grid'; };

$('#enterRoom').onclick=async()=>{
  displayName=$('#displayName').value.trim() || (isHost?'صاحب الاجتماع':'مشارك');
  if(!localStream) await getMedia();
  if(isHost){ approved=true; socket.emit('host-join',{roomId,name:displayName}); enterMeeting(); }
  else{
    $('#enterRoom').classList.add('hidden'); $('#waitingBox').classList.remove('hidden');
    socket.emit('request-join',{roomId,name:displayName});
  }
};
$('#cancelRequest').onclick=()=>{ socket.emit('cancel-join',{roomId}); location.href=location.pathname; };

socket.on('join-approved',()=>{ approved=true; $('#waitingBox').classList.add('hidden'); enterMeeting(); socket.emit('approved-join',{roomId,name:displayName}); });
socket.on('join-rejected',()=>{ localStream?.getTracks().forEach(t=>t.stop()); show('rejected'); });
socket.on('room-unavailable',()=>{ alert('هذا الاجتماع غير متاح أو انتهى.'); location.href=location.pathname; });

function enterMeeting(){
  show('meeting');
  $('#meetingRoomId').textContent='رمز: '+roomId;
  if(isHost) $('#endBtn').classList.remove('hidden');
  addVideo('local',localStream,displayName,true);
  participantNames.set(socket.id,displayName);
  updateLocalButtons();
  if(isHost) setTimeout(startRecording,500);
}

function addVideo(id,stream,name,local=false){
  let tile=$('#v-'+CSS.escape(id));
  if(!tile){
    tile=document.createElement('div'); tile.id='v-'+id; tile.className='videoTile'+(local?' local':'');
    tile.innerHTML='<video autoplay playsinline '+(local?'muted':'')+'></video><div class="videoOff hidden">الكاميرا مغلقة</div><div class="videoLabel"></div>';
    $('#videoGrid').appendChild(tile);
  }
  tile.querySelector('video').srcObject=stream;
  tile.querySelector('.videoLabel').textContent=name+(local?' (أنت)':'');
  participantNames.set(id,name);
  updateVideoOff(id,stream);
}
function updateVideoOff(id,stream){ const tile=document.getElementById('v-'+id); if(!tile)return; const v=stream?.getVideoTracks()[0]; tile.querySelector('.videoOff').classList.toggle('hidden',!!(v&&v.enabled)); }
function removeVideo(id){ document.getElementById('v-'+id)?.remove(); participantNames.delete(id); remoteStreams.delete(id); }

async function createPeer(id,initiator=false){
  if(peers.has(id)) return peers.get(id);
  const pc=new RTCPeerConnection(rtcConfig); peers.set(id,pc);
  localStream?.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit('signal',{target:id,data:{candidate:e.candidate}}); };
  pc.ontrack=e=>{ let s=remoteStreams.get(id); if(!s){ s=new MediaStream(); remoteStreams.set(id,s); } s.addTrack(e.track); addVideo(id,s,participantNames.get(id)||'مشارك'); connectRemoteToRecorder(s,id); };
  pc.onconnectionstatechange=()=>{ if(['failed','closed','disconnected'].includes(pc.connectionState)){ pc.close(); peers.delete(id); removeVideo(id); } };
  if(initiator){ const offer=await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('signal',{target:id,data:{sdp:pc.localDescription}}); }
  return pc;
}

socket.on('existing-users',async users=>{ for(const u of users){ participantNames.set(u.id,u.name||'مشارك'); await createPeer(u.id,true); } });
socket.on('user-joined',({id,name})=>{ participantNames.set(id,name||'مشارك'); });
socket.on('signal',async({from,data,name})=>{
  participantNames.set(from,name||participantNames.get(from)||'مشارك');
  const pc=await createPeer(from,false);
  if(data.sdp){ await pc.setRemoteDescription(data.sdp); if(data.sdp.type==='offer'){ const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); socket.emit('signal',{target:from,data:{sdp:pc.localDescription}}); } }
  else if(data.candidate){ try{ await pc.addIceCandidate(data.candidate); }catch{} }
});
socket.on('user-left',({id})=>{ peers.get(id)?.close(); peers.delete(id); removeVideo(id); });

socket.on('room-state',state=>{
  const list=state.participants||[];
  $('#participantCount').textContent=list.length+' مشارك'; $('#peopleCount').textContent=list.length;
  renderParticipants(list,state.hostId);
});
function renderParticipants(list,hostId){
  const box=$('#participantsList'); box.innerHTML='';
  list.forEach(p=>{
    const row=document.createElement('div'); row.className='participantRow';
    const initials=(p.name||'م').trim().slice(0,1);
    row.innerHTML=`<div class="participantInfo"><div class="avatar"></div><div><b class="pname"></b><div class="personMeta"></div></div></div><span class="hostTag ${p.id===hostId?'':'hidden'}">المضيف</span>`;
    row.querySelector('.avatar').textContent=initials; row.querySelector('.pname').textContent=p.name+(p.id===socket.id?' (أنت)':'');
    row.querySelector('.personMeta').textContent=[p.mic===false?'الميكروفون مغلق':'الميكروفون يعمل',p.cam===false?'الكاميرا مغلقة':'الكاميرا تعمل'].join(' • ');
    box.appendChild(row);
  });
}

socket.on('join-request',req=>{
  if(!isHost)return;
  $('#pendingSection').classList.remove('hidden');
  if(document.getElementById('req-'+req.id))return;
  const d=document.createElement('div'); d.className='requestCard'; d.id='req-'+req.id;
  d.innerHTML='<div class="requestName"></div><div class="requestActions"><button class="acceptBtn">قبول</button><button class="rejectBtn">رفض</button></div>';
  d.querySelector('.requestName').textContent=req.name+' يريد الانضمام';
  d.querySelector('.acceptBtn').onclick=()=>{ socket.emit('approve-join',{roomId,target:req.id}); d.remove(); hidePendingIfEmpty(); };
  d.querySelector('.rejectBtn').onclick=()=>{ socket.emit('reject-join',{roomId,target:req.id}); d.remove(); hidePendingIfEmpty(); };
  $('#joinRequests').appendChild(d);
});
socket.on('join-request-cancelled',({id})=>{ document.getElementById('req-'+id)?.remove(); hidePendingIfEmpty(); });
function hidePendingIfEmpty(){ if(!$('#joinRequests').children.length) $('#pendingSection').classList.add('hidden'); }

function emitMediaState(){ const mic=localStream?.getAudioTracks()[0]?.enabled??false; const cam=localStream?.getVideoTracks()[0]?.enabled??false; socket.emit('media-state',{roomId,mic,cam}); updateVideoOff('local',localStream); }
function updateLocalButtons(){ const mic=localStream?.getAudioTracks()[0]?.enabled??false; const cam=localStream?.getVideoTracks()[0]?.enabled??false; $('#micBtn').textContent=mic?'إيقاف الميكروفون':'تشغيل الميكروفون'; $('#camBtn').textContent=cam?'إيقاف الكاميرا':'تشغيل الكاميرا'; $('#micBtn').classList.toggle('off',!mic); $('#camBtn').classList.toggle('off',!cam); emitMediaState(); }
$('#micBtn').onclick=()=>{ const t=localStream?.getAudioTracks()[0]; if(!t)return; t.enabled=!t.enabled; updateLocalButtons(); };
$('#camBtn').onclick=()=>{ const t=localStream?.getVideoTracks()[0]; if(!t)return; t.enabled=!t.enabled; updateLocalButtons(); };
$('#screenBtn').onclick=async()=>{ try{ if(!screenStream){ screenStream=await navigator.mediaDevices.getDisplayMedia({video:true}); const track=screenStream.getVideoTracks()[0]; for(const pc of peers.values()){ const sender=pc.getSenders().find(s=>s.track?.kind==='video'); if(sender) await sender.replaceTrack(track); } $('#screenBtn').textContent='إيقاف مشاركة الشاشة'; track.onended=stopScreen; } else stopScreen(); }catch{} };
async function stopScreen(){ const cam=localStream?.getVideoTracks()[0]; if(cam){ for(const pc of peers.values()){ const sender=pc.getSenders().find(s=>s.track?.kind==='video'); if(sender) await sender.replaceTrack(cam); } } screenStream?.getTracks().forEach(t=>t.stop()); screenStream=null; $('#screenBtn').textContent='مشاركة الشاشة'; }
async function copyLink(){ try{ await navigator.clipboard.writeText(shareUrl()); toast('تم نسخ رابط الاجتماع'); }catch{ prompt('انسخ رابط الاجتماع:',shareUrl()); } }
$('#copyBtn').onclick=copyLink; $('#copySide').onclick=copyLink; $('#topCopyBtn').onclick=copyLink;
$('#leaveBtn').onclick=()=>leaveMeeting();
function leaveMeeting(){ socket.emit('leave-room',{roomId}); peers.forEach(p=>p.close()); localStream?.getTracks().forEach(t=>t.stop()); screenStream?.getTracks().forEach(t=>t.stop()); location.href=location.pathname; }

socket.on('room-ended',()=>{ if(isHost)return; peers.forEach(p=>p.close()); localStream?.getTracks().forEach(t=>t.stop()); show('ended'); });

function initRecorderGraph(){
  if(audioCtx)return; audioCtx=new AudioContext(); audioDest=audioCtx.createMediaStreamDestination();
  const a=localStream?.getAudioTracks()[0]; if(a) audioCtx.createMediaStreamSource(new MediaStream([a])).connect(audioDest);
  remoteStreams.forEach((s,id)=>connectRemoteToRecorder(s,id));
}
function connectRemoteToRecorder(stream,id){ if(!isHost||!audioDest||connectedSources.has(id))return; const a=stream.getAudioTracks(); if(!a.length)return; try{ audioCtx.createMediaStreamSource(new MediaStream(a)).connect(audioDest); connectedSources.add(id); }catch{} }
function startRecording(){ if(!isHost||recorder)return; try{ initRecorderGraph(); recorder=new MediaRecorder(audioDest.stream,{mimeType:MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'}); recorder.ondataavailable=e=>{if(e.data.size)recordChunks.push(e.data)}; recorder.start(1000); }catch{ toast('تعذر بدء تسجيل صوت الملخص'); } }
$('#endBtn').onclick=()=>{
  if(!isHost)return; socket.emit('end-room',{roomId});
  if(!recorder||recorder.state==='inactive'){ toast('لا يوجد تسجيل متاح للتلخيص'); return; }
  show('processing');
  recorder.onstop=async()=>{ const blob=new Blob(recordChunks,{type:'audio/webm'}); await summarize(blob); };
  recorder.stop();
};
async function summarize(blob){
  try{ const fd=new FormData(); fd.append('audio',blob,'meeting.webm'); const r=await fetch('/api/summarize',{method:'POST',body:fd}); const data=await r.json(); if(!r.ok)throw new Error(data.error||'فشل التلخيص'); renderSummary(data); }
  catch(e){ alert('تعذر إنشاء الملخص: '+e.message+'\nتأكد من OPENAI_API_KEY ورصيد الـAPI.'); location.href=location.pathname; }
}
function fillList(sel,items,empty='لا يوجد شيء محدد.'){ const ul=$(sel); ul.innerHTML=''; (items?.length?items:[empty]).forEach(x=>{const li=document.createElement('li'); li.textContent=x; ul.appendChild(li)}); }
function renderSummary(data){
  const s=data.summary||{}; show('summary'); $('#summaryTitle').textContent=s.title||'ملخص الاجتماع'; $('#summaryText').textContent=s.summary||'لم يتوفر ملخص.';
  fillList('#keyPoints',s.keyPoints); fillList('#decisions',s.decisions); fillList('#followUps',s.followUps);
  $('#actions').innerHTML='';
  if(s.actions?.length) s.actions.forEach(a=>{const d=document.createElement('div'); d.className='taskCard'; d.innerHTML='<b></b><div class="taskMeta"></div>'; d.querySelector('b').textContent=a.task||'مهمة'; d.querySelector('.taskMeta').textContent=[a.owner&&('المسؤول: '+a.owner),a.deadline&&('الموعد: '+a.deadline)].filter(Boolean).join(' • ')||'لم يذكر مسؤول أو موعد'; $('#actions').appendChild(d)}); else $('#actions').textContent='لم تُذكر مهام واضحة.';
  $('#transcript').textContent=data.transcript||'';
}
$('#newMeeting').onclick=()=>location.href=location.pathname;
if(roomId) openPrejoin();
