/**
 * Slither Clone – Client
 *
 * Smoothness strategy (tuned for ~200ms ping):
 *
 *  OWN SNAKE  – Full client-side prediction: move locally every frame using
 *               the same physics as the server. When the server snapshot
 *               arrives, do soft reconciliation (lerp small drifts, snap large
 *               desyncs). Player sees ZERO input lag.
 *
 *  OTHERS     – Entity interpolation: buffer server snapshots and render them
 *               INTERP_DELAY ms in the past. With a 200 ms round-trip and a
 *               50 ms server tick, this gives us plenty of buffer states to
 *               interpolate between, guaranteeing silky smooth motion.
 *
 *  INPUT      – Sent at INPUT_HZ (20/sec). The server also ticks at 20/sec so
 *               there's no benefit sending faster, but we render at 60 fps.
 */

'use strict';

// ─── Canvas & Context ─────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas');
const ctx       = canvas.getContext('2d', { alpha: false });
const minimap   = document.getElementById('minimap');
const mmCtx     = minimap.getContext('2d');
const bgCanvas  = document.getElementById('bg-canvas');
const bgCtx     = bgCanvas.getContext('2d');

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  bgCanvas.width  = window.innerWidth;
  bgCanvas.height = window.innerHeight;
  drawBgStars();
}
window.addEventListener('resize', resize);
resize();

// ─── Background Stars ─────────────────────────────────────────────────────────
const STARS = [];
for (let i = 0; i < 220; i++) {
  STARS.push({
    x: Math.random(),
    y: Math.random(),
    r: 0.4 + Math.random() * 1.2,
    a: 0.2 + Math.random() * 0.6
  });
}
function drawBgStars() {
  bgCtx.fillStyle = '#060b18';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  for (const s of STARS) {
    bgCtx.beginPath();
    bgCtx.arc(s.x * bgCanvas.width, s.y * bgCanvas.height, s.r, 0, Math.PI * 2);
    bgCtx.fillStyle = `rgba(200,220,255,${s.a})`;
    bgCtx.fill();
  }
}

// ─── Constants (mirror server) ────────────────────────────────────────────────
const SNAKE_SPEED    = 2.8;
const BOOST_SPEED    = 5.0;
const SEGMENT_DIST   = 7;
const TURN_SPEED     = 0.12;
const INPUT_HZ       = 20;           // input send rate
const INPUT_INTERVAL = 1000 / INPUT_HZ;
const INTERP_DELAY   = 120;          // ms – render others this far in the past
const LERP_CORRECT   = 0.25;         // reconciliation lerp factor per frame
const SNAP_THRESHOLD = 180;          // px – beyond this, snap instead of lerp
const CAM_LERP       = 0.10;         // camera smoothing

// ─── Socket.io ────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

// ─── Game State ───────────────────────────────────────────────────────────────
let myId        = null;
let worldSize   = 5000;
let mySnake     = null;   // client-predicted own snake
let myAngle     = 0;      // target angle derived from mouse
let boosting    = false;

// Snapshot buffer for other snakes: id → [ { receivedAt, x, y, angle, segments, … } ]
const snakeBuffers = new Map();

// Latest food from server (food is authoritative, not predicted)
let serverFood = [];

// Camera (world-space)
let camX = 0, camY = 0;
let smoothCamX = 0, smoothCamY = 0;

// Input timing
let lastInputSend = 0;

// Ping
let pingVal = 0;
let pingSentAt = 0;

// UI elements
const scoreVal      = document.getElementById('score-val');
const pingEl        = document.getElementById('ping-val');
const lbRows        = document.getElementById('lb-rows');
const menuScreen    = document.getElementById('menu-screen');
const deathScreen   = document.getElementById('death-screen');
const deathScoreEl  = document.getElementById('death-score-val');
const nameInput     = document.getElementById('name-input');
const playBtn       = document.getElementById('play-btn');
const respawnBtn    = document.getElementById('respawn-btn');
const respawnName   = document.getElementById('respawn-name');

// ─── Input ────────────────────────────────────────────────────────────────────
let mouseX = 0, mouseY = 0;

window.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
window.addEventListener('mousedown',  e => { if (e.button === 0 || e.button === 2) boosting = true; });
window.addEventListener('mouseup',    e => { if (e.button === 0 || e.button === 2) boosting = false; });
window.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('touchmove', e => {
  e.preventDefault();
  mouseX = e.touches[0].clientX;
  mouseY = e.touches[0].clientY;
}, { passive: false });
window.addEventListener('touchstart', () => { boosting = true; });
window.addEventListener('touchend',   () => { boosting = false; });

// ─── Menu / Death Screens ─────────────────────────────────────────────────────
function joinGame() {
  const name = nameInput.value.trim() || 'Anonymous';
  if (!socket.connected) {
    playBtn.textContent = 'CONNECTING...';
    socket.once('connect', () => {
      playBtn.textContent = 'PLAY';
      socket.emit('join', { name });
    });
    return;
  }
  socket.emit('join', { name });
}
function respawnGame() {
  const name = (respawnName.value.trim() || nameInput.value.trim() || 'Anonymous');
  socket.emit('respawn', { name });
}

playBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
respawnBtn.addEventListener('click', respawnGame);
respawnName.addEventListener('keydown', e => { if (e.key === 'Enter') respawnGame(); });

socket.on('connect_error', (err) => {
  playBtn.textContent = 'PLAY';
  const s = document.getElementById('conn-status');
  if (s) { s.textContent = '❌ Cannot reach server'; s.style.color = '#e74c3c'; }
  console.error('Socket error:', err.message);
});
socket.on('connect', () => {
  playBtn.textContent = 'PLAY';
  const s = document.getElementById('conn-status');
  if (s) { s.textContent = '✅ Connected'; s.style.color = '#2ecc71'; }
});

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('joined', ({ id, snake, worldSize: ws }) => {
  myId      = id;
  worldSize = ws;
  mySnake   = deepClone(snake);
  myAngle   = snake.angle;
  smoothCamX = snake.x - window.innerWidth  / 2;
  smoothCamY = snake.y - window.innerHeight / 2;
  menuScreen.style.display  = 'none';
  deathScreen.style.display = 'none';
  snakeBuffers.clear();
});

socket.on('state', ({ snakes, food, timestamp }) => {
  const now = Date.now();
  serverFood = food;

  const activeIds = new Set();

  for (const s of snakes) {
    activeIds.add(s.id);

    if (s.id === myId) {
      // ── Server reconciliation for own snake ──────────────────────────────
      if (!mySnake) { mySnake = deepClone(s); continue; }

      const dx = s.x - mySnake.x;
      const dy = s.y - mySnake.y;
      const d  = Math.sqrt(dx * dx + dy * dy);

      if (d > SNAP_THRESHOLD) {
        // Large desync → snap
        mySnake.x        = s.x;
        mySnake.y        = s.y;
        mySnake.angle    = s.angle;
        mySnake.segments = deepCloneSegs(s.segments);
      } else if (d > 2) {
        // Small drift → soft lerp
        mySnake.x += dx * LERP_CORRECT;
        mySnake.y += dy * LERP_CORRECT;
      }

      // Always sync score & colour from server (authoritative)
      mySnake.score  = s.score;
      mySnake.colors = s.colors;
      mySnake.name   = s.name;
      scoreVal.textContent = s.score;
      continue;
    }

    // ── Buffer snapshot for other snakes ─────────────────────────────────
    if (!snakeBuffers.has(s.id)) snakeBuffers.set(s.id, []);
    const buf = snakeBuffers.get(s.id);
    buf.push({ ...s, segs: deepCloneSegs(s.segments), receivedAt: now });
    // Trim old entries (keep 1.5 s)
    while (buf.length > 0 && now - buf[0].receivedAt > 1500) buf.shift();
  }

  // Remove gone snakes
  for (const id of snakeBuffers.keys()) {
    if (!activeIds.has(id)) snakeBuffers.delete(id);
  }
});

socket.on('died', ({ score }) => {
  mySnake = null;
  myId    = null;
  deathScoreEl.textContent  = score;
  deathScreen.style.display = 'flex';
});

// ─── Latency Probe (every 2 s) ────────────────────────────────────────────────
setInterval(() => {
  pingSentAt = Date.now();
  socket.emit('ping', pingSentAt);
}, 2000);
socket.on('pong', () => {
  pingVal = Date.now() - pingSentAt;
  pingEl.textContent = pingVal;
});

// ─── Client-Side Prediction ───────────────────────────────────────────────────
function predictOwn() {
  if (!mySnake) return;

  // Derive target angle from mouse relative to screen centre
  const dx = mouseX - window.innerWidth  / 2;
  const dy = mouseY - window.innerHeight / 2;
  myAngle = Math.atan2(dy, dx);

  // Same turn logic as server
  let diff = myAngle - mySnake.angle;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  mySnake.angle += Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED);

  const spd = boosting ? BOOST_SPEED : SNAKE_SPEED;

  mySnake.x = wrap(mySnake.x + Math.cos(mySnake.angle) * spd);
  mySnake.y = wrap(mySnake.y + Math.sin(mySnake.angle) * spd);

  // Slide segments
  mySnake.segments.unshift({ x: mySnake.x, y: mySnake.y });
  mySnake.segments.pop();
}

// ─── Entity Interpolation ─────────────────────────────────────────────────────
function getInterpolated(id) {
  const buf = snakeBuffers.get(id);
  if (!buf || buf.length === 0) return null;

  const renderTime = Date.now() - INTERP_DELAY;

  // Find the two surrounding snapshots
  let lo = null, hi = null;
  for (const snap of buf) {
    if (snap.receivedAt <= renderTime) lo = snap;
    else if (!hi) { hi = snap; break; }
  }

  if (!lo) return buf[0];
  if (!hi) return lo;

  const t = clamp01((renderTime - lo.receivedAt) / (hi.receivedAt - lo.receivedAt));

  // Interpolate head
  const x     = lerp(lo.x, hi.x, t);
  const y     = lerp(lo.y, hi.y, t);
  const angle = lerpAngle(lo.angle, hi.angle, t);

  // Interpolate segments
  const len  = Math.min(lo.segs.length, hi.segs.length);
  const segs = new Array(len);
  for (let i = 0; i < len; i++) {
    segs[i] = {
      x: lerp(lo.segs[i].x, hi.segs[i].x, t),
      y: lerp(lo.segs[i].y, hi.segs[i].y, t)
    };
  }

  return { ...lo, x, y, angle, segs };
}

// ─── Camera ───────────────────────────────────────────────────────────────────
function updateCamera() {
  if (!mySnake) return;
  const tx = mySnake.x - canvas.width  / 2;
  const ty = mySnake.y - canvas.height / 2;
  smoothCamX += (tx - smoothCamX) * CAM_LERP;
  smoothCamY += (ty - smoothCamY) * CAM_LERP;
  camX = smoothCamX;
  camY = smoothCamY;
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
const GRID = 60;

function drawGrid() {
  ctx.strokeStyle = 'rgba(80,160,255,0.06)';
  ctx.lineWidth   = 1;

  const ox = camX % GRID;
  const oy = camY % GRID;

  for (let x = -ox; x < canvas.width + GRID; x += GRID) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = -oy; y < canvas.height + GRID; y += GRID) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  // World border
  ctx.strokeStyle = 'rgba(255,80,80,0.5)';
  ctx.lineWidth   = 3;
  ctx.strokeRect(-camX, -camY, worldSize, worldSize);
}

function drawFood() {
  for (const f of serverFood) {
    const sx = f.x - camX;
    const sy = f.y - camY;
    if (sx < -f.r - 2 || sx > canvas.width  + f.r + 2 ||
        sy < -f.r - 2 || sy > canvas.height + f.r + 2) continue;

    // Glow
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, f.r * 2.2);
    g.addColorStop(0, f.color);
    g.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(sx, sy, f.r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(sx, sy, f.r, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();

    // Specular
    ctx.beginPath();
    ctx.arc(sx - f.r * 0.28, sy - f.r * 0.28, f.r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }
}

function drawSnake(snake, isMe) {
  const segs = isMe ? snake.segments : snake.segs;
  if (!segs || segs.length === 0) return;

  const [c1, c2] = snake.colors;
  const headR = isMe ? 11 : 10;

  // Body path for glow
  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // Draw body segments back-to-front
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const sx  = seg.x - camX;
    const sy  = seg.y - camY;

    // Frustum cull
    if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) continue;

    const ratio = 1 - i / segs.length;
    const r     = (headR - 3) * (0.55 + 0.45 * ratio) + 3;
    const alpha = 0.6 + 0.4 * ratio;

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = lerpColor(c2, c1, ratio);
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  // Head
  const hx = segs[0].x - camX;
  const hy = segs[0].y - camY;

  // Head glow
  const gl = ctx.createRadialGradient(hx, hy, 0, hx, hy, headR * 2.5);
  gl.addColorStop(0, c1 + '88');
  gl.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(hx, hy, headR * 2.5, 0, Math.PI * 2);
  ctx.fillStyle = gl;
  ctx.fill();

  // Head circle
  ctx.beginPath();
  ctx.arc(hx, hy, headR, 0, Math.PI * 2);
  ctx.fillStyle = c1;
  ctx.fill();

  // Boost trail
  if (snake.boosting && isMe) {
    ctx.globalAlpha = 0.35;
    for (let i = 1; i <= 5; i++) {
      const ts = segs[Math.min(i * 2, segs.length - 1)];
      if (!ts) break;
      const tx = ts.x - camX, ty = ts.y - camY;
      ctx.beginPath();
      ctx.arc(tx, ty, headR * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = c1;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Eyes
  const ang = isMe ? snake.angle : snake.angle;
  const er  = 3.5;
  const eo  = 5.5;

  [[-0.55, 1], [0.55, -1]].forEach(([sign]) => {
    const ex = hx + Math.cos(ang + sign * 0.55) * eo;
    const ey = hy + Math.sin(ang + sign * 0.55) * eo;

    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ex + Math.cos(ang) * 1.2, ey + Math.sin(ang) * 1.2, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  });

  // Name label
  if (snake.name) {
    ctx.font         = 'bold 12px Rajdhani, sans-serif';
    ctx.textAlign    = 'center';
    ctx.fillStyle    = 'rgba(255,255,255,0.9)';
    ctx.shadowColor  = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur   = 4;
    ctx.fillText(snake.name, hx, hy - headR - 6);
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

function drawMinimap(allSnakes) {
  const W = minimap.width  = 130;
  const H = minimap.height = 130;
  const scale = W / worldSize;

  mmCtx.clearRect(0, 0, W, H);
  mmCtx.fillStyle = 'rgba(6,11,24,0.85)';
  mmCtx.fillRect(0, 0, W, H);

  // Food dots (sampled)
  for (let i = 0; i < serverFood.length; i += 8) {
    const f = serverFood[i];
    mmCtx.fillStyle = f.color + '77';
    mmCtx.fillRect(f.x * scale - 1, f.y * scale - 1, 2, 2);
  }

  // Other snakes
  for (const s of allSnakes) {
    if (s.id === myId) continue;
    mmCtx.beginPath();
    mmCtx.arc(s.x * scale, s.y * scale, 2.5, 0, Math.PI * 2);
    mmCtx.fillStyle = s.colors[0];
    mmCtx.fill();
  }

  // Own snake
  if (mySnake) {
    mmCtx.beginPath();
    mmCtx.arc(mySnake.x * scale, mySnake.y * scale, 4, 0, Math.PI * 2);
    mmCtx.fillStyle = '#fff';
    mmCtx.fill();

    // Viewport rect
    mmCtx.strokeStyle = 'rgba(255,255,255,0.3)';
    mmCtx.lineWidth   = 0.8;
    mmCtx.strokeRect(
      camX * scale, camY * scale,
      canvas.width * scale, canvas.height * scale
    );
  }
}

function updateLeaderboard(all) {
  const sorted = all.slice().sort((a, b) => b.score - a.score).slice(0, 8);
  lbRows.innerHTML = sorted.map((s, i) => {
    const me = s.id === myId;
    return `<div class="lb-row${me ? ' me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="lname">${escHtml(s.name)}</span>
      <span class="lscore">${s.score}</span>
    </div>`;
  }).join('');
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
let lastFrameTime = 0;

function loop(ts) {
  requestAnimationFrame(loop);

  const now = Date.now();

  // 1. Client-side prediction for own snake (runs every frame = 60fps)
  predictOwn();

  // 2. Send input at INPUT_HZ (20/sec)
  if (mySnake && now - lastInputSend >= INPUT_INTERVAL) {
    socket.emit('input', { angle: myAngle, boosting });
    lastInputSend = now;
  }

  // 3. Camera
  updateCamera();

  // ── Render ────────────────────────────────────────────────────────────
  ctx.drawImage(bgCanvas, 0, 0);
  drawGrid();
  drawFood();

  // Collect all snake data for leaderboard / minimap
  const allSnakes = [];

  // Draw other snakes (interpolated)
  for (const [id] of snakeBuffers) {
    const s = getInterpolated(id);
    if (!s) continue;
    drawSnake(s, false);
    allSnakes.push(s);
  }

  // Draw own snake
  if (mySnake) {
    drawSnake(mySnake, true);
    allSnakes.push({ ...mySnake, id: myId });
  }

  drawMinimap(allSnakes);
  updateLeaderboard(allSnakes);

  lastFrameTime = ts;
}

requestAnimationFrame(loop);

// ─── Util ─────────────────────────────────────────────────────────────────────
function lerp(a, b, t)   { return a + (b - a) * t; }
function clamp01(t)      { return t < 0 ? 0 : t > 1 ? 1 : t; }
function wrap(v)         { return ((v % worldSize) + worldSize) % worldSize; }

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Very fast hex-based colour lerp
function lerpColor(c1, c2, t) {
  // c1, c2 are CSS hex strings (#rrggbb) or hsl
  // For HSL/hex we just return c1/c2 based on threshold for perf
  return t > 0.5 ? c1 : c2;
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function deepCloneSegs(segs) {
  const out = new Array(segs.length);
  for (let i = 0; i < segs.length; i++) out[i] = { x: segs[i].x, y: segs[i].y };
  return out;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}