# Handover 2: state after the first orchestrated run (27 Oct 2026)

Read this before `docs/HANDOVER.md`. That file is still the brief (goal, data
sources, pipeline design); `docs/TASKS.md` is the checklist; `CLAUDE.md` has
commands, conventions, budgets and gotchas. This file covers what happened in
the first long unattended run, what's unfinished, and how to work next time.

## Start here

1. **Unfinished work is on the `backup/wip` branch, not `main`.** It is `main`
   plus three commits (named by subject; hashes change on rebase) that have
   not been verified by anyone:
   - "Fix camera-relative walking after a snap; ram the CPO wall
     square-on in smoke" (a fix for the wall-collision smoke checks that failed
     on GitHub's runner; see "Known issues").
   - "T9a: hand-made Sky Tower, Ferry Building, Chief Post Office and Civic".
   - "T9a: lift the Civic's rooftop sign clear of the parapet merlons".

   To pick them up: `git fetch origin && git checkout main && git merge --ff-only origin/backup/wip`
   (or cherry-pick the three). Then run `npm run build && npm run sim && npm run smoke`,
   look at each landmark in game (`npm run dev`, `?debug`), and push `main`.
   The subagent that wrote them was cut off by a usage limit before it
   reported, so check budgets and colliders yourself.
2. **Then continue `docs/TASKS.md`:** finish T9 (record T9a there; part 2 is
   Town Hall, Wynyard silos, Harbour Bridge backdrop, Rangitoto skyline), then
   T8c look polish, then T10–T14.

## Branches and deploys

- **`main`** is the working branch (owner's choice).
- **`claude/gta-style-auckland-game-pffg64`** is the repo's *default* branch
  and the only one the `github-pages` environment will deploy. Until the
  owner makes `main` the default (Settings → General), deploy by pushing both:
  `git push origin main main:claude/gta-style-auckland-game-pffg64`. The
  workflow deploys only from the default branch, so nothing else needs
  changing once it's switched.
- **`backup/wip`** holds force-pushed snapshots of unfinished work. It doesn't
  deploy. Overwrite it freely.
- **`claude/orchestrator-handover-setup-7lp1db`** is a stale session branch;
  ignore it.
- **CI only builds and deploys.** At the owner's request it no longer runs sim
  or smoke (they were slow and flaky on the GitHub runner and blocked
  deploys). Run them locally before pushing.
- Live: https://jay-aye-see-kay.github.io/grand-theft-auckland/ (add `?debug`).
  It currently has everything up to T8b (street-level look).

## What was done

Tier 1 and the street-level look, T1–T8b. See TASKS.md for per-task notes:

- citygen pipeline (`tools/citygen/`): OSM + LINZ LiDAR fetch and cache,
  projection (origin Britomart), terrain, buildings, roads, ground land-use,
  parking, overrides (`overrides/cbd.json`), skyline LOD; deterministic output
  committed in `public/city/cbd/` (~3 MB).
- Game: Auckland is the default map (`?map=test` keeps the old town), chunk
  streaming, one draw call per chunk, harbour water with splash and reset,
  spawn at Britomart, 9 parked cars, title screen with data credits.
- Performance pass: street views ~130k triangles and ~30 draw calls, smoke
  checks the budgets.
- Look (owner feedback: "aerials good, ground level looks PS1, I expected
  PS2/PS3"): northern sun, ACES tone mapping and haze, procedural facade atlas
  styled from OSM tags, verandahs, road textures, lane lines and crossings,
  Sky Tower visible over the rooftops. The old "flat vertex colours only" rule
  is dropped.

## How the run worked

One orchestrator session read the docs, then spawned one general-purpose
subagent per task with a self-contained brief (task, done-when, pointers,
"run build/sim/smoke 3×, commit, don't push, report in <200 words"). The
orchestrator re-ran the checks, looked at screenshots, ticked TASKS.md,
pushed, and checked the deploy. A scheduled check-in every 40 minutes pushed
unfinished work to `backup/wip`.

### What worked

- **Small verified tasks with a "done when"** and an honest re-check by the
  orchestrator. It caught flaky checks twice and wrong test geometry once.
- **Screenshots at fixed views** (`__game.view('spawn'|'queen-st'|'aerial')`)
  as the main quality signal, and reading them critically ("does this read as
  Auckland?").
- **Budgets enforced in smoke** (triangles, draw calls), so a later feature
  can't silently blow the phone budget.
- **Overrides keyed by OSM id** and general rule fixes (canopies, LiDAR caps,
  bridges) instead of hand edits to generated data.
- **Pushing playable builds often.** The owner play-tests when they can and
  explicitly prefers a slightly buggy live build to a stale one.

### What didn't

- **Token cost was high.** Each subagent was a cold start (200–440k tokens per
  task), re-reading docs and code the orchestrator already had. Long tool
  calls likely broke the prompt cache: smoke takes 5–10 minutes, and each
  subagent ran it several times. Re-checks by the orchestrator doubled that.
- **The cloud container restarted every 30–60 minutes, and usage limits hit
  several times.** Subagents died mid-task. Uncommitted work survived only
  because of `backup/wip` snapshots. Each resume reloaded a long transcript.
  One task (T7b) lost its early work.
- **Smoke grew slow and flaky.** It holds keys and waits in real time in a
  software-rendered browser (~11 fps). Movement and wall checks failed on the
  slower GitHub runner while passing locally, which is why the gate was
  removed.
- **`git stash create` backups silently skipped untracked files.** Use a
  temporary index instead:
  `GIT_INDEX_FILE=$(mktemp -u); cp .git/index $GIT_INDEX_FILE; git add -A; git commit-tree $(git write-tree) -p HEAD -m wip`,
  then push that commit to `refs/heads/backup/wip`.

### Do differently next time

1. **Make tests fast and deterministic first.** Add a debug hook that steps
   physics N ticks without rendering (e.g. `__game.step(n)`), and rewrite the
   movement, drive and wall checks to use it instead of real-time waits. This
   is the biggest win for both speed and flakiness.
2. **Split smoke** into a fast core suite (< 1 min, every change) and a full
   suite (before push), with an `--only=<area>` filter.
3. **Use a real GPU** for smoke and screenshots when running on a laptop
   (hardware GL instead of SwiftShader).
4. **Prefer one working session over subagents.** Use a subagent only for a
   big, self-contained job, and don't re-run its full test suite unless
   something looks off; re-run the fast suite and look at screenshots.
5. **Make citygen incremental** (cache per layer) so a facade change doesn't
   regenerate terrain and roads.
6. **Test frame rate on a real phone** with `npm run dev` over the LAN. The
   headless fps means nothing.
7. **Commit each verified step immediately**, however small.

## Known issues

- **Possible wall tunnelling when the sim runs slowly.** On GitHub's runner a
  car rammed at the Chief Post Office wall ended up ~50 m past it, and the
  player stopped 3 m short. The "Fix camera-relative walking" commit on
  `backup/wip` changes the test
  setup; it is not yet known whether the game itself can tunnel on a slow
  phone. Colliders are built asynchronously within ~300 m, which is a
  suspect: check that colliders exist around teleport targets and fast cars.
- Lane lines run through junctions; shop window displays are garish; a lower
  Queen St view goes slightly over the triangle budget, mostly terrain (T8c).
- Marina pontoons have jagged slopes, the distant coastline is saw-toothed.
- Handling and camera tuning is still parked by the owner's choice.

## Questions waiting on the owner

See the Questions section of `docs/TASKS.md`: the phone checklist for the
tier 1 milestone, and switching the default branch to `main`.
