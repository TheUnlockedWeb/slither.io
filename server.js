const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000, pingTimeout: 5000,
  transports: ['websocket', 'polling']
});
app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE     = 20;
const TICK_MS       = 1000 / TICK_RATE;
const WORLD_SIZE    = 4000;
const FOOD_TARGET   = 700;
const SPEED         = 5.5;   // px/tick
const BOOST_SPEED   = 9.0;
const SEG_DIST      = 8;
const START_SEGS    = 24;
const TURN_SPEED    = 0.16;
const HEAD_R        = 9;
const BODY_R        = 8;
const GROW_PER_FOOD = 8;
const MIN_BOOST_LEN = 12;

const snakes = new Map();
const food   = new Map();
let foodId = 0, tick = 0;

const rand  = (a,b) => a + Math.random()*(b-a);
const wrap  = v => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const dist2 = (ax,ay,bx,by) => (ax-bx)**2+(ay-by)**2;

const PALETTES = [
  ['#ff00ff','#cc00ff'],['#00ffcc','#00aaff'],['#ffee00','#ff6600'],
  ['#ff2266','#ff8800'],['#00ff88','#00ccff'],['#ff00aa','#6600ff'],
  ['#ff6600','#ffcc00'],['#00ffff','#0044ff'],['#ff3399','#ff6600'],
  ['#33ffcc','#3388ff'],['#ccff00','#00ff66'],['#ff0055','#ff66cc'],
];
const randColor = () => PALETTES[Math.random()*PALETTES.length|0];

function spawnFood(x,y,color,r) {
  const id = foodId++;
  food.set(id, {
    id, r: r ?? 3+Math.random()*3,
    x: x ?? rand(60, WORLD_SIZE-60),
    y: y ?? rand(60, WORLD_SIZE-60),
    color: color ?? `hsl(${Math.random()*360|0},100%,65%)`
  });
}
for (let i=0;i<FOOD_TARGET;i++) spawnFood();

function createSnake(id, name) {
  const x=rand(400,WORLD_SIZE-400), y=rand(400,WORLD_SIZE-400);
  const a=Math.random()*Math.PI*2;
  const segs=[];
  for (let i=0;i<START_SEGS;i++)
    segs.push({ x:wrap(x-Math.cos(a)*i*SEG_DIST), y:wrap(y-Math.sin(a)*i*SEG_DIST) });
  return { id, name, x, y, angle:a, targetAngle:a, segments:segs,
           colors:randColor(), score:0, alive:true, boosting:false };
}

function tickSnake(s) {
  let d = s.targetAngle - s.angle;
  while (d> Math.PI) d-=Math.PI*2;
  while (d<-Math.PI) d+=Math.PI*2;
  s.angle += Math.sign(d)*Math.min(Math.abs(d), TURN_SPEED);

  const spd = s.boosting ? BOOST_SPEED : SPEED;
  s.x = wrap(s.x + Math.cos(s.angle)*spd);
  s.y = wrap(s.y + Math.sin(s.angle)*spd);

  // Distance-based waypoint
  const h=s.segments[0], dx=s.x-h.x, dy=s.y-h.y;
  if (dx*dx+dy*dy >= SEG_DIST*SEG_DIST) {
    s.segments.unshift({x:s.x, y:s.y});
    s.segments.pop();
  }

  // Boost drains tail
  if (s.boosting && s.segments.length > MIN_BOOST_LEN && tick%2===0) {
    const tail = s.segments.pop();
    spawnFood(tail.x, tail.y, s.colors[0], 4);
    s.segments.push({...s.segments[s.segments.length-1]});
  }
}

function eatFood(s) {
  const r2 = (HEAD_R+12)**2;
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
  const cr2  = (HEAD_R+BODY_R)**2;
  for (const [aid,a] of snakes) {
    if (!a.alive||dead.has(aid)) continue;
    for (const [bid,b] of snakes) {
      if (!b.alive) continue;
      // Skip own neck (no self-collision)
      if (aid===bid) continue;
      // Only check other snakes' bodies
      for (let i=0; i<b.segments.length; i++) {
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
    spawnFood(seg.x+rand(-6,6), seg.y+rand(-6,6), s.colors[i%2], 4+Math.random()*4);
  }
  io.to(id).emit('died', {score:s.score});
}

function gameTick() {
  tick++;
  for (const [,s] of snakes) if (s.alive) { tickSnake(s); eatFood(s); }
  const dead = checkCollisions();
  for (const id of dead) killSnake(id);
  while (food.size < FOOD_TARGET) spawnFood();

  const out=[];
  for (const [,s] of snakes) {
    if (!s.alive) continue;
    out.push({id:s.id,name:s.name,x:s.x,y:s.y,angle:s.angle,
              segments:s.segments,colors:s.colors,score:s.score,boosting:s.boosting});
  }
  io.emit('state', {snakes:out, food:[...food.values()], ts:Date.now()});
}

let lastTick=Date.now();
(function loop() {
  const now=Date.now(), drift=now-lastTick-TICK_MS;
  lastTick=now; gameTick();
  setTimeout(loop, Math.max(0,TICK_MS-drift));
})();

io.on('connection', socket => {
  socket.on('join', ({name}) => {
    const s=createSnake(socket.id,(name||'Anonymous').slice(0,20));
    snakes.set(socket.id,s);
    socket.emit('joined',{id:socket.id,snake:s,worldSize:WORLD_SIZE});
  });
  socket.on('respawn', ({name}) => {
    const s=createSnake(socket.id,(name||'Anonymous').slice(0,20));
    snakes.set(socket.id,s);
    socket.emit('joined',{id:socket.id,snake:s,worldSize:WORLD_SIZE});
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