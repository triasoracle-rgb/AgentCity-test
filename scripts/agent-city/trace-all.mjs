#!/usr/bin/env node
/**
 * Full on-chain traceability report for the AgentCity flow.
 *
 * Sources:
 *  - Blockscout explorer API (testnet.netxscan.io): complete tx history per
 *    wallet, plus AgentRegistry transactions to find the relayer-submitted
 *    registerFor() calls that carry our wallet addresses in calldata.
 *  - NETX RPC: balances and current block.
 *  - AgentCity API: staking totals and final mission/collaboration state.
 *
 * Output: a chronological, classified ledger of every transaction related to
 * the wallets in runs/state.json, with explorer links, plus a holistic map of
 * which flow phases leave an on-chain footprint. No private keys or tokens.
 *
 * Usage: node scripts/agent-city/trace-all.mjs [state.json] [out.md]
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
const outFile = process.argv[3] || path.join("runs", `trazabilidad-completa-${new Date().toISOString().slice(0, 10)}.md`);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

const CONTRACTS = Object.fromEntries(
  Object.entries(state.config?.addresses || {}).map(([k, v]) => [v.toLowerCase(), k]),
);
const SELECTORS = {
  "0x7b0472f0": "stake(agentId,amount)",
  "0x84d995ee": "registerFor(...)",
};

async function getJson(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
async function apiGet(p, token) {
  try {
    const r = await fetch(API + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  } catch (e) {
    return { status: 0, json: null };
  }
}

const ROLES = ["owner", "provider", "team0", "team1", "team2", "team3", "team4", "voter0", "voter1", "voter2"];
const wallets = ROLES.filter((r) => state[r]?.address).map((r) => ({ role: r, ...state[r] }));
const byAddr = Object.fromEntries(wallets.map((w) => [w.address.toLowerCase(), w.role]));

const fmt = (wei) => (Number(BigInt(wei || "0")) / 1e18).toFixed(6).replace(/\.?0+$/, "") || "0";
const ts = (unix) => new Date(Number(unix) * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";

function labelAddr(a) {
  if (!a) return "(creación de contrato)";
  const low = a.toLowerCase();
  if (byAddr[low]) return `wallet ${byAddr[low]}`;
  if (CONTRACTS[low]) return CONTRACTS[low];
  return null;
}

// 1. Per-wallet tx history (both directions) from Blockscout v1 API.
const ledger = new Map(); // hash -> tx record
for (const w of wallets) {
  const j = await getJson(`${EXPLORER}/api/?module=account&action=txlist&address=${w.address}`);
  for (const t of j.result || []) ledger.set(t.hash, t);
  console.error(`${w.role}: ${j.result?.length ?? 0} txs`);
}

// 2. Relayer registerFor() txs on the AgentRegistry that mention our wallets.
// AgentRegistry is a shared contract used by every mission on the platform,
// so pagination is unbounded in principle; keep going until every wallet's
// registration has been found (or a generous page cap is hit).
const agentRegistry = state.config?.addresses?.agentRegistry;
const ourHex = wallets.map((w) => w.address.slice(2).toLowerCase());
const registeredRoles = new Set();
let pageParams = "";
for (let page = 0; page < 80 && registeredRoles.size < wallets.length; page++) {
  const j = await getJson(`${EXPLORER}/api/v2/addresses/${agentRegistry}/transactions${pageParams}`);
  for (const t of j.items || []) {
    const input = (t.raw_input || "").toLowerCase();
    const matchedHex = ourHex.find((h) => input.includes(h));
    if (matchedHex) {
      const role = wallets.find((w) => w.address.slice(2).toLowerCase() === matchedHex)?.role;
      registeredRoles.add(role);
      ledger.set(t.hash, {
        hash: t.hash,
        blockNumber: String(t.block_number),
        timeStamp: String(Math.floor(new Date(t.timestamp).getTime() / 1000)),
        from: t.from?.hash || "",
        to: t.to?.hash || agentRegistry,
        value: t.value || "0",
        gasUsed: t.gas_used || "",
        isError: t.result === "success" ? "0" : "1",
        input: t.raw_input || "",
        _method: t.method || "",
        _relayed: true,
        _forRole: role,
      });
    }
  }
  if (!j.next_page_params) break;
  const p = j.next_page_params;
  pageParams = `?${Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
console.error(`registros de agentes encontrados: ${registeredRoles.size}/${wallets.length}`);

// 3. Relayer-submitted escrow payments (createMission) on the MissionFactory:
// the client wallet's address never appears in the calldata (it encodes
// on-chain agent ids, not wallet addresses). Small integer agent ids collide
// too often as a bare 32-byte-padded substring (other missions on the same
// shared contract reference unrelated small ids), so require BOTH the
// client's and the matched quote's provider chain_agent_id to appear
// together in the same calldata — that pair is specific to one agreement.
const missionFactory = state.config?.addresses?.missionFactory;
const agentIdHex = wallets
  .filter((w) => w.chainAgentId != null)
  .map((w) => ({ role: w.role, pad: w.chainAgentId.toString(16).padStart(64, "0") }));
const ownerPad = state.owner?.chainAgentId != null ? state.owner.chainAgentId.toString(16).padStart(64, "0") : null;
let escrowFound = false;
pageParams = "";
for (let page = 0; page < 80 && missionFactory && ownerPad && !escrowFound; page++) {
  const j = await getJson(`${EXPLORER}/api/v2/addresses/${missionFactory}/transactions${pageParams}`);
  for (const t of j.items || []) {
    const input = (t.raw_input || "").toLowerCase();
    if (!input.includes(ownerPad)) continue; // must involve our client agent id
    const providerHit = agentIdHex.find((a) => a.role !== "owner" && input.includes(a.pad));
    if (providerHit) {
      if (t.result === "success") escrowFound = true;
      ledger.set(t.hash, {
        hash: t.hash,
        blockNumber: String(t.block_number),
        timeStamp: String(Math.floor(new Date(t.timestamp).getTime() / 1000)),
        from: t.from?.hash || "",
        to: t.to?.hash || missionFactory,
        value: t.value || "0",
        gasUsed: t.gas_used || "",
        isError: t.result === "success" ? "0" : "1",
        input: t.raw_input || "",
        _method: t.method || "",
        _relayed: true,
        _forRole: providerHit.role,
        _escrow: true,
      });
    }
  }
  if (!j.next_page_params) break;
  const p = j.next_page_params;
  pageParams = `?${Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
console.error(`ledger: ${ledger.size} txs totales`);

// 3. Classify and sort.
function classify(t) {
  const from = (t.from || "").toLowerCase();
  const to = (t.to || "").toLowerCase();
  const sel = (t.input || "").slice(0, 10);
  if (t._escrow) {
    const ownWallet = byAddr[from];
    if (ownWallet) return `Intento de pago de escrow desde el cliente (${ownWallet}) — ${t.isError === "0" ? "ejecutado" : "revertido, ya cubierto por el relayer"}`;
    return `Pago de escrow de misión relayado por el backend`;
  }
  if (t._relayed || t._method === "registerFor") {
    const role = t._forRole ?? "?";
    return `Registro on-chain del agente (${role}) relayado por el backend`;
  }
  if (CONTRACTS[to] === "stakingRegistry" && sel === "0x7b0472f0") return `Stake de colateral (${byAddr[from] ?? from})`;
  if (CONTRACTS[to] === "missionFactory" && t.isError === "0") return `Pago de escrow de misión (${byAddr[from] ?? from})`;
  if (CONTRACTS[to] === "missionFactory" && t.isError !== "0") return `Intento de pago de escrow FALLIDO (${byAddr[from] ?? from}) — ya cubierto por el relayer`;
  if (byAddr[to] && !byAddr[from]) return `Fondeo del faucet → ${byAddr[to]}`;
  if (byAddr[from]) return `Salida de ${byAddr[from]}`;
  return "Otra";
}
const rows = [...ledger.values()]
  .map((t) => ({ ...t, purpose: classify(t) }))
  .sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp) || Number(a.blockNumber) - Number(b.blockNumber));

// 4. Balances + final API state.
const blockHex = await rpc("eth_blockNumber", []);
const balances = [];
for (const w of wallets) {
  const b = await rpc("eth_getBalance", [w.address, "latest"]);
  const stk = w.chainAgentId != null ? (await apiGet(`/api/staking/${w.chainAgentId}`, w.token)).json : null;
  balances.push({ role: w.role, address: w.address, chainAgentId: w.chainAgentId, balance: fmt(b), staked: stk?.total_staked ?? 0, locked: stk?.total_locked ?? 0 });
}
const missionId = state.mission?.id;
const owner = state.owner;
const mission = missionId ? (await apiGet(`/api/missions/${missionId}`, owner.token)).json : null;
const onchain = missionId ? await apiGet(`/api/missions/${missionId}/onchain`, owner.token) : null;
const collabId = state.collaboration?.id || state.collaboration?.contract_id;
const collab = collabId ? (await apiGet(`/api/collaboration/${collabId}/state`, owner.token)).json : null;
const proposals = missionId ? (await apiGet(`/api/teams/mission/${missionId}/proposals`, owner.token)).json : null;
const winning = Array.isArray(proposals) ? proposals.find((p) => p.id === (state.winningProposal?.id || state.proposal?.id)) : null;

const faucetSenders = [...new Set(rows.filter((r) => r.purpose.startsWith("Fondeo")).map((r) => r.from.toLowerCase()))];

const md = `# Trazabilidad on-chain completa del flujo AgentCity

Generado: ${new Date().toISOString()} · Bloque actual: ${Number(BigInt(blockHex))}
Red: NETX testnet (chain id 587) · RPC: ${RPC} · Explorador: ${EXPLORER}

## 1. El flujo AgentCity de forma holística

AgentCity divide el ciclo de vida de una misión en fases **off-chain** (API +
firmas EIP-712 de los agentes) y **on-chain** (transacciones en la testnet NETX).
La cadena solo se toca donde hay valor o identidad en juego:

| Fase | Dónde ocurre | Huella on-chain |
|---|---|---|
| 1. Autenticación de wallets (challenge → firma → login) | API | ninguna (firma personal_sign verificada off-chain) |
| 2. Registro de delegate agents | API + cadena | tx \`registerFor()\` en AgentRegistry enviada por el **relayer** del backend (\`${rows.find((r) => r._relayed)?.from ?? "0x…"}\`) con la firma EIP-712 \`RegisterAgent\` del agente; la wallet no gasta gas |
| 3. Constitución (acknowledge de leyes) | API | ninguna (firmas EIP-712 archivadas off-chain) |
| 4. Misión + equipo + propuesta | API | ninguna |
| 5. Deliberación (evaluaciones, shortlist, ranking, tally) | API | ninguna (la gobernanza es off-chain; ancla evidencia opcionalmente vía EvidenceAnchor) |
| 6. Stake del líder ganador (20 % del quote) | cadena | tx \`stake(agentId, amount)\` al StakingRegistry **enviada por la propia wallet** con valor nativo |
| 7. Agreement (owner + líder) | API | firmas EIP-712 sobre el payload construido por el chain-service |
| 8. Pago del escrow | cadena | \`createMission()\` al MissionFactory (valor = quote + fee). El endpoint \`signing-batch\` documenta que el *cliente* firma y envía esta tx, pero en la práctica observada el **relayer del backend** la ejecutó automáticamente en cuanto detectó ambas firmas del agreement, sin esperar la tx manual del cliente; una tx manual enviada en paralelo revierte (el contrato ya ha sido creado) |
| 9. Codificación, firmas de clerks, colaboración | API | dag_hash calculado; despliegue verificado |
| 10. Fondeo | cadena | txs del relayer del faucet (${faucetSenders.map((f) => `\`${f}\``).join(", ") || "n/a"}) de 0.1 tNETX |

Dos patrones de custodia conviven: las wallets de los agentes firman mensajes
(EIP-712) que el backend releya a la cadena pagando el gas (registro), y firman
transacciones propias cuando mueven su valor (stake, escrow). Por eso la mayoría
de wallets tienen nonce 0 aunque su identidad esté on-chain.

## 2. Libro mayor: todas las transacciones (orden cronológico)

| # | Fecha (UTC) | Bloque | Tx | Propósito | De → A | Valor (tNETX) | Estado |
|---|---|---|---|---|---|---|---|
${rows.map((r, i) => {
  const from = labelAddr(r.from) || `\`${r.from.slice(0, 10)}…\``;
  const to = labelAddr(r.to) || `\`${(r.to || "").slice(0, 10)}…\``;
  return `| ${i + 1} | ${ts(r.timeStamp)} | ${r.blockNumber} | [\`${r.hash.slice(0, 14)}…\`](${EXPLORER}/tx/${r.hash}) | ${r.purpose} | ${from} → ${to} | ${fmt(r.value)} | ${r.isError === "0" ? "✔" : "✖"} |`;
}).join("\n")}

Total: ${rows.length} transacciones relacionadas con las wallets del flujo.

## 3. Estado final por wallet

| Rol | Dirección | Agent | Balance | Stake total | Stake bloqueado |
|---|---|---|---|---|---|
${balances.map((b) => `| ${b.role} | [\`${b.address}\`](${EXPLORER}/address/${b.address}) | ${b.chainAgentId ?? "-"} | ${b.balance} | ${b.staked} | ${b.locked} |`).join("\n")}

## 4. Estado final de la misión (API)

- Misión: \`${missionId ?? "-"}\` — estado \`${mission?.status ?? mission?.mission?.status ?? "?"}\`
- Propuesta ganadora: \`${state.winningProposal?.id ?? "-"}\` (estado \`${winning?.status ?? state.winningProposal?.status ?? "?"}\`)
- Colaboración: \`${collabId ?? "-"}\`${collab ? ` — dag_hash \`${collab.dag_hash}\`, nodos: ${collab.nodes?.map((n) => `${n.node_id}=${n.status}`).join(", ")}` : ""}
- Despliegue on-chain de la misión: ${onchain?.status === 200 ? `**desplegada** — contrato [\`${onchain.json.mission_address}\`](${EXPLORER}/address/${onchain.json.mission_address}), estado \`${onchain.json.contract_status_label}\`, tx [\`${onchain.json.transaction_hash}\`](${EXPLORER}/tx/${onchain.json.transaction_hash}), bloque ${onchain.json.block_number}` : `pendiente (\`${onchain?.json?.detail ?? onchain?.json?.error?.message ?? "?"}\`) — bloqueado por la caída del chain-service que construye el agreement`}
- Pago de escrow: ${onchain?.status === 200 ? `ejecutado por el **relayer del backend** (no por el cliente) al detectar ambas firmas — ver tx [\`${onchain.json.transaction_hash.slice(0, 18)}…\`](${EXPLORER}/tx/${onchain.json.transaction_hash}) en la sección 2` : state.nativePaymentTxHash ? `[\`${state.nativePaymentTxHash}\`](${EXPLORER}/tx/${state.nativePaymentTxHash})` : "no ejecutado aún (requiere el agreement firmado)"}

## 5. Contratos de la plataforma

| Contrato | Dirección |
|---|---|
${Object.entries(state.config?.addresses || {}).map(([k, v]) => `| ${k} | [\`${v}\`](${EXPLORER}/address/${v}) |`).join("\n")}
`;

fs.writeFileSync(outFile, md);
console.log(`wrote ${outFile}`);
