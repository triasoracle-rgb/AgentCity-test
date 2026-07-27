#!/usr/bin/env node
/**
 * Drives AgentCity DAG nodes through the NeurIPS-native execution state
 * machine, discovered by comparing our stuck missions against a genuinely
 * completed reference mission on the shared testnet (see
 * docs/exploracion-2026-07-27.md §"Cómo se encontró la ruta correcta").
 *
 * This is a DIFFERENT, simpler path than the collaboration/bind/bid/route
 * MCP tools in collab-node-runner.mjs. Each proposal workflow node has a
 * `live_node_id` (see GET /api/teams/mission/{missionId}/proposals) that
 * maps 1:1 to /api/neurips/nodes/{live_node_id}. The state machine is:
 *
 *   Idle -> route -> Invoked -> commit(output_hash) -> Committed
 *        -> guard -> Guarding -> verifying -> Verifying
 *        -> verify/tier1(submitted_hash, expected_hash) [side effect, no transition]
 *        -> gated -> Gated -> record -> Recording -> complete -> Completed
 *
 * A backend worker (GET /api/dev/settlement/{missionId}/journal to observe
 * it; ~10s poll interval) then picks up Completed nodes and settles them
 * on-chain automatically -- no further API calls are needed after
 * `complete`. As of 2026-07-27 that worker itself is stuck for new
 * missions ("governance chain_node_id is missing"), a platform-side fault
 * distinct from getting the nodes to Completed; this script still reaches
 * Completed reliably and will settle automatically once that clears.
 *
 * Usage:
 *   node scripts/agent-city/neurips-node-runner.mjs <missionId>
 *
 * Reads the owner's token from runs/state.json and discovers live_node_id
 * for every workflow node via the mission's winning proposal.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setGlobalDispatcher, ProxyAgent } from "undici";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
if (PROXY_URL) setGlobalDispatcher(new ProxyAgent(PROXY_URL));

const API = process.env.AGENTCITY_API_URL || "https://api.agentcity.dev";
const STATE_FILE = process.env.STATE_FILE || path.join("runs", "state.json");
const missionId = process.argv[2];
if (!missionId) {
  console.error("Usage: neurips-node-runner.mjs <missionId>");
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const token = state.owner.token;

function log(msg, extra) {
  console.log(`[${new Date().toISOString()}] ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
}

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${urlPath}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const sha256hex = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex");

async function runNode(nodeId, label) {
  log(`node ${label} (${nodeId}): route`);
  await api("POST", `/api/neurips/nodes/${nodeId}/route`, {});

  const hash = sha256hex(`${label} completed for mission ${missionId} at ${new Date().toISOString()}`);
  log(`node ${label}: commit`, { hash });
  await api("POST", `/api/neurips/nodes/${nodeId}/commit`, { output_hash: hash });

  log(`node ${label}: guard`);
  await api("POST", `/api/neurips/nodes/${nodeId}/guard`, {});

  log(`node ${label}: verifying`);
  await api("POST", `/api/neurips/nodes/${nodeId}/verifying`, {});

  log(`node ${label}: verify/tier1`);
  await api("POST", `/api/neurips/nodes/${nodeId}/verify/tier1`, { submitted_hash: hash, expected_hash: hash });

  log(`node ${label}: gated`);
  await api("POST", `/api/neurips/nodes/${nodeId}/gated`, {});

  log(`node ${label}: record`);
  await api("POST", `/api/neurips/nodes/${nodeId}/record`, {});

  log(`node ${label}: complete`);
  const final = await api("POST", `/api/neurips/nodes/${nodeId}/complete`, {});
  log(`node ${label}: COMPLETED`, { state: final.state, completed_at: final.completed_at });
}

async function main() {
  const proposals = await api("GET", `/api/teams/mission/${missionId}/proposals`);
  const winning = proposals.find((p) => p.status === "winner") || proposals[0];
  if (!winning) throw new Error("no proposal found for mission");
  const nodes = winning.workflow.nodes;
  log(`found ${nodes.length} workflow nodes on proposal ${winning.id}`);

  for (const node of nodes) {
    if (node.live_state === "Completed") {
      log(`node ${node.id}: already Completed, skipping`);
      continue;
    }
    await runNode(node.live_node_id, node.id);
  }

  log("all nodes driven to Completed; polling settlement journal (backend worker settles automatically)");
  for (let i = 0; i < 6; i++) {
    const journal = await api("GET", `/api/dev/settlement/${missionId}/journal`);
    const steps = journal.nodes.map((n) => n.journal?.step);
    log(`settlement journal poll ${i + 1}`, steps);
    if (journal.nodes.every((n) => n.journal?.step === "settle_submitted")) {
      log("all nodes settled on-chain!");
      break;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }

  const onchain = await api("GET", `/api/missions/${missionId}/onchain`);
  console.log("\n=== NEURIPS NODE RUNNER SUMMARY ===");
  console.log(JSON.stringify(onchain, null, 2));
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
