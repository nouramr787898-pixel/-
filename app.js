const $ = s => document.querySelector(s);
const socket = io({ transports: ['websocket', 'polling'] });
const qs = new URLSearchParams(location.search);
let roomId = qs.get('room');
let isHost = qs.get('host') === '1';
let displayName = '';
let approved = false;
let localStream = null;
let screenStream = null;
let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let recorder = null;
let recordChunks = [];
let audioCtx = null;
let audioDest = null;
const connectedSources = new Set();
const peers = new Map();
const remoteStreams = new Map();
const participantNames = new Map();
const pendingCandidates = new Map();
const reconnectTimers = new Map();

function show(id) {
  ['landing','prejoin','meeting','processing','summary','rejected','ended'].forEach(x => $('#'+x)?.classList.add('hidden'));
  $('#'+id)?.classList.remove('hidden');
}
function toast(t) {
  const e = $('#toast'); e.textContent = t; e.classList.add('show');
  setTimeout(() => e.classList.remove('show'), 2300);
}
function makeRoom() { return crypto.randomUUID().replaceAll('-','').slice(0,10); }
function meetingUrl(id, host = false) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('room', id);
  if (host) u.searchParams.set('host', '1');
  return u.toString();
}
function shareUrl() { return meetingUrl(roomId, false); }

async function loadRtcConfig() {
  try {
    const r = await fetch('/api/rtc-config', { cache: 'no-store' });
    if (r.ok) rtcConfig = await r.json();
  } catch {}
}
loadRtcConfig();

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
  await getMedia();
}

async function getMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('المتصفح لا يدعم الكاميرا والميكروفون');
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    $('#previewVideo').srcObject = localStream;
    $('#previewPlaceholder').style.display = 'none';
  } catch (e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      $('#previewPlaceholder').textContent = 'الكاميرا مغلقة';
    } catch {
      localStream = new MediaStream();
      $('#previewPlaceholder').textContent = 'الكاميرا والميكروفون غير متاحين';
    }
    $('#previewPlaceholder').style.display = 'grid';
  }
}
function setTrack(kind, on) { localStream?.getTracks().filter(t => t.kind === kind).forEach(t => t.enabled = on); }
$('#preMic').onclick = () => {
  const b = $('#preMic'); b.classList.toggle('active');
  const on = b.classList.contains('active');
  b.textContent = 'الميكروفون: ' + (on ? 'يعمل' : 'مغلق'); setTrack('audio', on);
};
$('#preCam').onclick = () => {
  const b = $('#preCam'); b.classList.toggle('active');
  const on = b.classList.contains('active');
  b.textContent = 'الكاميرا: ' + (on ? 'تعمل' : 'مغلقة'); setTrack('video', on);
  $('#previewPlaceholder').style.display = on ? 'none' : 'grid';
};

$('#enterRoom').onclick = async () => {
  displayName = $('#displayName').value.trim() || (isHost ? 'صاحب الاجتماع' : 'مشارك');
  if (!localStream) await getMedia();
  await unlockAudio();
  if (isHost) {
    approved = true;
    socket.emit('host-join', { roomId, name: displayName });
    enterMeeting();
  } else {
    $('#enterRoom').classList.add('hidden');
    $('#waitingBox').classList.remove('hidden');
    socket.emit('request-join', { roomId, name: displayName });
  }
};
$('#cancelRequest').onclick = () => { socket.emit('cancel-join', { roomId }); location.href = location.pathname; };

// The server has already placed us in the room when this event arrives.
socket.on('join-approved', async ({ existingUsers = [] } = {}) => {
  approved = true;
  $('#waitingBox').classList.add('hidden');
  enterMeeting();
  for (const u of existingUsers) {
    participantNames.set(u.id, u.name || 'مشارك');
    ensureRemoteTile(u.id, u.name || 'مشارك');
  }
  // The newly approved guest is the only side that starts offers. No offer collision.
  for (const u of existingUsers) await createPeer(u.id, true);
});
socket.on('join-rejected', () => { localStream?.getTracks().forEach(t => t.stop()); show('rejected'); });
socket.on('room-unavailable', () => { alert('هذا الاجتماع غير متاح أو انتهى.'); location.href = location.pathname; });

function enterMeeting() {
  show('meeting');
  window.scrollTo(0, 0);
  setPeoplePanel(false); // start with the video area fully visible, like Google Meet
  $('#meetingRoomId').textContent = 'رمز: ' + roomId;
  if (isHost) $('#endBtn').classList.remove('hidden');
  addVideo('local', localStream, displayName, true);
  participantNames.set(socket.id, displayName);
  updateLocalButtons();
  updateGridLayout();
  if (isHost) setTimeout(startRecording, 600);
}

function tileId(id) { return 'v-' + id.replace(/[^a-zA-Z0-9_-]/g, '_'); }
function ensureRemoteTile(id, name = 'مشارك') {
  let tile = document.getElementById(tileId(id));
  if (!tile) {
    tile = document.createElement('div');
    tile.id = tileId(id); tile.dataset.peerId = id; tile.className = 'videoTile remote waitingMedia';
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="avatarStage"><div class="bigAvatar"></div><div class="waitingText">جاري الاتصال بالصوت والصورة…</div></div>
      <button class="playAudio hidden">اضغط لتشغيل الصوت</button>
      <div class="connectionBadge warn">جاري الاتصال…</div>
      <div class="videoLabel"></div>`;
    $('#videoGrid').appendChild(tile);
  }
  tile.querySelector('.bigAvatar').textContent = (name || 'م').trim().slice(0,1);
  tile.querySelector('.videoLabel').textContent = name;
  updateGridLayout();
  return tile;
}

function addVideo(id, stream, name, local = false) {
  let tile;
  if (local) {
    tile = document.getElementById('v-local');
    if (!tile) {
      tile = document.createElement('div'); tile.id = 'v-local'; tile.className = 'videoTile local';
      tile.innerHTML = '<video autoplay muted playsinline></video><div class="avatarStage hidden"><div class="bigAvatar"></div></div><div class="videoLabel"></div>';
      $('#videoGrid').appendChild(tile);
    }
  } else {
    tile = ensureRemoteTile(id, name);
  }

  const video = tile.querySelector('video');
  video.srcObject = stream;
  if (!local) {
    tile.classList.remove('waitingMedia');
    const avatarStage = tile.querySelector('.avatarStage');
    if (avatarStage) avatarStage.classList.toggle('hidden', !!stream?.getVideoTracks().length);
    video.muted = false; video.volume = 1;
    const playBtn = tile.querySelector('.playAudio');
    const tryPlay = async () => {
      try { await video.play(); playBtn.classList.add('hidden'); }
      catch { playBtn.classList.remove('hidden'); $('#audioUnlock').classList.remove('hidden'); }
    };
    playBtn.onclick = async () => { await unlockAudio(); await tryPlay(); };
    video.onloadedmetadata = tryPlay;
    tryPlay();
  }
  tile.querySelector('.videoLabel').textContent = name + (local ? ' (أنت)' : '');
  participantNames.set(id, name);
  updateTileCameraState(tile, stream, local);
  updateGridLayout();
}

function updateTileCameraState(tile, stream, local = false) {
  const videoTrack = stream?.getVideoTracks()?.[0];
  const camOn = !!(videoTrack && videoTrack.enabled && videoTrack.readyState === 'live');
  let avatarStage = tile.querySelector('.avatarStage');
  if (avatarStage) avatarStage.classList.toggle('hidden', camOn || tile.classList.contains('waitingMedia'));
  if (local && avatarStage) {
    avatarStage.querySelector('.bigAvatar').textContent = (displayName || 'أ').slice(0,1);
  }
}

function removeVideo(id) {
  const tile = document.getElementById(tileId(id));
  tile?.remove();
  participantNames.delete(id); remoteStreams.delete(id);
  updateGridLayout();
}
function updateGridLayout() {
  const grid = $('#videoGrid');
  const count = grid?.children.length || 0;
  grid.classList.remove('count-1','count-2','count-3','count-4','count-many');
  grid.classList.add(count <= 4 ? `count-${Math.max(1,count)}` : 'count-many');
}

async function createPeer(id, initiator = false) {
  if (!id || id === socket.id) return null;
  if (peers.has(id)) {
    const pc = peers.get(id);
    if (initiator && !pc._offerSent && pc.signalingState === 'stable') await makeOffer(id, false);
    return pc;
  }

  ensureRemoteTile(id, participantNames.get(id) || 'مشارك');
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(id, pc);
  pc._initiator = initiator;
  pc._makingOffer = false;
  pc._offerSent = false;

  for (const track of localStream?.getTracks() || []) pc.addTrack(track, localStream);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('signal', { target: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = e => {
    let stream = remoteStreams.get(id);
    if (!stream) { stream = new MediaStream(); remoteStreams.set(id, stream); }
    const source = e.streams?.[0];
    if (source) {
      for (const track of source.getTracks()) if (!stream.getTracks().some(t => t.id === track.id)) stream.addTrack(track);
    } else if (!stream.getTracks().some(t => t.id === e.track.id)) {
      stream.addTrack(e.track);
    }
    addVideo(id, stream, participantNames.get(id) || 'مشارك');
    connectRemoteToRecorder(stream, id);
    e.track.onunmute = () => addVideo(id, stream, participantNames.get(id) || 'مشارك');
  };
  pc.onconnectionstatechange = () => handleConnectionState(id, pc);
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && pc._initiator) restartPeerIce(id);
  };

  if (initiator) await makeOffer(id, false);
  return pc;
}

function setConnectionBadge(id, text, type = 'warn') {
  const tile = document.getElementById(tileId(id));
  if (!tile) return;
  const b = tile.querySelector('.connectionBadge');
  if (!b) return;
  b.textContent = text; b.className = `connectionBadge ${type}`;
  b.classList.toggle('hidden', !text);
}
function handleConnectionState(id, pc) {
  const state = pc.connectionState;
  if (state === 'connected') {
    setConnectionBadge(id, 'متصل', 'ok');
    clearTimeout(reconnectTimers.get(id));
    reconnectTimers.delete(id);
    setTimeout(() => setConnectionBadge(id, '', 'ok'), 1500);
  } else if (state === 'connecting' || state === 'new') {
    setConnectionBadge(id, 'جاري الاتصال…', 'warn');
  } else if (state === 'disconnected') {
    setConnectionBadge(id, 'إعادة الاتصال…', 'warn');
    if (pc._initiator && !reconnectTimers.has(id)) {
      reconnectTimers.set(id, setTimeout(() => restartPeerIce(id), 1800));
    }
  } else if (state === 'failed') {
    setConnectionBadge(id, 'فشل الاتصال — إعادة المحاولة…', 'bad');
    if (pc._initiator) restartPeerIce(id);
  } else if (state === 'closed') {
    peers.delete(id); removeVideo(id);
  }
}

async function makeOffer(id, iceRestart = false) {
  const pc = peers.get(id);
  if (!pc || pc._makingOffer || pc.signalingState !== 'stable') return;
  try {
    pc._makingOffer = true;
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    pc._offerSent = true;
    socket.emit('signal', { target: id, data: { sdp: pc.localDescription } });
  } catch (e) { console.error('Offer error', e); }
  finally { pc._makingOffer = false; }
}
async function restartPeerIce(id) {
  const pc = peers.get(id);
  if (!pc || pc.signalingState === 'closed') return;
  clearTimeout(reconnectTimers.get(id)); reconnectTimers.delete(id);
  try { pc.restartIce(); } catch {}
  await makeOffer(id, true);
}

socket.on('user-joined', async ({ id, name }) => {
  participantNames.set(id, name || 'مشارك');
  ensureRemoteTile(id, name || 'مشارك');
  // Existing members wait for the newly approved guest's offer.
  await createPeer(id, false);
});

socket.on('signal', async ({ from, data, name }) => {
  if (!approved) return;
  participantNames.set(from, name || participantNames.get(from) || 'مشارك');
  const pc = await createPeer(from, false);
  if (!pc) return;

  if (data.sdp) {
    try {
      if (data.sdp.type === 'offer') {
        if (pc.signalingState !== 'stable') {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
        }
        await pc.setRemoteDescription(data.sdp);
        const queued = pendingCandidates.get(from) || [];
        for (const c of queued) { try { await pc.addIceCandidate(c); } catch {} }
        pendingCandidates.delete(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { target: from, data: { sdp: pc.localDescription } });
      } else if (data.sdp.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(data.sdp);
          const queued = pendingCandidates.get(from) || [];
          for (const c of queued) { try { await pc.addIceCandidate(c); } catch {} }
          pendingCandidates.delete(from);
        }
      }
    } catch (e) { console.error('SDP error', e); }
  } else if (data.candidate) {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn('ICE error', e); }
    } else {
      const q = pendingCandidates.get(from) || [];
      q.push(data.candidate); pendingCandidates.set(from, q);
    }
  }
});

socket.on('user-left', ({ id }) => {
  peers.get(id)?.close(); peers.delete(id); removeVideo(id);
});

socket.on('room-state', state => {
  const list = state.participants || [];
  $('#participantCount').textContent = list.length + (list.length === 1 ? ' مشارك' : ' مشاركين');
  $('#peopleCount').textContent = list.length;
  renderParticipants(list, state.hostId);

  // Always render one visible box per participant, even before their media arrives.
  const liveIds = new Set(list.map(p => p.id));
  for (const p of list) {
    participantNames.set(p.id, p.name || 'مشارك');
    if (p.id !== socket.id) ensureRemoteTile(p.id, p.name || 'مشارك');
  }
  for (const id of [...peers.keys()]) if (!liveIds.has(id)) { peers.get(id)?.close(); peers.delete(id); removeVideo(id); }
  updateGridLayout();
});

function renderParticipants(list, hostId) {
  const box = $('#participantsList'); box.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'participantRow';
    row.innerHTML = '<div class="participantInfo"><div class="avatar"></div><div><b class="pname"></b><div class="personMeta"></div></div></div><span class="hostTag hidden">المضيف</span>';
    row.querySelector('.avatar').textContent = (p.name || 'م').trim().slice(0,1);
    row.querySelector('.pname').textContent = p.name + (p.id === socket.id ? ' (أنت)' : '');
    row.querySelector('.personMeta').textContent = [p.mic === false ? 'الميكروفون مغلق' : 'الميكروفون يعمل', p.cam === false ? 'الكاميرا مغلقة' : 'الكاميرا تعمل'].join(' • ');
    if (p.id === hostId) row.querySelector('.hostTag').classList.remove('hidden');
    box.appendChild(row);
  }
}

socket.on('join-request', req => {
  if (!isHost) return;
  $('#pendingSection').classList.remove('hidden');
  setPeoplePanel(true);
  if (document.getElementById('req-' + req.id)) return;
  const d = document.createElement('div'); d.className = 'requestCard'; d.id = 'req-' + req.id;
  d.innerHTML = '<div class="requestName"></div><div class="requestActions"><button class="acceptBtn">قبول</button><button class="rejectBtn">رفض</button></div>';
  d.querySelector('.requestName').textContent = req.name + ' يريد الانضمام';
  d.querySelector('.acceptBtn').onclick = () => { socket.emit('approve-join', { roomId, target: req.id }); d.remove(); hidePendingIfEmpty(); setPeoplePanel(false); };
  d.querySelector('.rejectBtn').onclick = () => { socket.emit('reject-join', { roomId, target: req.id }); d.remove(); hidePendingIfEmpty(); };
  $('#joinRequests').appendChild(d);
});
socket.on('join-request-cancelled', ({ id }) => { document.getElementById('req-' + id)?.remove(); hidePendingIfEmpty(); });
function hidePendingIfEmpty() { if (!$('#joinRequests').children.length) $('#pendingSection').classList.add('hidden'); }

function emitMediaState() {
  const mic = localStream?.getAudioTracks()[0]?.enabled ?? false;
  const cam = localStream?.getVideoTracks()[0]?.enabled ?? false;
  socket.emit('media-state', { roomId, mic, cam });
  const localTile = $('#v-local'); if (localTile) updateTileCameraState(localTile, localStream, true);
}
function updateLocalButtons() {
  const mic = localStream?.getAudioTracks()[0]?.enabled ?? false;
  const cam = localStream?.getVideoTracks()[0]?.enabled ?? false;
  $('#micBtn').textContent = mic ? 'إيقاف الميكروفون' : 'تشغيل الميكروفون';
  $('#camBtn').textContent = cam ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا';
  $('#micBtn').classList.toggle('off', !mic); $('#camBtn').classList.toggle('off', !cam);
  emitMediaState();
}
$('#micBtn').onclick = () => { const t = localStream?.getAudioTracks()[0]; if (!t) return toast('الميكروفون غير متاح'); t.enabled = !t.enabled; updateLocalButtons(); };
$('#camBtn').onclick = () => { const t = localStream?.getVideoTracks()[0]; if (!t) return toast('الكاميرا غير متاحة'); t.enabled = !t.enabled; updateLocalButtons(); };

$('#screenBtn').onclick = async () => {
  try {
    if (!screenStream) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = screenStream.getVideoTracks()[0];
      for (const pc of peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }
      $('#screenBtn').textContent = 'إيقاف مشاركة الشاشة';
      track.onended = stopScreen;
    } else await stopScreen();
  } catch {}
};
async function stopScreen() {
  const cam = localStream?.getVideoTracks()[0];
  if (cam) for (const pc of peers.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(cam);
  }
  screenStream?.getTracks().forEach(t => t.stop()); screenStream = null;
  $('#screenBtn').textContent = 'مشاركة الشاشة';
}

async function copyLink() {
  try { await navigator.clipboard.writeText(shareUrl()); toast('تم نسخ رابط الاجتماع'); }
  catch { prompt('انسخ رابط الاجتماع:', shareUrl()); }
}
$('#copyBtn').onclick = copyLink; $('#copySide').onclick = copyLink; $('#topCopyBtn').onclick = copyLink;
$('#leaveBtn').onclick = leaveMeeting;
function leaveMeeting() {
  socket.emit('leave-room', { roomId });
  peers.forEach(p => p.close()); localStream?.getTracks().forEach(t => t.stop()); screenStream?.getTracks().forEach(t => t.stop());
  location.href = location.pathname;
}

async function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    for (const v of document.querySelectorAll('.videoTile.remote video')) {
      try { await v.play(); } catch {}
    }
    $('#audioUnlock')?.classList.add('hidden');
  } catch {}
}
document.addEventListener('pointerdown', () => unlockAudio(), { passive: true });
$('#audioUnlock').onclick = unlockAudio;

socket.on('room-ended', () => {
  if (isHost) return;
  peers.forEach(p => p.close()); localStream?.getTracks().forEach(t => t.stop()); show('ended');
});

function initRecorderGraph() {
  if (audioDest) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioDest = audioCtx.createMediaStreamDestination();
  const a = localStream?.getAudioTracks()[0];
  if (a) audioCtx.createMediaStreamSource(new MediaStream([a])).connect(audioDest);
  remoteStreams.forEach((s, id) => connectRemoteToRecorder(s, id));
}
function connectRemoteToRecorder(stream, id) {
  if (!isHost || !audioDest || connectedSources.has(id)) return;
  const tracks = stream.getAudioTracks(); if (!tracks.length) return;
  try { audioCtx.createMediaStreamSource(new MediaStream(tracks)).connect(audioDest); connectedSources.add(id); } catch {}
}
function startRecording() {
  if (!isHost || recorder) return;
  try {
    initRecorderGraph();
    recorder = new MediaRecorder(audioDest.stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    recorder.ondataavailable = e => { if (e.data.size) recordChunks.push(e.data); };
    recorder.start(1000);
  } catch { toast('تعذر بدء تسجيل صوت الملخص'); }
}
$('#endBtn').onclick = () => {
  if (!isHost) return;
  socket.emit('end-room', { roomId });
  if (!recorder || recorder.state === 'inactive') { toast('لا يوجد تسجيل متاح للتلخيص'); return; }
  show('processing');
  recorder.onstop = async () => { const blob = new Blob(recordChunks, { type: 'audio/webm' }); await summarize(blob); };
  recorder.stop();
};

async function summarize(blob) {
  try {
    const fd = new FormData(); fd.append('audio', blob, 'meeting.webm');
    const r = await fetch('/api/summarize', { method: 'POST', body: fd });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'فشل التلخيص');
    renderSummary(data);
  } catch (e) {
    alert('تعذر إنشاء الملخص: ' + e.message + '\nتأكد من OPENAI_API_KEY ورصيد الـAPI.');
    location.href = location.pathname;
  }
}
function fillList(sel, items, empty = 'لا يوجد شيء محدد.') {
  const ul = $(sel); ul.innerHTML = '';
  (items?.length ? items : [empty]).forEach(x => { const li = document.createElement('li'); li.textContent = x; ul.appendChild(li); });
}
function renderSummary(data) {
  const s = data.summary || {}; show('summary');
  $('#summaryTitle').textContent = s.title || 'ملخص الاجتماع'; $('#summaryText').textContent = s.summary || 'لم يتوفر ملخص.';
  fillList('#keyPoints', s.keyPoints); fillList('#decisions', s.decisions); fillList('#followUps', s.followUps);
  $('#actions').innerHTML = '';
  if (s.actions?.length) s.actions.forEach(a => {
    const d = document.createElement('div'); d.className = 'taskCard'; d.innerHTML = '<b></b><div class="taskMeta"></div>';
    d.querySelector('b').textContent = a.task || 'مهمة';
    d.querySelector('.taskMeta').textContent = [a.owner && ('المسؤول: ' + a.owner), a.deadline && ('الموعد: ' + a.deadline)].filter(Boolean).join(' • ') || 'لم يذكر مسؤول أو موعد';
    $('#actions').appendChild(d);
  }); else $('#actions').textContent = 'لم تُذكر مهام واضحة.';
  $('#transcript').textContent = data.transcript || '';
}
$('#newMeeting').onclick = () => location.href = location.pathname;

if (roomId) openPrejoin();
