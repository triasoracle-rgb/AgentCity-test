#!/usr/bin/env node
/**
 * Generate an on-chain traceability report for the wallets in runs/state.json:
 * native balance and tx count from the NETX RPC, delegate-agent registration
 * status (tx hash, block) and staking totals from the AgentCity API, plus
 * explorer links. Never prints private keys or tokens.
 *
 * Usage: node scripts/agent-city/onchain-trace.mjs [state.json] [out.md]
 */

import fs from "node:fs";
import path from "node:path";
import { setGlobalDispatcher, ProxyAgent } from "undici";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
if (PROXY_URL) setGlobalDispatcher(new ProxyAgent(PROXY_URL));

const API = process.env.AGENTCITY_API_URL || "https://api.agentcity.dev";
const RPC = process.env.NETX_RPC_URL || "https://testnetrpc.netxscan.io";
const EXPLORER = "https://testnet.netxscan.io";

const stateFile = process.argv[2] || path.join("runs", "state.json");
const outFile = process.argv[3] || path.join("runs", `trazabilidad-onchain-${new Date().toISOString().slice(0, 10)}.md`);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function api(p, token) {
  try {
    const r = await fetch(API + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  } catch (e) {
    return { status: 0, json: { error: e.message } };
  }
}

const fmtEth = (weiHex) => (Number(BigInt(weiHex)) / 1e18).toFixed(6);

const ROLES = ["owner", "provider", "team0", "team1", "team2", "team3", "team4", "voter0", "voter1", "voter2"];

// Stake txs sent locally by this client (recorded during the documented runs).
const KNOWN_TXS = [
  { label: "Stake 0.019 tNETX (agent 70, provider)", hash: "0x4d708187417bac5ec496f60af787a57c68cf204041f444cda843efcffabda77d" },
  { label: "Stake 0.019 tNETX (agent 71, team0/líder)", hash: "0xfcc731f4f1b9b8a5860c07f9fd98d8c4b6c32233628665da7d6c873d89483e63" },
];

const chainIdHex = await rpc("eth_chainId", []);
const blockHex = await rpc("eth_blockNumber", []);

const rows = [];
for (const role of ROLES) {
  const rec = state[role];
  if (!rec?.address) continue;
  const [balHex, nonceHex] = await Promise.all([
    rpc("eth_getBalance", [rec.address, "latest"]),
    rpc("eth_getTransactionCount", [rec.address, "latest"]),
  ]);
  const regStatus = rec.agentId ? await api(`/api/delegate-agents/${rec.agentId}/registration-status`, rec.token) : { json: null };
  const staking = rec.chainAgentId != null ? await api(`/api/staking/${rec.chainAgentId}`, rec.token) : { json: null };
  rows.push({
    role,
    address: rec.address,
    chainAgentId: rec.chainAgentId,
    balance: fmtEth(balHex),
    txCount: Number(BigInt(nonceHex)),
    reg: regStatus.json,
    staking: staking.json,
  });
  console.log(`${role}: balance=${fmtEth(balHex)} txs=${Number(BigInt(nonceHex))} regTx=${regStatus.json?.txHash ?? "-"}`);
}

const txDetails = [];
for (const t of KNOWN_TXS) {
  try {
    const rcpt = await rpc("eth_getTransactionReceipt", [t.hash]);
    txDetails.push({ ...t, block: rcpt ? Number(BigInt(rcpt.blockNumber)) : null, status: rcpt ? (rcpt.status === "0x1" ? "success" : "revert") : "pending", to: rcpt?.to });
  } catch {
    txDetails.push({ ...t, block: null, status: "unknown", to: null });
  }
}

const cfg = state.config?.addresses || {};

const md = `# Trazabilidad on-chain de las wallets (testnet NETX)

Generado: ${new Date().toISOString()}
Red: chain id ${Number(BigInt(chainIdHex))} (${state.config?.chainProfile ?? "netx-testnet"}) · Bloque actual: ${Number(BigInt(blockHex))}
RPC: ${RPC} · Explorador: ${EXPLORER}

Las claves privadas de estas wallets están persistidas en \`runs/state.json\`
(fuera de git) para su exportación posterior; este documento solo contiene datos
públicos on-chain.

## Wallets

| Rol | Dirección | Agent on-chain | Balance (tNETX) | Txs enviadas | Registro on-chain | Stake total |
|---|---|---|---|---|---|---|
${rows.map((r) => {
  const reg = r.reg ? `${r.reg.status ?? "?"}${r.reg.txHash ? ` ([tx](${EXPLORER}/tx/${r.reg.txHash}))` : ""}` : "-";
  const stk = r.staking?.total_staked != null ? `${r.staking.total_staked} tNETX` : "-";
  return `| ${r.role} | [\`${r.address}\`](${EXPLORER}/address/${r.address}) | ${r.chainAgentId ?? "-"} | ${r.balance} | ${r.txCount} | ${reg} | ${stk} |`;
}).join("\n")}

Las wallets sin txs enviadas (nonce 0) operan por firmas relayadas: el registro
on-chain lo ejecuta el relayer del backend con la firma EIP-712 del agente, por lo
que su actividad aparece en el contrato AgentRegistry y no como txs salientes de
la wallet.

## Registro de delegate agents

${rows.map((r) => {
  const g = r.reg || {};
  return `- **${r.role}** (agent ${r.chainAgentId ?? "?"}): estado \`${g.status ?? "?"}\`, verificado: ${g.isVerified ?? "?"}${g.txHash ? `, tx de registro [\`${g.txHash}\`](${EXPLORER}/tx/${g.txHash})` : ""}${g.blockNumber ? `, bloque ${g.blockNumber}` : ""}${g.finality ? `, finalidad ${g.finality}` : ""}`;
}).join("\n")}

## Transacciones enviadas desde este cliente

| Tx | Propósito | Bloque | Estado | Destino |
|---|---|---|---|---|
${txDetails.map((t) => `| [\`${t.hash.slice(0, 18)}…\`](${EXPLORER}/tx/${t.hash}) | ${t.label} | ${t.block ?? "-"} | ${t.status} | ${t.to ? `\`${t.to}\`` : "-"} |`).join("\n")}

Además, cada llamada a \`/api/faucet/native\` generó una tx de fondeo (0.1 tNETX)
desde la wallet del relayer del faucet hacia las wallets de la tabla; se pueden ver
en el historial de cada dirección en el explorador.

## Contratos de la plataforma (chain 587)

| Contrato | Dirección |
|---|---|
| AgentRegistry | \`${cfg.agentRegistry ?? "-"}\` |
| StakingRegistry | \`${cfg.stakingRegistry ?? "-"}\` |
| MissionFactory | \`${cfg.missionFactory ?? "-"}\` |
| ReputationRegistry | \`${cfg.reputationRegistry ?? "-"}\` |
| GovernanceRegistry | \`${cfg.governanceRegistry ?? "-"}\` |
| SanctionRegistry | \`${cfg.sanctionRegistry ?? "-"}\` |
| EvidenceAnchor | \`${cfg.evidenceAnchor ?? "-"}\` |
| USDC (mock) | \`${cfg.usdc ?? "-"}\` |
`;

fs.writeFileSync(outFile, md);
console.log(`wrote ${outFile}`);
