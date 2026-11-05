# RecruitME Tool

An agent that searches the public web for **uncommitted high school baseball
players**, checks each one's commitment status, and ranks them on
**measurables** and **performance stats** for the MSC Baseball staff.

```
./
  config/default.json   program info, agent limits, ranking weights, benchmarks
  src/agent.js          Claude + web search/fetch; records players via tools
  src/schema.js         prospect data model (validated with zod)
  src/scoring.js        deterministic ranking (no AI involved)
  src/board.js          JSON board storage, de-duplication and merging
  src/report.js         CSV / standalone HTML export
  src/server.js         web dashboard + live agent progress (SSE)
  src/cli.js            `recruit` command line
  public/index.html     dashboard UI
  data/board.json       your board (git-ignored; created on first run)
```

## Setup

Requires Node 20+ and an Anthropic API key.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

`config/default.json` is set up for MSC Baseball: NJCAA Division II,
recruiting Oklahoma, Texas, Arkansas and Kansas (searches default to those
states), with benchmarks tuned for the JUCO D2 level. For personal or
temporary overrides, put the keys you want to change in `config/local.json`
(git-ignored). It is deep-merged over the defaults:

```json
{ "program": { "notes": "This fall: need LHP and a catcher in 2027." } }
```

## Usage

### Command line

```bash
# Find uncommitted 2027 RHPs in Texas throwing 86+
npm run recruit -- find --pos RHP --class 2027 --state TX --min-fb 86 --count 15

# Hitters, several positions and states, free-form requirements
npm run recruit -- find --pos SS,2B,OF --class 2027,2028 --state OK,AR --min-ev 92 --notes "left-handed bats preferred"

# See the ranked board (committed players are hidden; --all shows them)
npm run recruit -- rank --class 2027 --group pitcher --top 20

# Re-check commitment status (they change weekly in the fall)
npm run recruit -- verify --days 7

# Export for the staff
npm run recruit -- export --out board.csv     # spreadsheet
npm run recruit -- export --out board.html    # standalone page, works offline
```

### Dashboard

```bash
npm run serve      # http://localhost:5178
```

From the dashboard you can start a search, watch the agent's searches and
finds live, filter and sort the board, click a player for their full
profile, sources and commitment evidence, and export to CSV.

The server has no login and binds to `127.0.0.1`, because every search
spends API credits. Don't expose it publicly without adding auth.

## Google Sheets dashboard (always on, updated weekly)

The board can live in a Google Sheet, with a dashboard that opens inside it.
Nothing needs hosting, and only people the Sheet is shared with can see it.

- **The Sheet:** `MSC Baseball Recruiting Board` in Google Drive. The
  `Players` tab holds one row per player, and coaches can edit it directly.
  Columns are matched by header name, so you can reorder them or add your
  own (for example "Coach notes") without breaking anything.
- **The dashboard:** `apps-script/Code.gs` and `apps-script/Dashboard.html`.
  One-time setup:
  1. Open the Sheet, then **Extensions > Apps Script**.
  2. Replace the contents of `Code.gs` with `apps-script/Code.gs`.
  3. Click **+ > HTML**, name it `Dashboard`, and paste in
     `apps-script/Dashboard.html`.
  4. Save, reload the Sheet, and choose **Recruiting > Open dashboard**.
     Approve the permission prompt the first time.
  For a full-page version, use **Deploy > New deployment > Web app** with
  "Who has access" set to **Only myself** or your school's domain.
- **Weekly updates:** a scheduled Claude task runs the steps in
  [`docs/weekly-update.md`](docs/weekly-update.md): re-check commitments,
  find new players, write the Sheet, and log the run in the `Updates` tab.
  It needs the **Google Sheets** connector in claude.ai to edit the Sheet.

After changing `public/index.html`, `src/scoring.js` or the config, run
`npm run build:apps-script` and paste the new `Dashboard.html` into the
script editor.

CLI helpers for the Sheet:

```bash
npm run recruit -- sheet-export --out players.csv   # board -> Sheet layout
npm run recruit -- sheet-import --file players.csv  # Sheet -> board
```

## How it works

1. **Search.** Claude (`claude-opus-5-5`) uses web search and web fetch on
   public pages: PBR/Perfect Game public profiles and event results,
   MaxPreps, rosters, local news and recruiting posts. Players already on the
   board are passed in, so repeat searches find new names.
2. **Verify.** Before recording anyone, the agent checks commitment status
   and records what it checked (`evidence` + `checkedUrl`). If it can't tell,
   the status is `unknown`, which is flagged and given a small score penalty.
3. **Record.** Each player is saved with the `record_prospect` tool. The
   input is schema-validated, and every number must have a source URL. The
   agent is told to use `null` instead of estimating. The board is saved
   after every player, so an interrupted run loses nothing.
4. **Rank.** `src/scoring.js` scores players in plain code, so rankings are
   reproducible and change instantly when you edit the weights. You don't
   need to re-run a search.

### Scoring

- Players are grouped as **pitcher / catcher / infield / outfield**, and each
  group has its own metrics in `config.benchmarks`.
- Each metric maps linearly from `floor` (0) to `elite` (100). Times
  (60-yard, pop) and ERA/BB9/WHIP are lower-is-better.
- **Class adjustment:** benchmarks are set for the current senior class. For
  each year younger, velocity targets drop by `classAdjust.veloPerYear` mph
  (and so on), so a sophomore throwing 85 is graded fairly next to a senior
  throwing 88.
- **Score** = weighted blend of measurables (default 60%) and performance
  (40%). Performance weight shrinks when the stat sample is small (under
  40 AB / 15 IP by default), because HS stats on small samples are noise.
- **Confidence** = how much of the expected profile was found. The score
  starts at a neutral `priorScore` (35) and moves toward the player's
  numbers in proportion to confidence. One strong number can't top a full
  strong profile, and a player with no data sits mid-board, not at zero.
- Flags: `commitment unverified`, `small stat sample`, `thin measurables`.

The benchmarks are tuned for NJCAA D2 (for example, a senior fastball scores
0 at 78 mph and 100 at 88+). Adjust them to match how your staff grades.

## Cost and limits

Each `find` run is capped by `config.agent` (`maxWebSearches`,
`maxWebFetches`, `maxTurns`). The CLI prints token usage at the end of every
run, and usage is also saved per run in `data/board.json`. Try a small
`--count` first to get a feel for the cost. Requests opt into server-side
refusal fallbacks (`fallbacks: "default"`), so a declined request is retried
on a fallback model instead of failing the run.

## Data and compliance notes

- **Sources.** Perfect Game and PBR don't offer public APIs, and their
  terms prohibit scraping, so the agent only reads public pages the way a
  person would through search. It never logs in. If your program subscribes
  to a scouting service, its exports are the more complete source.
- **Minors.** The agent is told to collect only recruiting-relevant
  athletic information (school, hometown, travel team, measurables, stats).
  It must not collect addresses, phone numbers, emails or family details.
  Keep `data/` out of git (it is ignored by default).
- **Accuracy.** Web data is incomplete and goes stale. Treat the board as a
  lead list for your staff to evaluate, and confirm commitment status and
  numbers before contacting a player.
- **NCAA rules.** This tool only identifies and organizes prospects. Contact
  and communication still follow your division's recruiting calendar and
  rules.

## Tests

```bash
npm test
```

The tests cover scoring, class adjustment, merging, export escaping, and the
agent loop: tool validation, `pause_turn` resume and persistence, run
against a scripted fake client with no network or API key needed.
