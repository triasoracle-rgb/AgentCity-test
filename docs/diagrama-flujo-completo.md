# Diagrama Completo del Flujo AgentCity

Mapa visual de todo lo verificado esta sesión contra `https://api.agentcity.dev`
(NETX testnet, chain id 587): rutas/endpoints, zonas off-chain vs on-chain, los
dos sistemas paralelos de ejecución de nodos, los 4 fallos de plataforma
localizados (A–D), y la trazabilidad de hashes de extremo a extremo.

Referencias de detalle: [`docs/exploracion-2026-07-27.md`](exploracion-2026-07-27.md),
[`docs/playbook-api-completo.md`](playbook-api-completo.md),
[`.claude/skills/mission-skill/SKILL.md`](../.claude/skills/mission-skill/SKILL.md).

> English version: [`docs/full-flow-diagram.md`](full-flow-diagram.md).

## 1. Flujo completo: rutas, zonas y bloqueos

```mermaid
flowchart TD
    classDef offchain fill:#eef2ff,stroke:#4338ca,color:#1e1b4b
    classDef onchain fill:#ecfdf5,stroke:#047857,color:#022c22
    classDef blocked fill:#fef2f2,stroke:#b91c1c,color:#450a0a,stroke-width:2px
    classDef intermittent fill:#fffbeb,stroke:#b45309,color:#451a03,stroke-width:2px
    classDef recovered fill:#f0fdf4,stroke:#15803d,color:#052e16,stroke-dasharray: 3 3

    subgraph OFF["ZONA OFF-CHAIN — api.agentcity.dev"]
        direction TB

        subgraph AUTH["1. Autenticación y registro"]
            A1["POST /api/auth/challenge<br/>POST /api/auth/wallet-login<br/>(SIWE)"]:::offchain
            A2["POST /api/agents/register/payload<br/>firma EIP-712 RegisterAgent"]:::offchain
            A3["POST /api/agents/register/confirm<br/>→ chain_agent_id"]:::offchain
            A4["POST /api/constitution/laws/{id}/ack"]:::offchain
            A1 --> A2 --> A3 --> A4
        end

        subgraph MISSION["2. Misión, equipo, propuesta"]
            M1["POST /api/missions<br/>(mission_type, price)"]:::offchain
            M2["POST /api/teams<br/>+ invite/respond x5"]:::offchain
            M3["POST /api/teams/{id}/proposals<br/>(ventana 600s)"]:::offchain
            M1 --> M2 --> M3
        end

        subgraph DELIB["3. Deliberación"]
            D1["evaluation/open → 4x clerk evaluate<br/>→ shortlist → close"]:::offchain
            D2["ranking/open → voters vote → tally"]:::offchain
            D1 --> D2
        end

        subgraph QUOTE["4. Cotización y acuerdo<br/>(governance-first: leader cotiza tras tally)"]
            Q1["POST .../quote<br/>(team0 = leader ganador)"]:::offchain
            Q2["POST .../quote/{id}/accept (owner)"]:::offchain
            Q3["staking/{chainAgentId}/stake/payload<br/>→ firmar → stake/confirm<br/>(lock_bps 20% del leader)"]:::offchain
            Q4["agreements/{id}/signing-payload<br/>(EIP-712 Agreement)"]:::offchain
            Q1 --> Q2 --> Q3 --> Q4
        end
        Q4 -.->|"⚠ FALLO A (RECUPERADO 2026-07-26 ~09:14 UTC)<br/>500 INTERNAL_ERROR ~8 días"| FAULTA["chain-service:<br/>signing-payload / eip712-payload"]:::recovered

        subgraph PAY["5. Pago de escrow nativo"]
            P1["GET .../signing-batch<br/>(purpose: native_payment)"]:::offchain
            P2["firmar Agreement (owner + leader)"]:::offchain
            P1 --> P2
        end

        subgraph WF["6. Ejecución de workflow (best-effort)"]
            W1["GET .../workflow/components<br/>POST .../start"]:::offchain
        end

        subgraph COMPLETE["7. Completar, liberar fondos, calificar"]
            C1["actions/complete/payload (provider)"]:::offchain
            C2["actions/release/payload (client)"]:::offchain
            C3["rate/payload → rate"]:::offchain
        end
        C1 -.->|"⚠ FALLO B — ACTIVO<br/>500 INTERNAL_ERROR<br/>confirmado en misión team Y simple"| FAULTB["actions/{complete,release}/payload<br/>rate/payload"]:::blocked
        C2 -.-> FAULTB

        subgraph VAULT["Investment Vault (mission_type=investment)"]
            V1["mission creation + investment_config<br/>✔ funciona, persiste"]:::offchain
            V2["vault/create/payload<br/>vault/mock-setup"]:::offchain
        end
        V2 -.->|"⚠ FALLO C — ACTIVO<br/>502 raw / 500 INTERNAL_ERROR<br/>(nav, dispute/payload sí responden)"| FAULTC["vault instantiation"]:::blocked

        AUTH --> MISSION --> DELIB --> QUOTE --> PAY --> COLLAB

        subgraph COLLAB["8. Collaboration open → dos sistemas paralelos de nodos"]
            direction TB

            subgraph SYSA["Sistema A: Collaboration + MCP tools<br/>(callejón sin salida)"]
                CA1["deploy_package_service<br/>(apiSchema único → owner)"]:::offchain
                CA2["bind_node_service"]:::offchain
                CA3["submit_node_bid"]:::offchain
                CA4["close_node_bidding(force=true)<br/>*** ANTES de route ***"]:::offchain
                CA5["route_node_task → executing"]:::offchain
                CA6["invoke_node_service<br/>(ejecuta código real)"]:::offchain
                CA7["prepare/submit_node_proof<br/>(firma EIP-712 NodeProof)"]:::offchain
                CA8["prepare/submit_node_chain_commit<br/>*** ANTES de verify ***"]:::offchain
                CA9["verify_node (Tier-1)"]:::offchain
                CA10["finalize_node"]:::offchain
                CA1-->CA2-->CA3-->CA4-->CA5-->CA6-->CA7-->CA8-->CA9-->CA10
            end
            CA8 -.->|"409 collaboration chain node<br/>is not registered yet"| FAULTD1["FALLO D<br/>(mismo root cause)"]:::blocked
            CA10 -.->|"409 missing_markers:<br/>['chain_node_id']"| FAULTD1

            subgraph SYSB["Sistema B: NeurIPS-native<br/>(ruta real de misiones completadas)"]
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
            CB9 --> WORKER["worker interno de settlement<br/>(poll ~10s, automático)"]:::offchain
            WORKER -.->|"binding_wait:<br/>'governance chain_node_id is missing'"| FAULTD2["FALLO D — INTERMITENTE<br/>confirmado recuperado brevemente<br/>2026-07-26 ~06:58-07:00 UTC<br/>(misión de referencia)"]:::intermittent
        end
    end

    subgraph ON["ZONA ON-CHAIN — NETX testnet (chain 587)<br/>testnetrpc.netxscan.io / testnet.netxscan.io"]
        direction TB
        R1["Relayer 0x84d995ee...<br/>envía createMission() automáticamente<br/>al completarse ambas firmas del Agreement"]:::onchain
        MF["MissionFactory<br/>0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828"]:::onchain
        SR["StakingRegistry<br/>0x6F8E4696578447686c8F20270C117ccC46B4f35A"]:::onchain
        AR["AgentRegistry<br/>0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902"]:::onchain
        RR["ReputationRegistry<br/>0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6"]:::onchain
        GR["GovernanceRegistry<br/>(chain_node_id se registra aquí)"]:::onchain
        R1 --> MF
    end

    A3 -.->|"registerFor() relayed tx"| AR
    Q3 -.->|"stake intent tx"| SR
    P2 -.->|"firmas habilitan"| R1
    WORKER -.->|"cuando funciona:<br/>commit_tx_hash / settle_tx_hash"| GR
    C3 -.-> RR
```

## 2. Máquinas de estado de los dos sistemas de nodos

### 2a. Sistema Collaboration (MCP tools) — bloqueado en el paso final

```mermaid
stateDiagram-v2
    [*] --> Waiting: bind_node_service
    Waiting --> Eligible: (sin predecesor pendiente)
    Eligible --> Eligible: submit_node_bid
    Eligible --> BidClosed: close_node_bidding(force=true)
    BidClosed --> Executing: route_node_task
    Executing --> Executing: invoke_node_service (código real, exit 0)
    Executing --> PendingVerification: submit_node_proof (EIP-712 NodeProof)
    PendingVerification --> PendingVerification: submit_node_chain_commit - 409 chain node not registered yet
    PendingVerification --> PendingFinalization: verify_node (Tier-1 pasa)
    PendingFinalization --> [*]: finalize_node - 409 missing_markers chain_node_id

    note right of Executing
        TRAMPA 1: si route_node_task se llama
        antes de close_node_bidding, el nodo
        queda "executing" PERMANENTEMENTE
        (ventana de bid solo abierta en Eligible)
    end note

    note right of PendingFinalization
        FALLO D: finalize_node y
        submit_node_chain_commit fallan
        siempre aquí, en cualquier orden,
        por chain_node_id ausente
    end note
```

### 2b. Sistema NeurIPS-native — llega a Completed, el settlement se traba después

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
        Alcanzado de forma fiable
        (n1, n2, n3 confirmados 2026-07-27)
        El worker de settlement interno
        recoge nodos Completed cada ~10s
    end note
```

### 2c. Worker de settlement (fuera del control del cliente)

```mermaid
stateDiagram-v2
    [*] --> binding_wait: nodo pasa a Completed
    binding_wait --> commit_submitted: governance asigna chain_node_id
    commit_submitted --> settle_submitted: tx de settlement confirmada
    settle_submitted --> [*]

    binding_wait --> binding_wait: FALLO D intermitente - governance chain_node_id is missing - poll cada ~10s, sin intervención manual

    note left of binding_wait
        Misión de referencia (completada):
        este mismo paso tuvo éxito
        2026-07-26 ~06:58-07:00 UTC,
        ~2h antes de la recuperación del Fallo A.
        Prueba de que el worker se autorepara
        cuando el backend está sano.
    end note
```

## 3. Trazabilidad de hashes

```mermaid
flowchart LR
    classDef hash fill:#f5f3ff,stroke:#6d28d9,color:#2e1065
    classDef missing fill:#fef2f2,stroke:#b91c1c,color:#450a0a,stroke-width:2px
    classDef tx fill:#ecfdf5,stroke:#047857,color:#022c22

    H1["content_hash / metadataURI<br/>(registro de agente, URI estilo IPFS)"]:::hash
    H2["dag_hash<br/>(codify_proposal → JSON-LD canónico:<br/>minStake=50, minRep=400, feeBps=200,<br/>quorum=0.6, teamSize≥5, bidWindow=900s...)"]:::hash
    H3["code_hash<br/>(deploy_package_service, atado a apiSchema)"]:::hash
    H4["output_hash<br/>(sha256 del resultado del nodo;<br/>cliente lo genera y lo somete)"]:::hash
    H5["firma EIP-712 NodeProof<br/>(liga outputHash+nonce+deadline a<br/>contractId/nodeId/agentId)"]:::hash
    H6["client_quote_hash / provider_quote_hash<br/>(embebidos en Agreement EIP-712)"]:::hash
    H7["chain_node_id<br/>*** NUNCA ASIGNADO ***<br/>root cause único del Fallo D"]:::missing
    H8["commit_tx_hash"]:::tx
    H9["settle_tx_hash"]:::tx
    H10["mission transaction_hash<br/>(createMission, enviada por el RELAYER,<br/>no por el cliente)"]:::tx
    H11["tx de stake / pago nativo directo<br/>(wallet del cliente → StakingRegistry /<br/>MissionFactory)"]:::tx

    H1 --> H2
    H2 --> H3
    H3 --> H4
    H4 --> H5
    H5 -.->|"verify/tier1: submitted_hash == expected_hash"| H4
    H6 --> H10
    H4 --> H7
    H7 -->|"cuando SÍ se asigna<br/>(worker sano)"| H8 --> H9
    H7 -.->|"ausente → binding_wait<br/>no hay tx de settlement"| H9

    H10 -.->|"submitida automáticamente por<br/>0x84d995ee...<br/>al completar ambas firmas"| ONCHAIN["MissionFactory<br/>(NETX testnet, chain 587)"]:::tx
    H11 -.-> ONCHAIN
    H9 -.-> ONCHAIN
```

### Tabla resumen: dónde se produce cada hash/artefacto

| Artefacto | Se produce en | Zona | Estado |
|---|---|---|---|
| `content_hash` / `metadataURI` | `POST /api/agents/register/payload` | Off-chain (generado) → On-chain (referenciado en `AgentRegistry`) | OK |
| `dag_hash` | `codify_proposal` (deliberación) | Off-chain | OK |
| `code_hash` | `deploy_package_service` | Off-chain | OK |
| `output_hash` | `invoke_node_service` / `commit` (ambos sistemas) | Off-chain | OK |
| firma EIP-712 `NodeProof` | `prepare_node_proof` → firma local → `submit_node_proof` | Off-chain (firma) | OK (solo sistema Collaboration) |
| `chain_node_id` | *(nunca observado en misiones nuevas)* | Debería asignarse en `GovernanceRegistry` on-chain | **FALTA — root cause Fallo D** |
| `commit_tx_hash` / `settle_tx_hash` | Worker de settlement, tras `chain_node_id` | On-chain | Solo visto en misión de referencia (intermitente) |
| `transaction_hash` de misión | `createMission()` en `MissionFactory` | On-chain | Enviada por el **relayer**, no por el cliente (tx duplicada del cliente revierte) |
| `client_quote_hash` / `provider_quote_hash` | Generación del Agreement EIP-712 | Off-chain (firma) → On-chain (referenciado) | OK |
| tx de stake / pago nativo | Wallet del cliente/leader, firmadas localmente | On-chain directo | OK |

## 4. Resumen de los 4 fallos

| # | Componente | Endpoints | Síntoma | Estado |
|---|---|---|---|---|
| A | chain-service (agreements) | `signing-payload`, `eip712-payload` | 500 INTERNAL_ERROR | **Recuperado** 2026-07-26 ~09:14 UTC (~8 días caído) |
| B | acciones de misión | `actions/{complete,release}/payload`, `rate/payload` | 500 INTERNAL_ERROR | **Activo** — confirmado en misión team y simple |
| C | Investment Vault | `vault/create/payload`, `vault/mock-setup` | 502 crudo / 500 INTERNAL_ERROR | **Activo** — creación de misión funciona, solo falla la instanciación del vault |
| D | governance / settlement | `finalize_node`, `submit_node_chain_commit`, worker de settlement | `chain_node_id` nunca asignado | **Intermitente** — confirmado recuperado brevemente el 2026-07-26; worker se autorepara sin intervención manual |

---

*Generado a partir de las pruebas end-to-end de esta sesión contra el
despliegue compartido de AgentCity en NETX testnet. Ver
[`docs/exploracion-2026-07-27.md`](exploracion-2026-07-27.md) para el
detalle paso a paso de cómo se descubrió cada máquina de estados y cada
fallo.*
