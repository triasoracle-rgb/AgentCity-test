#!/usr/bin/env node
// Render runs/state.json into a redacted markdown run report.
// Private keys and bearer tokens are never written to the report.

import fs from "node:fs";
import path from "node:path";

const stateFile = process.argv[2] || path.join("runs", "state.json");
const outFile = process.argv[3] || path.join("runs", `report-${new Date().toISOString().slice(0, 10)}.md`);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

function agentRow(role) {
  const r = state[role];
  if (!r) return null;
  return `| ${role} | \`${r.address}\` | \`${r.agentId ?? "-"}\` | ${r.chainAgentId ?? "-"} |`;
}

const roles = ["owner", "provider", ...(state.teamAgents || []), ...(state.voters || [])];
const steps = Object.entries(state.steps || {}).map(([name, s]) => {
  const detail = s.ok ? JSON.stringify(s.body ?? "").slice(0, 300) : (s.error || "").slice(0, 300);
  return `| ${name} | ${s.ok ? "ok" : "FAILED"} | ${s.status ?? "-"} | ${detail.replaceAll("|", "\\|")} |`;
});

const md = `# AgentCity Mission Flow Run Report

Generated: ${new Date().toISOString()}
API: ${state.apiUrl} · RPC: ${state.rpcUrl} · Chain: ${state.config?.chainId} (${state.config?.chainProfile}, ${state.config?.paymentMode})

## Summary

\`\`\`json
${JSON.stringify(state.summary ?? {}, null, 2)}
\`\`\`

## Participants

| role | wallet | agent id | chain agent id |
|---|---|---|---|
${roles.map(agentRow).filter(Boolean).join("\n")}

## Key objects

- Mission: \`${state.mission?.id ?? "-"}\` — "${state.mission?.title ?? ""}"
- Quote: \`${state.quote?.id ?? "-"}\` (suggested ${state.quote?.suggested_price ?? "?"} ${state.quote?.currency ?? ""})
- Team: \`${state.team?.id ?? "-"}\`
- Proposal: \`${state.winningProposal?.id ?? state.proposal?.id ?? "-"}\` (status: ${state.winningProposal?.status ?? state.proposal?.status ?? "?"})
- Native payment tx: \`${state.nativePaymentTxHash ?? "-"}\`
- Collaboration: \`${state.collaboration?.id ?? state.collaboration?.contract_id ?? "-"}\`

## Step results

| step | outcome | http | detail |
|---|---|---|---|
${steps.join("\n")}
`;

fs.writeFileSync(outFile, md);
console.log(`wrote ${outFile}`);
