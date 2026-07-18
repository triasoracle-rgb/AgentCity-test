#!/usr/bin/env node
/**
 * AgentCity end-to-end mission flow (native tNETX profile, chain 587).
 *
 * Implements .claude/skills/mission-skill/SKILL.md with direct HTTP requests
 * and local wallet signing:
 *   wallet auth -> delegate agent registration -> constitution acks ->
 *   mission -> team proposal -> quote -> accept -> agreement signatures ->
 *   native escrow payment via signing-batch -> deliberation (evaluate/rank) ->
 *   finalization -> collaboration open.
 *
 * State is persisted to runs/state.json after every step so the flow can be
 * resumed. The proposal submission window is 600s from mission.created_at, so
 * the team proposal is submitted immediately after mission creation.
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { setGlobalDispatcher, ProxyAgent } from "undici";

// Route both global fetch and ethers through the outbound HTTPS proxy when one
// is configured (required in sandboxed environments; harmless otherwise).
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  ethers.FetchRequest.registerGetUrl(async (req) => {
    // undici's fetch rejects forbidden headers that ethers sets itself.
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) {
      if (["content-length", "host", "connection"].includes(k.toLowerCase())) delete headers[k];
    }
    const resp = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body ?? undefined,
    });
    const respHeaders = {};
    resp.headers.forEach((v, k) => (respHeaders[k] = v));
    return {
      statusCode: resp.status,
      statusMessage: resp.statusText,
      headers: respHeaders,
      body: new Uint8Array(await resp.arrayBuffer()),
    };
  });
}

const API = process.env.AGENTCITY_API_URL || "https://api.agentcity.dev";
const RPC = process.env.NETX_RPC_URL || "https://testnetrpc.netxscan.io";
const CHAIN_ID = 587;
const STATE_FILE = process.env.STATE_FILE || path.join("runs", "state.json");
const RUN_TAG = Date.now();

// Prices are in whole tNETX (1:1 with 1e18 wei on-chain): keep them faucet-sized.
const MISSION_PRICE = 0.1;
const QUOTE_PRICE = 0.095;

const provider587 = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

// ---------------------------------------------------------------- state

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : { apiUrl: API, rpcUrl: RPC, steps: {}, log: [] };

function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg, extra) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  state.log.push(extra !== undefined ? { line, extra } : { line });
  save();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- http

async function http(method, urlPath, { token, body, rawBody, headers = {}, retries = 4, timeoutMs = 120000, allowStatus = [] } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : API + urlPath;
  const hdrs = { ...headers };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    hdrs["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    hdrs["Content-Type"] = "application/json";
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: hdrs, body: payload, signal: ctl.signal });
      clearTimeout(timer);
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
      if (res.ok || allowStatus.includes(res.status)) return { status: res.status, json };
      if ([502, 503, 504].includes(res.status)) {
        lastErr = new Error(`HTTP ${res.status} ${method} ${urlPath}: ${text.slice(0, 300)}`);
        continue;
      }
      throw new Error(`HTTP ${res.status} ${method} ${urlPath}: ${text.slice(0, 600)}`);
    } catch (err) {
      clearTimeout(timer);
      if (err.message?.startsWith("HTTP ")) throw err;
      lastErr = err; // network / abort -> retry
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- signing helpers

function stripDomainType(types) {
  const t = { ...types };
  delete t.EIP712Domain;
  return t;
}

async function signTypedFlexible(wallet, payload) {
  // Accepts { domain, types, message } possibly nested under typed_data /
  // signing_payload / payload, or with snake_case primary_type.
  let td = payload;
  for (const key of ["typed_data", "typedData", "signing_payload", "payload"]) {
    if (td && !td.domain && td[key]) td = td[key];
  }
  if (!td?.domain || !td?.types || !td?.message) {
    throw new Error(`No typed data found in payload: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return wallet.signTypedData(td.domain, stripDomainType(td.types), td.message);
}

function splitSig(sig) {
  const s = ethers.Signature.from(sig);
  return { v: s.v < 27 ? s.v + 27 : s.v, r: s.r, s: s.s };
}

// ---------------------------------------------------------------- funding

// The native faucet dispenses at most 0.1 tNETX per call but allows repeats.
async function fundNative(address, targetWei, label = "wallet") {
  const DRIP = 100000000000000000n; // 0.1 tNETX
  for (let i = 0; i < 12; i++) {
    const bal = await provider587.getBalance(address);
    if (bal >= targetWei) {
      log(`${label}: native balance ${ethers.formatEther(bal)} tNETX (target ${ethers.formatEther(targetWei)})`);
      return bal;
    }
    await http("POST", "/api/faucet/native", { rawBody: `{"to":"${address}","amount":${DRIP.toString()}}`, retries: 2 });
  }
  const bal = await provider587.getBalance(address);
  if (bal < targetWei) throw new Error(`${label}: could not reach target balance (have ${ethers.formatEther(bal)})`);
  return bal;
}

// ---------------------------------------------------------------- agent setup

function extractRegisterStake(payload) {
  // Native profiles return only a register payload; ERC-20 profiles add stake.
  const p = payload?.signing_payload && (payload.signing_payload.register || payload.signing_payload.stake)
    ? payload.signing_payload
    : payload;
  if (p.register) return { register: p.register, stake: p.stake ?? null };
  if (p.register_domain) {
    return {
      register: { domain: p.register_domain, types: p.register_types, primaryType: p.register_primary_type, message: p.register_message },
      stake: p.stake_domain
        ? { domain: p.stake_domain, types: p.stake_types, primaryType: p.stake_primary_type, message: p.stake_message }
        : null,
    };
  }
  throw new Error(`Unrecognized registration payload shape: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function ensureAgent(role, { name, description, agentType, services, skills }) {
  state[role] = state[role] || {};
  const rec = state[role];

  if (!rec.privateKey) {
    const w = ethers.Wallet.createRandom();
    rec.privateKey = w.privateKey;
    rec.address = w.address;
    save();
    log(`${role}: generated wallet ${rec.address}`);
  }
  const wallet = new ethers.Wallet(rec.privateKey);

  if (!rec.token) {
    const ch = await http("POST", "/api/auth/challenge", { body: { wallet_address: rec.address } });
    const challenge = ch.json.challenge || ch.json;
    const signature = await wallet.signMessage(challenge.message);
    const login = await http("POST", "/api/auth/wallet-login", {
      body: { wallet_address: rec.address, message: challenge.message, signature, nonce: challenge.nonce },
    });
    rec.token = login.json.access_token || login.json.token?.access_token;
    if (!rec.token) throw new Error(`${role}: no access_token in login response`);
    save();
    log(`${role}: authenticated`);
  }

  if (!rec.chainAgentId) {
    const me = await http("GET", "/api/me/delegate-agent", { token: rec.token, allowStatus: [404] });
    let agent = me.json?.agent || (me.json?.id ? me.json : null);
    if (!agent?.id) {
      try {
        await http("POST", "/api/dev/faucet", { body: { wallet_address: rec.address, amount: 500 }, retries: 0 });
        log(`${role}: faucet funded`);
      } catch (err) {
        log(`${role}: dev faucet failed (continuing): ${err.message.slice(0, 200)}`);
        // Fall back to the native faucet so the wallet has gas money at least.
        try {
          await fundNative(rec.address, ethers.parseEther("0.1"), role);
        } catch (err2) {
          log(`${role}: native faucet also failed (continuing): ${err2.message.slice(0, 200)}`);
        }
      }
      const reg = await http("POST", "/api/delegate-agents/register", {
        token: rec.token,
        body: { name, description, wallet_address: rec.address, services, skills, agent_type: agentType },
      });
      agent = reg.json.agent || reg.json;
      log(`${role}: registered delegate agent ${agent.id || agent.agent_id}`, { status: agent.status, chain_agent_id: agent.chain_agent_id });
    }
    rec.agentId = agent.id || agent.agent_id;
    save();

    if (agent.chain_agent_id == null) {
      const payloadRes = await http("POST", `/api/delegate-agents/${rec.agentId}/refresh-registration-payload`, { token: rec.token, body: {} });
      const { register, stake } = extractRegisterStake(payloadRes.json);
      const regSig = splitSig(await signTypedFlexible(wallet, register));
      const confirmBody = { register_v: regSig.v, register_r: regSig.r, register_s: regSig.s };
      if (stake) {
        const stakeSig = splitSig(await signTypedFlexible(wallet, stake));
        Object.assign(confirmBody, { stake_v: stakeSig.v, stake_r: stakeSig.r, stake_s: stakeSig.s });
      }
      const confirm = await http("POST", `/api/delegate-agents/${rec.agentId}/confirm-registration`, {
        token: rec.token,
        body: confirmBody,
      });
      log(`${role}: confirm-registration submitted`, confirm.json);
    }

    for (let i = 0; i < 20; i++) {
      const again = await http("GET", "/api/me/delegate-agent", { token: rec.token, allowStatus: [404] });
      const a = again.json?.agent || again.json;
      if (a?.chain_agent_id != null) {
        rec.chainAgentId = a.chain_agent_id;
        rec.agentRegistryAddress = a.agent_registry_address ?? null;
        save();
        break;
      }
      await sleep(5000);
    }
    if (rec.chainAgentId == null) throw new Error(`${role}: chain_agent_id still null after confirm-registration`);
    log(`${role}: on-chain agent id ${rec.chainAgentId}`);
  }

  if (!rec.constitutionAcked) {
    const pending = await http("GET", "/api/constitution/pending", { token: rec.token, allowStatus: [404] });
    const laws = Array.isArray(pending.json) ? pending.json : pending.json?.laws || pending.json?.pending || [];
    for (const law of laws) {
      const lawId = law.id || law.law_id;
      const pl = await http("POST", `/api/constitution/${lawId}/acknowledge/payload`, { token: rec.token, body: {} });
      const signature = await signTypedFlexible(wallet, pl.json);
      await http("POST", `/api/constitution/${lawId}/acknowledge`, { token: rec.token, body: { signature } });
    }
    rec.constitutionAcked = true;
    save();
    log(`${role}: acknowledged ${laws.length} constitution law(s)`);
  }

  return rec;
}

// ---------------------------------------------------------------- best-effort helper

async function bestEffort(label, fn) {
  try {
    const res = await fn();
    state.steps[label] = { ok: true, status: res?.status, body: res?.json };
    save();
    log(`${label}: ok`, res?.json);
    return res;
  } catch (err) {
    state.steps[label] = { ok: false, error: err.message };
    save();
    log(`${label}: FAILED (continuing): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- main flow

async function main() {
  log(`--- mission flow run ${RUN_TAG} against ${API} ---`);

  const cfg = (await http("GET", "/api/config")).json;
  state.config = cfg;
  save();
  if (cfg.chainId !== CHAIN_ID || cfg.paymentMode !== "native") {
    throw new Error(`Expected native chain 587, got ${cfg.chainId}/${cfg.paymentMode}`);
  }

  // 0. Register every participant BEFORE creating the mission, so the 600s
  //    proposal window is spent only on post-mission steps.
  const owner = await ensureAgent("owner", {
    name: `Step Flow Mission Owner ${RUN_TAG}`,
    description: "Mission Owner registered through the step-based on-chain flow.",
    agentType: "MISSION_POSTER",
    services: ["mission-management"],
    skills: ["planning"],
  });
  const providerAgent = await ensureAgent("provider", {
    name: `Step Flow Mission Provider ${RUN_TAG}`,
    description: "Mission Provider registered through the step-based on-chain flow.",
    agentType: "MISSION_SEEKER",
    services: ["implementation"],
    skills: ["execution"],
  });

  state.teamAgents = state.teamAgents || [];
  const TEAM_SIZE = 5;
  for (let i = 0; i < TEAM_SIZE; i++) {
    const rec = await ensureAgent(`team${i}`, {
      name: `Step Flow Team Agent ${i + 1} ${RUN_TAG}`,
      description: `Proposal team agent ${i + 1} registered through the step-based on-chain flow.`,
      agentType: "MISSION_SEEKER",
      services: ["implementation"],
      skills: ["execution"],
    });
    if (!state.teamAgents.includes(`team${i}`)) state.teamAgents.push(`team${i}`);
    save();
  }

  const VOTERS = 3;
  state.voters = state.voters || [];
  for (let i = 0; i < VOTERS; i++) {
    await ensureAgent(`voter${i}`, {
      name: `Step Flow Rank Voter ${i + 1} ${RUN_TAG}`,
      description: `Rank voter ${i + 1} registered through the step-based on-chain flow.`,
      agentType: "MISSION_SEEKER",
      services: ["governance"],
      skills: ["voting"],
    });
    if (!state.voters.includes(`voter${i}`)) state.voters.push(`voter${i}`);
    save();
  }

  // Owner needs native tNETX for the escrow payment transaction + gas.
  await bestEffort("fund_owner", () => fundNative(owner.address, ethers.parseEther("0.4"), "owner"));

  // 1. Create mission
  if (!state.mission) {
    const res = await http("POST", "/api/missions", {
      token: owner.token,
      body: {
        title: `Step Flow On-chain Mission ${RUN_TAG}`,
        description: "Mission created through the step-based on-chain quote/agreement and proposal flow.",
        price: MISSION_PRICE,
        currency: "tNETX",
        deadline: "2026-12-31T00:00:00Z",
        skills: [],
      },
    });
    state.mission = res.json.mission || res.json;
    save();
    log(`mission created: ${state.mission.id}`);
  }
  const missionId = state.mission.id;

  // 6 (moved early). Team + proposal, inside the 600s window from created_at.
  const leader = state.team0;
  if (!state.team) {
    const res = await http("POST", "/api/teams", {
      token: leader.token,
      body: { mission_id: missionId, name: `Step Flow Proposal Team ${RUN_TAG}` },
    });
    state.team = res.json.team || res.json;
    save();
    log(`team created: ${state.team.id}`);
  }
  const teamId = state.team.id;

  for (let i = 1; i < TEAM_SIZE; i++) {
    if (state[`teamJoined${i}`]) continue;
    const member = state[`team${i}`];
    try {
      await http("POST", `/api/teams/${teamId}/invite`, { token: leader.token, body: { agent_id: member.agentId } });
    } catch (err) {
      log(`team${i} invite: ${err.message.slice(0, 160)} (may already be invited)`);
    }
    try {
      await http("POST", `/api/teams/${teamId}/respond?accept=true`, { token: member.token, body: {} });
    } catch (err) {
      log(`team${i} respond: ${err.message.slice(0, 160)} (may already be accepted)`);
    }
    state[`teamJoined${i}`] = true;
    save();
    log(`team member team${i} invited + accepted`);
  }
  await bestEffort("team_refresh", () => http("GET", `/api/teams/${teamId}`, { token: leader.token }));

  if (!state.proposal) {
    const res = await http("POST", `/api/teams/${teamId}/submit-proposal`, {
      token: leader.token,
      body: {
        description: `Step-flow proposal by Step Flow Proposal Team for mission ${missionId}.`,
        proposed_cost: QUOTE_PRICE,
        workflow: {
          nodes: [
            { id: "n1", title: "Discovery and acceptance criteria", description: "Clarify mission scope, constraints, and measurable acceptance criteria.", required_skills: [], max_budget: 0.02, max_time_minutes: 45, min_benchmark: 70, pop_tier: 1 },
            { id: "n2", title: "Implementation work", description: "Execute the main deliverable according to the agreed scope.", required_skills: [], max_budget: 0.055, max_time_minutes: 120, min_benchmark: 80, pop_tier: 1 },
            { id: "n3", title: "Verification and handoff", description: "Verify the output, collect evidence, and deliver final artifacts.", required_skills: [], max_budget: 0.02, max_time_minutes: 60, min_benchmark: 75, pop_tier: 1 },
          ],
          edges: [ { from: "n1", to: "n2" }, { from: "n2", to: "n3" } ],
          total_budget: QUOTE_PRICE,
          deadline: "2026-12-31T00:00:00Z",
        },
      },
    });
    state.proposal = res.json.proposal || res.json;
    save();
    log(`proposal submitted: ${state.proposal.id || JSON.stringify(state.proposal).slice(0, 200)}`);
  }

  // 2. Quote
  if (!state.quote) {
    const res = await http("POST", `/api/missions/${missionId}/quotes`, {
      token: providerAgent.token,
      body: {
        suggested_price: QUOTE_PRICE,
        currency: "tNETX",
        estimated_time: "2026-12-01T00:00:00Z",
        description: "Quote submitted by an on-chain registered provider agent.",
        confirmed_steps: [
          { title: "Plan and acceptance criteria", description: "Confirm scope, constraints, and success criteria." },
          { title: "Execute mission", description: "Complete the agreed deliverable." },
          { title: "Verify and hand off", description: "Verify outputs and deliver evidence." },
        ],
      },
    });
    state.quoteResult = res.json;
    state.quote = res.json.quote || res.json;
    save();
    log(`quote created: ${state.quote.id}`);
  }
  const quoteId = state.quote.id;

  // 3. Accept quote
  if (!state.accepted) {
    const res = await http("POST", `/api/missions/${missionId}/quotes/${quoteId}/accept`, { token: owner.token, body: {} });
    state.accepted = res.json;
    save();
    log("quote accepted");
  }

  // 7. Evaluate proposal.
  if (!state.evaluationSessionId) {
    const res = await http("POST", `/api/deliberation/${missionId}/evaluate/open?round_number=1`, { token: owner.token, body: {} });
    const s = res.json.session || res.json;
    state.evaluationSessionId = s.id || s.session_id || s.evaluation_session_id;
    state.evaluationOpen = res.json;
    save();
    log(`evaluation session: ${state.evaluationSessionId}`);
  }
  const evals = [
    ["registrar", "identity", 92, "Team sponsorship and delegate identity are sufficient."],
    ["speaker", "process", 90, "Proposal is complete and ready for deliberation."],
    ["regulator", "compliance", 88, "No compliance blockers found in the workflow."],
    ["codifier", "feasibility", 91, "Workflow DAG is feasible and within budget."],
  ];
  for (const [clerk_role, domain, score, reasoning] of evals) {
    await bestEffort(`evaluate_${clerk_role}`, () =>
      http("POST", `/api/deliberation/sessions/${state.evaluationSessionId}/evaluate`, {
        token: owner.token,
        body: { clerk_role, team_id: teamId, domain, score, reasoning },
      }),
    );
  }
  await bestEffort("shortlist", () => http("POST", `/api/deliberation/sessions/${state.evaluationSessionId}/shortlist`, { token: owner.token, body: {} }));
  await bestEffort("evaluation_close", () => http("POST", `/api/deliberation/sessions/${state.evaluationSessionId}/close`, { token: owner.token, body: {} }));

  // 8. Rank proposal.
  if (!state.rankSessionId) {
    const res = await http("POST", `/api/deliberation/${missionId}/rank/open?timeout_seconds=0`, { token: owner.token, body: {} });
    const s = res.json.session || res.json;
    state.rankSessionId = s.id || s.session_id || s.rank_session_id;
    state.rankOpen = res.json;
    save();
    log(`rank session: ${state.rankSessionId}`);
  }
  for (const v of state.voters) {
    await bestEffort(`vote_${v}`, () =>
      http("POST", `/api/deliberation/sessions/${state.rankSessionId}/vote`, { token: state[v].token, body: { preferences: [teamId] } }),
    );
  }
  await bestEffort("rank_state", () => http("GET", `/api/deliberation/sessions/${state.rankSessionId}/rank-state`, { token: owner.token }));
  await bestEffort("tally", () => http("POST", `/api/deliberation/sessions/${state.rankSessionId}/tally`, { token: owner.token, body: {} }));

  const props = await bestEffort("proposals_after_tally", () => http("GET", `/api/teams/mission/${missionId}/proposals`, { token: owner.token }));
  const proposalList = Array.isArray(props?.json) ? props.json : props?.json?.proposals || [];
  const winning = proposalList.find((p) => (p.team_id || p.teamId) === teamId) || proposalList[0] || state.proposal;
  const proposalId = winning?.id || state.proposal?.id;
  state.winningProposal = winning;
  save();
  log(`proposal for finalization: ${proposalId}`, { status: winning?.status });

  // 4b. Provider-side stake. The agreement "provider" signer is the WINNING
  // TEAM LEADER (not the quote creator): eip712-payload returns
  // NOT_MISSION_PARTICIPANT for anyone else, and signing-payload 500s until a
  // winner exists. The leader stakes lock_bps (20%) of the mission amount.
  const leaderRec = state.team0;
  if (!state.providerStake) {
    const dep = await http("GET", `/api/staking/${leaderRec.chainAgentId}/required-deposit?mission_amount=${QUOTE_PRICE}`, { token: leaderRec.token });
    log("provider required-deposit", dep.json);
    const needed = Number(dep.json.additional_needed ?? 0);
    if (needed > 0) {
      const stakeRes = await http("POST", `/api/staking/${leaderRec.chainAgentId}/stake`, { token: leaderRec.token, body: { amount: needed } });
      const intent = stakeRes.json.intent;
      if (!intent) throw new Error(`no stake intent in response: ${JSON.stringify(stakeRes.json).slice(0, 300)}`);
      const value = BigInt(intent.value);
      const gasPrice = BigInt(intent.suggestedGasPriceWei || "300000000000");
      const wallet = new ethers.Wallet(leaderRec.privateKey, provider587);
      let gasLimit;
      try {
        gasLimit = ((await provider587.estimateGas({ from: providerAgent.address, to: intent.to, data: intent.data, value })) * 130n) / 100n;
      } catch {
        gasLimit = 500000n;
      }
      await fundNative(leaderRec.address, value + gasPrice * gasLimit + ethers.parseEther("0.01"), "team0-leader");
      const sent = await wallet.sendTransaction({ to: intent.to, data: intent.data, value, gasPrice, gasLimit, type: 0, chainId: CHAIN_ID });
      log(`provider stake tx sent: ${sent.hash}`);
      const receipt = await sent.wait();
      if (receipt.status !== 1) throw new Error(`stake tx reverted: ${sent.hash}`);
      const confirm = await http("POST", `/api/staking/${leaderRec.chainAgentId}/stake/confirm`, { token: leaderRec.token, body: { tx_hash: sent.hash } });
      log("provider stake confirmed", confirm.json);
    }
    state.providerStake = { done: true, needed };
    save();
  }

  // 5. Sign agreement (owner + provider); native chains have no USDC auth step.
  state.agreements = state.agreements || {};
  for (const [role, rec] of [["owner", owner], ["provider", leaderRec]]) {
    if (state.agreements[role]) continue;
    const wallet = new ethers.Wallet(rec.privateKey);
    const payload = await http("GET", `/api/missions/${missionId}/quotes/${quoteId}/signing-payload`, { token: rec.token });
    const signature = await signTypedFlexible(wallet, payload.json);
    const res = await http("POST", `/api/missions/${missionId}/quotes/${quoteId}/sign`, { token: rec.token, body: { signature } });
    state.agreements[role] = res.json;
    save();
    log(`agreement signed by ${role}`);
  }

  // 4. Native escrow payment via signing-batch (surfaces after both signatures).
  if (!state.nativePaymentTxHash) {
    let item = null;
    for (let i = 0; i < 20 && !item; i++) {
      const batch = await http("GET", `/api/missions/${missionId}/signing-batch`, { token: owner.token });
      state.signingBatch = batch.json;
      save();
      const pend = batch.json.pending_signatures || batch.json.pending || [];
      item = pend.find((p) => p.purpose === "native_payment") || null;
      if (!item) {
        log(`signing-batch: native_payment not pending yet (pending=${pend.map((p) => p.purpose).join(",") || "none"})`);
        await sleep(5000);
      }
    }
    if (!item) throw new Error("native_payment never appeared in signing-batch");

    const tx = item.tx;
    if (Number(tx.chainId) !== CHAIN_ID) throw new Error(`native_payment tx chainId ${tx.chainId} != ${CHAIN_ID}`);
    const wallet = new ethers.Wallet(owner.privateKey, provider587);
    const value = BigInt(tx.value);
    const gasPrice = BigInt(tx.gasPriceWei || tx.gasPrice || "300000000000");
    let gasLimit;
    try {
      gasLimit = ((await provider587.estimateGas({ from: owner.address, to: tx.to, data: tx.data, value })) * 130n) / 100n;
    } catch {
      gasLimit = 2000000n;
    }
    const need = value + gasPrice * gasLimit;
    const have = await provider587.getBalance(owner.address);
    log(`native payment: value=${ethers.formatEther(value)} gasLimit=${gasLimit} need=${ethers.formatEther(need)} have=${ethers.formatEther(have)}`);
    if (have < need) {
      await fundNative(owner.address, need + ethers.parseEther("0.05"), "owner");
    }
    const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value, gasPrice, gasLimit, type: 0, chainId: CHAIN_ID });
    log(`native payment tx sent: ${sent.hash}`);
    const receipt = await sent.wait();
    if (receipt.status !== 1) throw new Error(`native payment tx reverted: ${sent.hash}`);
    log(`native payment confirmed in block ${receipt.blockNumber}`);

    const submit = await http("POST", `/api/missions/${missionId}/signing-batch`, {
      token: owner.token,
      body: { signatures: [{ purpose: "native_payment", tx_hash: sent.hash }] },
    });
    state.nativePaymentTxHash = sent.hash;
    state.nativePaymentSubmit = submit.json;
    save();
    log("native payment submitted to signing-batch", submit.json);
  }

  // Refresh mission + on-chain status.
  await bestEffort("mission_refresh", () => http("GET", `/api/missions/${missionId}`, { token: owner.token }));
  for (let i = 0; i < 6; i++) {
    const oc = await bestEffort("mission_onchain", () => http("GET", `/api/missions/${missionId}/onchain`, { token: owner.token }));
    if (oc?.json && (oc.json.contract_address || oc.json.onchain_status || oc.json.status)) break;
    await sleep(5000);
  }


  // 9. Finalize + open collaboration (best effort).
  await bestEffort("constitutional_review", () => http("POST", `/api/deliberation/${proposalId}/constitutional-review`, { token: owner.token, body: {} }));
  await bestEffort("codify", () => http("POST", `/api/deliberation/${proposalId}/codify`, { token: owner.token, body: {} }));
  await bestEffort("sign_speaker", () => http("POST", `/api/deliberation/${proposalId}/sign?role=speaker`, { token: owner.token, body: {}, headers: { "X-Clerk-Role": "speaker" } }));
  await bestEffort("sign_regulator", () => http("POST", `/api/deliberation/${proposalId}/sign?role=regulator`, { token: owner.token, body: {}, headers: { "X-Clerk-Role": "regulator" } }));
  await bestEffort("verify_deployment", () => http("POST", `/api/deliberation/${proposalId}/verify-deployment`, { token: owner.token, body: {} }));

  const collab = await bestEffort("collaboration_open", () => http("POST", `/api/collaboration/${proposalId}/open`, { token: owner.token, body: {} }));
  if (collab?.json) {
    const c = collab.json.contract || collab.json;
    state.collaboration = c;
    const collabId = c.id || c.contract_id || c.collaboration_id;
    save();
    if (collabId) {
      await bestEffort("collaboration_state", () => http("GET", `/api/collaboration/${collabId}/state`, { token: owner.token }));
    }
  }
  await bestEffort("proposals_final", () => http("GET", `/api/teams/mission/${missionId}/proposals`, { token: owner.token }));

  // Final status.
  const finalMission = await bestEffort("final_mission", () => http("GET", `/api/missions/${missionId}`, { token: owner.token }));
  const finalOnchain = await bestEffort("final_onchain", () => http("GET", `/api/missions/${missionId}/onchain`, { token: owner.token }));

  const summary = {
    missionId,
    quoteId,
    teamId,
    proposalId,
    proposalStatus: state.winningProposal?.status,
    collaborationId: state.collaboration?.id || state.collaboration?.contract_id || null,
    nativePaymentTxHash: state.nativePaymentTxHash,
    missionStatus: finalMission?.json?.mission?.status || finalMission?.json?.status,
    onchain: finalOnchain?.json || null,
  };
  state.summary = summary;
  save();
  console.log("\n=== FLOW SUMMARY ===\n" + JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  save();
  process.exit(1);
});
