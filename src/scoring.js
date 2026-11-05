// Deterministic ranking. The agent only gathers data; every score is
// computed here from config benchmarks, so rankings are reproducible and
// tunable without re-running a search.

export function positionGroup(pos) {
  if (pos === "RHP" || pos === "LHP") return "pitcher";
  if (pos === "C") return "catcher";
  if (pos === "OF") return "outfield";
  return "infield"; // 1B/2B/SS/3B/MIF/INF/UTIL
}

// Senior class for the current recruiting cycle: from August on, the
// class graduating next spring is the senior class.
export function seniorClass(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

function scoreMetric(value, bench, yearsYounger, classAdjust) {
  let { floor, elite } = bench;
  if (bench.adjust && yearsYounger > 0) {
    // Younger players get proportionally easier targets. For "lower is
    // better" metrics (times) the target moves up; otherwise it moves down.
    const delta = (classAdjust[bench.adjust] ?? 0) * yearsYounger;
    const sign = bench.lower ? 1 : -1;
    floor += sign * delta;
    elite += sign * delta;
  }
  const t = (value - floor) / (elite - floor); // works for both directions
  return Math.max(0, Math.min(1, t)) * 100;
}

function scoreCategory(values, benches, yearsYounger, classAdjust) {
  let total = 0, weightSum = 0, possible = 0, present = 0;
  const detail = {};
  for (const [key, bench] of Object.entries(benches)) {
    if (key.startsWith("_")) continue;
    possible += bench.weight;
    const v = values?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const sc = scoreMetric(v, bench, yearsYounger, classAdjust);
    detail[key] = Math.round(sc);
    total += sc * bench.weight;
    weightSum += bench.weight;
    present += bench.weight;
  }
  return {
    score: weightSum ? total / weightSum : null,
    coverage: possible ? present / possible : 0,
    detail,
  };
}

export function scoreProspect(p, config, now = new Date()) {
  const { ranking, benchmarks } = config;
  const group = positionGroup(p.primaryPosition);
  const g = benchmarks[group];
  const perfBench = typeof g.performance === "string" ? benchmarks[g.performance] : g.performance;
  const yearsYounger = Math.max(0, p.gradYear - seniorClass(now));

  const meas = scoreCategory(p.measurables, g.measurables, yearsYounger, ranking.classAdjust);
  const perf = scoreCategory(p.stats, perfBench, 0, ranking.classAdjust);

  // Small samples make HS stats noise; scale their weight by sample size.
  const sample = group === "pitcher" ? p.stats?.inningsPitched : p.stats?.atBats;
  const minSample = group === "pitcher" ? ranking.minSample.inningsPitched : ranking.minSample.atBats;
  const sampleFactor = typeof sample === "number" ? Math.min(1, sample / minSample) : 0.5;

  let wM = ranking.weights.measurables;
  let wP = ranking.weights.performance * sampleFactor;
  if (meas.score === null) wM = 0;
  if (perf.score === null) wP = 0;

  const flags = [];
  let raw = 0;
  if (wM + wP > 0) raw = ((meas.score ?? 0) * wM + (perf.score ?? 0) * wP) / (wM + wP);
  else flags.push("no scorable data");

  // Confidence: how much of the expected profile we actually have.
  const wTotal = ranking.weights.measurables + ranking.weights.performance;
  const confidence =
    (meas.coverage * ranking.weights.measurables + perf.coverage * ranking.weights.performance) / wTotal;
  // Shrink toward a neutral prior in proportion to missing data, so one
  // good number (say, height) can't outrank a complete strong profile, and
  // an unknown player sits mid-board rather than at zero.
  const prior = ranking.priorScore;
  let score = prior + (raw - prior) * confidence;

  if (p.commitment?.status === "unknown") {
    score *= 1 - ranking.unverifiedCommitmentPenalty;
    flags.push("commitment unverified");
  }
  if (perf.score !== null && typeof sample !== "number") flags.push("stat sample unknown");
  else if (sampleFactor < 1 && perf.score !== null) flags.push("small stat sample");
  if (meas.coverage < 0.5) flags.push("thin measurables");

  return {
    score: Math.round(score * 10) / 10,
    measurablesScore: meas.score === null ? null : Math.round(meas.score),
    performanceScore: perf.score === null ? null : Math.round(perf.score),
    confidence: Math.round(confidence * 100),
    group,
    detail: { ...meas.detail, ...perf.detail },
    flags,
  };
}

// Rank the board. Committed players are excluded unless asked for.
export function rankBoard(prospects, config, { includeCommitted = false, filters = {}, now } = {}) {
  return prospects
    .filter((p) => includeCommitted || p.commitment?.status !== "committed")
    .filter((p) => !filters.gradYear || p.gradYear === Number(filters.gradYear))
    .filter((p) => !filters.state || (p.state ?? "").toUpperCase() === filters.state.toUpperCase())
    .filter((p) => !filters.group || positionGroup(p.primaryPosition) === filters.group)
    .filter((p) => !filters.position || p.primaryPosition === filters.position)
    .map((p) => ({ ...p, ranking: scoreProspect(p, config, now) }))
    .sort((a, b) => b.ranking.score - a.ranking.score)
    .map(withRank());
}

// Committed players (shown only on request) don't take a rank slot.
function withRank() {
  let n = 0;
  return (p) => ({ ...p, rank: p.commitment?.status === "committed" ? null : ++n });
}
