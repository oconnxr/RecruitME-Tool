# Weekly recruiting update (scheduled task prompt)

This is the instruction a weekly scheduled Claude task runs (Mondays, about
8 AM Central). Each run starts a fresh cloud session with this repository and the **Google Sheets**
connector. It needs no Anthropic API key, because Claude does the research
itself with web search.

Sheet: `MSC Baseball Recruiting Board`, spreadsheet ID
`1FbS-Dri_wIgh8EWOYyslqGF95pEiwhvm0g92jfAmMWQ`.

---

You are updating the MSC Baseball (NJCAA D2) recruiting board, a Google Sheet
with spreadsheet ID `1FbS-Dri_wIgh8EWOYyslqGF95pEiwhvm0g92jfAmMWQ`. The tool is this
repository, oconnxr/RecruitME-Tool (branch `main`); run every command from
its root. Work in a scratch directory outside
the repository for all player data, and never commit player data to git.

1. **Set up.** `npm ci` in the repository root.
2. **Load the Sheet.** Read the `Players` tab with the Google Sheets
   connector (`get_values` on `Players!A1:AZ`; use the first tab if there is
   no `Players` tab). Save the returned 2D array as `values.json` in the
   scratch directory, then run
   `node src/cli.js sheet-import --file <scratch>/values.json`.
   The Sheet is the source of truth. Staff edits made there must survive.
3. **Re-check commitments.** For up to 15 players whose Commitment is
   `uncommitted` or `unknown`, oldest "Commitment checked" date first, search
   for current status ("<name> commits", "<name> committed", their PBR or
   Perfect Game profile, their school's news). Write one full record per
   player (same fields as `src/schema.js`, carrying over their existing data)
   with the new `commitment` and a short `evidence` that says what you
   checked. Import them with `node src/cli.js add --file <scratch>/recheck.json`.
4. **Find new players.** Search for up to 10 new uncommitted high school
   players in Oklahoma, Texas, Arkansas and Kansas, current senior class
   first, then juniors, who aren't already on the board. Good JUCO D2 targets
   are players four-year programs overlooked. Rules:
   - Check each player's commitment status before adding them.
   - Record only numbers you saw in a source, with the source URL in
     `sources`. Use null for anything missing, and never estimate. When a
     source gives a sitting range (for example 84-88), you may record the
     midpoint as `fbVelo` and say so in `measuredAt`.
   - Record recruiting-relevant athletic information only: no addresses,
     phone numbers, emails or family details. These are minors.
   Import them with `node src/cli.js add --file <scratch>/new.json`. Fix and
   re-import anything it rejects.
5. **Write the Sheet back.** Run
   `node src/cli.js sheet-export --out <scratch>/players.json` and write that
   2D array to `Players!A1` with `update_values`. The table only grows, so
   every existing row is rewritten in place and new rows are added below.
   Write values only: the formatting, dropdowns, checkboxes and column groups
   already cover rows 2–1000. Leave the `Summary` tab alone (its formulas
   read `Players` live). If you refresh a position tab such as `2027 RHP`,
   write columns `A:AT` only; `AU:AV` hold formulas that look up Priority and
   Assigned coach from `Players`.
6. **Log the run.** Append one row to the `Updates` tab (create the tab with
   headers `Date, Type, Added, Updated, Status changes, Notes` if it is
   missing): today's date, `Weekly`, the counts printed by `add`, and a
   one-sentence note on what was searched and anything a coach should look at
   (for example, a player who just committed).
7. **Verify.** Read `Players` back with `get_values` and check that the row
   count equals the exported table and that no cell shows an error.

Finish with a short summary: players added, status changes, and the top five
uncommitted players by score (`node src/cli.js rank --top 5`).
