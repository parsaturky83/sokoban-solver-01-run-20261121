// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Approach
// --------
// The generator's levels are a hallway with one to four rooms off it, each room holding
// 3 or 4 boxes and as many goals, and a box pushed out of a room can never come back, so
// the rooms are independent problems joined only by the player's walk and the level's
// push-optimal count is the sum of its rooms' optima. This solver therefore:
//
//   1. cuts the level into rooms (the hallway's dead squares divide the floor),
//   2. solves each room push-optimally with A* over pushes, then
//   3. stitches the rooms' move strings together with the player's walks between them.
//
// The room search is A* over push states: a state is the boxes' squares and the player's
// reachable region (named by its lowest square). Its estimate is the cheapest assignment
// of boxes to goals by push distance, which never overstates the pushes left, so the
// first solved state A* takes off its open list is push-optimal. Two deadlocks are
// pruned, neither of which can cut a solvable state: a box on a square from which no
// push brings it to any goal, and a frozen 2 x 2 block of walls and boxes with a box
// off its goal. If A* gives up on a room, a greedy best-first search on the same
// estimate tries for any solution at all, so the level still gets a valid answer.
//
// Everything is budgeted by work, never by the clock: one expansion counter shared by
// the whole run, so two executions write the same bytes. No network, no model calls,
// no randomness, no clock reads; the output of a level is its moves in LURD.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps: [dx, dy, the walk's letter, the push's letter].
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// The whole run's work budget, in search expansions. A run that would pass the 60 s
// wall instead writes empty answers for the levels it never reaches, and keeps the
// score of the ones it did.
const EXPANSION_LIMIT = 2_000_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** A level in XSB text: width, height, walls (1 a wall; the frame is wall whatever it shows), goals, boxes, player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The fewest pushes a lone box needs to reach `goal`, from every square: a reverse
 * breadth-first walk over pushes. From a square x the box came from y = x - d, pushed
 * in direction d, which needs y itself open and the stance y - d open too.
 */
function pushDistances(board: Board, goal: number): Int32Array {
  const { w, wall } = board;
  const size = wall.length;
  const dist = new Int32Array(size).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let di = 0; di < 4; di++) {
      const [dx, dy] = DIRS[di];
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size || dist[y] >= 0 || wall[y] !== 0) continue;
      if (wall[y - d] !== 0) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/** The squares from which a box alone can be pushed onto some goal. */
function liveSquares(dist: Int32Array[]): Uint8Array {
  if (dist.length === 0) return new Uint8Array(0);
  const size = dist[0].length;
  const live = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    for (const d of dist) {
      if (d[i] >= 0) {
        live[i] = 1;
        break;
      }
    }
  }
  return live;
}

/** All orders of n goal indices, for the exact assignment below. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(n);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

/**
 * The cheapest assignment of boxes to goals by push distance (Infinity when no box
 * can be matched onto a goal). Exact: every push moves one box one step along its
 * shortest path, so no assignment's cost overstates the pushes left.
 */
function matchExact(boxes: number[], dist: Int32Array[], orders: number[][]): number {
  let best = Infinity;
  for (const order of orders) {
    let sum = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = dist[order[i]][boxes[i]];
      if (d < 0) {
        sum = Infinity;
        break;
      }
      sum += d;
    }
    if (sum < best) best = sum;
  }
  return best;
}

/** A greedy assignment, for boards too wide for the exact one; used only by the fallback search. */
function matchGreedy(boxes: number[], dist: Int32Array[]): number {
  const taken = new Uint8Array(dist.length);
  let sum = 0;
  for (const b of boxes) {
    let best = Infinity;
    let bestG = -1;
    for (let g = 0; g < dist.length; g++) {
      if (taken[g]) continue;
      const d = dist[g][b];
      if (d >= 0 && d < best) {
        best = d;
        bestG = g;
      }
    }
    if (bestG < 0) return Infinity;
    taken[bestG] = 1;
    sum += best;
  }
  return sum;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goalSet: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
  }
  return false;
}

// A state's key: the region's lowest square and the boxes' squares. A number while the
// board is small enough for it to stay exact, a string otherwise.
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return low + ':' + boxes.join(',');
}

// A heap entry: [priority, pushes so far, insertion order, state index]. Lower priority
// first; ties go to the deeper state, then to the earlier insertion, so the order is fixed.
type HeapEntry = [number, number, number, number];
const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
  a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    [heap[i], heap[p]] = [heap[p], heap[i]];
    i = p;
  }
}
function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
      if (!heapLess(heap[c], heap[i])) break;
      [heap[i], heap[c]] = [heap[c], heap[i]];
      i = c;
    }
  }
  return top;
}

/**
 * The push-optimal solution of a board, or null when the search gives up: A* over
 * pushes ('astar'), or a greedy best-first search on the same estimate ('greedy'), which
 * finds a solution when one is in reach but promises nothing about its pushes.
 */
function search(
  board: Board,
  budget: { used: number },
  mode: 'astar' | 'greedy',
): { pushes: number; moves: string } | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = board;
  const size = wall.length;
  const nB = startBoxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const dist = goals.map((g) => pushDistances(board, g));
  const live = liveSquares(dist);
  for (const b of startBoxes) if (!live[b]) return null;
  const exact = nB <= 5;
  const orders = exact ? permutations(nB) : [];
  const hCache = new Map<number | string, number>();
  const heuristic = (bs: number[]): number => {
    const ck: number | string = nB <= 5 ? bs.reduce((k, b) => k * size + b, 0) : bs.join(',');
    const hit = hCache.get(ck);
    if (hit !== undefined) return hit;
    const v = exact ? matchExact(bs, dist, orders) : matchGreedy(bs, dist);
    hCache.set(ck, v);
    return v;
  };

  // The states in the order found: their boxes, the player's square, and the push that
  // made them from their parent. The region stamps mark the player's reachable squares.
  const stBoxes: number[][] = [startBoxes.slice()];
  const stPlayer: number[] = [startPlayer];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stDir: number[] = [-1];
  const stKey: (number | string)[] = [];
  const closed = new Map<number | string, number>();
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  const regionMark = new Uint8Array(size);
  const scratchMark = new Uint8Array(size);
  let stamp = 0;
  const occupied = new Uint8Array(size);

  // The player's reachable region from `from` over open floor around the boxes in
  // `occupied`: its lowest square, with the region itself marked in `mark`.
  const regionLow = (from: number, mark: Uint8Array): number => {
    stamp++;
    mark.fill(0);
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    mark[from] = 1;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      const q0 = p - w;
      const q1 = p + w;
      const q2 = p - 1;
      const q3 = p + 1;
      if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; mark[q0] = 1; stack[n++] = q0; }
      if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; mark[q1] = 1; stack[n++] = q1; }
      if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; mark[q2] = 1; stack[n++] = q2; }
      if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; mark[q3] = 1; stack[n++] = q3; }
    }
    return low;
  };

  // The shortest walk from `from` to `to` around walls and the boxes in `boxes`, in
  // lower LURD letters (the first direction first on ties).
  const walkTo = (boxes: number[], from: number, to: number): string => {
    if (from === to) return '';
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    const prev = new Int32Array(size).fill(-1);
    const how: string[] = new Array(size);
    const queue = [from];
    prev[from] = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      if (p === to) break;
      for (const [dx, dy, letter] of DIRS) {
        const q = p + dy * w + dx;
        if (wall[q] || occ[q] || prev[q] !== -1) continue;
        prev[q] = p;
        how[q] = letter;
        queue.push(q);
      }
    }
    if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
    let s = '';
    for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
    return s;
  };

  for (const b of startBoxes) occupied[b] = 1;
  const low0 = regionLow(startPlayer, regionMark);
  for (const b of startBoxes) occupied[b] = 0;
  const key0 = keyOf(startBoxes, low0, size);
  stKey.push(key0);
  closed.set(key0, 0);
  if (startBoxes.every((b) => goalSet[b])) return { pushes: 0, moves: '' };
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  const heap: HeapEntry[] = [];
  let counter = 0;
  heapPush(heap, [h0, 0, counter++, 0]);

  while (heap.length > 0) {
    const top = heapPop(heap);
    const g = top[1];
    const s = top[3];
    if ((closed.get(stKey[s]) ?? Infinity) < g) continue;
    const bs = stBoxes[s];
    if (bs.every((b) => goalSet[b])) {
      // The path of pushes, then the moves: walk to each push's square, then push.
      const chain: number[] = [];
      for (let t = s; t > 0; t = stParent[t]) chain.push(t);
      chain.reverse();
      let moves = '';
      let player = startPlayer;
      let boxes = startBoxes.slice();
      for (const t of chain) {
        const from = stFrom[t];
        const di = stDir[t];
        const [dx, dy, , pushLetter] = DIRS[di];
        const d = dy * w + dx;
        moves += walkTo(boxes, player, from - d);
        moves += pushLetter;
        player = from;
        boxes = stBoxes[t].slice();
      }
      return { pushes: chain.length, moves };
    }
    if (budget.used >= EXPANSION_LIMIT) return null;
    budget.used++;
    const p = stPlayer[s];
    for (const b of bs) occupied[b] = 1;
    regionLow(p, regionMark);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const d = dy * w + dx;
        const stance = b - d;
        const t = b + d;
        if (regionMark[stance] !== 1) continue;
        if (wall[t] !== 0 || occupied[t] !== 0 || live[t] === 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, wall, occupied, goalSet, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = bs.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const lowNext = regionLow(b, scratchMark);
        const key = keyOf(next, lowNext, size);
        const g2 = g + 1;
        const prev = closed.get(key);
        if (prev !== undefined && (mode === 'greedy' || prev <= g2)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const h2 = heuristic(next);
        occupied[t] = 0;
        occupied[b] = 1;
        if (h2 === Infinity) continue;
        closed.set(key, g2);
        const idx = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stDir.push(di);
        stKey.push(key);
        heapPush(heap, [mode === 'astar' ? g2 + h2 : h2, g2, counter++, idx]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  return null;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left that holds a box is a
 * room, its squares, boxes and goals. Null when some part holds more or fewer boxes
 * than goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dist = goals.map((g) => pushDistances(level, g));
  const live = liveSquares(dist);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One level's moves: each room solved in turn, the other rooms' boxes standing as walls. */
function solveLevel(text: string, budget: { used: number }): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const solved = search(level, budget, 'astar') ?? search(level, budget, 'greedy');
    return solved === null ? '' : solved.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const src = other.done ? other.goals : other.boxes;
      for (const b of src) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = search(sub, budget, 'astar') ?? search(sub, budget, 'greedy');
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

const budget = { used: 0 };
for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
