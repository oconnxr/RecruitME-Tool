// The scouting agent: Claude with web search/fetch finds high school
// players, checks commitment status, and records each one through a
// client tool. Scoring happens afterwards in scoring.js.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ProspectSchema, CommitmentSchema, RECORD_PROSPECT_TOOL, FINISH_TOOL } from "./schema.js";
import { loadBoard, saveBoard, upsertProspect, prospectKey } from "./board.js";
import { seniorClass } from "./scoring.js";

const SYSTEM_PROMPT = `You are a recruiting coordinator's research assistant for a college baseball program. Your job is to find high school baseball players who are NOT yet committed to a college, and record accurate, sourced data about each one so the staff can evaluate them.

How to work:
- Search public sources: Perfect Game and Prep Baseball Report public profile and event pages, MaxPreps, state high school association sites, high school and travel-team rosters, local news, and recruiting posts on X.
- For every candidate, check commitment status before recording them. Search for "<name> commits", "<name> committed", and look at their PBR/PG profile commitment field and their X bio if public. A commitment can be recent, so prefer the newest information. If you cannot tell, use status "unknown" and say what you checked. Don't record players you confirmed are committed unless the request asks for them.
- Record only numbers you actually saw in a source, with that source in "sources". Use null for anything missing. Don't estimate, round up, or carry a number from one player to another. Note the event and date for measurables when given, since velocities change fast.
- Convert units: height "6-2" is 74 inches; rate stats are decimals (.412 -> 0.412).
- Capture recruiting-relevant athletic information only. These are minors: don't record home addresses, phone numbers, emails, parents' names, or anything personal beyond school, hometown, and travel team.
- Call record_prospect once per player as soon as you have checked them, rather than saving everyone up for the end. When the target count is reached or leads run dry, call finish_search with a short summary of what you covered and what's worth a follow-up search.`;

const UpdateCommitmentSchema = z.object({ id: z.string(), commitment: CommitmentSchema });
const UPDATE_COMMITMENT_TOOL = {
  name: "update_commitment",
  description: "Record the current commitment status for one player from the provided list.",
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The player's id exactly as given in the list" },
      commitment: RECORD_PROSPECT_TOOL.input_schema.properties.commitment,
    },
    required: ["id", "commitment"],
    additionalProperties: false,
  },
};

function describeCriteria(c) {
  const lines = [];
  if (c.positions?.length) lines.push(`Positions: ${c.positions.join(", ")}`);
  if (c.gradYears?.length) lines.push(`Graduating classes: ${c.gradYears.join(", ")}`);
  if (c.states?.length) lines.push(`States/regions: ${c.states.join(", ")}`);
  if (c.minFbVelo) lines.push(`Pitchers: fastball at least ${c.minFbVelo} mph`);
  if (c.minExitVelo) lines.push(`Hitters: exit velocity at least ${c.minExitVelo} mph`);
  if (c.notes) lines.push(`Other requirements: ${c.notes}`);
  return lines.length ? lines.join("\n") : "No specific filters; find the best uncommitted players you can.";
}

async function runLoop({ client, config, system, userPrompt, tools, handleTool, onEvent }) {
  const { agent } = config;
  const messages = [{ role: "user", content: userPrompt }];
  const serverTools = [
    { type: "web_search_20260209", name: "web_search", max_uses: agent.maxWebSearches },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: agent.maxWebFetches },
  ];
  let jsonRetries = 0;
  const usage = { input: 0, output: 0, cacheRead: 0 };

  for (let turn = 0; turn < agent.maxTurns; turn++) {
    const stream = client.beta.messages.stream({
      model: agent.model,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // a declined request is re-run on a fallback model server-side
      output_config: { effort: agent.effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [...serverTools, ...tools],
      messages,
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") {
        if (block.name === "web_search") onEvent({ type: "search", query: block.input?.query });
        else if (block.name === "web_fetch") onEvent({ type: "fetch", url: block.input?.url });
      } else if (block.type === "text" && block.text.trim()) {
        onEvent({ type: "text", text: block.text.trim() });
      } else if (block.type === "fallback") {
        onEvent({ type: "info", text: `${block.from?.model} declined; continued on ${block.to?.model}` });
      }
    });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API, auth and
      // network errors propagate. The SDK has no dedicated class for this
      // case (it is a bare AnthropicError), so it is identified by message.
      const badToolJson =
        err instanceof Anthropic.AnthropicError &&
        !(err instanceof Anthropic.APIError) &&
        err.message.startsWith("Unable to parse tool parameter JSON");
      if (!badToolJson || jsonRetries++ >= 2) throw err;
      onEvent({ type: "info", text: "Tool input was malformed; retrying the turn." });
      turn--;
      continue;
    }

    usage.input += message.usage?.input_tokens ?? 0;
    usage.output += message.usage?.output_tokens ?? 0;
    usage.cacheRead += message.usage?.cache_read_input_tokens ?? 0;

    if (message.stop_reason === "refusal") {
      onEvent({ type: "info", text: `Model declined: ${message.stop_details?.explanation ?? "no details"}` });
      return { reason: "refusal", usage };
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return { reason: message.stop_reason, usage };
    if (message.stop_reason === "max_tokens") throw new Error("Tool input truncated at max_tokens.");

    messages.push({ role: "assistant", content: message.content });
    const results = [];
    let done = false;
    for (const tu of toolUses) {
      const r = await handleTool(tu);
      if (r.done) done = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
    }
    if (done) return { reason: "finished", usage };
    messages.push({ role: "user", content: results });
  }
  onEvent({ type: "info", text: `Stopped after ${agent.maxTurns} turns (agent.maxTurns).` });
  return { reason: "max_turns", usage };
}

// Find new uncommitted prospects matching `criteria` and add them to the board.
export async function findProspects(criteria, config, { onEvent = () => {}, client = new Anthropic() } = {}) {
  const board = loadBoard();
  const runId = `run_${Date.now()}`;
  const target = criteria.count ?? config.agent.targetProspects;
  // Searches stay inside the program's territory unless states are given.
  if (!criteria.states?.length && config.program.states?.length) criteria = { ...criteria, states: config.program.states };
  const known = board.prospects.map((p) => `${p.name} (${p.gradYear}, ${p.state ?? "?"}, ${p.commitment?.status})`);
  const stats = { added: 0, updated: 0, rejected: 0 };
  let summary = null;

  const userPrompt = `Program: ${config.program.name} (${config.program.level})
Program notes: ${config.program.notes}
Today: ${new Date().toISOString().slice(0, 10)}. The current senior class is ${seniorClass()}.

Find up to ${target} uncommitted high school players matching:
${describeCriteria(criteria)}

Already on our board (skip unless you find newer data or a status change):
${known.length ? known.join("\n") : "(none yet)"}`;

  onEvent({ type: "start", runId, criteria });

  const result = await runLoop({
    client, config, onEvent, userPrompt,
    system: SYSTEM_PROMPT,
    tools: [RECORD_PROSPECT_TOOL, FINISH_TOOL],
    handleTool: async (tu) => {
      if (tu.name === "finish_search") {
        summary = typeof tu.input?.summary === "string" ? tu.input.summary : null;
        return { content: "ok", done: true };
      }
      if (tu.name !== "record_prospect") return { content: `Unknown tool ${tu.name}`, isError: true };
      const parsed = ProspectSchema.safeParse(tu.input);
      if (!parsed.success) {
        stats.rejected++;
        return { isError: true, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.slice(0, 5), received: tu.input }) };
      }
      const outcome = upsertProspect(board, parsed.data, runId);
      stats[outcome]++;
      saveBoard(board); // persist as we go so a crash loses nothing
      onEvent({ type: "prospect", outcome, prospect: parsed.data });
      const n = stats.added + stats.updated;
      return { content: `Saved (${outcome}). ${n}/${target} recorded this run.` };
    },
  });

  board.runs.push({ id: runId, at: new Date().toISOString(), criteria, ...stats, summary, stopReason: result.reason, usage: result.usage });
  saveBoard(board);
  onEvent({ type: "done", runId, ...stats, summary, stopReason: result.reason, usage: result.usage });
  return { runId, ...stats, summary, usage: result.usage };
}

// Re-check commitment status for players on the board (status changes fast).
export async function verifyCommitments(config, { olderThanDays = 7, limit = 15, onEvent = () => {}, client = new Anthropic() } = {}) {
  const board = loadBoard();
  const cutoff = Date.now() - olderThanDays * 864e5;
  const due = board.prospects
    .filter((p) => p.commitment?.status !== "committed")
    .filter((p) => new Date(p.commitment?.verifiedAt ?? p.updatedAt).getTime() < cutoff || p.commitment?.status === "unknown")
    .slice(0, limit);
  if (!due.length) {
    onEvent({ type: "done", checked: 0 });
    return { checked: 0, changed: 0 };
  }

  let checked = 0, changed = 0;
  const list = due.map((p) => `- id: ${p.id} | ${p.name}, ${p.primaryPosition}, class of ${p.gradYear}, ${p.highSchool ?? "?"} (${p.city ?? "?"}, ${p.state ?? "?"})`).join("\n");
  onEvent({ type: "start", verifying: due.length });

  await runLoop({
    client, config, onEvent,
    system: SYSTEM_PROMPT,
    userPrompt: `Today: ${new Date().toISOString().slice(0, 10)}. Re-check the current college commitment status of each player below and call update_commitment once per player. Then call finish_search.\n\n${list}`,
    tools: [UPDATE_COMMITMENT_TOOL, FINISH_TOOL],
    handleTool: async (tu) => {
      if (tu.name === "finish_search") return { content: "ok", done: true };
      const parsed = UpdateCommitmentSchema.safeParse(tu.input);
      if (!parsed.success) return { isError: true, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.slice(0, 5) }) };
      const p = board.prospects.find((x) => x.id === parsed.data.id || prospectKey(x) === parsed.data.id);
      if (!p) return { isError: true, content: `No player with id ${parsed.data.id}` };
      const before = p.commitment?.status;
      p.commitment = { ...parsed.data.commitment, verifiedAt: new Date().toISOString() };
      checked++;
      if (before !== p.commitment.status) changed++;
      saveBoard(board);
      onEvent({ type: "commitment", name: p.name, from: before, to: p.commitment.status, school: p.commitment.school });
      return { content: "Saved." };
    },
  });
  onEvent({ type: "done", checked, changed });
  return { checked, changed };
}
