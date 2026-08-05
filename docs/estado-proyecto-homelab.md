# Estado del proyecto AgentCity — tracker para homelab

> Documento vivo de consolidación. Reúne todo lo verificado esta sesión
> contra el despliegue público de AgentCity (`https://api.agentcity.dev`,
> NETX testnet, chain id 587) para llevar el seguimiento en el homelab.
> Cada sección enlaza al doc de detalle correspondiente — este archivo es
> el resumen ejecutivo, no sustituye a los demás.
>
> **Última actualización: 2026-08-03.**

## 1. Qué es AgentCity

Marketplace descentralizado donde humanos publican "misiones" y agentes
delegados on-chain cotizan, colaboran en equipo y liquidan el trabajo vía
escrow en NETX testnet. Identidad y reputación combinan registros propios
(`AgentRegistry`, `ReputationRegistry`) con los registros canónicos
ERC-8004 (Identity/Reputation/Validation). Gobernanza constitucional
(deliberación, votación, sanciones) controla qué misiones se aprueban y
cómo se resuelven disputas.

## 2. Configuración de red

| Parámetro | Valor |
|---|---|
| Chain | NETX testnet |
| Chain ID | 587 |
| RPC | `https://testnetrpc.netxscan.io` |
| Explorer | `https://testnet.netxscan.io` |
| Moneda nativa | tNETX (18 decimales) — gas y pago son el mismo activo |
| API base | `https://api.agentcity.dev` |
| MCP server | `https://mcp.agentcity.dev` (streamable HTTP, 119 tools) |
| 8004-Scan (indexador ERC-8004) | `https://agentcity.dev/8004scan/api/v1` |

### Contratos (vía `GET /api/config`, reconfirmado en vivo)

| Contrato | Dirección |
|---|---|
| MissionFactory | `0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828` |
| StakingRegistry | `0x6F8E4696578447686c8F20270C117ccC46B4f35A` |
| AgentRegistry | `0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902` |
| ReputationRegistry | `0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6` |
| GovernanceRegistry | `0x02Fa505012D29c1405EF3592d78f1D9bE9f9bf49` |
| SanctionRegistry | `0x71D916F5aA56eff03128FE5E9c9E662B224186F0` |
| EvidenceAnchor | `0x55930E18EaA8cDD8a6471FB46E526f2546D49323` |
| InvestmentVaultFactory | `0xC7c7d069Ae1bc48F5B7B715BE0B0016BD70ba6da` |
| MockUSDC (`isMock: true`) | `0xe400c07A1ea70228b2148B934278f1fD7A91F1b7` |

ERC-8004 canónico (registro distinto, indexado por 8004-Scan): Identity
`0x4250Eb41FbB899fC08d613f9bffCaCF694af3fCF`, Reputation
`0x9B46De99b2E7CdcBC99cAa5A244AadB7C47fF574`, Validation
`0xADCD9Fc5c5F4e365F2847bB6A68a5Dc3B7a290F5`.

Relayer que paga `createMission()` automáticamente al completarse ambas
firmas del Agreement: `0x84d995ee26754F62B26699F43d945399f6048BdC` (una tx
manual duplicada del cliente revierte porque el relayer ya la pagó).

**Multi-chain / Base**: el backend está fijado a `chainId: 587`
(`paymentMode: "native"`). `chain_id=8453` (Base) en `/api/missions`
devuelve 0 resultados; Base solo existe como ejemplo genérico de "cadena
ERC-20" en el SDK y como red indexada por el 8004-Scan (aparte, no
marketplace de misiones).

## 3. Estado de los fallos de plataforma (no del cliente)

Vigilados a diario por una Routine automática. Última comprobación:
**2026-08-03**, ambos B y D siguen rotos.

| # | Componente | Endpoints | Síntoma | Estado |
|---|---|---|---|---|
| A | chain-service (agreements) | `signing-payload`, `eip712-payload` | 500 `INTERNAL_ERROR` | ✅ **Recuperado** 2026-07-26 ~09:14 UTC (~8 días caído) |
| B | acciones de misión | `actions/{complete,release}/payload`, `rate/payload` | 500 `INTERNAL_ERROR` | ❌ **Activo** — confirmado en misión de equipo y misión simple, cada día desde el 18/07 |
| C | Investment Vault | `vault/create/payload`, `vault/mock-setup` | 502 crudo / 500 `INTERNAL_ERROR` | ❌ **Activo** — creación de misión con `investment_config` funciona, solo falla la instanciación del vault. Sin vigilancia automática |
| D | governance / settlement | `finalize_node`, `submit_node_chain_commit`, worker de asentamiento | `chain_node_id` nunca asignado | ⚠️ **Intermitente** — confirmado recuperado brevemente el 26/07 (misión de referencia real); worker se autorepara solo, sin intervención manual, en cuanto se recupere |

**Causa raíz unificada del fallo D**: existen dos sistemas paralelos de
ejecución de nodos DAG (colaboración vía MCP tools, y NeurIPS-nativo).
Solo el segundo es el que usan las misiones que de verdad se completan en
esta testnet. Ambos comparten el mismo bloqueo final: el campo
`chain_node_id` que un worker de backend debe asignar y hoy no asigna
para misiones nuevas. Detalle completo en
[`exploracion-2026-07-27.md`](exploracion-2026-07-27.md) y el diagrama
Mermaid en [`diagrama-flujo-completo.md`](diagrama-flujo-completo.md).

## 4. Qué funciona de extremo a extremo hoy

1. Generación + autenticación de wallets (SIWE: challenge → firma →
   wallet-login, `nonce` obligatorio en el body).
2. Registro on-chain de agente delegado (firmas EIP-712 register+stake,
   confirmación, espera de `chain_agent_id`).
3. Acknowledgment de leyes constitucionales pendientes.
4. Creación de misión, equipo (5+ miembros), propuesta (ventana 600s).
5. Deliberación completa: evaluación, shortlist, ranking, votación, tally.
6. Cotización **post-tally** por el líder ganador (orden "governance-first"
   — cotizar antes deja el `signing-payload` permanentemente roto).
7. Stake del líder (20% `lock_bps` de la cotización).
8. Firma del Agreement (EIP-712) por ambas partes.
9. Pago de escrow nativo (tNETX) vía signing-batch.
10. Apertura de colaboración + ejecución de nodos DAG hasta `Completed`
    (sistema NeurIPS-nativo, ver §5).

**Bloqueado hoy**: cierre económico final (`actions/complete`,
`actions/release`, `rate` — fallo B) y liquidación on-chain de los nodos
(worker de asentamiento — fallo D). Ninguno de los dos es un problema del
cliente; el tooling está listo y espera a que el backend se recupere.

## 5. Los dos sistemas de ejecución de nodos

| | Sistema Collaboration (MCP) | Sistema NeurIPS-nativo |
|---|---|---|
| Endpoints | `/api/collaboration/*` + tools MCP (`bind_node_service`, `route_node_task`, etc.) | `/api/neurips/nodes/{live_node_id}/*` |
| Script | `collab-node-runner.mjs` | `neurips-node-runner.mjs` |
| Llega a completado | No — atascado en `finalize_node` (fallo D) | Sí, de forma fiable (`route→commit→guard→verifying→verify/tier1→gated→record→complete`) |
| Usado por misiones reales completadas en esta testnet | No, ningún ejemplo encontrado | **Sí** — descubierto comparando con una misión de referencia real completada |

Máquinas de estado completas (diagramas Mermaid) en
[`diagrama-flujo-completo.md`](diagrama-flujo-completo.md) /
[`full-flow-diagram.md`](full-flow-diagram.md) (versión inglés).

## 6. Wallets de prueba (direcciones públicas — claves NUNCA en git)

Todas persistidas en `runs/state.json` (gitignored). Reutilizadas en
misiones sucesivas desde el 18/07.

| Rol | Dirección | agentId |
|---|---|---|
| owner (cliente) | `0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1` | `b07e8489-40a5-4a33-a5e4-3900c47efd37` |
| provider | `0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01` | `4b5e1242-ed84-44f9-b2e3-fba9cf558a30` |
| team0 (líder) | `0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF` | `de04aef3-f1a4-4150-8202-4482b7b53f08` |
| team1 | `0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76` | `d24208e2-b442-4788-8fa1-c2166a3f0c2f` |
| team2 | `0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae` | `77859c24-46ab-4107-80cc-770183173dc6` |
| team3 | `0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0` | `2801c968-3df7-4ebd-a13d-1f3c28a10e1c` |
| team4 | `0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2` | `0fb23142-a392-40de-8bc0-1bc3c45e6bb5` |
| voter0 | `0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F` | `cd73e7a5-6be0-42d9-9c66-c97c3febd41e` |
| voter1 | `0x2AceDe843C30cEe69892D494E01dD23263F690A5` | `cbcc38d0-34a1-443c-87f5-3234bb024bdc` |
| voter2 | `0xD6D31815C14A84E7c7E32685117818A9290A730A` | `a826e2f8-feec-4fba-88c9-274d4d227ec6` |

Exportables a formato MetaMask (keystore V3 cifrado) con
`scripts/agent-city/export-keys.mjs` — ver
[`guia-homelab.md`](guia-homelab.md).

## 7. Misiones de prueba activas

| Mission ID | Propósito | Estado |
|---|---|---|
| `676068cc-05fa-4947-b156-692f1d8a8e7c` | Misión de equipo original (18/07). Usada para vigilar el fallo B (`actions/complete/payload`) | Bloqueada en fallo B — `mission.status: "completed"` pero `contract_status_label: "InProgress"` (ver nota ⚠️ abajo) |
| `7e3919d8-e0a9-4872-8c3b-0582d21302d3` | Misión con los 3 nodos NeurIPS llevados a `Completed` a mano (27/07). Usada para vigilar el fallo D | Nodos completados, esperando asentamiento (worker se autorepara solo) — mismo `mission.status: "completed"` engañoso |
| `690efe2a-4604-4700-81f1-46bc028356e0` | Misión simple de 2 agentes (sin equipo), diagnóstico independiente del fallo B | Confirmó que el fallo B es de plataforma, no de la misión de equipo |
| `72ae8b85-...` (ajena) | Misión de referencia real, completada por otro agente/sesión en la testnet compartida | Usada solo para comparar y descubrir la ruta correcta (§5) |

> ⚠️ **`mission.status` no es fiable como señal de cierre.** Ambas misiones
> vigiladas muestran `"status": "completed"` en `GET /api/missions/{id}`
> desde el 27/07 (en cuanto todos los nodos del DAG llegan a `Completed`),
> pero `contract_status_label` (`GET .../onchain`) sigue en `InProgress` y
> los balances on-chain no cambiaron — no hay liquidación real. Para
> detectar una recuperación genuina hay que mirar `contract_status_label`
> o `settled_node_id`/`settle_tx_hash`, no `mission.status`. Detalle en
> `docs/playbook-api-completo.md` §"Actualización 2026-08-03".

## 8. Scripts del repo

| Script | Qué hace |
|---|---|
| `scripts/agent-city/mission-flow.mjs` | Flujo completo equipo/colaboración, resumible vía `runs/state.json` |
| `scripts/agent-city/simple-mission-flow.mjs` | Flujo mínimo 2 agentes, diagnóstico |
| `scripts/agent-city/trace-all.mjs` | Genera ledger de trazabilidad on-chain de todas las wallets |
| `scripts/agent-city/collab-node-runner.mjs` | Sistema Collaboration (MCP), secuencia corregida bind→bid→close→route→invoke→proof→chain-commit→verify→finalize |
| `scripts/agent-city/neurips-node-runner.mjs` | Sistema NeurIPS-nativo, la ruta que sí llega a `Completed` |
| `scripts/agent-city/export-keys.mjs` | Exporta wallets a keystore MetaMask cifrado |

## 9. Documentación del repo (mapa completo)

| Archivo | Contenido |
|---|---|
| `README.md` | Punto de entrada, cómo correr el flujo |
| `.claude/skills/mission-skill/SKILL.md` | Definición del skill, fuente de verdad del flujo (extendida con workflow/completion/rating) |
| `docs/guia-homelab.md` | Guía de despliegue en homelab (instalación, proxy, faucet, systemd timer) |
| `docs/exploracion-2026-07-27.md` | Exploración MCP/ERC-8004/gobernanza, descubrimiento de la ruta NeurIPS correcta |
| `docs/playbook-api-completo.md` | Auditoría completa de las 47 categorías del OpenAPI (qué funciona, qué está roto, qué requiere privilegios) |
| `docs/diagrama-flujo-completo.md` / `full-flow-diagram.md` | Diagramas Mermaid: rutas, zonas off/on-chain, máquinas de estado, trazabilidad de hashes (ES/EN) |
| `docs/agentcity-reference/` | Espejo local de docs upstream + `mcp-tools-index.json` (119 tools) + `snapshots/` (capturas de `openapi.json` para diffing) |
| `runs/report-*.md`, `runs/trazabilidad-completa-*.md` | Informes de cada corrida (secretos redactados) |

## 10. Superficie de API (para detectar cambios futuros)

| | 2026-07-27 | 2026-07-28 |
|---|---|---|
| Operaciones REST | 439 | 469 (+30, sin diff exacto — ver snapshots) |
| Categorías (tags) | 46 | 47 |
| Herramientas MCP | 113 | 119 (+6, 0 eliminadas) |

Las 6 herramientas MCP nuevas: `get_constitutional_review`,
`get_evaluation_sessions`, `get_invocation_job`, `get_invocation_receipt`,
`get_node_artifact`, `get_node_chain_status` (esta última no es un
endpoint nuevo — envuelve `GET .../chain-commit-payload`, que ya existía,
en una respuesta más limpia). Snapshot guardado en
`docs/agentcity-reference/snapshots/openapi-2026-07-28.json` con script de
diff en `docs/agentcity-reference/README.md` — a partir de ahora los
cambios sí se pueden comparar de verdad.

## 11. Gaps de seguridad conocidos (admitidos por la propia plataforma)

Vía `GET /api/config` → `runtime.knownGapCodes`:

- `shared_runner_no_job_isolation` — sin aislamiento garantizado entre
  jobs (no hay TEE/enclave de hardware; confirmado que AgentCity no
  implementa TEE en ninguna capa).
- `runner_self_attestation` — el propio runner auto-declara qué ejecutó,
  sin verificación de hardware independiente.
- `bid_collateral_not_enforced`
- `reputation_chain_write_unwired`
- `cached_demo_actors`
- `relayer_operational_dependency`
- `netx_funding_dependency`

El modelo de confianza real es firmas EIP-712 + hashes + votación/
deliberación on-chain (`requiredGuarantees: blockchainFinality,
strictExecutionProofs, signedNodeProofs`) — no hardware.

## 12. Vigilancia automática (Routine)

- **ID**: `trig_01B1LYS2dNTTkFrwZnQsko1E`
- **Nombre**: "AgentCity: vigilar fallos B (actions/complete) y D
  (governance chain_node_id)"
- **Cron**: `13 9 * * *` (diaria, ~09:13 UTC)
- **Sesión ligada**: persistente (esta misma conversación)
- **Comportamiento**: si ambos fallos siguen rotos, termina en silencio
  sin comitear. Si alguno se recupera, reautentica wallets, relanza el
  script correspondiente, regenera trazabilidad, comitea/pushea a
  `claude/agentcity-mission-flow-pzij7v` y se autoelimina.
- **Última ejecución**: 2026-08-03 — ambos fallos B y D siguen activos.

## 13. Próximos pasos para el homelab

1. Replicar el proxy/CA (`NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`) — ver
   `docs/guia-homelab.md`.
2. Importar las wallets exportadas (§6) o generar unas nuevas con
   `mission-flow.mjs` desde cero.
3. Levantar un backend propio (repo mencionado en `llms.txt`:
   `tnkoeu/agent-city-frontend`) si se quiere probar sin las
   restricciones/fallos del despliegue público — necesario para: bóvedas
   de inversión (fallo C), gobernanza NeurIPS completa (requiere rol admin
   + 5000 de stake por adjudicador), capa SDK Compatibility (requiere
   secreto HMAC del despliegue).
4. Mientras el despliegue público siga con B/D rotos, todo el tooling
   cliente (`mission-flow.mjs`, `neurips-node-runner.mjs`) ya está listo
   para completar el ciclo económico automáticamente en cuanto se
   recuperen — no requiere cambios.
