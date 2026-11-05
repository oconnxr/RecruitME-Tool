// Prospect data model: the zod schema used to validate what the agent
// records, and the matching JSON Schema handed to Claude as a tool.
import { z } from "zod";

const num = z.number().nullable();

export const MeasurablesSchema = z.object({
  fbVelo: num.describe("Fastball velocity, typical/sitting (mph)"),
  fbTopVelo: num.describe("Fastball top velocity (mph)"),
  exitVelo: num.describe("Max exit velocity (mph)"),
  sixty: num.describe("60-yard dash (seconds)"),
  ifVelo: num.describe("Infield throwing velocity (mph)"),
  ofVelo: num.describe("Outfield throwing velocity (mph)"),
  cVelo: num.describe("Catcher throwing velocity (mph)"),
  popTime: num.describe("Catcher pop time (seconds)"),
  heightIn: num.describe("Height in inches"),
  weightLb: num.describe("Weight in pounds"),
  measuredAt: z.string().nullable().describe("Event/date the measurables came from"),
});

export const StatsSchema = z.object({
  season: z.string().nullable().describe("Season the stats are from, e.g. '2026 spring HS'"),
  atBats: num, avg: num, obp: num, slg: num, hr: num, sb: num,
  inningsPitched: num, era: num, k9: num, bb9: num, whip: num,
});

export const CommitmentSchema = z.object({
  status: z.enum(["uncommitted", "committed", "unknown"]),
  school: z.string().nullable().describe("College committed to, if any"),
  evidence: z.string().describe("How status was determined (what was checked, what it said)"),
  checkedUrl: z.string().nullable().describe("URL of the most authoritative page checked"),
});

export const ProspectSchema = z.object({
  name: z.string().min(1),
  gradYear: z.number().int().min(2025).max(2035),
  primaryPosition: z.enum(["RHP", "LHP", "C", "1B", "2B", "SS", "3B", "MIF", "INF", "OF", "UTIL"]),
  secondaryPosition: z.string().nullable(),
  bats: z.enum(["R", "L", "S"]).nullable(),
  throws: z.enum(["R", "L"]).nullable(),
  highSchool: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable().describe("Two-letter state code"),
  travelTeam: z.string().nullable(),
  measurables: MeasurablesSchema,
  stats: StatsSchema,
  commitment: CommitmentSchema,
  scoutingNotes: z.string().nullable().describe("Short summary of public scouting reports"),
  sources: z.array(z.string()).min(1).describe("URLs every number above came from"),
});

// zod -> JSON Schema for the tool definition. Kept hand-written so the
// tool schema stays stable byte-for-byte (prompt caching) and readable.
const n = (description) => ({ type: ["number", "null"], description });
const s = (description) => ({ type: ["string", "null"], description });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const RECORD_PROSPECT_TOOL = {
  name: "record_prospect",
  description:
    "Save one high school baseball prospect to the recruiting board. Call once per player, " +
    "after you have checked their commitment status. Use null for anything you could not find " +
    "in a source - never estimate or invent numbers.",
  strict: true,
  eager_input_streaming: true,
  input_schema: obj({
    name: { type: "string" },
    gradYear: { type: "integer", description: "High school graduation year" },
    primaryPosition: {
      type: "string",
      enum: ["RHP", "LHP", "C", "1B", "2B", "SS", "3B", "MIF", "INF", "OF", "UTIL"],
    },
    secondaryPosition: s("Secondary position if listed"),
    bats: { type: ["string", "null"], enum: ["R", "L", "S", null] },
    throws: { type: ["string", "null"], enum: ["R", "L", null] },
    highSchool: s("High school name"),
    city: s("Hometown city"),
    state: s("Two-letter state code"),
    travelTeam: s("Summer/travel organization"),
    measurables: obj({
      fbVelo: n("Fastball velocity, typical/sitting (mph)"),
      fbTopVelo: n("Fastball top velocity (mph)"),
      exitVelo: n("Max exit velocity (mph)"),
      sixty: n("60-yard dash (seconds)"),
      ifVelo: n("Infield throwing velocity (mph)"),
      ofVelo: n("Outfield throwing velocity (mph)"),
      cVelo: n("Catcher throwing velocity (mph)"),
      popTime: n("Catcher pop time (seconds)"),
      heightIn: n("Height in inches (6-2 = 74)"),
      weightLb: n("Weight in pounds"),
      measuredAt: s("Event and date the measurables came from"),
    }),
    stats: obj({
      season: s("Season the stats are from, e.g. '2026 spring HS'"),
      atBats: n("At-bats"),
      avg: n("Batting average as a decimal, e.g. 0.412"),
      obp: n("On-base percentage as a decimal"),
      slg: n("Slugging percentage as a decimal"),
      hr: n("Home runs"),
      sb: n("Stolen bases"),
      inningsPitched: n("Innings pitched"),
      era: n("ERA"),
      k9: n("Strikeouts per 9 innings (K/9)"),
      bb9: n("Walks per 9 innings"),
      whip: n("WHIP"),
    }),
    commitment: obj({
      status: { type: "string", enum: ["uncommitted", "committed", "unknown"] },
      school: s("College committed to, if any"),
      evidence: { type: "string", description: "What you checked and what it said" },
      checkedUrl: s("URL of the most authoritative page checked"),
    }),
    scoutingNotes: s("1-3 sentence summary of public scouting reports"),
    sources: {
      type: "array",
      items: { type: "string" },
      description: "URLs the data came from (at least one)",
    },
  }),
};

export const FINISH_TOOL = {
  name: "finish_search",
  description: "Call when the search is complete (target reached or leads exhausted).",
  strict: true,
  eager_input_streaming: true,
  input_schema: obj({
    summary: { type: "string", description: "What was searched, what was found, gaps worth a follow-up" },
  }),
};
