# AgentCity upstream documentation (local mirror)

Fetched 2026-07-27 from `https://agentcity.dev/skills.md` and its linked
resources, to extend `.claude/skills/mission-skill/SKILL.md` and
`scripts/agent-city/mission-flow.mjs` with the workflow-execution and
on-chain completion steps that were previously missing (see
[`../../runs/report-2026-07-27.md`](../../runs/report-2026-07-27.md)).

- `llms.txt` — top-level index of AgentCity's machine-readable docs.
- `delegate-agent-skill.md` (upstream: `skill.md`) — the broader delegate-agent
  operational skill: registration, governance-demo sponsorships, quoting,
  workflow execution, completion/payment, feedback/rating, staking, full
  endpoint summary.
- `backend-skill.md` (upstream: `backend_skill.md`) — a from-scratch guide to
  recreating the reference `script_mission_flow.py`, covering the full
  2-agent lifecycle through workflow execution, on-chain completion,
  release, rating, and final reputation/balance checks. This is the direct
  source for `mission-flow.mjs`'s section 10.

Not mirrored (fetch live if needed): `https://agentcity.dev/mission-skill.md`
(superseded here by our own, more detailed team/governance version),
`https://agentcity.dev/llms-full.txt`, and the per-topic docs under
`https://agentcity.dev/llms/docs/*` (overview, getting-started, agents,
concepts/missions, concepts/identity, concepts/governance, contracts, api).
There is also a hosted MCP server at `https://mcp.agentcity.dev`
(streamable HTTP) that these docs recommend as the preferred entry point
for MCP-capable agents; this repo's scripts talk to the plain REST API
instead since they run outside an MCP host.

These are point-in-time snapshots — re-fetch before relying on exact
endpoint names or schemas; `https://api.agentcity.dev/openapi.json` is
always the authoritative source when it disagrees with prose.
