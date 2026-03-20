'use strict';

// ─── Canvas setup ─────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const ctx      = canvas.getContext('2d', { alpha: false });
const minimap  = document.getElementById('minimap');
const mmCtx    = minimap.getContext('2d');
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx    = bgCanvas.getContext('2d');

// ─── Stars ────────────────────────────────────────────────────────────────────
const STARS = Array.from({length:200}, () => ({
  x: Math.random(), y: Math.random(),
  r: 0.4 + Math.random()*1.2,
  a: 0.15 + Math.random()*0.5
}));

function drawBgStars() {
  bgCtx.fillStyle = '#030812';
  bgCtx.fillRect(0,0,bgCanvas.width,bgCanvas.height);
  for (const s of STARS) {
    bgCtx.beginPath();
    bgCtx.arc(s.x*bgCanvas.width, s.y*bgCanvas.height, s.r, 0, Math.PI*2);
    bgCtx.fillStyle = `rgba(180,210,255,${s.a})`;
    bgCtx.fill();
  }
}

function resize() {
  canvas.width  = bgCanvas.width  = window.innerWidth;
  canvas.height = bgCanvas.height = window.innerHeight;
  drawBgStars();
}
window.addEventListener('resize', resize);
resize();

// ─── Constants ────────────────────────────────────────────────────────────────
const SERVER_TICK_MS = 50;    // 20hz
const SNAKE_SPEED    = 5.5;   // px per server tick
const BOOST_SPEED    = 9.0;
const SEGMENT_DIST   = 8;
const TURN_SPEED     = 0.14;  // radians per server tick
const INPUT_INTERVAL = 50;    // send input at 20hz
const INTERP_DELAY   = 100;   // ms behind for other snakes
const CAM_LERP       = 0.13;

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

// ─── State ────────────────────────────────────────────────────────────────────
let myId        = null;
let worldSize   = 4000;
let mySnake     = null;
let myAngle     = 0;
let boosting    = false;

const snakeBuffers = new Map(); // id → [{receivedAt, x, y, angle, segs, ...}]
let serverFood = [];

let camX=0, camY=0, smoothCamX=0, smoothCamY=0;
let lastInputSend = 0;
let lastFrameMs   = performance.now();
let pingVal=0, pingSentAt=0;

// ─── UI refs ─────────────────────────────────────────────────────────────────
const scoreVal    = document.getElementById('score-val');
const pingEl      = document.getElementById('ping-val');
const lbRows      = document.getElementById('lb-rows');
const menuScreen  = document.getElementById('menu-screen');
const deathScreen = document.getElementById('death-screen');
const deathScoreEl= document.getElementById('death-score-val');
const nameInput   = document.getElementById('name-input');
const playBtn     = document.getElementById('play-btn');
const respawnBtn  = document.getElementById('respawn-btn');
const respawnName = document.getElementById('respawn-name');

// ─── Input: mouse + arrow keys ────────────────────────────────────────────────
let mouseX = window.innerWidth/2;
let mouseY = window.innerHeight/2;
let usingKeys = false;
let keyAngle  = 0;

// Track keys
const keys = { ArrowUp:false, ArrowDown:false, ArrowLeft:false, ArrowRight:false,
               w:false, a:false, s:false, d:false };

window.addEventListener('keydown', e => {
  if (e.key in keys) { e.preventDefault(); keys[e.key]=true; usingKeys=true; }
  if (e.key===' ') boosting=true;
});
window.addEventListener('keyup', e => {
  if (e.key in keys) keys[e.key]=false;
  if (e.key===' ') boosting=false;
});

function updateKeyAngle() {
  if (!usingKeys) return;
  const up    = keys.ArrowUp    || keys.w;
  const down  = keys.ArrowDown  || keys.s;
  const left  = keys.ArrowLeft  || keys.a;
  const right = keys.ArrowRight || keys.d;

  let dx=0, dy=0;
  if (up)    dy=-1;
  if (down)  dy= 1;
  if (left)  dx=-1;
  if (right) dx= 1;

  if (dx!==0||dy!==0) keyAngle = Math.atan2(dy,dx);
}

window.addEventListener('mousemove', e => {
  mouseX=e.clientX; mouseY=e.clientY; usingKeys=false;
});
window.addEventListener('mousedown',  e => { if(e.button===0||e.button===2) boosting=true; });
window.addEventListener('mouseup',    e => { if(e.button===0||e.button===2) boosting=false; });
window.addEventListener('contextmenu',e => e.preventDefault());
window.addEventListener('touchmove',  e => {
  e.preventDefault(); mouseX=e.touches[0].clientX; mouseY=e.touches[0].clientY; usingKeys=false;
}, {passive:false});
window.addEventListener('touchstart', ()=>boosting=true);
window.addEventListener('touchend',   ()=>boosting=false);

// ─── Menu ─────────────────────────────────────────────────────────────────────
function joinGame() {
  const name=nameInput.value.trim()||'Anonymous';
  if (!socket.connected) {
    playBtn.textContent='CONNECTING...';
    socket.once('connect', ()=>{ playBtn.textContent='PLAY'; socket.emit('join',{name}); });
    return;
  }
  socket.emit('join', {name});
}
function respawnGame() {
  socket.emit('respawn', {name:(respawnName.value.trim()||nameInput.value.trim()||'Anonymous')});
}

playBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') joinGame(); });
respawnBtn.addEventListener('click', respawnGame);
respawnName.addEventListener('keydown', e=>{ if(e.key==='Enter') respawnGame(); });

socket.on('connect', ()=>{
  playBtn.textContent='PLAY';
  const s=document.getElementById('conn-status');
  if(s){s.textContent='✅ Connected';s.style.color='#00ff88';}
});
socket.on('connect_error', ()=>{
  const s=document.getElementById('conn-status');
  if(s){s.textContent='❌ Cannot reach server';s.style.color='#ff3366';}
});

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('joined', ({id, snake, worldSize:ws}) => {
  myId=id; worldSize=ws;
  mySnake=deepClone(snake);
  myAngle=snake.angle;
  smoothCamX=snake.x-canvas.width/2;
  smoothCamY=snake.y-canvas.height/2;
  menuScreen.style.display='none';
  deathScreen.style.display='none';
  snakeBuffers.clear();
});

socket.on('state', ({snakes, food}) => {
  const now=Date.now();
  serverFood=food;
  const active=new Set();

  for (const s of snakes) {
    active.add(s.id);
    if (s.id===myId) {
      if (!mySnake) { mySnake=deepClone(s); continue; }
      // Only sync non-positional authoritative data
      mySnake.score=s.score; mySnake.colors=s.colors; mySnake.name=s.name;
      // Sync length if server says we grew
      while (mySnake.segments.length < s.segments.length) {
        mySnake.segments.push({...mySnake.segments[mySnake.segments.length-1]});
      }
      scoreVal.textContent=s.score;
      continue;
    }
    if (!snakeBuffers.has(s.id)) snakeBuffers.set(s.id,[]);
    const buf=snakeBuffers.get(s.id);
    buf.push({...s, segs:cloneSegs(s.segments), receivedAt:now});
    while (buf.length>0 && now-buf[0].receivedAt>1500) buf.shift();
  }
  for (const id of snakeBuffers.keys()) if (!active.has(id)) snakeBuffers.delete(id);
});

socket.on('died', ({score}) => {
  mySnake=null; myId=null;
  deathScoreEl.textContent=score;
  deathScreen.style.display='flex';
});

// Ping
setInterval(()=>{ pingSentAt=Date.now(); socket.emit('ping',pingSentAt); },2000);
socket.on('pong', ()=>{ pingVal=Date.now()-pingSentAt; pingEl.textContent=pingVal; });

// ─── Client prediction ────────────────────────────────────────────────────────
function predictOwn(dt) {
  if (!mySnake) return;
  const scale=dt/SERVER_TICK_MS;

  updateKeyAngle();

  // Target angle
  if (usingKeys) {
    myAngle = keyAngle;
  } else {
    myAngle = Math.atan2(mouseY-canvas.height/2, mouseX-canvas.width/2);
  }

  // Turn (frame-rate independent)
  let diff=myAngle-mySnake.angle;
  while (diff> Math.PI) diff-=Math.PI*2;
  while (diff<-Math.PI) diff+=Math.PI*2;
  mySnake.angle += Math.sign(diff)*Math.min(Math.abs(diff), TURN_SPEED*scale);

  // Move
  const spd=(boosting?BOOST_SPEED:SNAKE_SPEED)*scale;
  mySnake.x=wrap(mySnake.x+Math.cos(mySnake.angle)*spd);
  mySnake.y=wrap(mySnake.y+Math.sin(mySnake.angle)*spd);

  // Distance-based segment push
  const seg0=mySnake.segments[0];
  const dx=mySnake.x-seg0.x, dy=mySnake.y-seg0.y;
  if (dx*dx+dy*dy >= SEGMENT_DIST*SEGMENT_DIST) {
    mySnake.segments.unshift({x:mySnake.x,y:mySnake.y});
    mySnake.segments.pop();
  }
}

// ─── Entity interpolation ─────────────────────────────────────────────────────
function getInterpolated(id) {
  const buf=snakeBuffers.get(id);
  if (!buf||buf.length===0) return null;
  const rt=Date.now()-INTERP_DELAY;
  let lo=null, hi=null;
  for (const snap of buf) {
    if (snap.receivedAt<=rt) lo=snap;
    else if (!hi) { hi=snap; break; }
  }
  if (!lo) return buf[0];
  if (!hi) return lo;
  const t=clamp01((rt-lo.receivedAt)/(hi.receivedAt-lo.receivedAt));
  const len=Math.min(lo.segs.length,hi.segs.length);
  const segs=new Array(len);
  for (let i=0;i<len;i++) segs[i]={x:lerp(lo.segs[i].x,hi.segs[i].x,t),y:lerp(lo.segs[i].y,hi.segs[i].y,t)};
  return {...lo, x:lerp(lo.x,hi.x,t), y:lerp(lo.y,hi.y,t), angle:lerpAngle(lo.angle,hi.angle,t), segs};
}

// ─── Camera ───────────────────────────────────────────────────────────────────
function updateCamera() {
  if (!mySnake) return;
  const tx=mySnake.x-canvas.width/2, ty=mySnake.y-canvas.height/2;
  smoothCamX+=(tx-smoothCamX)*CAM_LERP;
  smoothCamY+=(ty-smoothCamY)*CAM_LERP;
  camX=smoothCamX; camY=smoothCamY;
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
const GRID=80;
function drawGrid() {
  ctx.strokeStyle='rgba(0,180,255,0.05)';
  ctx.lineWidth=1;
  const ox=((camX%GRID)+GRID)%GRID, oy=((camY%GRID)+GRID)%GRID;
  for (let x=-ox;x<canvas.width+GRID;x+=GRID) { ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke(); }
  for (let y=-oy;y<canvas.height+GRID;y+=GRID) { ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke(); }
  // Border
  ctx.strokeStyle='rgba(255,50,50,0.6)';
  ctx.lineWidth=4;
  ctx.shadowBlur=12; ctx.shadowColor='#ff2222';
  ctx.strokeRect(-camX,-camY,worldSize,worldSize);
  ctx.shadowBlur=0;
}

function drawFood() {
  for (const f of serverFood) {
    const sx=f.x-camX, sy=f.y-camY;
    if (sx<-30||sx>canvas.width+30||sy<-30||sy>canvas.height+30) continue;

    // Outer glow
    ctx.shadowBlur=f.r*5; ctx.shadowColor=f.color;
    ctx.beginPath();
    ctx.arc(sx,sy,f.r*1.3,0,Math.PI*2);
    ctx.fillStyle=f.color+'55';
    ctx.fill();

    // Core bright
    ctx.shadowBlur=f.r*3; ctx.shadowColor=f.color;
    ctx.beginPath();
    ctx.arc(sx,sy,f.r,0,Math.PI*2);
    ctx.fillStyle=f.color;
    ctx.fill();

    // White hot centre
    ctx.shadowBlur=0;
    ctx.beginPath();
    ctx.arc(sx-f.r*0.25,sy-f.r*0.25,f.r*0.35,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.85)';
    ctx.fill();
  }
  ctx.shadowBlur=0;
}

function drawSnake(snake, isMe) {
  const segs  = isMe ? snake.segments : snake.segs;
  if (!segs||segs.length<2) return;

  const [c1,c2] = snake.colors;
  const len     = segs.length;

  // ── 1. Draw body as a thick glowing line ──────────────────────────────────
  // We draw in two passes: wide soft glow pass, then bright narrow core pass

  // Collect on-screen segments
  const pts = [];
  for (let i=0;i<len;i++) {
    pts.push({x:segs[i].x-camX, y:segs[i].y-camY, t:1-i/len});
  }

  // Glow pass — wide, soft, semi-transparent
  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';

  for (let i=1;i<pts.length;i++) {
    const p=pts[i-1], q=pts[i];
    // Frustum cull
    if (Math.max(p.x,q.x)<-20||Math.min(p.x,q.x)>canvas.width+20) continue;
    if (Math.max(p.y,q.y)<-20||Math.min(p.y,q.y)>canvas.height+20) continue;

    const t  = (p.t+q.t)*0.5;
    const bw = 14*(0.4+0.6*t); // taper toward tail

    ctx.shadowBlur  = 18;
    ctx.shadowColor = c1;
    ctx.strokeStyle = c1+'aa';
    ctx.lineWidth   = bw;
    ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke();
  }

  // Core pass — thinner, bright
  for (let i=1;i<pts.length;i++) {
    const p=pts[i-1], q=pts[i];
    if (Math.max(p.x,q.x)<-20||Math.min(p.x,q.x)>canvas.width+20) continue;
    if (Math.max(p.y,q.y)<-20||Math.min(p.y,q.y)>canvas.height+20) continue;

    const t  = (p.t+q.t)*0.5;
    const bw = 7*(0.3+0.7*t);
    const col = t>0.5 ? c1 : c2;

    ctx.shadowBlur  = 6;
    ctx.shadowColor = col;
    ctx.strokeStyle = col;
    ctx.lineWidth   = bw;
    ctx.globalAlpha = 0.5+0.5*t;
    ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke();
  }

  ctx.globalAlpha=1; ctx.shadowBlur=0;

  // ── 2. Head ───────────────────────────────────────────────────────────────
  const hx=segs[0].x-camX, hy=segs[0].y-camY;
  const headR=isMe?11:10;

  // Head glow
  ctx.shadowBlur=24; ctx.shadowColor=c1;
  ctx.beginPath(); ctx.arc(hx,hy,headR,0,Math.PI*2);
  ctx.fillStyle=c1; ctx.fill();

  // Head bright ring
  ctx.shadowBlur=8; ctx.shadowColor='#ffffff44';
  ctx.strokeStyle='rgba(255,255,255,0.4)';
  ctx.lineWidth=2;
  ctx.stroke();

  ctx.shadowBlur=0;

  // ── 3. Eyes — properly placed, no overlap ─────────────────────────────────
  const ang   = snake.angle;
  const eyeR  = 3.2;
  const eyeOff= headR*0.52;      // lateral offset from head centre
  const eyeFwd= headR*0.25;      // how far forward the eyes sit

  // Perpendicular directions
  const perpX = -Math.sin(ang);
  const perpY =  Math.cos(ang);
  const fwdX  =  Math.cos(ang)*eyeFwd;
  const fwdY  =  Math.sin(ang)*eyeFwd;

  for (const side of [1,-1]) {
    const ex = hx + fwdX + perpX*side*eyeOff;
    const ey = hy + fwdY + perpY*side*eyeOff;

    // White sclera
    ctx.beginPath(); ctx.arc(ex,ey,eyeR,0,Math.PI*2);
    ctx.fillStyle='white'; ctx.fill();

    // Pupil — points in direction of travel
    const px = ex + Math.cos(ang)*eyeR*0.45;
    const py = ey + Math.sin(ang)*eyeR*0.45;
    ctx.beginPath(); ctx.arc(px,py,eyeR*0.55,0,Math.PI*2);
    ctx.fillStyle='#111'; ctx.fill();
  }

  // ── 4. Name label ─────────────────────────────────────────────────────────
  if (snake.name) {
    ctx.font='bold 13px "Rajdhani", sans-serif';
    ctx.textAlign='center';
    ctx.shadowBlur=6; ctx.shadowColor='rgba(0,0,0,0.9)';
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.fillText(snake.name, hx, hy-headR-7);
    ctx.shadowBlur=0;
  }

  ctx.restore();
}

function drawMinimap(allSnakes) {
  minimap.width=minimap.height=130;
  const sc=130/worldSize;
  mmCtx.fillStyle='rgba(3,8,18,0.88)';
  mmCtx.fillRect(0,0,130,130);
  mmCtx.strokeStyle='rgba(0,180,255,0.3)';
  mmCtx.lineWidth=1; mmCtx.strokeRect(0,0,130,130);

  for (let i=0;i<serverFood.length;i+=6) {
    const f=serverFood[i];
    mmCtx.fillStyle=f.color+'99';
    mmCtx.fillRect(f.x*sc-1,f.y*sc-1,2,2);
  }
  for (const s of allSnakes) {
    if (s.id===myId) continue;
    mmCtx.shadowBlur=4; mmCtx.shadowColor=s.colors[0];
    mmCtx.beginPath(); mmCtx.arc(s.x*sc,s.y*sc,2.5,0,Math.PI*2);
    mmCtx.fillStyle=s.colors[0]; mmCtx.fill();
  }
  if (mySnake) {
    mmCtx.shadowBlur=6; mmCtx.shadowColor='#fff';
    mmCtx.beginPath(); mmCtx.arc(mySnake.x*sc,mySnake.y*sc,4,0,Math.PI*2);
    mmCtx.fillStyle='#fff'; mmCtx.fill();
    mmCtx.shadowBlur=0;
    mmCtx.strokeStyle='rgba(255,255,255,0.25)'; mmCtx.lineWidth=0.8;
    mmCtx.strokeRect(camX*sc,camY*sc,canvas.width*sc,canvas.height*sc);
  }
  mmCtx.shadowBlur=0;
}

function updateLeaderboard(all) {
  const sorted=all.slice().sort((a,b)=>b.score-a.score).slice(0,8);
  lbRows.innerHTML=sorted.map((s,i)=>{
    const me=s.id===myId;
    const dot=`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.colors[0]};margin-right:6px;box-shadow:0 0 4px ${s.colors[0]}"></span>`;
    return `<div class="lb-row${me?' me':''}">`+
      `<span class="rank">${i+1}</span>`+
      `<span class="lname">${dot}${escHtml(s.name)}</span>`+
      `<span class="lscore">${s.score}</span></div>`;
  }).join('');
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function loop(ts) {
  requestAnimationFrame(loop);
  const dt=Math.min(ts-lastFrameMs, 100);
  lastFrameMs=ts;
  const now=Date.now();

  predictOwn(dt);

  if (mySnake && now-lastInputSend>=INPUT_INTERVAL) {
    socket.emit('input', {angle:myAngle, boosting});
    lastInputSend=now;
  }

  updateCamera();

  // Background
  ctx.drawImage(bgCanvas,0,0);
  drawGrid();
  drawFood();

  const allSnakes=[];

  for (const [id] of snakeBuffers) {
    const s=getInterpolated(id);
    if (!s) continue;
    drawSnake(s,false);
    allSnakes.push(s);
  }

  if (mySnake) {
    drawSnake(mySnake,true);
    allSnakes.push({...mySnake,id:myId});
  }

  drawMinimap(allSnakes);
  updateLeaderboard(allSnakes);
}
requestAnimationFrame(loop);

// ─── Utils ────────────────────────────────────────────────────────────────────
function lerp(a,b,t)   { return a+(b-a)*t; }
function clamp01(t)    { return t<0?0:t>1?1:t; }
function wrap(v)       { return ((v%worldSize)+worldSize)%worldSize; }
function lerpAngle(a,b,t) {
  let d=b-a;
  while(d> Math.PI) d-=Math.PI*2;
  while(d<-Math.PI) d+=Math.PI*2;
  return a+d*t;
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function cloneSegs(s) { return s.map(p=>({x:p.x,y:p.y})); }
function escHtml(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }