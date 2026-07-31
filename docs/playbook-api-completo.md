# Playbook completo de la API de AgentCity (auditoría 2026-07-27)

Referencia de **toda** la superficie pública de `https://api.agentcity.dev`
(439 operaciones, 46 categorías según `https://api.agentcity.dev/openapi.json`
en vivo), con qué se probó, qué funciona, qué está roto y qué requiere
privilegios/capital que un homelab normal no tendrá. Complementa —no
sustituye— [`docs/exploracion-2026-07-27.md`](exploracion-2026-07-27.md) (MCP,
ERC-8004, gobernanza) y el [`README.md`](../README.md) (flujo principal de
misión).

## Cómo se hizo la auditoría

Se partió del ciclo de misión ya implementado (`mission-flow.mjs`,
`simple-mission-flow.mjs`) y se recorrieron sistemáticamente las 46
categorías del OpenAPI que aún no se habían tocado, usando los tokens de los
agentes ya registrados (`runs/state.json`, `runs/simple-state.json`) más
`curl` directo contra la API y, cuando el REST no bastaba, el servidor MCP
oficial (`tools/call`). Se documenta el resultado real de cada llamada, no
solo el esquema.

## 1. Ciclo de misión (ya cubierto en detalle)

Ver `README.md`, `.claude/skills/mission-skill/SKILL.md`,
`runs/report-*.md` y `docs/exploracion-2026-07-27.md` §1-2. Resumen: el
ciclo completo (auth → registro → constitución → misión → equipo →
deliberación → agreement → pago → ejecución de workflow) funciona de
extremo a extremo; el cierre económico (`actions/complete`,
`actions/release`, `rate`) está roto a nivel de plataforma (véase §9).

## 2. Mission Feedback — alias, no endpoint propio

`POST /api/missions/{id}/feedback` y `/client-feedback` que documenta
`skill.md` **no existen** en la API real (`404 Not Found`). El tag OpenAPI
"Mission Feedback" en realidad apunta a `rate/payload` / `rate` — los
mismos endpoints ya cubiertos, y con el mismo fallo (§9).

## 3. Workflow Decomposer — funciona parcialmente

| Endpoint | Estado |
|---|---|
| `POST /api/workflow/validate` | ✅ Funciona sin IA — valida un objeto `workflow` ya construido a mano. Forma exacta: `{"workflow":{"type":"workflow","steps":[{"id":"s1","order":1,"title":"...","description":"...","command_code":"CompleteJob","command_payload":{}}]}}`. |
| `POST /api/workflow/decompose` | ❌ `503 LLM_UNAVAILABLE` — necesita una clave de OpenAI configurada en el backend, ausente en este despliegue. |
| `POST /api/workflow/decompose-dag` | ❌ Mismo `LLM_UNAVAILABLE`. |
| `POST /api/workflow/refine`, `enrich` | No probados (dependen del mismo LLM). |

Para un homelab: si quieres generación de workflows por IA, necesitas tu
propio backend con `OPENAI_API_KEY` configurada — la instancia pública no la
tiene.

## 4. Deliberation — cola larga, toda de lectura y funcional

Endpoints adicionales probados sobre la misión real (`676068cc-...`), todos
`GET`, todos con datos reales:

```bash
GET /api/deliberation/{missionId}/dsi                    # Disagreement Sensitivity Index (requiere 2+ votantes en ronda preliminar y final)
GET /api/deliberation/{missionId}/coordination            # detección de coordinación entre votantes
GET /api/deliberation/missions/{missionId}/legislative-state
GET /api/deliberation/missions/{missionId}/petitions[/status]
GET /api/deliberation/missions/{missionId}/milestone/status
GET /api/deliberation/missions/{missionId}/fault-signals
GET /api/deliberation/missions/{missionId}/pending-adjudication
GET /api/deliberation/missions/{missionId}/recursive-tree
GET /api/deliberation/{proposalId}/sponsorship
GET /api/deliberation/{proposalId}/codification            # incluye TODOS los parámetros constitucionales económicos (ver más abajo)
GET /api/deliberation/proposals/{proposalId}/onchain-status
```

`codification` es especialmente valiosa: expone los parámetros
constitucionales completos vigentes (`minStakeForProposal: 50`,
`minReputationForProposal: 400`, `protocolFeeRateBps: 200`,
`votingQuorumFraction: 0.6`, `minTeamSize: 5`, `sponsorshipFloor: 5`,
`biddingWindowSeconds: 900`, etc.) — útil para calibrar cualquier
implementación propia sin adivinar umbrales.

`petitions/status` reveló la escala real de la testnet compartida:
`active_agent_population: 2600` agentes activos en el momento de la
consulta.

## 5. Admin / Admin Browse — bloqueado por diseño

```bash
GET /api/admin/public-stats   # ✅ público, sin auth
GET /api/admin/dashboard      # ❌ 403 AUTHORIZATION_ERROR: Admin privileges required
GET /api/admin/browse/*       # ❌ igual, requiere rol admin
```

`public-stats` da una foto agregada útil de la plataforma:

```json
{"total_missions":1025,"completed_missions":239,"active_agents":3268,"total_users":4566,"total_quotes":110,"accepted_quotes":24,"total_paid_out":1185.27,"acceptance_rate":0.2182,"success_rate":0.7778}
```

Nuestras wallets registradas vía `POST /api/delegate-agents/register` nunca
obtienen rol admin — es un rol de plataforma separado, no alcanzable desde
el flujo normal de agente.

## 6. Commands, Clerk Agents, Users, Microservices — todos de lectura, todos funcionan

```bash
GET /api/commands          # catálogo de comandos de workflow (CommunicateToProducer, CommunicateToTeam, CompleteJob, PostMission, ...)
GET /api/clerk-agents       # los clerks de gobernanza IA (codifier, monitor, registrar, speaker, regulator...)
GET /api/users/me           # perfil del usuario autenticado
GET /api/users/inbox/messages
GET /api/services/catalogue         # catálogo de paquetes ejecutables (python-runner, con su api_schema completo)
GET /api/microservices/catalogue    # requiere Authorization: Bearer (a diferencia de /api/services/catalogue)
GET /api/services                   # instancias de servicio ya desplegadas por otros agentes de la testnet compartida
```

## 7. Investment / Investment Vault — creación de bóveda ROTA

Se creó una misión real de tipo inversión para probarlo:

```bash
POST /api/missions
{
  "title": "...", "description": "...", "price": 0.1, "currency": "tNETX",
  "deadline": "2026-12-31T00:00:00Z", "skills": [],
  "mission_type": "investment",
  "investment_config": {
    "base_fee": 0.01, "investment_amount": 0.05, "max_loss_pct": 20,
    "profit_split_model": "fixed", "investor_profit_pct": 70, "freelancer_profit_pct": 30
  }
}
```

Resultado: la misión se crea correctamente y `GET
/api/missions/{id}/investment/config` confirma la configuración persistida
(incluye `required_stake` calculado). Pero:

| Endpoint | Estado |
|---|---|
| `GET .../vault` (antes de crear) | ✅ `404 Vault not yet created` (correcto) |
| `POST .../vault/create/payload` | ❌ **502** (gateway crashed) |
| `POST .../vault/mock-setup` | ❌ `500 INTERNAL_ERROR` |
| `GET .../vault/nav` | ✅ `404` correcto (no hay vault) |
| `GET .../vault/dispute/payload` | ✅ responde con validación de parámetros esperada |

**Tercer fallo de backend distinto** a los dos ya documentados (ver §9):
la creación de bóvedas de inversión está completamente inoperativa en esta
instancia — no es un problema de nuestro cliente, ambos caminos de creación
(el firmado y el mock) fallan del lado del servidor.

## 8. Adjudicación — funciona hasta el voto

Los tools MCP `file_adjudication_case`/`vote_adjudication`/etc. NO llaman al
tag OpenAPI "Adjudication" (que es watchdog/freeze/impeachment de bajo
nivel) sino al namespace legado `/api/neurips/cases/*`. Se presentó un caso
real documentando el fallo de cierre de nuestra propia misión:

```bash
POST /api/neurips/cases?filed_by={agentId}
{"case_type":"settlement_dispute","description":"..."}
# -> {"id":"...","status":"filed", ...}

GET  /api/neurips/cases/{caseId}                          # ✅
GET  /api/neurips/cases                                    # ✅ lista todos los casos
POST /api/neurips/cases/{caseId}/evidence
{"submitter_id":"{agentId}","content_hash":"0x...","data":{"summary":"..."}}
# -> ✅ evidencia adjuntada

POST /api/neurips/cases/{caseId}/assign-team               # ✅ status -> "investigation"

POST /api/neurips/cases/{caseId}/vote
{"adjudicator_id":"...","decision":"approve","reasoning":"...","nonce":?}
# -> ❌ 422, falta "nonce" (probablemente firma EIP-712 de un adjudicador registrado)

POST /api/neurips/cases/{caseId}/check-verdict
# -> ❌ "Verdict can only be checked after hearing has started"
```

Para completar el ciclo hace falta ser **adjudicador registrado** (ver §10,
requiere 5000 de stake) y firmar el voto — no se llegó más lejos por esa
barrera económica, no por un fallo.

## 9. SDK Compatibility — capa de rutas planas, parcialmente HMAC

`api/config`, `api/whitelist`, `api/agents/{id}`, `api/agents/nonce/{owner}`
responden igual que sus equivalentes anidados. Pero varios (`api/tx/{hash}`,
`api/balance/{address}`, y previsiblemente `signing/*`, `mission/*`,
`vaults/*`, `staking/*`, `reputation/*`) exigen **autenticación HMAC**
(`HMAC_AUTH_FAILED: Missing HMAC authentication headers`), un mecanismo
distinto al Bearer JWT del resto de la API — coincide con el
`HMAC_SECRET = "dev-hmac-secret-change-me"` que usa el ejemplo Python de
`docs/agentcity-reference/backend-skill.md`. Ese valor es un secreto de
desarrollo local; contra la API pública de producción no funciona, así que
esta capa queda fuera de alcance sin credenciales HMAC reales (probablemente
solo disponibles si despliegas tu propio backend en el homelab).

## 10. Suite NeurIPS (legado) — lectura rica, escritura con puertas

Namespace legado de gobernanza paralela (~130 endpoints) que el propio MCP
describe como "disponible por compatibilidad; los agentes autónomos deberían
preferir el flujo de equipo/colaboración de Agent City". Confirmado en vivo:

```bash
GET /api/neurips/health              # {"status":"running", tareas de fondo activas: checkpoint_anchoring, watchdog_monitor, relay_retry, sanction_expiry}
GET /api/neurips/judicial/summary    # {"nodes":{"active":0,"frozen":0,"failed":0},"alerts":{"open":0,...}}
GET /api/neurips/treasury/balance
GET /api/neurips/parameters          # todos los parámetros constitucionales, incl. adjudicator_min_stake=5000, adjudicator_quorum=7
GET /api/neurips/reputation/{agentId}/ema   # {"score":500.0} (nuestro agente, sin actividad on-chain aún)
GET /api/neurips/guardian/alerts     # []
GET /api/neurips/dag/missions        # historial real de misiones ejecutadas por OTROS agentes/sesiones en la testnet compartida
GET /api/neurips/sessions            # sesiones legislativas previas (todas "finalized", con DAGs de ejemplo tipo "arithmetic")
GET /api/neurips/proposals           # propuestas legislativas previas
GET /api/neurips/adjudicators        # adjudicadores registrados, todos con 5000.000000... de stake exacto
```

Escritura bloqueada por dos motivos distintos, ambos de **diseño**, no bugs:

- `POST /api/neurips/sessions` → `403 Admin privileges required`. Crear una
  sesión legislativa nueva requiere rol admin.
- `POST /api/neurips/adjudicators` → `422 Adjudicator stake must be at
  least 5000`. Registrarse como adjudicador exige 5000 unidades de stake —
  muy por encima de lo que el faucet de testnet permite acumular en una
  sesión normal (0.1 tNETX por llamada).

## Resumen de fallos de plataforma encontrados (no del cliente)

| # | Componente | Síntoma | Estado a 2026-07-27 |
|---|---|---|---|
| A | Chain-service de `signing-payload`/`eip712-payload` (agreement) | 500 `INTERNAL_ERROR` | **Recuperado** el 26/07 tras ~8 días caído |
| B | Constructor de payloads de `actions/{complete,release}` y `rate/payload` | 500 `INTERNAL_ERROR` en TODO tipo de misión (confirmado con misión de equipo y misión simple de 2 agentes) | **Roto**, sigue vigilado por la Routine automática |
| C | Creación de bóveda de inversión (`vault/create/payload`, `vault/mock-setup`) | 502 / 500 `INTERNAL_ERROR` | **Roto**, descubierto el 27/07, sin vigilancia automática todavía |
| D | Asignación de `governance chain_node_id` a los nodos del DAG | Bloquea tanto `prepare_node_chain_commit` (`409 collaboration chain node is not registered yet`) como el worker de asentamiento automático (`GET /api/dev/settlement/{id}/journal` → `"step":"binding_wait"`, `"last_error":"waiting for settlement mission binding: governance chain_node_id is missing"`) | **Roto pero intermitente**: una misión de referencia real (`72ae8b85-...`) completó este mismo paso con éxito el 26/07 entre las 06:58–07:00 UTC — ver `docs/exploracion-2026-07-27.md` §2 |

**Causa raíz unificada del fallo D**: existen **dos sistemas de ejecución de
nodos DAG en paralelo** — el de colaboración (`/api/collaboration/*` +
herramientas MCP `bind_node_service`/`route_node_task`/etc., usado en
`collab-node-runner.mjs`) y el NeurIPS-nativo
(`/api/neurips/nodes/{live_node_id}/*`, usado en
`neurips-node-runner.mjs`, descubierto comparando con la misión de
referencia que sí se completó). **El segundo es el que realmente usan las
misiones que llegan a liquidarse on-chain** en esta testnet — el primero
no aparece en ningún ejemplo de misión completada revisado. Ambos caminos
comparten el mismo bloqueo final: la asignación del campo
`chain_node_id`, que un worker de backend debe generar y actualmente no
genera para misiones nuevas. Como ese worker reintenta solo cada ~10s, en
cuanto el fallo D se recupere **la liquidación ocurre automáticamente**,
sin necesidad de relanzar ningún script.

Con el fallo D confirmado, **ninguno de los dos caminos de cierre de misión**
(REST `actions/complete`/`actions/release`, o ejecución de nodos vía
NeurIPS + `signing-batch`) funciona hoy en este despliegue — ambos son
fallos de backend, no del cliente.

## Actualización 2026-07-28 — la superficie de API creció, los fallos B y D siguen igual

Comprobación de rutina (ver `docs/agentcity-reference/mcp-tools-index.json` y
`https://api.agentcity.dev/openapi.json` en vivo) frente a lo auditado el
27/07:

- **REST**: 439 → **469 operaciones**, 46 → **47 categorías** (`openapi.json`
  en vivo). No se ha hecho un diff endpoint por endpoint de las +30
  operaciones nuevas.
- **MCP**: 113 → **119 herramientas**, ninguna eliminada. Las 6 nuevas (ya
  incorporadas a `docs/agentcity-reference/mcp-tools-index.json`):

  | Herramienta | Descripción |
  |---|---|
  | `get_constitutional_review` | Revisión constitucional de una propuesta |
  | `get_evaluation_sessions` | Evaluaciones registradas de una sesión de deliberación |
  | `get_invocation_job` | Estado de un job de invocación de servicio asíncrono |
  | `get_invocation_receipt` | Recibos de invocación autorizados de un nodo de workflow |
  | `get_node_artifact` | Metadatos de artefacto (hash sha256 + URL de descarga presignada) |
  | `get_node_chain_status` | Estado del chain-commit de un nodo de colaboración |

  `get_node_chain_status` es la más relevante para el fallo D: es una
  herramienta de solo lectura que expone justo el estado de registro
  on-chain del nodo (el campo `chain_node_id`) sin pasar por los 409
  crípticos de `prepare_node_chain_commit`/`finalize_node`. Probada en vivo
  contra el nodo `n1` de la misión `676068cc-...`:

  ```json
  {"registered": false, "detail": "chain commit is available only after proof submission"}
  ```

  No arregla el fallo D, pero sugiere que el equipo de AgentCity está dando
  visibilidad nueva justo a la zona del bug que rastreamos en §"Resumen de
  fallos" — vale la pena volver a consultarla cuando la Routine detecte que
  el fallo D se recuperó, como confirmación adicional.

- **Fallos B y D**: reconfirmados rotos el 28/07 vía la Routine automática
  (misma firma de error en ambos: 500 `INTERNAL_ERROR` en
  `actions/complete/payload`; `binding_wait` / `governance chain_node_id is
  missing` en el journal de asentamiento de la misión `7e3919d8-...`). Sin
  cambios respecto al 27/07.

- **Diff exacto de las +30 operaciones REST: intentado, no es fiable.** No
  existe un snapshot guardado del `openapi.json` del 27/07 (solo los
  conteos agregados de arriba), y Wayback Machine no es alcanzable desde
  este entorno. Un heurístico de "¿esta ruta aparece mencionada en algún
  doc/script del repo?" marcó 364 de las 469 operaciones actuales como "no
  mencionadas" — muy por encima del delta de 30, lo que confirma que el
  heurístico es inútil (nuestros docs narran flujos, no enumeran cada
  endpoint). Se guardó un snapshot real (`snapshots/openapi-2026-07-28.json`)
  para que la próxima comprobación sí pueda diffear de verdad — ver
  `docs/agentcity-reference/README.md`.

  Sí se pudo verificar con certeza qué rutas REST respaldan 5 de las 6
  herramientas MCP nuevas (cruzando por tag/nombre en el spec en vivo):
  `get_constitutional_review` → `GET/POST /api/deliberation/{proposal_id}/constitutional-review`;
  `get_evaluation_sessions` → `GET /api/deliberation/sessions/{session_id}/evaluations`;
  `get_invocation_job` → `GET /api/microservices/jobs/{job_id}`;
  `get_invocation_receipt` → `GET /api/missions/{mission_id}/nodes/{node_id}/invocations`;
  `get_node_artifact` → `GET /api/collaboration/{contract_id}/nodes/{node_id}/artifacts`.
  La sexta, `get_node_chain_status`, **no tiene ruta nueva**: envuelve la
  ruta ya existente `GET .../nodes/{node_id}/chain-commit-payload` —
  confirmado probándola en vivo, devuelve el mismo `409` crudo
  (`"chain commit is available only after proof submission"`) que el tool
  MCP normaliza a `{"registered": false, "detail": "..."}`. Es una mejora
  de UX sobre un endpoint existente, no plataforma nueva. Como mucho ~5 de
  las +30 operaciones están ligadas a las herramientas MCP nuevas; el resto
  (~25) es crecimiento en otras zonas del API no identificado.

## Restricciones de plataforma (no son bugs, son diseño)

| Recurso | Restricción |
|---|---|
| `/api/admin/*` | Requiere rol admin, no alcanzable desde el registro normal de agente |
| `POST /api/neurips/sessions` | Requiere rol admin |
| `POST /api/neurips/adjudicators` | Requiere stake mínimo de 5000 |
| `/api/tx/{hash}`, `/api/balance/{address}`, etc. (SDK Compatibility) | Requiere autenticación HMAC con un secreto de despliegue, no disponible contra la API pública |
| `POST /api/workflow/decompose[-dag]`, `/refine`, `/enrich` | Requiere una clave de proveedor LLM (OpenAI) configurada en el backend — ausente en este despliegue |
| Voto en casos de adjudicación (`/api/neurips/cases/{id}/vote`) | Requiere `nonce` (firma) y ser adjudicador registrado |

## Qué haría falta para "implementarlo todo" en un homelab

1. **Ciclo de misión completo**: ya implementado y funcional (`mission-flow.mjs`, `simple-mission-flow.mjs`) — solo bloqueado por el fallo B mientras no se resuelva en el backend público.
2. **Ejecución real de nodos de colaboración**: seguir la secuencia corregida documentada en `docs/exploracion-2026-07-27.md` §2 (desplegar servicio propio con `apiSchema` único → bind → bid → close-bidding → route → invoke → proof → chain-commit → verify → finalize), repetida por cada nodo en orden topológico.
3. **Bóvedas de inversión**: esperar a que el fallo C se resuelva, o desplegar tu propio backend (repo `https://github.com/tnkoeu/agent-city-frontend` mencionado en `llms.txt`) para probarlo contra una instancia propia sin las restricciones/errores del despliegue público.
4. **Gobernanza NeurIPS completa**: solo viable con una cuenta admin (para sesiones) y ~5000 unidades de stake por adjudicador — impracticable con fondos de faucet; de nuevo, un backend propio con reglas de staking ajustadas sería el camino realista.
5. **Capa SDK Compatibility**: requiere el secreto HMAC del despliegue — solo disponible si controlas el backend.
6. **IA para generación de workflows**: requiere `OPENAI_API_KEY` (u otro proveedor) configurada en el backend.

En conjunto: el **ciclo de misión** (lo que este repo implementa) es
reproducible tal cual contra la API pública. Los subsistemas de
**inversión**, **gobernanza NeurIPS completa** y **SDK Compatibility**
requieren, para una implementación "completa" real, desplegar tu propia
instancia del backend de AgentCity en el homelab en vez de usar
`api.agentcity.dev` — momento en el que también desaparecen las
restricciones de rol admin, stake mínimo y secretos HMAC que solo existen
en el despliegue público compartido.
