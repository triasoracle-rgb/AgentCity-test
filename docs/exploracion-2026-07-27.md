# Exploración adicional de AgentCity (2026-07-27)

Con el cierre económico de la misión de equipo bloqueado por un fallo de backend
(ver [`runs/report-2026-07-27.md`](../runs/report-2026-07-27.md)), se exploraron
en paralelo cinco vías adicionales de la plataforma. Cada sección incluye los
comandos exactos para replicarlo desde un homelab.

## 1. Diagnóstico: ¿el fallo de `actions/complete` es específico del camino de equipo?

**Script**: [`scripts/agent-city/simple-mission-flow.mjs`](../scripts/agent-city/simple-mission-flow.mjs)
implementa el camino simple de 2 agentes de `docs/agentcity-reference/backend-skill.md`
(sin equipo, sin deliberación): cliente publica misión → un único proveedor
cotiza → acepta → firman el agreement → pago del escrow → ejecución del
workflow → `actions/complete` → `actions/release` → rating → reputación.

```bash
node scripts/agent-city/simple-mission-flow.mjs
```

Estado persistido en `runs/simple-state.json` (gitignored, independiente del
estado de la misión de equipo).

**Resultado**: misión `690efe2a-4604-4700-81f1-46bc028356e0` desplegada
on-chain (`0x2071d3b2...`), workflow completado, pero `actions/complete/payload`,
`actions/release/payload` y `rate/payload` fallan con el **mismo**
`INTERNAL_ERROR` que en la misión de equipo. **Conclusión: el fallo es de
plataforma, no específico del camino de equipo/colaboración.**

## 2. El servidor MCP oficial y el camino "canónico" de finalización

**Conexión** (streamable HTTP, JSON-RPC 2.0; requiere `Accept: application/json,
text/event-stream`):

```bash
curl -sS -X POST https://mcp.agentcity.dev \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}'
```

Listar herramientas (113 disponibles; índice guardado en
[`docs/agentcity-reference/mcp-tools-index.json`](agentcity-reference/mcp-tools-index.json)):

```bash
curl -sS -X POST https://mcp.agentcity.dev \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Leer el recurso guía (snapshot completo en
[`docs/agentcity-reference/mcp-canonical-mission-flow.json`](agentcity-reference/mcp-canonical-mission-flow.json)):

```bash
curl -sS -X POST https://mcp.agentcity.dev \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"agentcity://guide/canonical-mission-flow"}}'
```

Llamar una herramienta (`tools/call`, con `authToken` = el JWT del participante):

```bash
curl -sS -X POST https://mcp.agentcity.dev \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"<tool_name>","arguments":{"authToken":"...", "...": "..."}}}'
```

### Hallazgo principal: hay dos caminos de finalización distintos

- **Camino documentado en `skill.md`/`backend_skill.md`** (el que implementamos
  primero): `actions/complete` → `actions/release` → `rate`. Roto en producción
  (ver §1).
- **Camino "canónico" según el propio MCP** (versión
  `investor-demo-native-finality-2026-07-25`): tras finalizar **todos** los
  nodos de colaboración, `get_mission_signing_batch` expone los purposes
  `mission_complete` (firma el líder) y `funds_release` (firma el cliente) —
  **no** son los mismos endpoints REST `actions/{name}`. Cada nodo debe pasar
  por: `bind_node_service` (o competitivo con `submit_node_bid`) →
  `route_node_task` → `invoke_node_service` → `prepare_node_proof` →
  `submit_node_proof` → `prepare_node_chain_commit` → `submit_node_chain_commit`
  → `verify_node` → `finalize_node`.

### Reglas reales del ciclo de vida de un nodo (descubiertas en vivo, no solo leídas)

Se probó el ciclo sobre la colaboración real `470ebaa2-...` (misión de equipo),
nodos `n1`/`n2`/`n3`:

1. `deploy_package_service` con `catalogueName: "python-runner"` **sin**
   `apiSchema` reutiliza un servicio de catálogo ya existente **propiedad de
   otro agente** (`owner_agent_id` distinto al nuestro) — no crea uno nuevo.
   Para que tu propio agente sea dueño del servicio (necesario para pujar),
   hay que pasar un `apiSchema` único por ejecutor.
2. `bind_node_service` deja el nodo en `eligible` **solo si no tiene
   predecesores pendientes**; si depende de un nodo previo no completado,
   queda en `waiting` aunque el bind se acepte.
3. **Trampa de estado**: `route_node_task` se puede llamar inmediatamente tras
   `bind_node_service` sin pasar por `submit_node_bid`/`close_node_bidding`.
   El nodo pasa a `executing`, pero `invoke_node_service` entonces falla con
   `403 FORBIDDEN — Agent ... is not the winning bidder`, porque nunca se
   generó un registro de puja ganadora. Y ya no se puede pujar
   retroactivamente: `submit_node_bid`/`close_node_bidding` exigen que el
   nodo esté `eligible`, no `executing`. **El nodo queda permanentemente
   atascado.** Esto le pasó a nuestro nodo `n1` real durante la exploración.
4. `submit_node_bid` exige `BIDDER_NOT_SERVICE_OWNER` si el agente que puja no
   es el dueño del `ServiceContract` — confirma el punto 1: hace falta
   desplegar tu propio servicio con `apiSchema` único antes de poder pujar.
5. Los nodos del DAG se ejecutan en **orden estricto de dependencias**: al
   intentar `route_node_task` sobre `n2` (que depende de `n1`), el backend
   devolvió `409 CONFLICT — Predecessor 'n1' is not COMPLETED`. Un nodo
   atascado bloquea todo lo que depende de él.

### Actualización (misma fecha, sesión posterior): secuencia corregida, probada de verdad

Se creó una **tercera misión** (`f4bb14ae-1430-457c-bf8e-c6e267806059`,
colaboración `594ee654-...`) específicamente para validar la secuencia
corregida con `scripts/agent-city/collab-node-runner.mjs`. Resultado: **se
llegó mucho más lejos que antes**, ejecutando trabajo real:

```
deploy_package_service (apiSchema único → tu agente es el dueño)
  → bind_node_service (contractId, nodeId, serviceId)
  → submit_node_bid (bidderAgentId = dueño del servicio)
  → close_node_bidding(force=true)   *** ANTES de rutear, si no, atasco permanente ***
  → route_node_task (executingTeamId)                    # nodo → executing
  → invoke_node_service (payload {"source": "<python>"})  # ✅ ejecuta código real, exit_code 0
  → prepare_node_proof → firmar typed_data → submit_node_proof   # nodo → pending_verification
  → prepare_node_chain_commit → firmar → submit_node_chain_commit  *** ANTES de verify_node ***
  → verify_node                                           # nodo → pending_finalization (Tier-1, verificación por hash)
  → finalize_node
```

### Segunda actualización: descartado el orden, es un fallo real de plataforma

Se creó una **cuarta misión** (`7e3919d8-e0a9-4872-8c3b-0582d21302d3`,
colaboración `326a72bc-...`) con `collab-node-runner.mjs` ya corregido para
llamar `prepare_node_chain_commit` **antes** de `verify_node`. Resultado:
`prepare_node_chain_commit` falló igualmente, con un mensaje distinto y más
claro: `409 CONFLICT — collaboration chain node is not registered yet`.
Reintentado tras una espera (por si era una sincronización asíncrona): mismo
error, persistente.

Para confirmar que esto es un fallo real y no otra trampa de orden, se
verificó exhaustivamente en la cuarta misión:

1. `verify_node` **siempre** tiene éxito (verificación Tier-1 por hash,
   `verdict: passed`) y mueve el nodo a `pending_finalization`,
   independientemente de si `chain-commit` se intentó antes o después.
2. `finalize_node` **siempre** falla con `409 Node finalization is awaiting
   on-chain commitment`, `missing_markers: ["chain_node_id"]`.
3. No existe ningún endpoint (REST ni MCP) descubierto que registre ese
   `chain_node_id` — `prepare_node_chain_commit` es el único candidato y
   siempre responde que el nodo "aún no está registrado".

**Conclusión definitiva**: el camino de finalización por nodos de
colaboración está **roto de raíz** en este despliegue — no es un problema
de secuencia (ya se probaron ambos órdenes posibles, `proof→verify→commit`
y `proof→commit→verify`, con el mismo resultado terminal). Es un
**cuarto fallo de plataforma**, distinto de los otros tres:

| Misión | Nodo `n1` | Diagnóstico final |
|---|---|---|
| `676068cc-...` (26/07) | atascado en `executing` | error nuestro: ruteado antes de cerrar la puja |
| `fadd9259-...` (27/07) | atascado en `executing` | mismo error, repetido a propósito para confirmarlo |
| `f4bb14ae-...` (27/07) | atascado en `pending_finalization` | llegó hasta `verify_node`, pero el registro on-chain del nodo nunca se generó |
| `7e3919d8-...` (27/07) | atascado en `pending_finalization` | confirmado con el orden correcto: mismo fallo, no era un problema de secuencia |

`collab-node-runner.mjs` quedó actualizado para tratar el paso de
chain-commit como best-effort (registra el fallo y continúa hacia
`verify_node`/`finalize_node` para completar la documentación del estado,
en vez de abortar).

### Tercera actualización: cómo se encontró la ruta correcta (comparando con una misión ya completada)

Petición del usuario como doble verificación: si hay misiones genuinamente
completadas en la testnet, deberían dar la pista de la ruta correcta.
**Así fue.**

`GET /api/missions?status=completed&limit=100` devolvió 242 misiones con
`status: "completed"`, pero de esas, **66 de 100** en la muestra tenían
además `chain_derived_status: "completed"` (liquidación on-chain real,
distinta de nuestras propias misiones de hoy, que aparecen con
`status: "completed"` pero `chain_derived_status: "in_progress"` — la
misma discrepancia off-chain/on-chain ya documentada). Se inspeccionó en
detalle la más reciente: `72ae8b85-d70f-456e-ac12-8d459311d2ff`
("... public MCP eight-agent smoke", 2026-07-26 06:52–07:01 UTC),
con `contract_status_label: "Resolved"` (estado **5**, no 1/"InProgress"
como las nuestras).

Comparando `GET /api/teams/mission/{id}/proposals` de esa misión contra
la nuestra se descubrió el dato clave: cada nodo del workflow tiene un
campo `live_node_id` (además del `id` corto tipo "n1") que **no** pertenece
al sistema de colaboración (`/api/collaboration/*`) que habíamos estado
usando, sino a un sistema de ejecución NeurIPS-nativo completamente
distinto: `GET /api/neurips/nodes/{live_node_id}`. En la misión de
referencia esos nodos tenían `state: "Completed"`, `onchain_node_id`
(un hash real) y `onchain_settle_tx` (tx real); en la nuestra,
`state: "Idle"` — **nunca se habían tocado**, pese a todo lo que hicimos
vía `/api/collaboration/*`. Los dos sistemas coexisten en paralelo y solo
uno de ellos —el NeurIPS— es el que de verdad liquida la misión.

**Máquina de estados NeurIPS descubierta y verificada en vivo** (probada
con éxito sobre los 3 nodos de la misión `7e3919d8-...`, automatizada en
`scripts/agent-city/neurips-node-runner.mjs`):

```
Idle
  → POST /api/neurips/nodes/{id}/route              → Invoked
  → POST /api/neurips/nodes/{id}/commit {output_hash}      → Committed
  → POST /api/neurips/nodes/{id}/guard               → Guarding
  → POST /api/neurips/nodes/{id}/verifying           → Verifying
  → POST /api/neurips/nodes/{id}/verify/tier1 {submitted_hash, expected_hash}  → (registra el veredicto, no cambia el estado)
  → POST /api/neurips/nodes/{id}/gated               → Gated
  → POST /api/neurips/nodes/{id}/record              → Recording
  → POST /api/neurips/nodes/{id}/complete            → Completed
```

Cada paso devuelve `409 CONFLICT — Cannot transition ... expected <X>` si
se salta uno, así que el orden se descubrió por tanteo directo pero es
**estricto y determinista** — no hay trampas de estado como en el otro
sistema. Los 3 nodos de la misión `7e3919d8-...` llegaron a `Completed`
sin ningún problema.

**Pero el asentamiento final sigue bloqueado — y ahora sabemos por qué,
con precisión milimétrica.** `GET /api/dev/settlement/{missionId}/journal`
(y el equivalente `GET /api/missions/{id}/execution-settlement`, más
detallado) expone el trabajo de un **worker de asentamiento en segundo
plano** que sondea cada ~10s (`GET /api/dev/settlement/status` →
`tick_count` subiendo en vivo, `poll_interval: 10`) e intenta liquidar
cada nodo `Completed`. Para nuestros 3 nodos, tras 11-14 reintentos en 5
minutos, el journal muestra siempre:

```json
{"step": "binding_wait", "last_error": "waiting for settlement mission binding: governance chain_node_id is missing"}
```

Es el **mismo campo exacto** (`chain_node_id`) que bloqueaba
`finalize_node` en el otro sistema — confirma que es una única causa raíz
compartida por ambos caminos, no dos fallos independientes.

**La prueba de que es intermitente, no permanente**: el journal de la
misión de referencia (`72ae8b85-...`) muestra sus 3 nodos con
`"step": "settle_submitted"`, `commit_tx_hash` y `settle_tx_hash` reales
— es decir, **el mismo paso que a nosotros nos falla sí funcionó
ayer, 2026-07-26 entre las 06:58 y las 07:00 UTC**. Esa ventana es
~2 horas *antes* de que detectáramos la recuperación del chain-service
(~09:14 UTC) — sugiriendo que el subsistema que asigna `chain_node_id`
tuvo una ventana de funcionamiento independiente y ya ha vuelto a
fallar hoy.

**Consecuencia práctica importante**: como el worker de asentamiento ya
está reintentando nuestros 3 nodos automáticamente cada ~10s, **no hace
falta relanzar nada manualmente cuando el fallo D se recupere** — el
propio backend completará la liquidación on-chain sin más intervención
nuestra. La Routine automática ahora vigila
`GET /api/dev/settlement/7e3919d8.../journal` en vez de sondear
`prepare_node_chain_commit` directamente, porque es una señal mucho más
limpia y específica.

### Cuarta actualización (2026-08-05): misión de referencia #2 — el hosted demo oficial SÍ llega a `Resolved`

El usuario compartió el detalle completo de
`4aa85111-26ed-469b-95ca-e7bd369cdb5f` ("django__django-13768 direct
finality") tal como lo muestra el frontend
(`https://agentcity.dev/missions/4aa85111-...`). Verificado en vivo contra
la API — es un segundo ejemplo genuino de asentamiento completo, distinto
de la misión de referencia #1 (`72ae8b85-...`, §3 arriba):

- `GET /api/missions/4aa85111-.../onchain` → `contract_status_label:
  "Resolved"` (estado **5**).
- `GET /api/dev/settlement/4aa85111-.../journal` → los 3 nodos
  (`service-analyze`, `service-transform`, `service-validate`) en
  `"step": "settle_submitted"`, cada uno con `onchain_node_id`,
  `commit_tx_hash` y `settle_tx_hash` reales y distintos.
- Ciclo completo (creación → asentamiento) en **~15 minutos**:
  `created_at: 2026-08-05T02:26:13`, último nodo `settled_at:
  2026-08-05T02:39:24`.

**Pero no es una misión "normal" como las nuestras — es el hosted demo
oficial de la plataforma**, y eso importa para no confundirlo con una
señal de recuperación de los fallos B/D:

- La descripción dice explícitamente *"public AgentCity direct-mode
  execution"*.
- El workload (`django__django-13768`) coincide exactamente con
  `GET /api/config` → `runtime.hostedDemo.workloads`, cuyo
  `actorMode` es `"hosted_cached"` (actores/equipos pre-cacheados, no
  agentes registrados por el usuario — los equipos ganadores se llaman
  literalmente `direct-1785896769372 teamA`/`teamB`).
- Reconfirmado el mismo día (05/08) que los fallos B y D seguían activos
  para nuestras misiones vía la Routine automática — así que este camino
  "direct-mode" evidentemente no pasa por el mismo cuello de botella de
  gobernanza (`chain_node_id`) que bloquea las misiones normales.

**Utilidad real de esta misión**: no como prueba de recuperación, sino
como **plantilla de referencia** — el primer ejemplo con todas las
secciones de la UI pobladas con datos reales, útil para mapear cada
sección del frontend a su endpoint:

| Sección de la UI | Endpoint |
|---|---|
| Estado, título, precio, owner | `GET /api/missions/{id}` |
| On-Chain: Resolved, dirección del contrato | `GET /api/missions/{id}/onchain` → `contract_status_label` |
| Execution Branch / DAG nodes / tx de asentamiento | `GET /api/dev/settlement/{id}/journal` |
| Proposals (coste, DAG, co-firmantes) | `GET /api/teams/mission/{id}/proposals` |
| Agent Identity (ERC-8004, NFT #) | `GET https://agentcity.dev/8004scan/api/v1/agents/eip155:587:{registryAddress}:{tokenId}` |
| Sanctions | `GET /api/agents/{agentId}/sanctions` |
| Investment Vault, Mission Actions | `GET /api/missions/{id}/vault`, `GET /api/missions/{id}/signing-batch` (requieren auth) |

### Respuesta final a "¿puedo completar una misión con un agente hoy?"

No, por ninguno de los dos caminos — pero ahora con una causa raíz común,
precisa y con nombre (`governance chain_node_id` no se asigna), en vez de
dos fallos aparentemente independientes. Ambos son fallos de backend ajenos
al cliente. Todo el trabajo del lado del cliente está terminado y listo:

- `mission-flow.mjs` — completa la misión por el camino REST en cuanto el
  fallo B se recupere.
- `collab-node-runner.mjs` — camino de colaboración (documentado, pero
  probablemente redundante frente al hallazgo de esta sección).
- `neurips-node-runner.mjs` — el camino que **de verdad usan las misiones
  que se completan** en esta testnet; lleva los nodos a `Completed` de
  forma fiable y solo espera a que el worker de asentamiento del backend
  vuelva a asignar `chain_node_id` para terminar solo.

## 3. Registros ERC-8004 (identidad/reputación/validación) vía 8004-Scan

`https://agentcity.dev/8004scan` es un **indexador universal multi-cadena**
(20 registros activos en 8+ chains — Ethereum, Base, BSC, NETX testnet, etc.
— con cientos de miles de agentes indexados globalmente, no solo los de
AgentCity).

Listar los registros conocidos:

```bash
curl -sS "https://agentcity.dev/8004scan/api/v1/registries"
```

En NETX testnet (chain 587) hay dos registros indexados: el ERC-8004 Identity
canónico (`0x4250eb41fbb899fc08d613f9bffcacf694af3fcf`, 1005 agentes) y el
AgentRegistry propio de AgentCity (`0x2ba3c3b8aa9afceff6501e979d2c62566ee20902`,
995 agentes — el mismo que expone `GET /api/config`).

Consultar un agente por ID canónico `eip155:{chainId}:{registryAddress}:{agentId}`
(dirección del registro en minúsculas):

```bash
curl -sS "https://agentcity.dev/8004scan/api/v1/agents/eip155:587:0x2ba3c3b8aa9afceff6501e979d2c62566ee20902:69"
```

Nuestro agente owner (id 69) aparece indexado, con `reputation.count: 0` y
`validations.count: 0` — coherente con que `rate`/`release` nunca llegaron a
ejecutarse on-chain (§1 y el informe del 26/07).

## 4. Exportar wallets a MetaMask (re-verificado)

Ya documentado en [`docs/guia-homelab.md`](guia-homelab.md#exportar-las-wallets-a-metamask);
se re-verificó en esta sesión que `scripts/agent-city/export-keys.mjs` sigue
generando keystores V3 cifrados con verificación de ida y vuelta correcta.
No se generó ningún keystore permanente en el repo — la exportación real debe
ejecutarla el usuario con su propia contraseña.

## 5. Gobernanza de solo lectura: constitución, sanciones, reputación

```bash
# 19 leyes activas (ACCOUNTABILITY, AUDITABILITY, CONSTITUTIONAL_INTEGRITY,
# HONESTY, LAWFUL_AUTHORITY, NO_CIRCUMVENTION, NON_HARM, PRIVACY_CONSENT,
# SAFETY_OVERRIDE, y varias PRODE2E_* de pruebas internas de la plataforma)
curl -sS https://api.agentcity.dev/api/constitution

# Sanciones de un agente (vacío para el nuestro — sin incidentes)
curl -sS https://api.agentcity.dev/api/agents/{agentId}/sanctions

# Leaderboard de reputación (agentes de otros usuarios en la misma testnet compartida)
curl -sS "https://api.agentcity.dev/api/reputation/leaderboard?limit=5"

# Estado del relay judicial (los signers de settlement)
curl -sS https://api.agentcity.dev/api/judicial/relay-status
```

El relay judicial, que el 18/07 mostraba `wedged: true` con signers en
`lowBalance`, ahora reporta `healthy: true, degraded: false, wedged: false`
— coherente con la recuperación del chain-service documentada el 26/07,
aunque el fallo de `actions/*`/`rate` (un componente distinto) sigue activo.

## Resumen de hallazgos para replicar

| Exploración | Script/comando | Resultado |
|---|---|---|
| Aislar el bug de cierre | `node scripts/agent-city/simple-mission-flow.mjs` | Confirmado: fallo de plataforma, no del camino de equipo |
| MCP oficial | `curl` JSON-RPC contra `mcp.agentcity.dev` | 113 herramientas; camino canónico de finalización vía nodos de colaboración, documentado y probado hasta el punto de bloqueo |
| ERC-8004 | `curl https://agentcity.dev/8004scan/api/v1/...` | Indexador multi-cadena confirmado; nuestros agentes indexados con reputación en 0 |
| Exportación MetaMask | `node scripts/agent-city/export-keys.mjs` | Re-verificado, sin cambios necesarios |
| Gobernanza | `curl` a `/api/constitution`, `/api/agents/{id}/sanctions`, `/api/reputation/leaderboard`, `/api/judicial/relay-status` | 19 leyes activas, sin sanciones, relay judicial ya sano |
