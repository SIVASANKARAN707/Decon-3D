/**
 * Meeting Room - WebSocket Server with WebRTC Signaling
 * Pure Node.js, zero dependencies
 * Usage: node server.js
 */

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT = 3000;

// rooms: Map<roomId, { title, adminId, locked, forceMute, forceCamOff, members: Map<socketId, {name,role,ws}> }>
const rooms   = new Map();
const sockets = new Map();
let   nextId  = 1;

// Temp dir for uploaded models
const MODELS_DIR = path.join(__dirname, '_models');
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR);

// Clean up any leftover model files from a previous crashed session
try {
  fs.readdirSync(MODELS_DIR).forEach(f => {
    try { fs.unlinkSync(path.join(MODELS_DIR, f)); } catch(_) {}
  });
  console.log('[3D] Cleaned up leftover model files on startup');
} catch(_) {}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve stored model files: GET /_model/<roomId>
  if (req.method === 'GET' && req.url.startsWith('/_model/')) {
    const roomId = req.url.slice('/_model/'.length).split('?')[0];
    const room = rooms.get(roomId);
    if (!room || !room.modelFile) { res.writeHead(404); res.end('No model'); return; }
    fs.readFile(room.modelFile.path, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + room.modelFile.name + '"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
    return;
  }

  // Model upload: POST /_upload/<roomId>  (multipart or raw binary)
  if (req.method === 'POST' && req.url.startsWith('/_upload/')) {
    const parts = req.url.slice('/_upload/'.length).split('/');
    const roomId = parts[0];
    const fileName = decodeURIComponent(parts[1] || 'model.glb');
    const room = rooms.get(roomId);
    if (!room) { res.writeHead(404); res.end('Room not found'); return; }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const filePath = path.join(MODELS_DIR, roomId + '_' + Date.now() + '_' + fileName.replace(/[^a-zA-Z0-9._-]/g,'_'));
      fs.writeFile(filePath, buf, err => {
        if (err) { res.writeHead(500); res.end('Write failed'); return; }
        // Clean up old model file
        if (room.modelFile) try { fs.unlinkSync(room.modelFile.path); } catch(_) {}
        room.modelFile = { path: filePath, name: fileName };
        console.log('[3D] Model saved to disk:', filePath, '|', Math.round(buf.length/1024), 'KB');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
        // Notify server of new model (triggers relay to users if interactive mode on)
        _onModelSaved(roomId, room, fileName);
      });
    });
    req.on('error', () => { res.writeHead(500); res.end(); });
    return;
  }

  // ── Chat file upload: POST /chat-file ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/chat-file') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > 15 * 1024 * 1024) { req.destroy(); res.writeHead(413); res.end('Too large'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }
      const { roomId, senderName, fileName, fileSize, fileType, fileData } = msg;
      if (!roomId || !senderName || !fileName || !fileData) {
        res.writeHead(400); res.end('Missing fields'); return;
      }
      const room = rooms.get(roomId);
      if (!room) { res.writeHead(404); res.end('Room not found'); return; }
      const member = [...room.members.values()].find(m => m.name === senderName);
      const role = member ? member.role : 'user';
      const now = new Date();
      const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      broadcast(roomId, { type:'chat_file', name:senderName, role, fileName, fileSize:fileSize||0, fileType:fileType||'', fileData, time });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    req.on('error', () => { res.writeHead(500); res.end(); });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204); res.end(); return;
  }

  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

function _onModelSaved(roomId, room, fileName) {
  // Store lightweight model reference (no base64 data in memory!)
  room.lastModel3dData = { type: 'model3d_url', name: fileName, url: '/_model/' + roomId };
  if (room.interactive3d) {
    _notifyUsersModelUrl(room);
  }
}

function _notifyUsersModelUrl(room) {
  if (!room.lastModel3dData) return;
  const frame = encode(JSON.stringify(room.lastModel3dData));
  for (const [mid, m] of room.members) {
    if (mid !== room.adminId) try { m.ws.write(frame); } catch(_) {}
  }
  console.log('[3D] Notified users of model URL:', room.lastModel3dData.url);
}

// ── WebSocket upgrade ─────────────────────────────────────────────────────────
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const id = nextId++;
  socket._id  = id;
  socket._buf = Buffer.alloc(0);
  sockets.set(id, socket);

  console.log(`[+] #${id} connected`);

  socket.on('data', chunk => {
    socket._buf = Buffer.concat([socket._buf, chunk]);
    let msg;
    while ((msg = decode(socket._buf)) !== null) {
      socket._buf = socket._buf.slice(msg.consumed);
      if (msg.opcode === 8) { socket.destroy(); return; }
      if (msg.opcode === 1) onMessage(id, socket, msg.text);
    }
  });

  socket.on('close', () => onClose(id));
  socket.on('error', () => onClose(id));
});

// ── Frame decoder ─────────────────────────────────────────────────────────────
function decode(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  let   len    = buf[1] & 0x7f;
  let   off    = 2;

  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }

  const total = off + (masked ? 4 : 0) + len;
  if (buf.length < total) return null;

  let payload = buf.slice(off + (masked ? 4 : 0), total);
  if (masked) {
    const mask = buf.slice(off, off + 4);
    payload = Buffer.from(payload).map((b, i) => b ^ mask[i % 4]);
  }
  return { opcode, text: payload.toString('utf8'), consumed: total };
}

// ── Frame encoder ─────────────────────────────────────────────────────────────
function encode(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  let header;
  if      (n < 126)   { header = Buffer.from([0x81, n]); }
  else if (n < 65536) { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(n,2); }
  else                { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(n),2); }
  return Buffer.concat([header, payload]);
}

function emit(socket, obj) {
  try { socket.write(encode(JSON.stringify(obj))); } catch (_) {}
}

function broadcast(roomId, obj) {
  const room = rooms.get(roomId);
  if (!room) return;
  const frame = encode(JSON.stringify(obj));
  for (const [, m] of room.members) {
    try { m.ws.write(frame); } catch (_) {}
  }
}

function broadcastExcept(roomId, obj, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const frame = encode(JSON.stringify(obj));
  for (const [mid, m] of room.members) {
    if (mid !== exceptId) try { m.ws.write(frame); } catch (_) {}
  }
}

// Send stored model to all non-admin users, chunked if large
function emitToName(roomId, targetName, obj) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [, m] of room.members) {
    if (m.name === targetName) { emit(m.ws, obj); return; }
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
function onMessage(id, socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const { type, roomId } = msg;

  // CREATE
  if (type === 'create') {
    const { name, roomTitle } = msg;
    if (rooms.has(roomId)) { emit(socket, { type:'error', text:'Room ID already taken. Try another.' }); return; }
    const room = { title: roomTitle, adminId: id, locked: false, forceMute: false, forceCamOff: false, interactive3d: false, lastModel3dData: null, adminFsActive: false, adminFsSpotlight: null, adminFsGrid3d: false, members: new Map() };
    room.members.set(id, { name, role: 'admin', ws: socket });
    rooms.set(roomId, room);
    socket._roomId = roomId;
    emit(socket, { type:'joined', roomId, roomTitle, name, role:'admin', members: memberList(roomId) });
    console.log(`[room] "${roomTitle}" (${roomId}) created by ${name}`);
    return;
  }

  // JOIN
  if (type === 'join') {
    const { name } = msg;
    const room = rooms.get(roomId);
    if (!room)       { emit(socket, { type:'error', text:'Room not found. Check the Room ID.' }); return; }
    if (room.locked) { emit(socket, { type:'error', text:'This room is locked by the admin.' }); return; }

    // Get existing members BEFORE adding the new one — they'll need to initiate offers
    const existingMembers = memberList(roomId);

    room.members.set(id, { name, role: 'user', ws: socket });
    socket._roomId = roomId;

    emit(socket, { type:'joined', roomId, roomTitle: room.title, name, role:'user', members: memberList(roomId) });

    // Tell the NEW joiner who is already in the room so they can create offers
    emit(socket, { type:'existing_peers', peers: existingMembers });

    // Send current forced states to new joiner
    if (room.forceMute)   emit(socket, { type:'force_mute',  active: true });
    if (room.forceCamOff) emit(socket, { type:'force_cam',   active: true });
    if (room.locked)      emit(socket, { type:'room_locked', active: true });
    if (room.interactive3d) {
      emit(socket, { type:'interactive3d_state', active: true });
      if (room.lastModel3dData) emit(socket, room.lastModel3dData);
    }
    // Send current admin fullscreen layout to new joiner so they get the tile immediately
    if (room.adminFsActive) {
      emit(socket, { type:'admin_fs', active: true, spotlightUser: room.adminFsSpotlight || null, grid3d: room.adminFsGrid3d || false });
    }
    // Send current PiP cam state to new joiner
    if (room.pipCamActive) {
      emit(socket, { type:'pip_cam_state', active: true });
      if (room.pipCamPos) emit(socket, { type:'pip_pos', x: room.pipCamPos.x, y: room.pipCamPos.y });
    }
    // Send current screen-share state to new joiner so their tile renders correctly
    if (room.screenOn && room.screensharer) {
      emit(socket, { type:'screen_state', name: room.screensharer, screenOn: true });
    }

    broadcast(roomId, { type:'members', members: memberList(roomId) });
    broadcastExcept(roomId, { type:'sys', text: name + ' joined the room.' }, id);

    // Re-broadcast screen_state to EXISTING users so they restore the is-screenshare
    // class on their newly rebuilt tile videos after the members-triggered grid rebuild.
    // Without this, the persistent-video's is-screenshare class is not copied to the
    // freshly created tile video and the screenshare stream appears to "cut" for everyone.
    if (room.screenOn && room.screensharer) {
      broadcastExcept(roomId, { type:'screen_state', name: room.screensharer, screenOn: true }, id);
    }

    // NOTE: Do NOT re-broadcast admin_fs or interactive3d_state to existing users here.
    // Those re-broadcasts use the room's state SNAPSHOT at join time, which may be stale:
    // if the admin toggled 3D off a moment before/after the join, the stale re-broadcast
    // with grid3d:true arrives AFTER the admin set their local fs3dActive=false, resetting
    // it back to true and causing the 3D-options glitch (Bug #1).
    // Existing users already hold the correct live state; the members update triggers
    // renderAdminFullscreen which re-renders using their current local values.

    console.log(`[join] ${name} → ${roomId}`);
    return;
  }

  // CHAT
  if (type === 'chat') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member) return;
    const t = msg.text && msg.text.trim();
    if (!t) return;
    const now = new Date();
    const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    broadcast(roomId, { type:'chat', name: member.name, role: member.role, text: t, time });
    return;
  }


  // ── WebRTC SIGNALING — relay to target peer ────────────────────────────────
  // offer: new joiner sends offer to each existing peer
  if (type === 'rtc_offer') {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.members.get(id);
    if (!sender) return;
    emitToName(roomId, msg.target, {
      type: 'rtc_offer',
      sdp:  msg.sdp,
      from: sender.name
    });
    return;
  }

  // answer: existing peer sends answer back to the new joiner
  if (type === 'rtc_answer') {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.members.get(id);
    if (!sender) return;
    emitToName(roomId, msg.target, {
      type: 'rtc_answer',
      sdp:  msg.sdp,
      from: sender.name
    });
    return;
  }

  // ice: relay ICE candidates between peers
  if (type === 'rtc_ice') {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.members.get(id);
    if (!sender) return;
    emitToName(roomId, msg.target, {
      type:      'rtc_ice',
      candidate: msg.candidate,
      from:      sender.name
    });
    return;
  }

  // KICK (admin only)
  if (type === 'kick') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    const { targetName } = msg;
    let kicked = false;
    for (const [mid, m] of room.members) {
      if (m.name === targetName && m.role !== 'admin') {
        emit(m.ws, { type:'kicked', text:'You were removed by the admin.' });
        m.ws.destroy();
        room.members.delete(mid);
        sockets.delete(mid);
        // Clear tag if the kicked user was tagged
        if (room.taggedSuccessor === targetName) room.taggedSuccessor = null;
        kicked = true;
        break;
      }
    }
    if (kicked) {
      broadcast(roomId, { type:'members', members: memberList(roomId) });
      broadcast(roomId, { type:'sys', text: targetName + ' was removed by the admin.' });
    }
    return;
  }

  // MAKE ADMIN — swap current admin to user, target user to admin
  if (type === 'make_admin') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    const { targetName } = msg;
    let targetId = null, targetMember = null;
    for (const [mid, m] of room.members) {
      if (m.name === targetName && m.role !== 'admin') { targetId = mid; targetMember = m; break; }
    }
    if (!targetMember) return;
    // Demote current admin
    const curAdmin = room.members.get(id);
    if (curAdmin) curAdmin.role = 'user';
    // Promote target
    targetMember.role = 'admin';
    room.adminId = targetId;
    // Clear tag if target was tagged
    if (room.taggedSuccessor === targetName) room.taggedSuccessor = null;
    // Notify old admin they are now a user
    if (curAdmin) emit(curAdmin.ws, { type:'demoted', text:'You are now a regular user.' });
    // Notify new admin
    emit(targetMember.ws, { type:'promoted', text:'You are now the admin.' });
    // Broadcast updated member list
    broadcast(roomId, { type:'members', members: memberList(roomId) });
    broadcast(roomId, { type:'sys', text: targetName + ' is now the admin.' });
    console.log(`[admin] ${targetName} promoted to admin, ${curAdmin ? curAdmin.name : '?'} demoted`);
    return;
  }

  // TAG SUCCESSOR — admin designates who becomes admin if they leave
  if (type === 'tag_successor') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    room.taggedSuccessor = msg.targetName || null;
    console.log(`[tag] Successor for room ${roomId}: ${room.taggedSuccessor || 'none'}`);
    return;
  }

  // MUTE ALL — toggle forced mute, broadcast to all (including admin so UI updates)
  if (type === 'mute_all') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    room.forceMute = !room.forceMute;
    broadcast(roomId, { type:'force_mute', active: room.forceMute });
    broadcast(roomId, { type:'sys', text: room.forceMute
      ? 'Admin force-muted all participants. Users cannot unmute.'
      : 'Admin removed forced mute. Users can now unmute.' });
    return;
  }

  // CAM ALL — toggle forced camera off
  if (type === 'cam_all') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    room.forceCamOff = !room.forceCamOff;
    broadcast(roomId, { type:'force_cam', active: room.forceCamOff });
    broadcast(roomId, { type:'sys', text: room.forceCamOff
      ? 'Admin turned off all cameras. Users cannot turn on camera.'
      : 'Admin restored cameras. Users can now turn on camera.' });
    return;
  }

  // LOCK ROOM — toggle lock
  if (type === 'lock_room') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    room.locked = !room.locked;
    broadcast(roomId, { type:'room_locked', active: room.locked });
    broadcast(roomId, { type:'sys', text: room.locked
      ? 'Room locked. No new participants can join.'
      : 'Room unlocked. Anyone can now join.' });
    return;
  }

  // END SESSION — kick everyone and delete room
  if (type === 'end_session') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    broadcast(roomId, { type:'ended', text:'The admin ended the session.' });
    rooms.delete(roomId);
    return;
  }

  // SCREEN SHARE STATE — broadcast to all others so they un-mirror the video
  if (type === 'screen_state') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member) return;
    // Persist so new joiners receive current screen-share state on join
    room.screenOn      = !!msg.screenOn;
    room.screensharer  = msg.screenOn ? member.name : null;
    const frame = encode(JSON.stringify({ type: 'screen_state', name: member.name, screenOn: msg.screenOn }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  // GRID3D STREAM — admin broadcasts 3D canvas stream active state
  if (type === 'grid3d_stream') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member) return;
    const frame = encode(JSON.stringify({ type: 'grid3d_stream', name: member.name, active: msg.active }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  // FRAME3D — admin sends canvas JPEG frames; server relays to all users in room
  if (type === 'frame3d') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member || member.role !== 'admin') return;
    const recipients = [];
    const frame = encode(JSON.stringify({ type: 'frame3d', img: msg.img }));
    for (const [mid, m] of room.members) {
      if (mid !== id) { try { m.ws.write(frame); recipients.push(m.name); } catch(_) {} }
    }
    // Log first frame so we know it's flowing (then suppress to avoid spam)
    if (!room._3dFrameLogged) {
      room._3dFrameLogged = true;
      console.log('[3D] First frame relayed to:', recipients.join(', '), '| size:', (JSON.stringify({type:'frame3d',img:msg.img}).length/1024).toFixed(1)+'KB');
    }
    return;
  }

  // ADMIN FULLSCREEN STATE — broadcast to all others in room
  if (type === 'admin_fs') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member || member.role !== 'admin') return; // only admin can send this
    // Persist the current admin_fs state so late joiners get it on join
    room.adminFsActive    = !!msg.active;
    room.adminFsSpotlight = msg.spotlightUser || null;
    room.adminFsGrid3d    = msg.grid3d || false;
    const frame = encode(JSON.stringify({ type: 'admin_fs', active: msg.active, spotlightUser: msg.spotlightUser || null, grid3d: msg.grid3d || false }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  // CAM STATE — broadcast to all others in room
  if (type === 'cam_state') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member) return;
    // Relay to everyone else
    const frame = encode(JSON.stringify({ type: 'cam_state', name: member.name, camOn: msg.camOn }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  if (type === 'interactive3d_toggle') {
    const room = rooms.get(roomId);
    if (!room || room.adminId !== id) return;
    room.interactive3d = !!msg.active;
    broadcast(roomId, { type: 'interactive3d_state', active: room.interactive3d });
    broadcast(roomId, { type: 'sys', text: room.interactive3d
      ? 'Interactive 3D enabled — everyone now has their own 3D space!'
      : 'Interactive 3D disabled — back to admin view.' });
    if (room.interactive3d && room.lastModel3dData) {
      console.log('[3D] Sending model URL to users on toggle:', room.lastModel3dData.url);
      _notifyUsersModelUrl(room);
    }
    return;
  }

  // PIP CAM STATE — admin shows/hides camera PiP; relay to all users
  if (type === 'pip_cam_state') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member || member.role !== 'admin') return;

    // Always persist the admin's true cam state (regardless of interaction mode).
    // pipCamActive reflects what the admin WANTS; pipCamVisibleToUsers reflects
    // what non-interactive users should actually see.
    room.pipCamActive = !!msg.active;
    if (!msg.active) { room.pipCamPos = null; }

    // When suppressIfInteractive is true the admin's cam is on but user
    // interaction mode is also on — users have their own personal minicam,
    // so we must NOT push the admin's cam overlay to them.
    const suppress = !!msg.suppressIfInteractive;
    const payloadActive = msg.active && !suppress ? true : !msg.active ? false : null;

    // payloadActive === null means "admin cam is on but interaction is on too —
    // send active:false so users hide any previously shown admin cam."
    const sendActive = payloadActive === null ? false : payloadActive;
    const frame = encode(JSON.stringify({ type: 'pip_cam_state', active: sendActive }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  // PIP POS — admin dragged the PiP; relay position (percentage) to all users
  if (type === 'pip_pos') {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(id);
    if (!member || member.role !== 'admin') return;
    room.pipCamPos = { x: msg.x, y: msg.y };
    const frame = encode(JSON.stringify({ type: 'pip_pos', x: msg.x, y: msg.y }));
    for (const [mid, m] of room.members) {
      if (mid !== id) try { m.ws.write(frame); } catch(_) {}
    }
    return;
  }

  if (type === 'leave') { onClose(id); }
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function onClose(id) {
  const socket  = sockets.get(id);
  const roomId  = socket?._roomId;
  sockets.delete(id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const member = room.members.get(id);
  const name   = member?.name || 'Someone';
  room.members.delete(id);
  console.log(`[-] ${name} left ${roomId}`);

  if (room.members.size === 0) {
    // Session over — delete stored model file from disk
    if (room.modelFile) {
      fs.unlink(room.modelFile.path, err => {
        if (!err) console.log('[3D] Deleted model file:', room.modelFile.path);
      });
    }
    // Also clean up any leftover files for this room (e.g. from multiple uploads)
    try {
      const files = fs.readdirSync(MODELS_DIR);
      files.filter(f => f.startsWith(roomId + '_')).forEach(f => {
        try { fs.unlinkSync(path.join(MODELS_DIR, f)); } catch(_) {}
      });
    } catch(_) {}
    rooms.delete(roomId);
    console.log(`[room] ${roomId} closed — all model files deleted`);
    return;
  }

  if (room.adminId === id) {
    // Use tagged successor if set and still in room, otherwise fall back to first member
    let newId = null, newMember = null;
    if (room.taggedSuccessor) {
      for (const [mid, m] of room.members) {
        if (m.name === room.taggedSuccessor) { newId = mid; newMember = m; break; }
      }
    }
    if (!newMember) {
      // Fallback: first remaining member
      const entry = room.members.entries().next().value;
      if (entry) { newId = entry[0]; newMember = entry[1]; }
    }
    if (newMember) {
      room.adminId          = newId;
      newMember.role        = 'admin';
      room.taggedSuccessor  = null;
      emit(newMember.ws, { type:'promoted', text:'You are now the admin.' });
    }
  }

  // Tell remaining peers to remove this peer's video
  broadcast(roomId, { type:'peer_left', name });
  broadcast(roomId, { type:'members', members: memberList(roomId) });
  broadcast(roomId, { type:'sys', text: name + ' left the room.' });
}

function memberList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members.values()).map(m => ({ name: m.name, role: m.role }));
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n✅  Meeting Room server → http://localhost:' + PORT);
  console.log('    WebSocket          → ws://localhost:'    + PORT);
  console.log('    Open the URL in multiple tabs to test\n');
});
