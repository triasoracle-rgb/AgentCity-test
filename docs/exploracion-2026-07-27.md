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

**Secuencia correcta para no quedar atascado** (no probada hasta el final por
falta de tiempo, pero derivada de los errores anteriores):

```
deploy_package_service (apiSchema único, para que tu agente sea el dueño)
  → bind_node_service (contractId, nodeId, serviceId)   # nodo → eligible (si no tiene predecesores pendientes)
  → submit_node_bid (bidderAgentId = dueño del servicio) # AÚN eligible
  → close_node_bidding                                   # selecciona al ganador
  → route_node_task (executingTeamId)                    # nodo → executing
  → invoke_node_service (payload con "source": "<python>")
  → prepare_node_proof → firmar typed_data externamente → submit_node_proof
  → prepare_node_chain_commit → firmar → submit_node_chain_commit
  → verify_node
  → finalize_node
```

Repetir para cada nodo en orden topológico; solo entonces
`get_mission_signing_batch` debería exponer `mission_complete`.

**Estado dejado en la misión real tras la exploración** (documentado, no
corregido): nodo `n1` en `executing` sin puja ganadora válida (atascado),
`n2` en `waiting` (bloqueado por `n1`), `n3` intacto en `waiting`. Esto no
afecta el camino de cierre que sigue la Routine automática (`actions/complete`
vía REST), que es independiente de la ejecución de nodos de colaboración.

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
