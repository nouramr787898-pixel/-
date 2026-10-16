const $ = s => document.querySelector(s);
const socket = io({ transports: ['websocket', 'polling'] });
const qs = new URLSearchParams(location.search);
let roomId = qs.get('room');
let isHost = qs.get('host') === '1';
let displayName = '';
let approved = false;
let previewStream = null;
let desiredMic = true;
let desiredCam = true;
let mediaKey = '';
let lkRoom = null;
let recorder = null;
let recordChunks = [];
let audioCtx = null;
let audioDest = null;
const recorderSources = new Set();

const LK = window.LivekitClient;
const { Room, RoomEvent, Track, VideoPresets } = LK || {};

function show(id) {
  ['landing','prejoin','meeting','processing','summary','rejected','ended'].forEach(x => $('#'+x)?.classList.add('hidden'));
  $('#'+id)?.classList.remove('hidden');
}
function toast(t) {
  const e = $('#toast'); e.textContent = t; e.classList.add('show');
  setTimeout(() => e.classList.remove('show'), 2600);
}
function makeRoom() { return crypto.randomUUID().replaceAll('-','').slice(0,10); }
function meetingUrl(id, host = false) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('room', id);
  if (host) u.searchParams.set('host', '1');
  return u.toString();
}
function shareUrl() { return meetingUrl(roomId, false); }

function setPeoplePanel(open) {
  $('#peoplePanel')?.classList.toggle('panelHidden', !open);
  $('.meetingBody')?.classList.toggle('panelClosed', !open);
  $('#peopleToggleBtn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function createMeeting() {
  roomId = makeRoom(); isHost = true;
  history.replaceState({}, '', meetingUrl(roomId, true));
  openPrejoin();
}
$('#createMeeting').onclick = createMeeting;
$('#headerCreate').onclick = createMeeting;
$('#closePeopleBtn').onclick = () => setPeoplePanel(false);
$('#peopleToggleBtn').onclick = () => setPeoplePanel($('#peoplePanel').classList.contains('panelHidden'));
$('#joinByCode').onclick = () => {
  const link = prompt('الصق رابط الاجتماع هنا');
  if (!link) return;
  try { location.href = new URL(link).href; } catch { toast('الرابط غير صحيح'); }
};

async function openPrejoin() {
  show('prejoin');
  $('#roomCodeText').textContent = 'رمز الاجتماع: ' + roomId;
  $('#enterRoom').textContent = isHost ? 'بدء الاجتماع' : 'طلب الانضمام';
  $('#permissionStatus').textContent = 'اضغط على زر السماح لتفعيل الميكروفون والكاميرا';
}

function permissionHelp(message = 'لم يتم السماح بالميكروفون. افتح علامة القفل بجانب عنوان الموقع واختر السماح للميكروفون والكاميرا ثم أعد المحاولة.') {
  $('#permissionStatus').textContent = message;
  $('#permissionStatus').classList.add('error');
  toast('يلزم السماح للميكروفون من المتصفح');
}

async function getPreviewMedia() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('المتصفح لا يدعم الكاميرا والميكروفون');
  previewStream?.getTracks().forEach(t => t.stop());
  previewStream = null;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    desiredMic = true; desiredCam = true;
    $('#previewVideo').srcObject = previewStream;
    $('#previewPlaceholder').style.display = 'none';
    $('#permissionStatus').textContent = 'تم السماح بالميكروفون والكاميرا ✓';
    $('#permissionStatus').classList.remove('error');
    $('#allowMediaBtn').textContent = 'تم السماح ✓';
  } catch (e) {
    try {
      previewStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      desiredMic = true; desiredCam = false;
      $('#previewPlaceholder').textContent = 'الكاميرا غير متاحة — الميكروفون يعمل';
      $('#previewPlaceholder').style.display = 'grid';
      $('#permissionStatus').textContent = 'تم السماح بالميكروفون ✓ — الكاميرا غير متاحة';
      $('#permissionStatus').classList.remove('error');
      $('#allowMediaBtn').textContent = 'تم السماح بالميكروفون ✓';
    } catch (e2) {
      desiredMic = false; desiredCam = false;
      previewStream = null;
      $('#previewPlaceholder').textContent = 'الميكروفون والكاميرا غير مفعّلين';
      $('#previewPlaceholder').style.display = 'grid';
      permissionHelp(e?.name === 'NotAllowedError' || e2?.name === 'NotAllowedError'
        ? 'تم رفض الإذن. اضغط علامة القفل بجانب رابط الموقع واختر Allow للميكروفون والكاميرا.'
        : 'تعذر الوصول للميكروفون والكاميرا. تأكد من إعدادات الجهاز والمتصفح.');
    }
  }
  updatePreButtons();
}
function updatePreButtons() {
  $('#preMic').classList.toggle('active', desiredMic);
  $('#preCam').classList.toggle('active', desiredCam);
  $('#preMic').textContent = 'الميكروفون: ' + (desiredMic ? 'يعمل' : 'مغلق');
  $('#preCam').textContent = 'الكاميرا: ' + (desiredCam ? 'تعمل' : 'مغلقة');
}
$('#allowMediaBtn').onclick = async () => {
  $('#allowMediaBtn').disabled = true; $('#allowMediaBtn').textContent = 'انتظر إشعار المتصفح…';
  await getPreviewMedia(); $('#allowMediaBtn').disabled = false;
};
$('#preMic').onclick = async () => {
  if (!previewStream?.getAudioTracks().length && !desiredMic) await getPreviewMedia();
  desiredMic = !desiredMic;
  previewStream?.getAudioTracks().forEach(t => t.enabled = desiredMic);
  updatePreButtons();
};
$('#preCam').onclick = async () => {
  if (!previewStream?.getVideoTracks().length && !desiredCam) await getPreviewMedia();
  desiredCam = !desiredCam;
  previewStream?.getVideoTracks().forEach(t => t.enabled = desiredCam);
  $('#previewPlaceholder').style.display = desiredCam && previewStream?.getVideoTracks().length ? 'none' : 'grid';
  updatePreButtons();
};

$('#enterRoom').onclick = async () => {
  displayName = $('#displayName').value.trim() || (isHost ? 'صاحب الاجتماع' : 'مشارك');
  if (!previewStream && desiredMic) await getPreviewMedia();
  if (isHost) {
    approved = true;
    $('#enterRoom').disabled = true; $('#enterRoom').textContent = 'جاري بدء الاجتماع…';
    socket.emit('host-join', { roomId, name: displayName });
  } else {
    $('#enterRoom').classList.add('hidden');
    $('#waitingBox').classList.remove('hidden');
    socket.emit('request-join', { roomId, name: displayName });
  }
};
$('#cancelRequest').onclick = () => { socket.emit('cancel-join', { roomId }); location.href = location.pathname; };

socket.on('host-ready', async ({ mediaKey: key }) => {
  mediaKey = key; approved = true;
  await enterMeetingAndConnect();
});
socket.on('join-approved', async ({ mediaKey: key }) => {
  mediaKey = key; approved = true;
  $('#waitingBox').classList.add('hidden');
  await enterMeetingAndConnect();
});
socket.on('join-rejected', () => { previewStream?.getTracks().forEach(t => t.stop()); show('rejected'); });
socket.on('room-unavailable', () => { alert('هذا الاجتماع غير متاح أو انتهى.'); location.href = location.pathname; });

async function enterMeetingAndConnect() {
  show('meeting'); window.scrollTo(0,0); setPeoplePanel(false);
  $('#meetingRoomId').textContent = 'رمز: ' + roomId;
  if (isHost) $('#endBtn').classList.remove('hidden');
  addLocalTile();
  updateLocalButtons();

  try {
    await connectLiveKit();
    if (isHost) setTimeout(startRecording, 1000);
  } catch (e) {
    console.error(e);
    toast('تعذر تشغيل الصوت والفيديو');
    const msg = e?.message || String(e);
    alert('تعذر الاتصال بمحرك الصوت والفيديو.\n\n' + msg + '\n\nتأكد من إعداد LIVEKIT_URL و LIVEKIT_API_KEY و LIVEKIT_API_SECRET في Railway.');
  }
}

async function getLiveKitToken() {
  const r = await fetch('/api/livekit-token', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ roomId, socketId: socket.id, mediaKey })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'LiveKit token failed');
  return data;
}

async function connectLiveKit() {
  if (!Room) throw new Error('LiveKit client did not load.');
  const { token, url } = await getLiveKitToken();

  lkRoom = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets?.h720?.resolution },
  });

  lkRoom
    .on(RoomEvent.ParticipantConnected, p => ensureRemoteTile(p.identity, p.name || 'مشارك'))
    .on(RoomEvent.ParticipantDisconnected, p => removeRemoteTile(p.identity))
    .on(RoomEvent.TrackSubscribed, (track, pub, participant) => onTrackSubscribed(track, pub, participant))
    .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => onTrackUnsubscribed(track, pub, participant))
    .on(RoomEvent.LocalTrackPublished, publication => onLocalTrackPublished(publication))
    .on(RoomEvent.LocalTrackUnpublished, publication => onLocalTrackUnpublished(publication))
    .on(RoomEvent.TrackMuted, (publication, participant) => updateTileMediaState(participant))
    .on(RoomEvent.TrackUnmuted, (publication, participant) => updateTileMediaState(participant))
    .on(RoomEvent.Disconnected, () => toast('انقطع اتصال الاجتماع'));

  await lkRoom.connect(url, token);

  // Stop preview capture before LiveKit opens the real published tracks.
  previewStream?.getTracks().forEach(t => t.stop());
  previewStream = null;

  if (desiredMic) {
    try { await lkRoom.localParticipant.setMicrophoneEnabled(true); }
    catch (e) { desiredMic = false; permissionHelp('تعذر تشغيل الميكروفون. اسمح للميكروفون من إعدادات الموقع ثم اضغط تشغيل الميكروفون.'); }
  }
  if (desiredCam) {
    try { await lkRoom.localParticipant.setCameraEnabled(true); }
    catch (e) { desiredCam = false; toast('تعذر تشغيل الكاميرا — يمكنك تشغيلها من الزر بالأسفل'); }
  }

  // Existing participants and already subscribed tracks.
  for (const p of lkRoom.remoteParticipants.values()) {
    ensureRemoteTile(p.identity, p.name || 'مشارك');
    for (const pub of p.trackPublications.values()) {
      if (pub.track) onTrackSubscribed(pub.track, pub, p);
    }
  }
  renderLocalLiveKitVideo();
  updateLocalButtons();
  await unlockAudio();
}


function tileId(id) { return 'v-' + String(id).replace(/[^a-zA-Z0-9_-]/g,'_'); }
function hashSeed(text='') { let h=0; const t=String(text); for (let i=0;i<t.length;i++) h=(h*31 + t.charCodeAt(i))>>>0; return h; }
function pickAvatarVariant(seed='') { const variants=['male-a','female-a','male-b','female-b']; return variants[hashSeed(seed)%variants.length]; }
function avatarSVG(variant='male-a') {
  const female = variant.startsWith('female');
  const alt = variant.endsWith('b');
  const skin = alt ? '#f1c39a' : '#edbf95';
  const top = female ? (alt ? '#7d4cf4' : '#d4a63f') : (alt ? '#3b82f6' : '#d4a63f');
  const jacket = female ? (alt ? '#1c1b3f' : '#171717') : (alt ? '#151d2d' : '#171717');
  const hair = female ? (alt ? '#1d1d1d' : '#30221d') : (alt ? '#221812' : '#1d1d1d');
  const accent = female ? '#f5d07f' : '#d4a63f';
  const headTop = female ? `<path d="M73 58c9-18 37-26 54-10 10 10 12 24 12 40H58c0-10 3-20 15-30z" fill="${hair}"/>` : `<path d="M65 57c12-13 44-16 58 0 7 8 10 18 10 31H57c0-12 2-22 8-31z" fill="${hair}"/>`;
  const extra = female
    ? `<path d="M60 109c8 23 21 34 37 34s29-11 37-34v49H60v-49z" fill="${top}"/><path d="M48 157c6-33 24-49 50-49s44 16 50 49H48z" fill="${jacket}"/>`
    : `<rect x="61" y="108" width="74" height="52" rx="18" fill="${jacket}"/><path d="M49 158c8-31 26-48 49-48 24 0 42 17 50 48H49z" fill="${top}"/><path d="M96 108h8v28l-4 7-4-7z" fill="${accent}"/>`;
  return `
  <div class="avatarFigure ${variant}">
    <svg viewBox="0 0 196 196" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="bg-${variant}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgba(255,255,255,0.12)"/>
          <stop offset="100%" stop-color="rgba(212,166,63,0.06)"/>
        </linearGradient>
      </defs>
      <circle cx="98" cy="98" r="91" fill="url(#bg-${variant})" stroke="rgba(255,255,255,0.09)" />
      <circle class="spark" cx="38" cy="52" r="4" fill="${accent}" />
      <circle class="spark s2" cx="154" cy="42" r="5" fill="${accent}" />
      <circle class="spark s3" cx="162" cy="136" r="4" fill="${accent}" />
      <ellipse cx="98" cy="168" rx="54" ry="10" fill="rgba(0,0,0,.22)"/>
      ${headTop}
      <circle cx="98" cy="82" r="28" fill="${skin}"/>
      <circle cx="88" cy="82" r="2.2" fill="#2f241d"/>
      <circle cx="108" cy="82" r="2.2" fill="#2f241d"/>
      <path d="M88 94c6 6 14 6 20 0" fill="none" stroke="#8b4f40" stroke-width="3" stroke-linecap="round"/>
      <rect x="86" y="103" width="24" height="12" rx="5" fill="${skin}"/>
      ${extra}
      <rect x="70" y="149" width="56" height="14" rx="7" fill="rgba(255,255,255,.06)"/>
      <rect x="77" y="152" width="42" height="4" rx="2" fill="rgba(255,255,255,.12)"/>
    </svg>
  </div>`;
}
function avatarStageMarkup(name='', variantSeed='') {
  const variant = pickAvatarVariant(variantSeed || name);
  return `<div class="avatarStage ${variant}">${avatarSVG(variant)}<div class="avatarCaption">كاميرا مغلقة</div></div>`;
}
function miniAvatarMarkup(name='', seed='') {
  const variant = pickAvatarVariant(seed || name);
  return `<div class="avatarMiniWrap">${avatarSVG(variant).replace('avatarFigure', 'personVectorMini')}</div>`;
}
function addLocalTile() {
  let tile = $('#v-local');
  if (!tile) {
    tile = document.createElement('div'); tile.id='v-local'; tile.className='videoTile local';
    tile.innerHTML = '<video autoplay muted playsinline></video>' + avatarStageMarkup(displayName || 'أنت', 'local-'+(displayName||'')) + '<div class="videoLabel"></div>';
    $('#videoGrid').appendChild(tile);
  }
  tile.querySelector('.videoLabel').textContent = displayName + ' (أنت)';
  updateGridLayout();
}
function ensureRemoteTile(id, name='مشارك') {
  let tile = document.getElementById(tileId(id));
  if (!tile) {
    tile = document.createElement('div'); tile.id=tileId(id); tile.className='videoTile remote waitingMedia';
    tile.innerHTML = '<video autoplay playsinline></video><audio autoplay playsinline></audio>' + avatarStageMarkup(name, id+'-'+name).replace('</div></div>', '</div><div class="waitingText">جاري الاتصال بالصوت والصورة…</div></div>') + '<div class="connectionBadge warn">جاري الاتصال…</div><div class="videoLabel"></div>';
    $('#videoGrid').appendChild(tile);
  }
  tile.querySelector('.videoLabel').textContent = name;
  updateGridLayout();
  return tile;
}
function removeRemoteTile(id) { document.getElementById(tileId(id))?.remove(); updateGridLayout(); }
function updateGridLayout() {
  const grid=$('#videoGrid'); const count=grid?.children.length||0;
  grid.classList.remove('count-1','count-2','count-3','count-4','count-many');
  grid.classList.add(count<=4 ? `count-${Math.max(1,count)}` : 'count-many');
}

function onTrackSubscribed(track, publication, participant) {
  const tile = ensureRemoteTile(participant.identity, participant.name || 'مشارك');
  tile.classList.remove('waitingMedia');
  tile.querySelector('.connectionBadge').classList.add('hidden');
  const avatar = tile.querySelector('.avatarStage');
  if (track.kind === Track.Kind.Video) {
    const video = tile.querySelector('video');
    try { track.attach(video); } catch { video.srcObject = new MediaStream([track.mediaStreamTrack]); }
    avatar.classList.add('hidden');
    video.play().catch(() => {});
  } else if (track.kind === Track.Kind.Audio) {
    const audio = tile.querySelector('audio');
    try { track.attach(audio); } catch { audio.srcObject = new MediaStream([track.mediaStreamTrack]); }
    audio.volume = 1; audio.muted = false;
    audio.play().catch(() => $('#audioUnlock').classList.remove('hidden'));
    connectTrackToRecorder(track, 'remote-'+participant.identity+'-'+publication.trackSid);
  }
  updateTileMediaState(participant);
}
function onTrackUnsubscribed(track, publication, participant) {
  try { track.detach(); } catch {}
  updateTileMediaState(participant);
}
function updateTileMediaState(participant) {
  if (!participant) return;
  const tile = document.getElementById(tileId(participant.identity)); if (!tile) return;
  const camPub = participant.getTrackPublication?.(Track.Source.Camera);
  const camOn = !!(camPub && !camPub.isMuted && camPub.track);
  tile.querySelector('.avatarStage')?.classList.toggle('hidden', camOn);
}
function renderLocalLiveKitVideo() {
  if (!lkRoom) return;
  const tile=$('#v-local'); if(!tile) return;
  const video=tile.querySelector('video');
  const pub=lkRoom.localParticipant.getTrackPublication(Track.Source.Camera);
  if (pub?.track) {
    try { pub.track.attach(video); } catch { video.srcObject = new MediaStream([pub.track.mediaStreamTrack]); }
    tile.querySelector('.avatarStage')?.classList.toggle('hidden', !desiredCam);
  } else tile.querySelector('.avatarStage')?.classList.remove('hidden');
}
function onLocalTrackPublished(publication) {
  if (publication.source === Track.Source.Camera) renderLocalLiveKitVideo();
  if (publication.source === Track.Source.Microphone && publication.track) connectTrackToRecorder(publication.track, 'local-'+publication.trackSid);
}
function onLocalTrackUnpublished(publication) {
  if (publication.source === Track.Source.Camera) $('#v-local .avatarStage')?.classList.remove('hidden');
}

function emitMediaState() {
  socket.emit('media-state', { roomId, mic:desiredMic, cam:desiredCam });
}
function updateLocalButtons() {
  $('#micBtn').textContent = desiredMic ? 'إيقاف الميكروفون' : 'تشغيل الميكروفون';
  $('#camBtn').textContent = desiredCam ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا';
  $('#micBtn').classList.toggle('off', !desiredMic); $('#camBtn').classList.toggle('off', !desiredCam);
  emitMediaState();
  $('#v-local .avatarStage')?.classList.toggle('hidden', desiredCam);
}
$('#micBtn').onclick = async () => {
  if (!lkRoom) return toast('الاتصال لم يكتمل بعد');
  try {
    const next=!desiredMic;
    await lkRoom.localParticipant.setMicrophoneEnabled(next);
    desiredMic=next; updateLocalButtons();
    toast(next ? 'الميكروفون يعمل الآن' : 'تم إيقاف الميكروفون');
  } catch (e) { permissionHelp('لم يسمح المتصفح بالميكروفون. افتح إعدادات الموقع واختر Microphone: Allow ثم حاول مرة أخرى.'); }
};
$('#camBtn').onclick = async () => {
  if (!lkRoom) return toast('الاتصال لم يكتمل بعد');
  try {
    const next=!desiredCam;
    await lkRoom.localParticipant.setCameraEnabled(next);
    desiredCam=next; renderLocalLiveKitVideo(); updateLocalButtons();
    toast(next ? 'الكاميرا تعمل الآن' : 'تم إيقاف الكاميرا');
  } catch (e) { toast('لم يسمح المتصفح بالكاميرا. اسمح بها من إعدادات الموقع.'); }
};

$('#screenBtn').onclick = async () => {
  if (!lkRoom) return toast('الاتصال لم يكتمل بعد');
  try {
    const enabled = lkRoom.localParticipant.isScreenShareEnabled;
    await lkRoom.localParticipant.setScreenShareEnabled(!enabled);
    $('#screenBtn').textContent = !enabled ? 'إيقاف مشاركة الشاشة' : 'مشاركة الشاشة';
  } catch { toast('تعذر مشاركة الشاشة على هذا الجهاز'); }
};

async function unlockAudio() {
  try {
    if (lkRoom) await lkRoom.startAudio();
    for (const a of document.querySelectorAll('.videoTile.remote audio')) { a.muted=false; a.volume=1; try { await a.play(); } catch {} }
    $('#audioUnlock')?.classList.add('hidden');
  } catch { $('#audioUnlock')?.classList.remove('hidden'); }
}
$('#audioUnlock').onclick = unlockAudio;
document.addEventListener('pointerdown', () => unlockAudio(), { passive:true });

socket.on('room-state', state => {
  const list=state.participants||[];
  $('#participantCount').textContent = list.length + (list.length===1?' مشارك':' مشاركين');
  $('#peopleCount').textContent=list.length;
  renderParticipants(list,state.hostId);
  for (const p of list) if (p.id!==socket.id) ensureRemoteTile(p.id,p.name||'مشارك');
});
function renderParticipants(list,hostId) {
  const box=$('#participantsList'); box.innerHTML='';
  for(const p of list){
    const row=document.createElement('div'); row.className='participantRow';
    row.innerHTML='<div class="participantInfo">'+miniAvatarMarkup(p.name||'م', p.id+'-'+(p.name||''))+'<div><b class="pname"></b><div class="personMeta"></div></div></div><span class="hostTag hidden">المضيف</span>';
    row.querySelector('.pname').textContent=p.name+(p.id===socket.id?' (أنت)':'');
    row.querySelector('.personMeta').textContent=[p.mic===false?'الميكروفون مغلق':'الميكروفون يعمل',p.cam===false?'الكاميرا مغلقة':'الكاميرا تعمل'].join(' • ');
    if(p.id===hostId) row.querySelector('.hostTag').classList.remove('hidden'); box.appendChild(row);
  }
}

socket.on('join-request', req => {
  if(!isHost)return;
  $('#pendingSection').classList.remove('hidden'); setPeoplePanel(true);
  if(document.getElementById('req-'+req.id))return;
  const d=document.createElement('div'); d.className='requestCard'; d.id='req-'+req.id;
  d.innerHTML='<div class="requestName"></div><div class="requestActions"><button class="acceptBtn">قبول</button><button class="rejectBtn">رفض</button></div>';
  d.querySelector('.requestName').textContent=req.name+' يريد الانضمام';
  d.querySelector('.acceptBtn').onclick=()=>{socket.emit('approve-join',{roomId,target:req.id});d.remove();hidePendingIfEmpty();setPeoplePanel(false);};
  d.querySelector('.rejectBtn').onclick=()=>{socket.emit('reject-join',{roomId,target:req.id});d.remove();hidePendingIfEmpty();};
  $('#joinRequests').appendChild(d);
});
socket.on('join-request-cancelled',({id})=>{document.getElementById('req-'+id)?.remove();hidePendingIfEmpty();});
function hidePendingIfEmpty(){if(!$('#joinRequests').children.length)$('#pendingSection').classList.add('hidden');}

async function copyLink(){try{await navigator.clipboard.writeText(shareUrl());toast('تم نسخ رابط الاجتماع');}catch{prompt('انسخ رابط الاجتماع:',shareUrl());}}
$('#copyBtn').onclick=copyLink; $('#copySide').onclick=copyLink; $('#topCopyBtn').onclick=copyLink;
$('#leaveBtn').onclick=leaveMeeting;
async function leaveMeeting(){socket.emit('leave-room',{roomId});try{await lkRoom?.disconnect();}catch{} previewStream?.getTracks().forEach(t=>t.stop()); location.href=location.pathname;}
socket.on('room-ended',async()=>{if(isHost)return;try{await lkRoom?.disconnect();}catch{} show('ended');});

function ensureRecorderGraph(){
  if(audioDest)return;
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  audioDest=audioCtx.createMediaStreamDestination();
}
function connectTrackToRecorder(track,key){
  if(!isHost||!track||recorderSources.has(key))return;
  try{
    ensureRecorderGraph();
    const mst=track.mediaStreamTrack||track;
    if(!mst || mst.kind!=='audio')return;
    audioCtx.createMediaStreamSource(new MediaStream([mst])).connect(audioDest);
    recorderSources.add(key);
  }catch(e){console.warn('record source',e);}
}
function startRecording(){
  if(!isHost||recorder)return;
  try{
    ensureRecorderGraph();
    const lp=lkRoom?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    if(lp?.track)connectTrackToRecorder(lp.track,'local-'+lp.trackSid);
    for(const p of lkRoom?.remoteParticipants?.values()||[]){for(const pub of p.trackPublications.values()) if(pub.source===Track.Source.Microphone&&pub.track)connectTrackToRecorder(pub.track,'remote-'+p.identity+'-'+pub.trackSid);}
    recorder=new MediaRecorder(audioDest.stream,{mimeType:MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'});
    recorder.ondataavailable=e=>{if(e.data.size)recordChunks.push(e.data);}; recorder.start(1000);
  }catch(e){console.error(e);toast('تعذر بدء تسجيل صوت الملخص');}
}
$('#endBtn').onclick=()=>{
  if(!isHost)return;
  socket.emit('end-room',{roomId});
  if(!recorder||recorder.state==='inactive'){toast('لا يوجد تسجيل متاح للتلخيص');return;}
  show('processing');
  recorder.onstop=async()=>{const blob=new Blob(recordChunks,{type:'audio/webm'});try{await lkRoom?.disconnect();}catch{}await summarize(blob);};
  recorder.stop();
};
async function summarize(blob){
  try{
    const fd=new FormData();fd.append('audio',blob,'meeting.webm');
    const r=await fetch('/api/summarize',{method:'POST',body:fd});const data=await r.json();if(!r.ok)throw new Error(data.error||'فشل التلخيص');renderSummary(data);
  }catch(e){console.error(e); show('processing'); $('#processingText').textContent='تعذر إنشاء الملخص: '+e.message+' — تحقق من GEMINI_API_KEY وحدود الاستخدام ثم حاول مرة أخرى.';}
}
function fillList(sel,items,empty='لا يوجد شيء محدد.'){const ul=$(sel);ul.innerHTML='';(items?.length?items:[empty]).forEach(x=>{const li=document.createElement('li');li.textContent=x;ul.appendChild(li);});}
function renderSummary(data){
  const s=data.summary||{};show('summary');$('#summaryTitle').textContent=s.title||'ملخص الاجتماع';$('#summaryText').textContent=s.summary||'لم يتوفر ملخص.';
  fillList('#keyPoints',s.keyPoints);fillList('#decisions',s.decisions);fillList('#followUps',s.followUps);$('#actions').innerHTML='';
  if(s.actions?.length)s.actions.forEach(a=>{const d=document.createElement('div');d.className='taskCard';d.innerHTML='<b></b><div class="taskMeta"></div>';d.querySelector('b').textContent=a.task||'مهمة';d.querySelector('.taskMeta').textContent=[a.owner&&('المسؤول: '+a.owner),a.deadline&&('الموعد: '+a.deadline)].filter(Boolean).join(' • ')||'لم يذكر مسؤول أو موعد';$('#actions').appendChild(d);});else $('#actions').textContent='لم تُذكر مهام واضحة.';
  $('#transcript').textContent=data.transcript||'';
}
$('#newMeeting').onclick=()=>location.href=location.pathname;

if(roomId)openPrejoin();
