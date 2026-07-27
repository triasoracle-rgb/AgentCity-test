#!/usr/bin/env node
/**
 * Minimal 2-agent AgentCity mission flow (no team/deliberation), following
 * docs/agentcity-reference/backend-skill.md end to end through workflow
 * execution, on-chain completion, fund release, and rating.
 *
 * Purpose: diagnostic. mission-flow.mjs (team + collaboration path) hit
 * INTERNAL_ERROR on actions/complete, actions/release, and rate/payload
 * after workflow execution (see runs/report-2026-07-27.md). This script
 * isolates whether that failure is specific to the team/collaboration path
 * or a platform-wide fault affecting the simple single-provider path too.
 *
 * State persisted to runs/simple-state.json (gitignored), independent of
 * the team-mission state file.
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { setGlobalDispatcher, ProxyAgent } from "undici";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  ethers.FetchRequest.registerGetUrl(async (req) => {
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) {
      if (["content-length", "host", "connection"].includes(k.toLowerCase())) delete headers[k];
    }
    const resp = await fetch(req.url, { method: req.method, headers, body: req.body ?? undefined });
    const respHeaders = {};
    resp.headers.forEach((v, k) => (respHeaders[k] = v));
    return { statusCode: resp.status, statusMessage: resp.statusText, headers: respHeaders, body: new Uint8Array(await resp.arrayBuffer()) };
  });
}

const API = process.env.AGENTCITY_API_URL || "https://api.agentcity.dev";
const RPC = process.env.NETX_RPC_URL || "https://testnetrpc.netxscan.io";
const CHAIN_ID = 587;
const STATE_FILE = process.env.STATE_FILE || path.join("runs", "simple-state.json");
const RUN_TAG = Date.now();
const MISSION_PRICE = 0.1;
const QUOTE_PRICE = 0.095;

const provider587 = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { apiUrl: API, rpcUrl: RPC, steps: {}, log: [] };
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

async function http(method, urlPath, { token, body, rawBody, headers = {}, retries = 4, timeoutMs = 120000, allowStatus = [] } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : API + urlPath;
  const hdrs = { ...headers };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; hdrs["Content-Type"] = "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); hdrs["Content-Type"] = "application/json"; }
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
      if ([502, 503, 504].includes(res.status)) { lastErr = new Error(`HTTP ${res.status} ${method} ${urlPath}: ${text.slice(0, 300)}`); continue; }
      throw new Error(`HTTP ${res.status} ${method} ${urlPath}: ${text.slice(0, 600)}`);
    } catch (err) {
      clearTimeout(timer);
      if (err.message?.startsWith("HTTP ")) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function stripDomainType(types) { const t = { ...types }; delete t.EIP712Domain; return t; }
async function signTypedFlexible(wallet, payload) {
  let td = payload;
  for (const key of ["typed_data", "typedData", "signing_payload", "payload"]) if (td && !td.domain && td[key]) td = td[key];
  if (!td?.domain || !td?.types || !td?.message) throw new Error(`No typed data found in payload: ${JSON.stringify(payload).slice(0, 400)}`);
  return wallet.signTypedData(td.domain, stripDomainType(td.types), td.message);
}
function splitSig(sig) { const s = ethers.Signature.from(sig); return { v: s.v < 27 ? s.v + 27 : s.v, r: s.r, s: s.s }; }

async function fundNative(address, targetWei, label = "wallet") {
  const DRIP = 100000000000000000n;
  for (let i = 0; i < 12; i++) {
    const bal = await provider587.getBalance(address);
    if (bal >= targetWei) { log(`${label}: native balance ${ethers.formatEther(bal)} tNETX (target ${ethers.formatEther(targetWei)})`); return bal; }
    await http("POST", "/api/faucet/native", { rawBody: `{"to":"${address}","amount":${DRIP.toString()}}`, retries: 2 });
  }
  const bal = await provider587.getBalance(address);
  if (bal < targetWei) throw new Error(`${label}: could not reach target balance (have ${ethers.formatEther(bal)})`);
  return bal;
}

async function bestEffort(label, fn) {
  try {
    const res = await fn();
    state.steps[label] = { ok: true, status: res?.status, body: res?.json };
    save();
    log(`${label}: ok`, res?.json);
    return res;
  } catch (err) {
    state.steps[label] = { ok: false, error: err.message.slice(0, 400) };
    save();
    log(`${label}: FAILED (continuing): ${err.message}`);
    return null;
  }
}

async function ensureAgent(role, { name, description, agentType, services, skills }) {
  state[role] = state[role] || {};
  const rec = state[role];
  if (!rec.privateKey) {
    const w = ethers.Wallet.createRandom();
    rec.privateKey = w.privateKey; rec.address = w.address; save();
    log(`${role}: generated wallet ${rec.address}`);
  }
  const wallet = new ethers.Wallet(rec.privateKey);
  if (!rec.token) {
    const ch = await http("POST", "/api/auth/challenge", { body: { wallet_address: rec.address } });
    const challenge = ch.json.challenge || ch.json;
    const signature = await wallet.signMessage(challenge.message);
    const login = await http("POST", "/api/auth/wallet-login", { body: { wallet_address: rec.address, message: challenge.message, signature, nonce: challenge.nonce } });
    rec.token = login.json.access_token || login.json.token?.access_token;
    if (!rec.token) throw new Error(`${role}: no access_token in login response`);
    save();
    log(`${role}: authenticated`);
  }
  if (!rec.chainAgentId) {
    const me = await http("GET", "/api/me/delegate-agent", { token: rec.token, allowStatus: [404] });
    let agent = me.json?.agent || (me.json?.id ? me.json : null);
    if (!agent?.id) {
      try { await http("POST", "/api/dev/faucet", { body: { wallet_address: rec.address, amount: 500 }, retries: 0 }); }
      catch { await fundNative(rec.address, ethers.parseEther("0.1"), role).catch(() => {}); }
      const reg = await http("POST", "/api/delegate-agents/register", { token: rec.token, body: { name, description, wallet_address: rec.address, services, skills, agent_type: agentType } });
      agent = reg.json.agent || reg.json;
      log(`${role}: registered delegate agent ${agent.id || agent.agent_id}`, { status: agent.status });
    }
    rec.agentId = agent.id || agent.agent_id;
    save();
    if (agent.chain_agent_id == null) {
      const payloadRes = await http("POST", `/api/delegate-agents/${rec.agentId}/refresh-registration-payload`, { token: rec.token, body: {} });
      const p = payloadRes.json?.signing_payload && payloadRes.json.signing_payload.register ? payloadRes.json.signing_payload : payloadRes.json;
      const register = p.register || { domain: p.register_domain, types: p.register_types, primaryType: p.register_primary_type, message: p.register_message };
      const stake = p.stake || (p.stake_domain ? { domain: p.stake_domain, types: p.stake_types, primaryType: p.stake_primary_type, message: p.stake_message } : null);
      const regSig = splitSig(await signTypedFlexible(wallet, register));
      const confirmBody = { register_v: regSig.v, register_r: regSig.r, register_s: regSig.s };
      if (stake) { const stakeSig = splitSig(await signTypedFlexible(wallet, stake)); Object.assign(confirmBody, { stake_v: stakeSig.v, stake_r: stakeSig.r, stake_s: stakeSig.s }); }
      await http("POST", `/api/delegate-agents/${rec.agentId}/confirm-registration`, { token: rec.token, body: confirmBody });
    }
    for (let i = 0; i < 20; i++) {
      const again = await http("GET", "/api/me/delegate-agent", { token: rec.token, allowStatus: [404] });
      const a = again.json?.agent || again.json;
      if (a?.chain_agent_id != null) { rec.chainAgentId = a.chain_agent_id; save(); break; }
      await sleep(5000);
    }
    if (rec.chainAgentId == null) throw new Error(`${role}: chain_agent_id still null`);
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
    rec.constitutionAcked = true; save();
    log(`${role}: acknowledged ${laws.length} constitution law(s)`);
  }
  return rec;
}

async function main() {
  log(`--- simple 2-agent mission flow run ${RUN_TAG} against ${API} ---`);

  const client = await ensureAgent("client", { name: `Simple Flow Client ${RUN_TAG}`, description: "Client agent for the simple 2-agent diagnostic flow.", agentType: "MISSION_POSTER", services: ["mission-management"], skills: ["planning"] });
  const provider = await ensureAgent("provider", { name: `Simple Flow Provider ${RUN_TAG}`, description: "Provider agent for the simple 2-agent diagnostic flow.", agentType: "MISSION_SEEKER", services: ["implementation"], skills: ["execution"] });

  await bestEffort("fund_client", () => fundNative(client.address, ethers.parseEther("0.4"), "client"));

  if (!state.mission) {
    const res = await http("POST", "/api/missions", { token: client.token, body: { title: `Simple Diagnostic Mission ${RUN_TAG}`, description: "Minimal 2-agent mission to isolate the actions/complete INTERNAL_ERROR from the team/collaboration path.", price: MISSION_PRICE, currency: "tNETX", deadline: "2026-12-31T00:00:00Z", skills: [] } });
    state.mission = res.json.mission || res.json; save();
    log(`mission created: ${state.mission.id}`);
  }
  const missionId = state.mission.id;

  if (!state.quote) {
    const res = await http("POST", `/api/missions/${missionId}/quotes`, { token: provider.token, body: { suggested_price: QUOTE_PRICE, currency: "tNETX", estimated_time: "2026-12-01T00:00:00Z", description: "Quote from a directly-registered provider (no team).", confirmed_steps: [
      { title: "Plan and acceptance criteria", description: "Confirm scope, constraints, and success criteria." },
      { title: "Execute mission", description: "Complete the agreed deliverable." },
      { title: "Verify and hand off", description: "Verify outputs and deliver evidence." },
    ] } });
    state.quote = res.json.quote || res.json; save();
    log(`quote created: ${state.quote.id}`);
  }
  const quoteId = state.quote.id;

  if (!state.accepted) {
    const res = await http("POST", `/api/missions/${missionId}/quotes/${quoteId}/accept`, { token: client.token, body: {} });
    state.accepted = res.json; save();
    log("quote accepted");
  }

  // Provider stake (required before the agreement can be signed).
  if (!state.providerStake) {
    const dep = await http("GET", `/api/staking/${provider.chainAgentId}/required-deposit?mission_amount=${QUOTE_PRICE}`, { token: provider.token });
    const needed = Number(dep.json.additional_needed ?? 0);
    if (needed > 0) {
      const stakeRes = await http("POST", `/api/staking/${provider.chainAgentId}/stake`, { token: provider.token, body: { amount: needed } });
      const intent = stakeRes.json.intent;
      const value = BigInt(intent.value);
      const gasPrice = BigInt(intent.suggestedGasPriceWei || "300000000000");
      const wallet = new ethers.Wallet(provider.privateKey, provider587);
      let gasLimit;
      try { gasLimit = ((await provider587.estimateGas({ from: provider.address, to: intent.to, data: intent.data, value })) * 130n) / 100n; } catch { gasLimit = 500000n; }
      await fundNative(provider.address, value + gasPrice * gasLimit + ethers.parseEther("0.01"), "provider");
      const sent = await wallet.sendTransaction({ to: intent.to, data: intent.data, value, gasPrice, gasLimit, type: 0, chainId: CHAIN_ID });
      log(`provider stake tx sent: ${sent.hash}`);
      const receipt = await sent.wait();
      if (receipt.status !== 1) throw new Error(`stake tx reverted: ${sent.hash}`);
      await http("POST", `/api/staking/${provider.chainAgentId}/stake/confirm`, { token: provider.token, body: { tx_hash: sent.hash } });
      log("provider stake confirmed");
    }
    state.providerStake = { done: true, needed }; save();
  }

  // Agreement signatures (client + provider), polling through chain-service hiccups.
  state.agreements = state.agreements || {};
  for (const [role, rec] of [["client", client], ["provider", provider]]) {
    if (state.agreements[role]) continue;
    const wallet = new ethers.Wallet(rec.privateKey);
    let payload;
    for (let i = 0; i < 10; i++) {
      try { payload = await http("GET", `/api/missions/${missionId}/quotes/${quoteId}/signing-payload`, { token: rec.token, retries: 0 }); break; }
      catch (err) { if (!/HTTP (500|503)/.test(err.message)) throw err; log(`${role} signing-payload not ready (attempt ${i + 1})`); await sleep(15000); }
    }
    if (!payload) throw new Error(`${role}: signing-payload never became available`);
    const signature = await signTypedFlexible(wallet, payload.json);
    const res = await http("POST", `/api/missions/${missionId}/quotes/${quoteId}/sign`, { token: rec.token, body: { signature } });
    state.agreements[role] = res.json; save();
    log(`agreement signed by ${role}`);
  }

  // Native escrow payment via signing-batch.
  if (!state.nativePaymentTxHash) {
    let item = null;
    for (let i = 0; i < 20 && !item; i++) {
      const batch = await http("GET", `/api/missions/${missionId}/signing-batch`, { token: client.token });
      const pend = batch.json.pending_signatures || batch.json.pending || [];
      item = pend.find((p) => p.purpose === "native_payment") || null;
      if (!item) { log(`signing-batch: native_payment not pending yet`); await sleep(5000); }
    }
    if (!item) throw new Error("native_payment never appeared in signing-batch");
    const tx = item.tx;
    const wallet = new ethers.Wallet(client.privateKey, provider587);
    const value = BigInt(tx.value);
    const gasPrice = BigInt(tx.gasPriceWei || "300000000000");
    let gasLimit;
    try { gasLimit = ((await provider587.estimateGas({ from: client.address, to: tx.to, data: tx.data, value })) * 130n) / 100n; } catch { gasLimit = 2000000n; }
    await fundNative(client.address, value + gasPrice * gasLimit + ethers.parseEther("0.02"), "client");
    try {
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value, gasPrice, gasLimit, type: 0, chainId: CHAIN_ID });
      log(`native payment tx sent: ${sent.hash}`);
      const receipt = await sent.wait();
      if (receipt.status === 1) {
        const submit = await http("POST", `/api/missions/${missionId}/signing-batch`, { token: client.token, body: { signatures: [{ purpose: "native_payment", tx_hash: sent.hash }] } });
        state.nativePaymentTxHash = sent.hash; state.nativePaymentSubmit = submit.json; save();
        log("native payment submitted to signing-batch");
      } else {
        log("native payment tx reverted (likely already relayer-paid) — continuing");
      }
    } catch (err) {
      log(`native payment tx failed (continuing, likely already relayer-paid): ${err.message.slice(0, 200)}`);
    }
  }

  await bestEffort("mission_refresh", () => http("GET", `/api/missions/${missionId}`, { token: client.token }));
  for (let i = 0; i < 6; i++) {
    const oc = await bestEffort("mission_onchain", () => http("GET", `/api/missions/${missionId}/onchain`, { token: client.token }));
    if (oc?.json?.contract_status_label) break;
    await sleep(5000);
  }

  // Workflow execution.
  const wf = await bestEffort("workflow_components_list", () => http("GET", `/api/missions/${missionId}/quotes/${quoteId}/workflow/components`, { token: provider.token }));
  for (const comp of wf?.json || []) {
    if (comp.status === "done") continue;
    await bestEffort(`workflow_start_${comp.id}`, () => http("PATCH", `/api/missions/${missionId}/quotes/${quoteId}/workflow/components/${comp.id}/start`, { token: provider.token, body: {} }));
    await bestEffort(`workflow_complete_${comp.id}`, () => http("PATCH", `/api/missions/${missionId}/quotes/${quoteId}/workflow/components/${comp.id}/complete`, { token: provider.token, body: {} }));
  }

  async function signedAction(actionName, rec) {
    const payload = await http("POST", `/api/missions/${missionId}/actions/${actionName}/payload`, { token: rec.token, body: {} });
    const wallet = new ethers.Wallet(rec.privateKey);
    const signature = await signTypedFlexible(wallet, payload.json);
    const sig = splitSig(signature);
    return http("POST", `/api/missions/${missionId}/actions/${actionName}`, { token: rec.token, body: { v: sig.v, r: sig.r, s: sig.s, nonce: payload.json.nonce, expiry: payload.json.expiry, client_amount: "0", provider_amount: "0" } });
  }
  await bestEffort("action_complete", () => signedAction("complete", provider));
  await bestEffort("action_release", () => signedAction("release", client));

  async function submitRating(rec, score, comment) {
    const payload = await http("POST", `/api/missions/${missionId}/rate/payload`, { token: rec.token, body: { score, comment } });
    const wallet = new ethers.Wallet(rec.privateKey);
    const signature = await signTypedFlexible(wallet, payload.json);
    return http("POST", `/api/missions/${missionId}/rate`, { token: rec.token, body: { signature } });
  }
  await bestEffort("rate_client", () => submitRating(client, 5, "Simple diagnostic flow."));
  await bestEffort("rate_provider", () => submitRating(provider, 5, "Simple diagnostic flow."));

  await bestEffort("reputation_client", () => http("GET", `/api/delegate-agents/${client.agentId}/reputation`, { token: client.token }));
  await bestEffort("reputation_provider", () => http("GET", `/api/delegate-agents/${provider.agentId}/reputation`, { token: provider.token }));

  const finalMission = await bestEffort("final_mission", () => http("GET", `/api/missions/${missionId}`, { token: client.token }));
  const finalOnchain = await bestEffort("final_onchain", () => http("GET", `/api/missions/${missionId}/onchain`, { token: client.token }));

  const summary = {
    missionId, quoteId,
    missionStatus: finalMission?.json?.mission?.status || finalMission?.json?.status,
    onchain: finalOnchain?.json || null,
    actionComplete: state.steps.action_complete,
    actionRelease: state.steps.action_release,
    rateClient: state.steps.rate_client,
    rateProvider: state.steps.rate_provider,
  };
  state.summary = summary; save();
  console.log("\n=== SIMPLE FLOW SUMMARY ===\n" + JSON.stringify(summary, null, 2));
}

main().catch((err) => { log(`FATAL: ${err.message}`); save(); process.exit(1); });
