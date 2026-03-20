const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout:  5000,
  transports:   ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE      = 20;
const TICK_MS        = 1000 / TICK_RATE;
const WORLD_SIZE     = 4000;
const FOOD_TARGET    = 600;
const SNAKE_SPEED    = 5.5;
const BOOST_SPEED    = 9.0;
const SEGMENT_DIST   = 8;
const INITIAL_LENGTH = 20;
const TURN_SPEED     = 0.14;
const HEAD_RADIUS    = 10;
const BODY_RADIUS    = 7;
const GROW_PER_FOOD  = 6;
const MIN_BOOST_LEN  = 10;

const snakes = new Map();
const food   = new Map();
let   foodId = 0;
let   tickN  = 0;

const rand  = (a,b) => a + Math.random()*(b-a);
const wrap  = v     => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const dist2 = (ax,ay,bx,by) => { const dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; };

const PALETTES = [
  ['#ff00ff','#aa00ff'],['#00ffcc','#0088ff'],['#ffff00','#ff6600'],
  ['#ff3366','#ff9900'],['#00ff88','#00ccff'],['#ff00aa','#6600ff'],
  ['#ff6600','#ffcc00'],['#33ffcc','#3388ff'],['#ff3399','#ff6600'],
  ['#00ffff','#0044ff'],['#ccff00','#00ff66'],['#ff0055','#ff66cc'],
];
const randColor = () => PALETTES[Math.random()*PALETTES.length|0];

function spawnFood(x,y,color,r) {
  const id = foodId++;
  food.set(id, {
    id,
    x:     x     ?? rand(60, WORLD_SIZE-60),
    y:     y     ?? rand(60, WORLD_SIZE-60),
    color: color ?? `hsl(${Math.random()*360|0},100%,65%)`,
    r:     r     ?? (3 + Math.random()*3)
  });
}
for (let i=0;i<FOOD_TARGET;i++) spawnFood();

function createSnake(id, name) {
  const x=rand(400,WORLD_SIZE-400), y=rand(400,WORLD_SIZE-400);
  const angle = Math.random()*Math.PI*2;
  const segs=[];
  for (let i=0;i<INITIAL_LENGTH;i++) segs.push({
    x: wrap(x - Math.cos(angle)*i*SEGMENT_DIST),
    y: wrap(y - Math.sin(angle)*i*SEGMENT_DIST)
  });
  return {id,name,x,y,angle,targetAngle:angle,segments:segs,
          colors:randColor(),score:0,alive:true,boosting:false};
}

function tickSnake(s) {
  let d = s.targetAngle - s.angle;
  while (d >  Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  s.angle += Math.sign(d) * Math.min(Math.abs(d), TURN_SPEED);

  const spd = s.boosting ? BOOST_SPEED : SNAKE_SPEED;
  s.x = wrap(s.x + Math.cos(s.angle)*spd);
  s.y = wrap(s.y + Math.sin(s.angle)*spd);

  const h=s.segments[0], dx=s.x-h.x, dy=s.y-h.y;
  if (dx*dx+dy*dy >= SEGMENT_DIST*SEGMENT_DIST) {
    s.segments.unshift({x:s.x,y:s.y});
    s.segments.pop();
  }

  if (s.boosting && s.segments.length > MIN_BOOST_LEN && tickN%2===0) {
    const tail = s.segments.pop();
    spawnFood(tail.x, tail.y, s.colors[0], 4);
    s.segments.push({...s.segments[s.segments.length-1]});
  }
}

function eatFood(s) {
  const r2 = (HEAD_RADIUS+10)*(HEAD_RADIUS+10);
  for (const [id,f] of food) {
    if (dist2(s.x,s.y,f.x,f.y) < r2) {
      food.delete(id); spawnFood();
      s.score += Math.ceil(f.r);
      const tail = s.segments[s.segments.length-1];
      for (let i=0;i<GROW_PER_FOOD;i++) s.segments.push({...tail});
    }
  }
}

function checkCollisions() {
  const dead = new Set();
  const cr2  = (HEAD_RADIUS+BODY_RADIUS)*(HEAD_RADIUS+BODY_RADIUS);
  for (const [aid,a] of snakes) {
    if (!a.alive || dead.has(aid)) continue;
    for (const [bid,b] of snakes) {
      if (!b.alive) continue;
      const skip = aid===bid ? 8 : 0;
      for (let i=skip; i<b.segments.length; i++) {
        if (dist2(a.x,a.y,b.segments[i].x,b.segments[i].y) < cr2) {
          dead.add(aid); break;
        }
      }
      if (dead.has(aid)) break;
    }
  }
  return dead;
}

function killSnake(id) {
  const s = snakes.get(id);
  if (!s||!s.alive) return;
  s.alive = false;
  for (let i=0;i<s.segments.length;i++) {
    const seg=s.segments[i];
    spawnFood(seg.x+rand(-5,5), seg.y+rand(-5,5), s.colors[i%2], 4+Math.random()*3);
  }
  io.to(id).emit('died', {score:s.score});
}

function gameTick() {
  tickN++;
  for (const [,s] of snakes) if (s.alive) { tickSnake(s); eatFood(s); }
  const dead = checkCollisions();
  for (const id of dead) killSnake(id);
  while (food.size < FOOD_TARGET) spawnFood();

  const snakeArr=[];
  for (const [,s] of snakes) {
    if (!s.alive) continue;
    snakeArr.push({id:s.id,name:s.name,x:s.x,y:s.y,angle:s.angle,
                   segments:s.segments,colors:s.colors,score:s.score,boosting:s.boosting});
  }
  io.emit('state', {snakes:snakeArr, food:[...food.values()], ts:Date.now()});
}

let lastTick=Date.now();
function scheduleNext() {
  const now=Date.now(), drift=now-lastTick-TICK_MS;
  lastTick=now; gameTick();
  setTimeout(scheduleNext, Math.max(0, TICK_MS-drift));
}
setTimeout(scheduleNext, TICK_MS);

io.on('connection', socket => {
  socket.on('join', ({name}) => {
    const s=createSnake(socket.id,(name||'Anonymous').slice(0,20));
    snakes.set(socket.id,s);
    socket.emit('joined',{id:socket.id,snake:s,worldSize:WORLD_SIZE,tickRate:TICK_RATE});
  });
  socket.on('respawn', ({name}) => {
    const s=createSnake(socket.id,(name||'Anonymous').slice(0,20));
    snakes.set(socket.id,s);
    socket.emit('joined',{id:socket.id,snake:s,worldSize:WORLD_SIZE,tickRate:TICK_RATE});
  });
  socket.on('input', ({angle,boosting}) => {
    const s=snakes.get(socket.id);
    if (s&&s.alive) {
      if (typeof angle==='number'&&isFinite(angle)) s.targetAngle=angle;
      s.boosting=!!boosting;
    }
  });
  socket.on('ping', t => socket.emit('pong',t));
  socket.on('disconnect', () => snakes.delete(socket.id));
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Slither on :${PORT}`));