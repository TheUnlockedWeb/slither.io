'use strict';

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const ctx      = canvas.getContext('2d', { alpha: false });
const minimap  = document.getElementById('minimap');
const mmCtx    = minimap.getContext('2d');
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx    = bgCanvas.getContext('2d');

// ── Stars ─────────────────────────────────────────────────────────────────────
const STARS = Array.from({length:180}, ()=>({
  x:Math.random(), y:Math.random(),
  r:0.4+Math.random()*1.1, a:0.1+Math.random()*0.45
}));

function drawBg() {
  bgCtx.fillStyle='#030812';
  bgCtx.fillRect(0,0,bgCanvas.width,bgCanvas.height);
  for (const s of STARS) {
    bgCtx.beginPath();
    bgCtx.arc(s.x*bgCanvas.width, s.y*bgCanvas.height, s.r, 0, Math.PI*2);
    bgCtx.fillStyle=`rgba(160,200,255,${s.a})`;
    bgCtx.fill();
  }
}

function resize() {
  canvas.width=bgCanvas.width=window.innerWidth;
  canvas.height=bgCanvas.height=window.innerHeight;
  drawBg();
}
window.addEventListener('resize', resize);
resize();

// ── Constants ─────────────────────────────────────────────────────────────────
const SPEED          = 5.5;   // px per server tick (50ms)
const BOOST_SPEED    = 9.0;
const SEG_DIST       = 8;     // px between stored waypoints (server)
const TURN_SPEED     = 0.16;  // rad/server-tick
const SERVER_MS      = 50;    // server tick interval
const INPUT_INTERVAL = 50;    // send input at 20hz
const INTERP_DELAY   = 100;   // ms buffer for other snakes
const CAM_LERP       = 0.14;
const SNAKE_WIDTH    = 12;    // uniform body width — no tapering

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

// ── State ─────────────────────────────────────────────────────────────────────
let myId=null, worldSize=4000, mySnake=null, myAngle=0, boosting=false;
const snakeBufs = new Map();
let serverFood=[];
let camX=0, camY=0, smoothCamX=0, smoothCamY=0;
let lastInput=0, lastFrame=performance.now();
let pingSentAt=0;

// ── DOM ───────────────────────────────────────────────────────────────────────
const scoreVal    = document.getElementById('score-val');
const pingEl      = document.getElementById('ping-val');
const lbRows      = document.getElementById('lb-rows');
const menuScreen  = document.getElementById('menu-screen');
const deathScreen = document.getElementById('death-screen');
const deathScore  = document.getElementById('death-score-val');
const nameInput   = document.getElementById('name-input');
const playBtn     = document.getElementById('play-btn');
const respawnBtn  = document.getElementById('respawn-btn');
const respawnName = document.getElementById('respawn-name');

// ── Input ─────────────────────────────────────────────────────────────────────
let mouseX=window.innerWidth/2, mouseY=window.innerHeight/2;

// Arrow key turning: track which keys are held, turn smoothly each frame
const held = { up:false, down:false, left:false, right:false };

window.addEventListener('keydown', e => {
  if (e.key==='ArrowUp'   ||e.key==='w'||e.key==='W') { held.up=true;   e.preventDefault(); }
  if (e.key==='ArrowDown' ||e.key==='s'||e.key==='S') { held.down=true; e.preventDefault(); }
  if (e.key==='ArrowLeft' ||e.key==='a'||e.key==='A') { held.left=true; e.preventDefault(); }
  if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') { held.right=true;e.preventDefault(); }
  if (e.key===' ') { boosting=true; e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (e.key==='ArrowUp'   ||e.key==='w'||e.key==='W') held.up=false;
  if (e.key==='ArrowDown' ||e.key==='s'||e.key==='S') held.down=false;
  if (e.key==='ArrowLeft' ||e.key==='a'||e.key==='A') held.left=false;
  if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') held.right=false;
  if (e.key===' ') boosting=false;
});

let usingKeys=false;
window.addEventListener('mousemove', e => { mouseX=e.clientX; mouseY=e.clientY; usingKeys=false; });
window.addEventListener('mousedown', e => { if(e.button===0||e.button===2) boosting=true; });
window.addEventListener('mouseup',   e => { if(e.button===0||e.button===2) boosting=false; });
window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('touchmove', e => { e.preventDefault(); mouseX=e.touches[0].clientX; mouseY=e.touches[0].clientY; usingKeys=false; }, {passive:false});
window.addEventListener('touchstart', ()=>boosting=true);
window.addEventListener('touchend',   ()=>boosting=false);

// ── Menu ──────────────────────────────────────────────────────────────────────
function join(name) {
  if (!socket.connected) { playBtn.textContent='CONNECTING...'; socket.once('connect',()=>{ playBtn.textContent='PLAY'; socket.emit('join',{name}); }); return; }
  socket.emit('join', {name});
}
playBtn.addEventListener('click', ()=>join(nameInput.value.trim()||'Anonymous'));
nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') join(nameInput.value.trim()||'Anonymous'); });
respawnBtn.addEventListener('click', ()=>socket.emit('respawn',{name:respawnName.value.trim()||nameInput.value.trim()||'Anonymous'}));
respawnName.addEventListener('keydown', e=>{ if(e.key==='Enter') respawnBtn.click(); });

socket.on('connect', ()=>{ playBtn.textContent='PLAY'; const s=document.getElementById('conn-status'); if(s){s.textContent='✅ Connected';s.style.color='#00ff88';} });
socket.on('connect_error', ()=>{ const s=document.getElementById('conn-status'); if(s){s.textContent='❌ No server';s.style.color='#ff3366';} });

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('joined', ({id,snake,worldSize:ws}) => {
  myId=id; worldSize=ws; mySnake=deepClone(snake); myAngle=snake.angle;
  smoothCamX=snake.x-canvas.width/2; smoothCamY=snake.y-canvas.height/2;
  menuScreen.style.display='none'; deathScreen.style.display='none';
  snakeBufs.clear();
});

socket.on('state', ({snakes,food}) => {
  const now=Date.now();
  serverFood=food;
  const active=new Set();
  for (const s of snakes) {
    active.add(s.id);
    if (s.id===myId) {
      if (!mySnake) { mySnake=deepClone(s); continue; }
      mySnake.score=s.score; mySnake.colors=s.colors; mySnake.name=s.name;
      // Grow if server says longer
      while (mySnake.segments.length < s.segments.length)
        mySnake.segments.push({...mySnake.segments[mySnake.segments.length-1]});
      scoreVal.textContent=s.score;
      continue;
    }
    if (!snakeBufs.has(s.id)) snakeBufs.set(s.id,[]);
    const buf=snakeBufs.get(s.id);
    buf.push({...s, segs:s.segments.map(p=>({x:p.x,y:p.y})), at:now});
    if (buf.length>30) buf.shift();
  }
  for (const id of snakeBufs.keys()) if (!active.has(id)) snakeBufs.delete(id);
});

socket.on('died', ({score}) => {
  mySnake=null; myId=null;
  deathScore.textContent=score;
  deathScreen.style.display='flex';
});

setInterval(()=>{ pingSentAt=Date.now(); socket.emit('ping',pingSentAt); },2000);
socket.on('pong', ()=>pingEl.textContent=Date.now()-pingSentAt);

// ── Prediction ────────────────────────────────────────────────────────────────
function predict(dt) {
  if (!mySnake) return;
  const scale = dt / SERVER_MS; // fraction of one server tick

  // ── Target angle ──
  if (held.left||held.right||held.up||held.down) {
    usingKeys=true;
    // Smoothly rotate angle based on held keys
    const turnRate = TURN_SPEED * scale;
    if (held.left)  myAngle -= turnRate * 2.2;
    if (held.right) myAngle += turnRate * 2.2;
    if (held.up||held.down) {
      // Combine with up/down for diagonal
      const target = held.up ? (held.left?-Math.PI*0.75:held.right?-Math.PI*0.25:-Math.PI/2)
                              : (held.left? Math.PI*0.75:held.right? Math.PI*0.25: Math.PI/2);
      let diff=target-myAngle;
      while(diff> Math.PI) diff-=Math.PI*2;
      while(diff<-Math.PI) diff+=Math.PI*2;
      myAngle += Math.sign(diff)*Math.min(Math.abs(diff), turnRate*2.2);
    }
  } else if (!usingKeys) {
    myAngle = Math.atan2(mouseY-canvas.height/2, mouseX-canvas.width/2);
  }

  // Apply turning toward myAngle (for mouse mode smooth turn)
  if (!usingKeys) {
    let diff=myAngle-mySnake.angle;
    while(diff> Math.PI) diff-=Math.PI*2;
    while(diff<-Math.PI) diff+=Math.PI*2;
    mySnake.angle += Math.sign(diff)*Math.min(Math.abs(diff), TURN_SPEED*scale);
  } else {
    mySnake.angle = myAngle;
  }

  // Move head
  const spd=(boosting?BOOST_SPEED:SPEED)*scale;
  mySnake.x=wrap(mySnake.x+Math.cos(mySnake.angle)*spd);
  mySnake.y=wrap(mySnake.y+Math.sin(mySnake.angle)*spd);

  // Push new waypoint EVERY FRAME — this is what makes it smooth
  // We push every frame and pop from tail to keep total pixel-length constant
  mySnake.segments.unshift({x:mySnake.x, y:mySnake.y});
  // Keep array same length (tail follows head)
  mySnake.segments.pop();
}

// ── Interpolation ─────────────────────────────────────────────────────────────
function getInterp(id) {
  const buf=snakeBufs.get(id);
  if (!buf||buf.length===0) return null;
  const rt=Date.now()-INTERP_DELAY;
  let lo=null,hi=null;
  for (const s of buf) { if(s.at<=rt) lo=s; else if(!hi){hi=s;break;} }
  if (!lo) return buf[0];
  if (!hi) return lo;
  const t=clamp((rt-lo.at)/(hi.at-lo.at),0,1);
  const n=Math.min(lo.segs.length,hi.segs.length);
  const segs=new Array(n);
  for(let i=0;i<n;i++) segs[i]={x:lerp(lo.segs[i].x,hi.segs[i].x,t),y:lerp(lo.segs[i].y,hi.segs[i].y,t)};
  return {...lo, x:lerp(lo.x,hi.x,t), y:lerp(lo.y,hi.y,t), angle:lerpAng(lo.angle,hi.angle,t), segs};
}

// ── Camera ────────────────────────────────────────────────────────────────────
function updateCam() {
  if (!mySnake) return;
  smoothCamX += (mySnake.x-canvas.width/2  - smoothCamX)*CAM_LERP;
  smoothCamY += (mySnake.y-canvas.height/2 - smoothCamY)*CAM_LERP;
  camX=smoothCamX; camY=smoothCamY;
}

// ── Render ────────────────────────────────────────────────────────────────────
const GRID=80;
function drawGrid() {
  ctx.save();
  ctx.strokeStyle='rgba(0,160,255,0.045)';
  ctx.lineWidth=1;
  const ox=((camX%GRID)+GRID)%GRID, oy=((camY%GRID)+GRID)%GRID;
  for(let x=-ox;x<canvas.width+GRID;x+=GRID){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
  for(let y=-oy;y<canvas.height+GRID;y+=GRID){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
  // Border glow
  ctx.shadowBlur=16; ctx.shadowColor='#ff2222';
  ctx.strokeStyle='rgba(255,40,40,0.7)'; ctx.lineWidth=4;
  ctx.strokeRect(-camX,-camY,worldSize,worldSize);
  ctx.restore();
}

function drawFood() {
  ctx.save();
  for (const f of serverFood) {
    const sx=f.x-camX, sy=f.y-camY;
    if(sx<-20||sx>canvas.width+20||sy<-20||sy>canvas.height+20) continue;
    ctx.shadowBlur=f.r*6; ctx.shadowColor=f.color;
    ctx.beginPath(); ctx.arc(sx,sy,f.r,0,Math.PI*2);
    ctx.fillStyle=f.color; ctx.fill();
    ctx.shadowBlur=0;
    ctx.beginPath(); ctx.arc(sx-f.r*.28,sy-f.r*.28,f.r*.3,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.fill();
  }
  ctx.restore();
}

function drawSnake(snake, isMe) {
  const segs = isMe ? snake.segments : snake.segs;
  if (!segs||segs.length<2) return;
  const [c1,c2]=snake.colors;
  const W=SNAKE_WIDTH;

  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';

  // Glow pass
  ctx.shadowBlur=W*2.2; ctx.shadowColor=c1;
  ctx.strokeStyle=c1+'99'; ctx.lineWidth=W*1.4; ctx.globalAlpha=0.55;
  ctx.beginPath();
  let started=false;
  for (let i=0;i<segs.length;i++) {
    const sx=segs[i].x-camX, sy=segs[i].y-camY;
    if (!started){ctx.moveTo(sx,sy);started=true;} else ctx.lineTo(sx,sy);
  }
  ctx.stroke();

  // Core bright pass
  ctx.globalAlpha=1; ctx.shadowBlur=W*0.8; ctx.shadowColor=c1;
  ctx.strokeStyle=c1; ctx.lineWidth=W;
  ctx.beginPath(); started=false;
  for (let i=0;i<segs.length;i++) {
    const sx=segs[i].x-camX, sy=segs[i].y-camY;
    if (!started){ctx.moveTo(sx,sy);started=true;} else ctx.lineTo(sx,sy);
  }
  ctx.stroke();

  // Inner highlight
  ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=W*0.3;
  ctx.beginPath(); started=false;
  for (let i=0;i<segs.length;i++) {
    const sx=segs[i].x-camX, sy=segs[i].y-camY;
    if (!started){ctx.moveTo(sx,sy);started=true;} else ctx.lineTo(sx,sy);
  }
  ctx.stroke();

  ctx.globalAlpha=1; ctx.shadowBlur=0;

  // Head — same width as body, just glowing circle cap
  const hx=segs[0].x-camX, hy=segs[0].y-camY;
  const hr=W/2+1;

  ctx.shadowBlur=hr*3.5; ctx.shadowColor=c1;
  ctx.beginPath(); ctx.arc(hx,hy,hr,0,Math.PI*2);
  ctx.fillStyle=c1; ctx.fill();
  ctx.shadowBlur=0;

  // Eyes — perpendicular to travel direction, no overlap
  const ang=snake.angle;
  const px=-Math.sin(ang), py=Math.cos(ang); // perpendicular
  const fx= Math.cos(ang)*hr*0.3, fy=Math.sin(ang)*hr*0.3; // slight forward
  const spread=hr*0.55;
  const eyeR=hr*0.38;

  for (const side of [1,-1]) {
    const ex=hx+fx+px*side*spread, ey=hy+fy+py*side*spread;
    ctx.beginPath(); ctx.arc(ex,ey,eyeR,0,Math.PI*2);
    ctx.fillStyle='white'; ctx.fill();
    const pupilX=ex+Math.cos(ang)*eyeR*0.5, pupilY=ey+Math.sin(ang)*eyeR*0.5;
    ctx.beginPath(); ctx.arc(pupilX,pupilY,eyeR*0.55,0,Math.PI*2);
    ctx.fillStyle='#111'; ctx.fill();
  }

  // Name
  if (snake.name) {
    ctx.font='bold 12px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.shadowBlur=5; ctx.shadowColor='rgba(0,0,0,0.95)';
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.fillText(snake.name, hx, hy-hr-7);
    ctx.shadowBlur=0;
  }

  ctx.restore();
}

function drawMinimap(all) {
  minimap.width=minimap.height=130;
  const sc=130/worldSize;
  mmCtx.fillStyle='rgba(3,8,18,0.88)'; mmCtx.fillRect(0,0,130,130);
  mmCtx.strokeStyle='rgba(0,180,255,0.25)'; mmCtx.lineWidth=1; mmCtx.strokeRect(0,0,130,130);
  for(let i=0;i<serverFood.length;i+=5){const f=serverFood[i];mmCtx.fillStyle=f.color+'88';mmCtx.fillRect(f.x*sc-1,f.y*sc-1,2,2);}
  for(const s of all){
    if(s.id===myId)continue;
    mmCtx.shadowBlur=3; mmCtx.shadowColor=s.colors[0];
    mmCtx.beginPath(); mmCtx.arc(s.x*sc,s.y*sc,2,0,Math.PI*2);
    mmCtx.fillStyle=s.colors[0]; mmCtx.fill();
  }
  if(mySnake){
    mmCtx.shadowBlur=5; mmCtx.shadowColor='#fff';
    mmCtx.beginPath(); mmCtx.arc(mySnake.x*sc,mySnake.y*sc,3.5,0,Math.PI*2);
    mmCtx.fillStyle='#fff'; mmCtx.fill();
    mmCtx.shadowBlur=0; mmCtx.strokeStyle='rgba(255,255,255,0.2)'; mmCtx.lineWidth=0.8;
    mmCtx.strokeRect(camX*sc,camY*sc,canvas.width*sc,canvas.height*sc);
  }
  mmCtx.shadowBlur=0;
}

function updateLB(all) {
  const sorted=all.slice().sort((a,b)=>b.score-a.score).slice(0,8);
  lbRows.innerHTML=sorted.map((s,i)=>{
    const dot=`<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${s.colors[0]};box-shadow:0 0 5px ${s.colors[0]};margin-right:5px"></span>`;
    return `<div class="lb-row${s.id===myId?' me':''}"><span class="rank">${i+1}</span><span class="lname">${dot}${esc(s.name)}</span><span class="lscore">${s.score}</span></div>`;
  }).join('');
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function loop(ts) {
  requestAnimationFrame(loop);
  const dt=Math.min(ts-lastFrame, 80); lastFrame=ts;
  const now=Date.now();

  predict(dt);

  if (mySnake && now-lastInput>=INPUT_INTERVAL) {
    socket.emit('input', {angle:mySnake.angle, boosting});
    lastInput=now;
  }

  updateCam();

  ctx.drawImage(bgCanvas,0,0);
  drawGrid();
  drawFood();

  const all=[];
  for(const [id] of snakeBufs){ const s=getInterp(id); if(!s)continue; drawSnake(s,false); all.push(s); }
  if(mySnake){ drawSnake(mySnake,true); all.push({...mySnake,id:myId}); }

  drawMinimap(all);
  updateLB(all);
}
requestAnimationFrame(loop);

// ── Utils ─────────────────────────────────────────────────────────────────────
const lerp    = (a,b,t) => a+(b-a)*t;
const clamp   = (v,a,b) => v<a?a:v>b?b:v;
const wrap    = v       => ((v%worldSize)+worldSize)%worldSize;
function lerpAng(a,b,t){let d=b-a;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return a+d*t;}
function deepClone(o){return JSON.parse(JSON.stringify(o));}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}