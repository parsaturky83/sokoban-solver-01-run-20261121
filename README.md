# Sokoban solver — make.fun bounty `sokoban-solver-01-run-20261121`

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/parsaturky83/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/parsaturky83/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program, `main.ts` (Node 22, TypeScript with
erasable syntax only), that answers a set of 5 instances in one run. It reads
`/input/<id>/level.txt` for `i001`–`i005` and writes `/output/<id>/solution.txt`
(the player's moves in LURD) for each, creating the output directories itself.

## How it works

The generator's levels are a hallway with one to four rooms off it, each room
holding 3 or 4 boxes and as many goals, and a box pushed out of a room can never
come back — so the rooms are independent problems joined only by the player's
walk, and the level's push-optimal count is the sum of its rooms' optima. The
solver therefore:

1. cuts the level into rooms (the hallway's dead squares divide the floor),
2. solves each room push-optimally with A\* over pushes, then
3. stitches the rooms' move strings together with the player's walks between them.

The room search is A\* over push states: a state is the boxes' squares and the
player's reachable region (named by its lowest square). Its estimate is the
cheapest assignment of boxes to goals by push distance, which never overstates
the pushes left, so the first solved state A\* takes off its open list is
push-optimal. Two deadlocks are pruned, neither of which can cut a solvable
state: a box on a square from which no push brings it to any goal, and a frozen
2×2 block of walls and boxes with a box off its goal. If A\* gives up on a room,
a greedy best-first search on the same estimate tries for any solution at all,
so the level still gets a valid answer.

Everything is budgeted by work, never by the clock: one expansion counter shared
by the whole run (2,000,000 expansions), so two executions write the same bytes.
No network, no model calls, no randomness, no clock reads.

## Results

Practice set (kit's `grade-local`, process driver): **score 1,000,000** —
every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60),
two executions reproducing byte for byte, in under a second for the whole set.

The same perfect score on 6 further sets drawn with the kit's own generator
(30 fresh instances, P\* 12–63 pushes): 1,000,000 on every set, each set solved
in under a second. The house baseline, `plain-astar` 1.0.0, scores 200,000 on
the practice set and 280,000–400,000 on the generated sets (it solves only the
first one or two instances and gives up on the rest).

## Files

- `main.ts` — the solver (the entrypoint).
- `LICENSE` — MIT (the kit starter's).
- `.makefun/owner.json` — the claim file naming the entrant's wallet.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Grade it the way the server does (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process --worktree
```
