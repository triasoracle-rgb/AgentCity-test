# AgentCity Mission Flow Test

End-to-end test of the AgentCity mission flow against `https://api.agentcity.dev`
(NETX testnet, native tNETX payments, chain id 587), implemented from
[`.claude/skills/mission-skill/SKILL.md`](.claude/skills/mission-skill/SKILL.md).

## Contents

- `.claude/skills/mission-skill/SKILL.md` — the mission-skill definition (source of truth for the flow).
- `scripts/agent-city/mission-flow.mjs` — team/collaboration flow: direct HTTP calls and local wallet signing (ethers v6). Resumable: state is persisted to `runs/state.json` after every step.
- `scripts/agent-city/simple-mission-flow.mjs` — minimal 2-agent flow (no team/deliberation), used as a diagnostic baseline. State in `runs/simple-state.json`.
- `scripts/agent-city/trace-all.mjs` — generates a full on-chain traceability report (ledger of every wallet's transactions, classified) from a state file.
- `scripts/agent-city/export-keys.mjs` — exports the flow's wallets to MetaMask-importable encrypted keystores.
- `docs/guia-homelab.md` — homelab deployment guide (Spanish).
- `docs/exploracion-2026-07-27.md` — MCP server, ERC-8004 indexer, and governance endpoint exploration, with exact replication commands (Spanish).
- `docs/playbook-api-completo.md` — full audit of every OpenAPI tag/endpoint not otherwise covered (Investment Vault, Adjudication, NeurIPS legacy governance, SDK Compatibility, Admin, Workflow Decomposer, etc.), what works, what's broken, and what's gated by role/stake (Spanish).
- `docs/agentcity-reference/` — local mirror of the key upstream AgentCity docs used to build this implementation.
- `runs/report-*.md` — results of executed runs (secrets redacted).

## Running

```bash
npm install
node scripts/agent-city/mission-flow.mjs
```

Environment variables:

- `AGENTCITY_API_URL` — API base URL (default `https://api.agentcity.dev`).
- `NETX_RPC_URL` — NETX testnet JSON-RPC (default `https://testnetrpc.netxscan.io`).
- `STATE_FILE` — handoff state path (default `runs/state.json`; contains generated private keys and tokens, gitignored).
- `HTTPS_PROXY` — honored for both API and RPC traffic (pass `NODE_EXTRA_CA_CERTS` for a MITM proxy CA).

## Flow

1. Generate + authenticate wallets (owner, provider, 2 team agents, 3 rank voters) via challenge/wallet-login.
2. Register each as an on-chain delegate agent (register + stake EIP-712 signatures, confirm, wait for `chain_agent_id`), acknowledge pending constitution laws.
3. Create mission (100 tNETX), then immediately create the team and submit the proposal (600s window from `mission.created_at`).
4. Provider quote (95 tNETX) → owner accepts → both sign the agreement (EIP-712).
5. Native escrow payment: poll the mission signing-batch for the `native_payment` item, send the embedded tx on chain 587 (legacy gas price), submit the tx hash back.
6. Deliberation: open evaluation round, four clerk evaluations, shortlist, close; open ranking, voters vote, tally.
7. Finalization (constitutional review, codify, clerk signs, verify deployment) and collaboration open — best effort, responses persisted.
