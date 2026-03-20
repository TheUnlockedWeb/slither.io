const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Optimize for low-latency
  pingInterval: 2000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE        = 20;              // Server updates per second
const TICK_MS          = 1000 / TICK_RATE;
const WORLD_SIZE       = 5000;
const FOOD_TARGET      = 800;
const SNAKE_SPEED      = 2.8;            // px per tick
const BOOST_SPEED      = 5.0;
const SEGMENT_DIST     = 7;              // distance between body segments
const INITIAL_SEGS     = 12;
const TURN_SPEED       = 0.12;           // radians snapped per tick
const COLLISION_RADIUS = 9;             // head-to-body collision radius
const GROW_PER_FOOD    = 4;             // segments added when eating food
const BOOST_DRAIN      = 0.8;           // segments lost per tick when boosting
const MIN_BOOST_SEGS   = 8;

// ─── State ────────────────────────────────────────────────────────────────────
const snakes = new Map();
const food   = new Map();
let foodId   = 0;
let tickCount = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randRange(min, max) { return min + Math.random() * (max - min); }

function randColor() {
  const palettes = [
    ['#ff6b6b','#ff8e53'], ['#4facfe','#00f2fe'], ['#43e97b','#38f9d7'],
    ['#fa709a','#fee140'], ['#a18cd1','#fbc2eb'], ['#ffecd2','#fcb69f'],
    ['#ff9a9e','#fad0c4'], ['#a1c4fd','#c2e9fb'], ['#d4fc79','#96e6a1'],
    ['#f093fb','#f5576c'], ['#4481eb','#04befe'], ['#0ba360','#3cba92']
  ];
  return palettes[Math.floor(Math.random() * palettes.length)];
}

function wrapPos(v) {
  return ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// ─── Food ─────────────────────────────────────────────────────────────────────
function spawnFood(x, y, color, size) {
  const id = foodId++;
  food.set(id, {
    id,
    x: x ?? randRange(50, WORLD_SIZE - 50),
    y: y ?? randRange(50, WORLD_SIZE - 50),
    color: color ?? `hsl(${Math.random() * 360 | 0},80%,65%)`,
    r: size ?? (3 + Math.random() * 3.5)
  });
}

for (let i = 0; i < FOOD_TARGET; i++) spawnFood();

// ─── Snake ────────────────────────────────────────────────────────────────────
function createSnake(id, name) {
  const x = randRange(300, WORLD_SIZE - 300);
  const y = randRange(300, WORLD_SIZE - 300);
  const angle = Math.random() * Math.PI * 2;
  const colors = randColor();
  const segments = [];

  for (let i = 0; i < INITIAL_SEGS; i++) {
    segments.push({
      x: wrapPos(x - Math.cos(angle) * i * SEGMENT_DIST),
      y: wrapPos(y - Math.sin(angle) * i * SEGMENT_DIST)
    });
  }

  return {
    id, name,
    x, y,
    angle,
    targetAngle: angle,
    segments,
    colors,
    score: 0,
    alive: true,
    boosting: false
  };
}

// ─── Tick Logic ───────────────────────────────────────────────────────────────
function tickSnake(snake) {
  // Smooth turn
  let diff = snake.targetAngle - snake.angle;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  snake.angle += Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED);

  const spd = snake.boosting ? BOOST_SPEED : SNAKE_SPEED;

  // Move head
  snake.x = wrapPos(snake.x + Math.cos(snake.angle) * spd);
  snake.y = wrapPos(snake.y + Math.sin(snake.angle) * spd);

  // Push new head segment, maintain chain length
  snake.segments.unshift({ x: snake.x, y: snake.y });
  snake.segments.pop();

  // Boost drains length
  if (snake.boosting && snake.segments.length > MIN_BOOST_SEGS) {
    // Every 2 ticks drop a segment, spawn food there
    if (tickCount % 2 === 0) {
      const tail = snake.segments.pop();
      spawnFood(tail.x, tail.y, snake.colors[0], 4);
    }
  }
}

function eatFood(snake) {
  const r2 = 16 * 16;
  for (const [id, f] of food) {
    if (dist2(snake.x, snake.y, f.x, f.y) < r2) {
      food.delete(id);
      spawnFood(); // replenish
      snake.score += Math.ceil(f.r);
      const tail = snake.segments[snake.segments.length - 1];
      for (let i = 0; i < GROW_PER_FOOD; i++) {
        snake.segments.push({ ...tail });
      }
    }
  }
}

function checkCollisions() {
  const dead = [];
  const r2 = COLLISION_RADIUS * COLLISION_RADIUS;

  for (const [aid, a] of snakes) {
    if (!a.alive) continue;

    for (const [bid, b] of snakes) {
      if (!b.alive) continue;

      const startI = (aid === bid) ? 5 : 0; // skip own head area

      for (let i = startI; i < b.segments.length; i++) {
        if (dist2(a.x, a.y, b.segments[i].x, b.segments[i].y) < r2) {
          dead.push(aid);
          // If two snakes collide head-on, both die
          if (aid !== bid && i < 3) dead.push(bid);
          break;
        }
      }
      if (dead.includes(aid)) break;
    }
  }

  return [...new Set(dead)];
}

function killSnake(id) {
  const snake = snakes.get(id);
  if (!snake || !snake.alive) return;
  snake.alive = false;

  // Explode into food
  for (let i = 0; i < snake.segments.length; i += 2) {
    const seg = snake.segments[i];
    spawnFood(
      seg.x + randRange(-8, 8),
      seg.y + randRange(-8, 8),
      snake.colors[0],
      5 + Math.random() * 3
    );
  }

  io.to(id).emit('died', { score: snake.score });
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
function gameTick() {
  tickCount++;

  for (const [, snake] of snakes) {
    if (snake.alive) {
      tickSnake(snake);
      eatFood(snake);
    }
  }

  const dead = checkCollisions();
  for (const id of dead) killSnake(id);

  // Replenish food pool
  while (food.size < FOOD_TARGET) spawnFood();

  // Build snapshot
  const snakeArr = [];
  for (const [, s] of snakes) {
    if (!s.alive) continue;
    snakeArr.push({
      id:       s.id,
      name:     s.name,
      x:        s.x,
      y:        s.y,
      angle:    s.angle,
      segments: s.segments,
      colors:   s.colors,
      score:    s.score,
      boosting: s.boosting
    });
  }

  io.emit('state', {
    snakes:    snakeArr,
    food:      [...food.values()],
    timestamp: Date.now()
  });
}

// Use setInterval with drift compensation
let lastTick = Date.now();
function scheduleNext() {
  const now = Date.now();
  const drift = now - lastTick - TICK_MS;
  lastTick = now;
  gameTick();
  setTimeout(scheduleNext, Math.max(0, TICK_MS - drift));
}
setTimeout(scheduleNext, TICK_MS);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('join', ({ name }) => {
    const snake = createSnake(socket.id, (name || 'Anonymous').slice(0, 20));
    snakes.set(socket.id, snake);
    socket.emit('joined', {
      id:        socket.id,
      snake,
      worldSize: WORLD_SIZE,
      tickRate:  TICK_RATE
    });
  });

  socket.on('respawn', ({ name }) => {
    const snake = createSnake(socket.id, (name || 'Anonymous').slice(0, 20));
    snakes.set(socket.id, snake);
    socket.emit('joined', {
      id:        socket.id,
      snake,
      worldSize: WORLD_SIZE,
      tickRate:  TICK_RATE
    });
  });

  socket.on('input', ({ angle, boosting }) => {
    const snake = snakes.get(socket.id);
    if (snake && snake.alive) {
      if (typeof angle === 'number' && isFinite(angle)) {
        snake.targetAngle = angle;
      }
      snake.boosting = !!boosting;
    }
  });

  // Latency probe
  socket.on('ping', (t) => socket.emit('pong', t));

  socket.on('disconnect', () => {
    snakes.delete(socket.id);
    console.log(`[-] ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Slither clone listening on :${PORT}`));
