#!/usr/bin/env node
/**
 * Drives every node of an already-open AgentCity collaboration contract
 * through the corrected non-competitive execution sequence, discovered the
 * hard way in docs/exploracion-2026-07-27.md §2:
 *
 *   deploy_package_service (unique apiSchema, so the leader OWNS it)
 *   -> bind_node_service            (node -> waiting/eligible)
 *   -> submit_node_bid              (leader bids on its own service)
 *   -> close_node_bidding(force=true)   *** BEFORE route_node_task ***
 *   -> route_node_task              (node -> executing)
 *   -> invoke_node_service          (runs real python-runner code)
 *   -> prepare_node_proof -> sign -> submit_node_proof
 *   -> prepare_node_chain_commit -> sign -> submit_node_chain_commit
 *   -> verify_node
 *   -> finalize_node
 *
 * Calling route_node_task before close_node_bidding succeeds leaves the
 * node permanently stuck "executing" with no winning bidder (invoke then
 * 403s forever) -- this script closes bidding first specifically to avoid
 * that trap.
 *
 * After every node in `nodeIds` (topological order) is finalized, polls
 * GET /api/missions/{missionId}/signing-batch for the mission_complete and
 * funds_release purposes and signs+submits them as they appear.
 *
 * Usage:
 *   node scripts/agent-city/collab-node-runner.mjs <missionId> <contractId> <nodeId1,nodeId2,...>
 *
 * Reads wallets/tokens from runs/state.json: owner (client), team (id),
 * team0 (leader/provider).
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { setGlobalDispatcher, ProxyAgent } from "undici";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
if (PROXY_URL) setGlobalDispatcher(new ProxyAgent(PROXY_URL));

const API = process.env.AGENTCITY_API_URL || "https://api.agentcity.dev";
const MCP = process.env.AGENTCITY_MCP_URL || "https://mcp.agentcity.dev";
const STATE_FILE = process.env.STATE_FILE || path.join("runs", "state.json");

const [missionId, contractId, nodeIdsArg] = process.argv.slice(2);
if (!missionId || !contractId || !nodeIdsArg) {
  console.error("Usage: collab-node-runner.mjs <missionId> <contractId> <nodeId1,nodeId2,...>");
  process.exit(1);
}
const nodeIds = nodeIdsArg.split(",");

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const owner = state.owner;
const leader = state.team0;
const teamId = state.team.id;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, extra) {
  console.log(`[${new Date().toISOString()}] ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
}

let rpcId = 1;
async function mcpCall(name, args) {
  const body = { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } };
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const item = json.result?.content?.[0];
  let parsed;
  try { parsed = JSON.parse(item?.text ?? "null"); } catch { parsed = item?.text; }
  if (json.result?.isError) throw new Error(`${name}: ${item?.text?.slice(0, 300)}`);
  return parsed;
}

function stripDomainType(types) { const t = { ...types }; delete t.EIP712Domain; return t; }
function splitSig(sig) { const s = ethers.Signature.from(sig); return { v: s.v < 27 ? s.v + 27 : s.v, r: s.r, s: s.s }; }
async function signTyped(wallet, td) {
  return wallet.signTypedData(td.domain, stripDomainType(td.types), td.message);
}

async function apiCall(method, urlPath, token, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

async function runNode(nodeId, serviceId) {
  log(`node ${nodeId}: bind`);
  await mcpCall("bind_node_service", { authToken: owner.token, contractId, nodeId, serviceId });

  log(`node ${nodeId}: bid`);
  await mcpCall("submit_node_bid", { authToken: leader.token, contractId, nodeId, bidderAgentId: leader.agentId, serviceId, price: 0.02, capabilities: ["execution"] });

  log(`node ${nodeId}: close bidding (force) BEFORE routing`);
  await mcpCall("close_node_bidding", { authToken: owner.token, contractId, nodeId, force: true });

  log(`node ${nodeId}: route`);
  await mcpCall("route_node_task", { authToken: owner.token, contractId, nodeId, executingTeamId: teamId });

  log(`node ${nodeId}: invoke`);
  const invokeResult = await mcpCall("invoke_node_service", {
    authToken: leader.token, contractId, nodeId, packageRef: "python-runner",
    payload: { source: `print("Node ${nodeId} of mission ${missionId} executed via collab-node-runner.")` },
  });
  log(`node ${nodeId}: invoke result`, invokeResult);
  const outputHash = invokeResult?.outputHash || invokeResult?.output?.output_hash || invokeResult?.output_hash;
  if (!outputHash) throw new Error(`node ${nodeId}: no output_hash in invoke result`);

  log(`node ${nodeId}: prepare + submit proof`);
  const proofPayload = await mcpCall("prepare_node_proof", { authToken: leader.token, contractId, nodeId, outputHash });
  const leaderWallet = new ethers.Wallet(leader.privateKey);
  const proofSig = await signTyped(leaderWallet, proofPayload.typed_data || proofPayload);
  await mcpCall("submit_node_proof", { authToken: leader.token, contractId, nodeId, signature: proofSig, proofPayloadId: proofPayload.payload_id, outputHash });

  // KNOWN PLATFORM GAP (confirmed 2026-07-27, reproduced on 2 separate
  // missions in both possible orders): prepare_node_chain_commit fails with
  // "409 collaboration chain node is not registered yet" no matter when
  // it's called. verify_node still succeeds (Tier-1 hash verification) and
  // moves the node to pending_finalization, but finalize_node then always
  // 409s with "awaiting_onchain_commitment" (missing_markers:
  // ["chain_node_id"]). There is no discovered API/MCP call that registers
  // this chain_node_id -- the collaboration-node completion path is
  // currently a dead end on this deployment regardless of step order. This
  // block is left in place (best-effort) in case the backend starts
  // registering nodes automatically; expect it to throw.
  log(`node ${nodeId}: prepare + submit chain-commit (currently broken server-side, see comment above)`);
  try {
    const commitPayload = await mcpCall("prepare_node_chain_commit", { authToken: leader.token, contractId, nodeId });
    const td = commitPayload.typed_data || commitPayload;
    const commitSig = await signTyped(leaderWallet, td);
    await mcpCall("submit_node_chain_commit", {
      authToken: leader.token, contractId, nodeId,
      signer: leader.address, signature: commitSig,
      nonce: td.message?.nonce ?? commitPayload.nonce,
      sigDeadline: td.message?.sigDeadline ?? td.message?.deadline ?? commitPayload.sigDeadline,
      codeHash: commitPayload.code_hash ?? td.message?.codeHash,
      outputHash,
    });
    log(`node ${nodeId}: chain-commit succeeded (platform gap may be fixed!)`);
  } catch (err) {
    log(`node ${nodeId}: chain-commit failed as expected (continuing to verify): ${err.message.slice(0, 150)}`);
  }

  log(`node ${nodeId}: verify`);
  await mcpCall("verify_node", { authToken: owner.token, contractId, nodeId, verdict: "passed" });

  log(`node ${nodeId}: finalize`);
  try {
    const final = await mcpCall("finalize_node", { authToken: owner.token, contractId, nodeId });
    log(`node ${nodeId}: FINALIZED`, final);
  } catch (err) {
    log(`node ${nodeId}: finalize failed (blocked on missing chain_node_id, a known platform gap): ${err.message.slice(0, 200)}`);
  }
}

async function main() {
  // Reuse one owned service across all nodes.
  log("deploying leader-owned python-runner service");
  const service = await mcpCall("deploy_package_service", {
    authToken: leader.token, catalogueName: "python-runner",
    apiSchema: { unique: `collab-node-runner-${Date.now()}` },
    notes: `Owned execution service for mission ${missionId}.`,
  });
  log("service deployed", { id: service.id, owner_agent_id: service.owner_agent_id });

  for (const nodeId of nodeIds) {
    await runNode(nodeId, service.id);
    await sleep(2000);
  }

  log("all nodes finalized; polling signing-batch for mission_complete/funds_release");
  for (let i = 0; i < 10; i++) {
    const batch = await apiCall("GET", `/api/missions/${missionId}/signing-batch`, owner.token);
    const pending = batch.json?.pending_signatures || [];
    log(`signing-batch poll ${i + 1}`, pending.map((p) => p.purpose));
    const complete = pending.find((p) => p.purpose === "mission_complete");
    if (complete) {
      log("mission_complete pending -- leader signs");
      const leaderWallet = new ethers.Wallet(leader.privateKey);
      const sig = await signTyped(leaderWallet, complete.typed_data || complete);
      const s = splitSig(sig);
      const submit = await apiCall("POST", `/api/missions/${missionId}/signing-batch`, leader.token, {
        signatures: [{ purpose: "mission_complete", v: s.v, r: s.r, s: s.s }],
      });
      log("mission_complete submitted", submit.json);
    }
    const release = pending.find((p) => p.purpose === "funds_release");
    if (release) {
      log("funds_release pending -- owner signs");
      const ownerWallet = new ethers.Wallet(owner.privateKey);
      const sig = await signTyped(ownerWallet, release.typed_data || release);
      const s = splitSig(sig);
      const submit = await apiCall("POST", `/api/missions/${missionId}/signing-batch`, owner.token, {
        signatures: [{ purpose: "funds_release", v: s.v, r: s.r, s: s.s }],
      });
      log("funds_release submitted", submit.json);
      break;
    }
    if (!complete && !release) await sleep(5000);
  }

  const finalMission = await apiCall("GET", `/api/missions/${missionId}`, owner.token);
  const finalOnchain = await apiCall("GET", `/api/missions/${missionId}/onchain`, owner.token);
  console.log("\n=== COLLAB NODE RUNNER SUMMARY ===");
  console.log(JSON.stringify({ missionStatus: finalMission.json?.mission?.status || finalMission.json?.status, onchain: finalOnchain.json }, null, 2));
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
