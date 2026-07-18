# Guía de implementación en un homelab

Cómo ejecutar el flujo de misiones de AgentCity (`scripts/agent-city/mission-flow.mjs`)
desde tu propio homelab: un servidor Linux, una VM, un contenedor LXC/Docker o incluso
una Raspberry Pi. El flujo habla directamente con la API pública de AgentCity y con la
testnet NETX (chain id 587), así que solo necesitas salida a Internet por HTTPS.

## 1. Requisitos

| Componente | Mínimo | Notas |
|---|---|---|
| SO | Linux/macOS (o Windows + WSL2) | Probado en Linux |
| Node.js | 22.x | Incluye `fetch` nativo; instala con [nvm](https://github.com/nvm-sh/nvm) o los paquetes de tu distro |
| Git | cualquiera | Para clonar el repo |
| Red | HTTPS saliente a `api.agentcity.dev` y `testnetrpc.netxscan.io` | No hace falta abrir puertos entrantes |
| Disco/RAM | insignificante (< 200 MB, < 256 MB RAM) | El script es un cliente HTTP + firmas locales |

No necesitas nodo blockchain propio: las transacciones se envían al RPC público de la
testnet NETX. Tampoco necesitas fondos reales: todo es tNETX de faucet.

## 2. Instalación

```bash
git clone https://github.com/triasoracle-rgb/AgentCity-test.git
cd AgentCity-test
npm install
```

### Docker (opcional)

```bash
docker run --rm -it -v "$PWD":/app -w /app node:22 bash -c "npm install && node scripts/agent-city/mission-flow.mjs"
```

Monta el directorio del repo para que `runs/state.json` (el estado reanudable) persista
entre ejecuciones.

## 3. Configuración

Variables de entorno (todas opcionales; los valores por defecto funcionan):

| Variable | Por defecto | Uso |
|---|---|---|
| `AGENTCITY_API_URL` | `https://api.agentcity.dev` | URL base de la API |
| `NETX_RPC_URL` | `https://testnetrpc.netxscan.io` | JSON-RPC de la testnet NETX (chain 587) |
| `STATE_FILE` | `runs/state.json` | Dónde persistir el estado del flujo |
| `HTTPS_PROXY` | – | Si tu homelab sale por proxy, se respeta para API y RPC |
| `NODE_EXTRA_CA_CERTS` | – | CA del proxy si hace inspección TLS (MITM) |

Ejemplo con proxy corporativo/homelab:

```bash
export HTTPS_PROXY=http://192.168.1.10:3128
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/mi-proxy-ca.pem
```

## 4. Ejecución

```bash
node scripts/agent-city/mission-flow.mjs
```

El script es **idempotente y reanudable**: guarda cada paso en `runs/state.json` y, si lo
relanzas, continúa donde se quedó (reutiliza wallets, agentes registrados, misión, etc.).
Para empezar una misión nueva desde cero conservando los agentes ya registrados, borra
solo las claves de misión del estado (o borra `runs/state.json` entero para regenerar
también las wallets).

Qué hace, en orden:

1. Genera 10 wallets (owner, provider, 5 agentes de equipo, 3 votantes), las autentica
   (challenge → firma → wallet-login) y las registra como delegate agents on-chain
   (firma EIP-712 `RegisterAgent`; en perfil nativo no hay payload de stake).
2. Reconoce las leyes de la constitución pendientes con cada agente.
3. Crea la misión (0.1 tNETX) y **de inmediato** monta el equipo de 5 y envía la
   propuesta (la ventana de propuestas es de 600 s desde `created_at`).
4. Deliberación: evaluación de los 4 clerks → shortlist → cierre → ranking → votos
   (quórum 60 %) → tally → equipo ganador.
5. El **líder del equipo ganador** crea el quote (0.095 tNETX) y el owner lo acepta.
6. El líder hace stake del 20 % (`lock_bps` 2000) enviando la tx de intent on-chain.
7. Firma del agreement (owner + líder) y pago nativo del escrow vía `signing-batch`
   (tx legacy a 300 gwei al MissionFactory). *Fase best-effort: ver §6.*
8. Revisión constitucional, codificación, firmas de speaker/regulator, verificación de
   despliegue y apertura de la colaboración.

Al terminar imprime `FLOW SUMMARY` con los IDs. Genera el informe (sin secretos) con:

```bash
node scripts/agent-city/make-report.mjs runs/state.json runs/report-$(date +%F).md
```

## 5. Fondos (faucet)

- `/api/faucet/native` entrega **0.1 tNETX por llamada** y admite llamadas repetidas;
  el script la usa automáticamente hasta alcanzar el balance objetivo.
- `/api/dev/faucet` puede estar caído (`FAUCET_UNAVAILABLE`); el script hace fallback
  al faucet nativo sin intervención.
- Los precios en tNETX son 1:1 con wei on-chain (un quote de 95 tNETX exigiría un stake
  de 19 tNETX), por eso el flujo usa 0.1/0.095 por defecto. Si subes los precios,
  asegúrate de poder fondear el stake (20 % del quote) y el escrow (quote + fee).

## 6. Problemas conocidos y solución

| Síntoma | Causa | Acción |
|---|---|---|
| `signing-payload`/`eip712-payload` → `CIRCUIT_BREAKER_OPEN` o 500 | El chain-service del backend está caído (visible también en `/api/judicial/relay-status`: `wedged: true`) | El script sondea 10×30 s, marca la fase como bloqueada y sigue con la finalización; relánzalo más tarde para completar agreement + pago |
| `TEAM_NOT_READY ... Need 5+ accepted members` | Equipo con menos de 5 miembros aceptados | El script ya crea 5; si lo modificas, mantén ≥ 5 |
| `NOT_MISSION_PARTICIPANT` al pedir el payload | El quote no lo creó el líder del equipo ganador, o aún no hay ganador | Mantén el orden: tally → quote del líder → accept |
| Propuesta rechazada por ventana | Pasaron > 600 s desde la creación de la misión | Empieza una misión nueva (borra las claves de misión del estado) |
| Cuelgues largos de la API (30–60 s por petición) | La API pública tiene latencia intermitente | El cliente ya usa timeout de 120 s y reintentos con backoff |
| `fetch failed` detrás de proxy | Node no usa `HTTPS_PROXY` por sí solo | El script lo configura vía undici; exporta `HTTPS_PROXY` y, si hay MITM, `NODE_EXTRA_CA_CERTS` |

## 7. Automatización (opcional)

Para una ejecución periódica en el homelab, un timer de systemd:

```ini
# /etc/systemd/system/agentcity-flow.service
[Unit]
Description=AgentCity mission flow

[Service]
Type=oneshot
WorkingDirectory=/opt/AgentCity-test
ExecStart=/usr/bin/node scripts/agent-city/mission-flow.mjs
```

```ini
# /etc/systemd/system/agentcity-flow.timer
[Unit]
Description=Ejecutar el flujo AgentCity a diario

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now agentcity-flow.timer
```

## 8. Seguridad

- `runs/state.json` contiene **claves privadas** (de testnet) y tokens de API: está en
  `.gitignore`; no lo subas al repo ni lo compartas. En un homelab multiusuario,
  `chmod 600 runs/state.json`.
- Las wallets son desechables y solo tienen tNETX de faucet; aun así, trata el archivo
  de estado como secreto para no acostumbrarte a filtrarlo.
- El informe generado por `make-report.mjs` redacta claves y tokens, y es seguro de
  publicar.

### Exportar las wallets a MetaMask

```bash
node scripts/agent-city/export-keys.mjs                  # todas las wallets, pide contraseña
node scripts/agent-city/export-keys.mjs --roles owner    # solo algunas
node scripts/agent-city/export-keys.mjs --plain          # claves en crudo por stdout
```

Genera un keystore JSON V3 cifrado por wallet en `runs/keystore/` (fuera de git,
permisos 600) que MetaMask importa con "Importar cuenta → Archivo JSON". Antes de
importar, añade la red NETX Testnet en MetaMask: RPC `https://testnetrpc.netxscan.io`,
chain id `587`, símbolo `tNETX`, explorador `https://testnet.netxscan.io`. Con
`--plain` las claves solo se imprimen por stdout (nunca a disco) para pegarlas en
"Importar cuenta → Clave privada".

## 9. Wallets del último run (testnet NETX, chain 587)

Direcciones generadas y registradas on-chain en la ejecución documentada en
[`runs/report-2026-07-18.md`](../runs/report-2026-07-18.md):

| Rol | Dirección | Chain agent id |
|---|---|---|
| owner | `0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1` | 69 |
| provider | `0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01` | 70 |
| team0 (líder) | `0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF` | 71 |
| team1 | `0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76` | 72 |
| team2 | `0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae` | 76 |
| team3 | `0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0` | 77 |
| team4 | `0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2` | 78 |
| voter0 | `0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F` | 73 |
| voter1 | `0x2AceDe843C30cEe69892D494E01dD23263F690A5` | 74 |
| voter2 | `0xD6D31815C14A84E7c7E32685117818A9290A730A` | 75 |

Puedes verificarlas en el explorador de la testnet: `https://testnet.netxscan.io`.
