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
| E | Bootstrap de actores del Hosted Demo (`start_investor_demo` / `POST /api/demo/runs`) | Falla en la fase `actors_ready` con `{"code":"HOSTED_SMOKE_FAILED","message":"Smoke exited code=1 signal=none"}`, `retryable: false` — a diferencia de B/D, ni el propio backend reintenta solo (`next_actions: operator_review`) | **Roto pero intermitente**: descubierto el 06/08; la misión de referencia #2 (`4aa85111-...`) completó por esta misma ruta el día anterior (05/08) sin problema — ver "Actualización 2026-08-06" abajo |
| F | Cálculo de quórum de ranking (`GET /api/deliberation/sessions/{rankSessionId}/rank-state`) | `eligible_voters` cuenta a los 5 miembros del propio equipo (que NO pueden votar, `CANNOT_VOTE_OWN_TEAM`) en el denominador, pero solo reconoce **1** votante "neutral" elegible pese a haber 3+ wallets externas registradas como votantes — la participación máxima alcanzable queda por debajo del 60% requerido, `can_tally` nunca pasa a `true` | **Regresión confirmada** — descubierto el 07/08 (reportado independientemente por el usuario en su homelab, 4 reproducciones), y reproducido además contra nuestras propias sesiones históricas que SÍ alcanzaron quórum en su momento (ver "Actualización 2026-08-07" abajo). Bloquea la deliberación de CUALQUIER misión de un solo equipo — más temprano en el flujo que B/D |

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

## Actualización 2026-08-03 — `mission.status` se desacopla del estado on-chain real

Al revisar el detalle completo de las dos misiones vigiladas (no solo los
endpoints de acción/asentamiento, sino `GET /api/missions/{id}` entero) se
encontró que **ambas muestran `"status": "completed"`** a nivel de
aplicación, mientras que su estado on-chain real sigue sin cambios:

| Campo | `676068cc-...` (fallo B) | `7e3919d8-...` (fallo D) |
|---|---|---|
| `status` (`GET /api/missions/{id}`) | `completed` | `completed` |
| `chain_derived_status` | `in_progress` | `in_progress` |
| `contract_status_label` (`GET .../onchain`) | `InProgress` | `InProgress` |
| `settled_node_id` | `null` | `null` |
| `updated_at` | 2026-07-27T05:42 | 2026-07-27T06:32 |

No es un cambio reciente — ambos `updated_at` son del 27/07 (el de
`7e3919d8` coincide, al minuto, con el momento en que sus 3 nodos NeurIPS
se llevaron a `Completed`). Nunca se había mirado este campo concreto
antes porque la vigilancia diaria comprueba `actions/complete/payload` y
el journal de asentamiento directamente, no el detalle completo de la
misión.

**Interpretación**: `mission.status` parece reflejar "todo el trabajo del
DAG ha terminado" (todos los nodos en `Completed`), un flag de aplicación
independiente de si el contrato llegó a liquidarse en cadena.
`contract_status_label`/`chain_derived_status` sí reflejan el estado real
del contrato. Se confirmaron los balances on-chain de owner y team0 vía
RPC directo — sin cambios, consistente con que no hubo liberación de
fondos real.

**Implicación práctica**: para detectar una recuperación genuina de los
fallos B o D, `mission.status == "completed"` **no es una señal válida**
— hay que mirar `contract_status_label` (debe dejar de ser `InProgress`)
o `settled_node_id`/`settle_tx_hash` no nulos. La Routine automática ya
usa el criterio correcto (`contract_status_label` distinto de
`InProgress`, o balances cambiados); este hallazgo solo documenta por qué
`mission.status` por sí solo puede inducir a error.

## Actualización 2026-08-05 — misión de referencia #2: el hosted demo oficial sí liquida en cadena

El usuario compartió el detalle de la UI de
`4aa85111-26ed-469b-95ca-e7bd369cdb5f` ("django__django-13768 direct
finality"). Verificado en vivo: es un **segundo ejemplo genuino de
asentamiento completo** (el primero fue `72ae8b85-...`, §"Resumen de
fallos" fila D) — `contract_status_label: "Resolved"` (estado 5), los 3
nodos en `GET /api/dev/settlement/{id}/journal` con
`"step": "settle_submitted"` y `commit_tx_hash`/`settle_tx_hash` reales.
Ciclo completo en ~15 minutos (`created_at` 02:26 → último nodo
`settled_at` 02:39, 2026-08-05).

**No es una misión normal — es el hosted demo oficial** (descripción:
*"public AgentCity direct-mode execution"*; workload `django__django-13768`
coincide con `GET /api/config` → `runtime.hostedDemo.workloads`,
`actorMode: "hosted_cached"`, equipos ganadores literalmente llamados
`direct-... teamA`/`teamB`). Reconfirmado el mismo día que los fallos B y
D seguían activos para nuestras misiones — este camino "direct-mode"
evita el cuello de botella de gobernanza (`chain_node_id`) que bloquea el
flujo normal, probablemente porque los actores/registro ya vienen
pre-provisionados en vez de pasar por el ciclo completo de deliberación +
asignación on-chain.

**Valor real**: primer ejemplo con *todas* las secciones de la UI del
frontend pobladas con datos reales — sirve de plantilla para mapear cada
sección a su endpoint (detalle completo, con la tabla sección↔endpoint,
en `docs/exploracion-2026-07-27.md` §"Cuarta actualización").

## Actualización 2026-08-06 — el Hosted Demo SÍ es replicable, pero hoy está roto (fallo E)

Investigación de si el hosted demo (§ arriba) es disparable por cualquiera,
no solo observable. **Respuesta: sí, completamente.** Tres tools MCP
dedicadas, sin autenticación de ningún tipo:

- `start_investor_demo({requestId})` — arranca un run. Descripción textual
  de la herramienta: *"the calling agent needs no repository, wallet,
  bearer token, or local script"*.
- `get_investor_demo_status({runId})` — sondea el estado.
- `audit_investor_demo({runId})` — evidencia final "libre de secretos"
  (propuestas ganadora/perdedora, transacciones NETX reales, asentamiento
  de nodos, `mission status 5`, payout) para runs exitosos.

Backend REST equivalente (mismo dato, sin pasar por MCP):
`POST /api/demo/runs` (requiere header `X-Hosted-Demo-Token` que el MCP
server posee internamente — por eso la vía MCP es la única abierta al
público), `GET /api/demo/runs/{run_id}`, `GET
/api/demo/runs/{run_id}/evidence`. Un cuarto endpoint,
`POST /api/demo/runs/{run_id}/runner-callback`, requiere
`X-Demo-Runner-Token` — es el callback que usa el runner interno de
AgentCity para reportar progreso; confirma que la ejecución real de las
3 etapas (analyze/transform/validate) corre en infraestructura propia de
AgentCity, no en el cliente.

**Probado en vivo** (`requestId: homelab-probe-1785997051`): el run se
creó correctamente (`run_id: 2992b277-9dca-4a98-9837-ed921ce6a8f8`,
`status: "queued"` → `"running"`), pero falló en ~14s en la fase
`actors_ready`:

```json
{"error":{"code":"HOSTED_SMOKE_FAILED","message":"Smoke exited code=1 signal=none"}}
```

`retryable: false`, `next_actions: [{"action":"operator_review"}]` — a
diferencia de los fallos B y D, aquí **ni el propio backend se reintenta
solo**; requiere intervención manual del operador de la plataforma. Es un
**quinto fallo de plataforma (E)**: el script de bootstrap ("smoke") que
provisiona los actores cacheados del demo está roto. Intermitente, no
permanente — la misión de referencia #2 (`4aa85111-...`) completó por
esta misma ruta el día anterior sin problema.

**Conclusión sobre replicabilidad**: el mecanismo es genuinamente público
y sin fricción (ideal para un homelab — cero setup, cero wallet), pero
hoy no es utilizable porque el bootstrap interno de actores está caído.
No se ha añadido a la Routine automática (que solo vigila B y D); si se
quiere vigilar también E, sería una tercera comprobación diaria con
`start_investor_demo` + poll.

## Actualización 2026-08-07 — Fallo F: techo de quórum de ranking para misiones de un solo equipo

El usuario reportó, desde su implementación homelab (arquitectura de
**un solo equipo** por misión — sin equipos rivales compitiendo), un
bloqueo estructural reproducido **4 veces de forma idéntica e
independiente**: la deliberación nunca alcanza quórum de ranking.
`eligible_voters` cuenta a los 5 miembros del propio equipo (que no
pueden votar su propia propuesta, `CANNOT_VOTE_OWN_TEAM`) en el
denominador, pero solo reconoce **1 votante "neutral" elegible** pese a
tener 3 wallets externas registradas como votantes — la participación
tope queda en 50%, por debajo del 60% requerido, y `can_tally` nunca
pasa a `true`. Su runner ya no se bloquea 6h reintentando (tenía un fix
para abandonar en segundos), pero sin una vía de voto neutral adicional
la misión nunca sale de deliberación.

**Verificado y confirmado como REGRESIÓN de plataforma**, no diseño
original ni particularidad de su setup. Se volvió a consultar en vivo
`GET /api/deliberation/sessions/{rankSessionId}/rank-state` para las 4
sesiones de ranking de nuestra propia misión `7e3919d8-...` — la misma
que SÍ alcanzó quórum y completó deliberación en su momento:

| Cuándo | `eligible_voters` | `eligible_neutral_voters` | `participation` | `quorum_met` |
|---|---|---|---|---|
| Logs históricos, 2026-07-18 a 2026-07-27 (múltiples timestamps, misma `session_id`) | 5 | (implícito) | 0.6 | **true** |
| 2026-08-07 (ahora, mismas 4 `session_id`, mismos `votes_cast:3`) | **6** | **1** | **0.5** | **false** |

Ningún dato cambió del lado cliente — son las mismas sesiones, los
mismos votos ya emitidos. El backend cambió su forma de calcular
`eligible_voters`/`eligible_neutral_voters` en algún punto entre el
27/07 y el 07/08, degradando sesiones que ya habían alcanzado quórum
real a un estado de quórum insuficiente.

**Vía de escape "Speaker `/reintroduce`" descartada**: se probó en vivo
`POST /api/deliberation/missions/{missionId}/reintroduce` — responde
`401 clerk_role_required: "Clerk-only endpoint — send X-Clerk-Role
header"`. `GET /api/clerk-agents` confirma que los roles clerk
(`codifier`, `monitor`, `registrar`, `speaker`, `regulator`) son
identidades fijas y propias del backend ("City Speaker", "City
Registrar", etc.) — no reclamables por ningún agente registrado normal,
mismo patrón de restricción que el rol admin (§"Restricciones de
plataforma" abajo). No hay vía de escape para un operador de homelab
sin acceso privilegiado a la plataforma.

**Consecuencia práctica**: a diferencia de B/D/E (que bloquean el
*cierre* de la misión), el Fallo F bloquea la *deliberación* — mucho
antes en el flujo. Cualquier misión con arquitectura de un solo equipo
(sin equipos rivales genuinamente independientes compitiendo, que es
como está diseñado el homelab del usuario) queda permanentemente varada
sin alcanzar nunca un ganador, y por tanto nunca hay quote, agreement,
pago ni ejecución. Nuestras propias misiones de prueba (§"Resumen de
fallos") ya no podrían volver a pasar por deliberación desde cero hoy,
aunque en su día sí lo consiguieron — la ventana en la que el cálculo
de quórum funcionaba correctamente ya se cerró.

Sin vigilancia automática todavía. Posible causa raíz a investigar más
adelante: qué determina que una wallet externa cuente como "neutral
elegible" (¿reputación mínima? ¿actividad reciente? ¿un umbral
poblacional del pool completo de votantes de la testnet compartida,
degradado con el tiempo?) — no confirmado en esta sesión.

## Actualización 2026-08-14 — estado de los dos faucets, reconfirmado

Prueba en vivo de ambos endpoints de faucet contra la wallet `owner`
(`0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1`):

| Endpoint | Resultado |
|---|---|
| `POST /api/dev/faucet` (`{"wallet_address":"0x...","amount":500}`) | ❌ **503** `SERVICE_UNAVAILABLE` — `{"reason":"FAUCET_UNAVAILABLE"}`. Sigue caído, sin cambios desde el inicio de la sesión (18/07). |
| `POST /api/faucet/native` (`{"to":"0x...","amount":"100000000000000000"}`) | ✅ **200** — `{"success":true,"txHash":"0x8228214bc09db08f67ca739f38d99cd9824a6f398042516bc54df3ec374599f6","balanceAfter":"815346600000000000"}`. Entrega 0.1 tNETX reales, repetible sin problema. |

Transacción real verificable en el explorador de la testnet:
`https://testnet.netxscan.io/tx/0x8228214bc09db08f67ca739f38d99cd9824a6f398042516bc54df3ec374599f6`

Confirma que `mission-flow.mjs` sigue haciendo lo correcto al hacer
fallback automático de `/api/dev/faucet` a `/api/faucet/native` — no
hace falta ningún cambio en el tooling.

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
