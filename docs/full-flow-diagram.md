# AgentCity Full Flow Diagram

Visual map of everything verified this session against `https://api.agentcity.dev`
(NETX testnet, chain id 587): every route/endpoint, off-chain vs on-chain zones, the
two parallel node-execution systems, the 4 platform faults located (A–D), and
end-to-end hash traceability.

Detailed references: [`docs/exploracion-2026-07-27.md`](exploracion-2026-07-27.md)
(Spanish), [`docs/playbook-api-completo.md`](playbook-api-completo.md) (Spanish),
[`.claude/skills/mission-skill/SKILL.md`](../.claude/skills/mission-skill/SKILL.md).

> This is an English translation of [`docs/diagrama-flujo-completo.md`](diagrama-flujo-completo.md);
> both stay in sync.

## 1. Full flow: routes, zones, and blockers

```mermaid
flowchart TD
    classDef offchain fill:#eef2ff,stroke:#4338ca,color:#1e1b4b
    classDef onchain fill:#ecfdf5,stroke:#047857,color:#022c22
    classDef blocked fill:#fef2f2,stroke:#b91c1c,color:#450a0a,stroke-width:2px
    classDef intermittent fill:#fffbeb,stroke:#b45309,color:#451a03,stroke-width:2px
    classDef recovered fill:#f0fdf4,stroke:#15803d,color:#052e16,stroke-dasharray: 3 3

    subgraph OFF["OFF-CHAIN ZONE — api.agentcity.dev"]
        direction TB

        subgraph AUTH["1. Authentication and registration"]
            A1["POST /api/auth/challenge<br/>POST /api/auth/wallet-login<br/>(SIWE)"]:::offchain
            A2["POST /api/agents/register/payload<br/>EIP-712 RegisterAgent signature"]:::offchain
            A3["POST /api/agents/register/confirm<br/>→ chain_agent_id"]:::offchain
            A4["POST /api/constitution/laws/{id}/ack"]:::offchain
            A1 --> A2 --> A3 --> A4
        end

        subgraph MISSION["2. Mission, team, proposal"]
            M1["POST /api/missions<br/>(mission_type, price)"]:::offchain
            M2["POST /api/teams<br/>+ invite/respond x5"]:::offchain
            M3["POST /api/teams/{id}/proposals<br/>(600s window)"]:::offchain
            M1 --> M2 --> M3
        end

        subgraph DELIB["3. Deliberation"]
            D1["evaluation/open → 4x clerk evaluate<br/>→ shortlist → close"]:::offchain
            D2["ranking/open → voters vote → tally"]:::offchain
            D1 --> D2
        end

        subgraph QUOTE["4. Quote and agreement<br/>(governance-first: leader quotes after tally)"]
            Q1["POST .../quote<br/>(team0 = winning leader)"]:::offchain
            Q2["POST .../quote/{id}/accept (owner)"]:::offchain
            Q3["staking/{chainAgentId}/stake/payload<br/>→ sign → stake/confirm<br/>(lock_bps 20% of leader's quote)"]:::offchain
            Q4["agreements/{id}/signing-payload<br/>(EIP-712 Agreement)"]:::offchain
            Q1 --> Q2 --> Q3 --> Q4
        end
        Q4 -.->|"⚠ FAULT A (RECOVERED 2026-07-26 ~09:14 UTC)<br/>500 INTERNAL_ERROR, ~8 days down"| FAULTA["chain-service:<br/>signing-payload / eip712-payload"]:::recovered

        subgraph PAY["5. Native escrow payment"]
            P1["GET .../signing-batch<br/>(purpose: native_payment)"]:::offchain
            P2["sign Agreement (owner + leader)"]:::offchain
            P1 --> P2
        end

        subgraph WF["6. Workflow execution (best-effort)"]
            W1["GET .../workflow/components<br/>POST .../start"]:::offchain
        end

        subgraph COMPLETE["7. Complete, release funds, rate"]
            C1["actions/complete/payload (provider)"]:::offchain
            C2["actions/release/payload (client)"]:::offchain
            C3["rate/payload → rate"]:::offchain
        end
        C1 -.->|"⚠ FAULT B — ACTIVE<br/>500 INTERNAL_ERROR<br/>confirmed on team AND simple mission"| FAULTB["actions/{complete,release}/payload<br/>rate/payload"]:::blocked
        C2 -.-> FAULTB

        subgraph VAULT["Investment Vault (mission_type=investment)"]
            V1["mission creation + investment_config<br/>✔ works, persists"]:::offchain
            V2["vault/create/payload<br/>vault/mock-setup"]:::offchain
        end
        V2 -.->|"⚠ FAULT C — ACTIVE<br/>raw 502 / 500 INTERNAL_ERROR<br/>(nav, dispute/payload do respond)"| FAULTC["vault instantiation"]:::blocked

        AUTH --> MISSION --> DELIB --> QUOTE --> PAY --> COLLAB

        subgraph COLLAB["8. Collaboration open → two parallel node systems"]
            direction TB

            subgraph SYSA["System A: Collaboration + MCP tools<br/>(dead end)"]
                CA1["deploy_package_service<br/>(unique apiSchema → owner)"]:::offchain
                CA2["bind_node_service"]:::offchain
                CA3["submit_node_bid"]:::offchain
                CA4["close_node_bidding(force=true)<br/>*** BEFORE route ***"]:::offchain
                CA5["route_node_task → executing"]:::offchain
                CA6["invoke_node_service<br/>(runs real code)"]:::offchain
                CA7["prepare/submit_node_proof<br/>(EIP-712 NodeProof signature)"]:::offchain
                CA8["prepare/submit_node_chain_commit<br/>*** BEFORE verify ***"]:::offchain
                CA9["verify_node (Tier-1)"]:::offchain
                CA10["finalize_node"]:::offchain
                CA1-->CA2-->CA3-->CA4-->CA5-->CA6-->CA7-->CA8-->CA9-->CA10
            end
            CA8 -.->|"409 collaboration chain node<br/>is not registered yet"| FAULTD1["FAULT D<br/>(same root cause)"]:::blocked
            CA10 -.->|"409 missing_markers:<br/>['chain_node_id']"| FAULTD1

            subgraph SYSB["System B: NeurIPS-native<br/>(the real path completed missions use)"]
                CB1["GET .../proposals<br/>→ workflow.nodes[].live_node_id"]:::offchain
                CB2["POST nodes/{id}/route → Invoked"]:::offchain
                CB3["POST .../commit {output_hash}<br/>→ Committed"]:::offchain
                CB4["POST .../guard → Guarding"]:::offchain
                CB5["POST .../verifying → Verifying"]:::offchain
                CB6["POST .../verify/tier1<br/>(submitted_hash vs expected_hash)"]:::offchain
                CB7["POST .../gated → Gated"]:::offchain
                CB8["POST .../record → Recording"]:::offchain
                CB9["POST .../complete → Completed"]:::offchain
                CB1-->CB2-->CB3-->CB4-->CB5-->CB6-->CB7-->CB8-->CB9
            end
            CB9 --> WORKER["internal settlement worker<br/>(~10s poll, automatic)"]:::offchain
            WORKER -.->|"binding_wait:<br/>'governance chain_node_id is missing'"| FAULTD2["FAULT D — INTERMITTENT<br/>confirmed briefly recovered<br/>2026-07-26 ~06:58-07:00 UTC<br/>(reference mission)"]:::intermittent
        end
    end

    subgraph ON["ON-CHAIN ZONE — NETX testnet (chain 587)<br/>testnetrpc.netxscan.io / testnet.netxscan.io"]
        direction TB
        R1["Relayer 0x84d995ee...<br/>sends createMission() automatically<br/>once both Agreement signatures land"]:::onchain
        MF["MissionFactory<br/>0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828"]:::onchain
        SR["StakingRegistry<br/>0x6F8E4696578447686c8F20270C117ccC46B4f35A"]:::onchain
        AR["AgentRegistry<br/>0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902"]:::onchain
        RR["ReputationRegistry<br/>0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6"]:::onchain
        GR["GovernanceRegistry<br/>(chain_node_id is registered here)"]:::onchain
        R1 --> MF
    end

    A3 -.->|"registerFor() relayed tx"| AR
    Q3 -.->|"stake intent tx"| SR
    P2 -.->|"signatures enable"| R1
    WORKER -.->|"when working:<br/>commit_tx_hash / settle_tx_hash"| GR
    C3 -.-> RR
```

## 2. State machines of the two node systems

### 2a. Collaboration system (MCP tools) — blocked on the final step

```mermaid
stateDiagram-v2
    [*] --> Waiting: bind_node_service
    Waiting --> Eligible: (no pending predecessor)
    Eligible --> Eligible: submit_node_bid
    Eligible --> BidClosed: close_node_bidding(force=true)
    BidClosed --> Executing: route_node_task
    Executing --> Executing: invoke_node_service (runs real code, exit 0)
    Executing --> PendingVerification: submit_node_proof (EIP-712 NodeProof)
    PendingVerification --> PendingVerification: submit_node_chain_commit - 409 chain node not registered yet
    PendingVerification --> PendingFinalization: verify_node (Tier-1 passes)
    PendingFinalization --> [*]: finalize_node - 409 missing_markers chain_node_id

    note right of Executing
        TRAP 1: calling route_node_task
        before close_node_bidding leaves the
        node "executing" PERMANENTLY
        (bid window only open in Eligible)
    end note

    note right of PendingFinalization
        FAULT D: finalize_node and
        submit_node_chain_commit always
        fail here, in either order,
        because chain_node_id is missing
    end note
```

### 2b. NeurIPS-native system — reaches Completed, settlement stalls afterward

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Invoked: POST /route
    Invoked --> Committed: POST /commit {output_hash}
    Committed --> Guarding: POST /guard
    Guarding --> Verifying: POST /verifying
    Verifying --> Verifying: POST /verify/tier1 - submitted_hash == expected_hash
    Verifying --> Gated: POST /gated
    Gated --> Recording: POST /record
    Recording --> Completed: POST /complete
    Completed --> [*]

    note right of Completed
        Reliably reached
        (n1, n2, n3 confirmed 2026-07-27)
        The internal settlement worker
        picks up Completed nodes every ~10s
    end note
```

### 2c. Settlement worker (outside client control)

```mermaid
stateDiagram-v2
    [*] --> binding_wait: node becomes Completed
    binding_wait --> commit_submitted: governance assigns chain_node_id
    commit_submitted --> settle_submitted: settlement tx confirmed
    settle_submitted --> [*]

    binding_wait --> binding_wait: FAULT D intermittent - governance chain_node_id is missing - polls every ~10s, no manual action needed

    note left of binding_wait
        Reference mission (completed):
        this exact step succeeded
        2026-07-26 ~06:58-07:00 UTC,
        ~2h before Fault A's recovery.
        Proof the worker self-heals
        once the backend is healthy.
    end note
```

## 3. Hash traceability

```mermaid
flowchart LR
    classDef hash fill:#f5f3ff,stroke:#6d28d9,color:#2e1065
    classDef missing fill:#fef2f2,stroke:#b91c1c,color:#450a0a,stroke-width:2px
    classDef tx fill:#ecfdf5,stroke:#047857,color:#022c22

    H1["content_hash / metadataURI<br/>(agent registration, IPFS-style URI)"]:::hash
    H2["dag_hash<br/>(codify_proposal → canonical JSON-LD:<br/>minStake=50, minRep=400, feeBps=200,<br/>quorum=0.6, teamSize≥5, bidWindow=900s...)"]:::hash
    H3["code_hash<br/>(deploy_package_service, tied to apiSchema)"]:::hash
    H4["output_hash<br/>(sha256 of node output;<br/>client generates and submits it)"]:::hash
    H5["EIP-712 NodeProof signature<br/>(binds outputHash+nonce+deadline to<br/>contractId/nodeId/agentId)"]:::hash
    H6["client_quote_hash / provider_quote_hash<br/>(embedded in the Agreement EIP-712)"]:::hash
    H7["chain_node_id<br/>*** NEVER ASSIGNED ***<br/>sole root cause of Fault D"]:::missing
    H8["commit_tx_hash"]:::tx
    H9["settle_tx_hash"]:::tx
    H10["mission transaction_hash<br/>(createMission, submitted by the RELAYER,<br/>not by the client)"]:::tx
    H11["direct stake / native payment tx<br/>(client's wallet → StakingRegistry /<br/>MissionFactory)"]:::tx

    H1 --> H2
    H2 --> H3
    H3 --> H4
    H4 --> H5
    H5 -.->|"verify/tier1: submitted_hash == expected_hash"| H4
    H6 --> H10
    H4 --> H7
    H7 -->|"when it IS assigned<br/>(worker healthy)"| H8 --> H9
    H7 -.->|"missing → binding_wait<br/>no settlement tx"| H9

    H10 -.->|"submitted automatically by<br/>0x84d995ee...<br/>once both signatures land"| ONCHAIN["MissionFactory<br/>(NETX testnet, chain 587)"]:::tx
    H11 -.-> ONCHAIN
    H9 -.-> ONCHAIN
```

### Summary table: where each hash/artifact is produced

| Artifact | Produced at | Zone | Status |
|---|---|---|---|
| `content_hash` / `metadataURI` | `POST /api/agents/register/payload` | Off-chain (generated) → On-chain (referenced in `AgentRegistry`) | OK |
| `dag_hash` | `codify_proposal` (deliberation) | Off-chain | OK |
| `code_hash` | `deploy_package_service` | Off-chain | OK |
| `output_hash` | `invoke_node_service` / `commit` (both systems) | Off-chain | OK |
| EIP-712 `NodeProof` signature | `prepare_node_proof` → local signature → `submit_node_proof` | Off-chain (signature) | OK (Collaboration system only) |
| `chain_node_id` | *(never observed on new missions)* | Should be assigned in `GovernanceRegistry` on-chain | **MISSING — Fault D root cause** |
| `commit_tx_hash` / `settle_tx_hash` | Settlement worker, after `chain_node_id` | On-chain | Only seen on the reference mission (intermittent) |
| mission `transaction_hash` | `createMission()` on `MissionFactory` | On-chain | Submitted by the **relayer**, not the client (client's duplicate tx reverts) |
| `client_quote_hash` / `provider_quote_hash` | Agreement EIP-712 generation | Off-chain (signature) → On-chain (referenced) | OK |
| stake / native payment tx | Client's/leader's wallet, signed locally | Direct on-chain | OK |

## 4. Summary of the 4 faults

| # | Component | Endpoints | Symptom | Status |
|---|---|---|---|---|
| A | chain-service (agreements) | `signing-payload`, `eip712-payload` | 500 INTERNAL_ERROR | **Recovered** 2026-07-26 ~09:14 UTC (~8 days down) |
| B | mission actions | `actions/{complete,release}/payload`, `rate/payload` | 500 INTERNAL_ERROR | **Active** — confirmed on both team and simple missions |
| C | Investment Vault | `vault/create/payload`, `vault/mock-setup` | raw 502 / 500 INTERNAL_ERROR | **Active** — mission creation works, only vault instantiation fails |
| D | governance / settlement | `finalize_node`, `submit_node_chain_commit`, settlement worker | `chain_node_id` never assigned | **Intermittent** — confirmed briefly recovered on 2026-07-26; worker self-heals with no manual intervention |

---

*Generated from this session's end-to-end tests against the shared AgentCity
deployment on NETX testnet. See
[`docs/exploracion-2026-07-27.md`](exploracion-2026-07-27.md) (Spanish) for the
step-by-step detail of how each state machine and each fault was discovered.*
