# Trazabilidad on-chain completa del flujo AgentCity

Generado: 2026-07-26T09:21:17.666Z · Bloque actual: 780418
Red: NETX testnet (chain id 587) · RPC: https://testnetrpc.netxscan.io · Explorador: https://testnet.netxscan.io

## 1. El flujo AgentCity de forma holística

AgentCity divide el ciclo de vida de una misión en fases **off-chain** (API +
firmas EIP-712 de los agentes) y **on-chain** (transacciones en la testnet NETX).
La cadena solo se toca donde hay valor o identidad en juego:

| Fase | Dónde ocurre | Huella on-chain |
|---|---|---|
| 1. Autenticación de wallets (challenge → firma → login) | API | ninguna (firma personal_sign verificada off-chain) |
| 2. Registro de delegate agents | API + cadena | tx `registerFor()` en AgentRegistry enviada por el **relayer** del backend (`0x84d995ee26754F62B26699F43d945399f6048BdC`) con la firma EIP-712 `RegisterAgent` del agente; la wallet no gasta gas |
| 3. Constitución (acknowledge de leyes) | API | ninguna (firmas EIP-712 archivadas off-chain) |
| 4. Misión + equipo + propuesta | API | ninguna |
| 5. Deliberación (evaluaciones, shortlist, ranking, tally) | API | ninguna (la gobernanza es off-chain; ancla evidencia opcionalmente vía EvidenceAnchor) |
| 6. Stake del líder ganador (20 % del quote) | cadena | tx `stake(agentId, amount)` al StakingRegistry **enviada por la propia wallet** con valor nativo |
| 7. Agreement (owner + líder) | API | firmas EIP-712 sobre el payload construido por el chain-service |
| 8. Pago del escrow | cadena | `createMission()` al MissionFactory (valor = quote + fee). El endpoint `signing-batch` documenta que el *cliente* firma y envía esta tx, pero en la práctica observada el **relayer del backend** la ejecutó automáticamente en cuanto detectó ambas firmas del agreement, sin esperar la tx manual del cliente; una tx manual enviada en paralelo revierte (el contrato ya ha sido creado) |
| 9. Codificación, firmas de clerks, colaboración | API | dag_hash calculado; despliegue verificado |
| 10. Fondeo | cadena | txs del relayer del faucet (`0x84d995ee26754f62b26699f43d945399f6048bdc`) de 0.1 tNETX |

Dos patrones de custodia conviven: las wallets de los agentes firman mensajes
(EIP-712) que el backend releya a la cadena pagando el gas (registro), y firman
transacciones propias cuando mueven su valor (stake, escrow). Por eso la mayoría
de wallets tienen nonce 0 aunque su identidad esté on-chain.

## 2. Libro mayor: todas las transacciones (orden cronológico)

| # | Fecha (UTC) | Bloque | Tx | Propósito | De → A | Valor (tNETX) | Estado |
|---|---|---|---|---|---|---|---|
| 1 | 2026-07-18 00:20:51Z | 539212 | [`0xd02dbfadfd2b…`](https://testnet.netxscan.io/tx/0xd02dbfadfd2b2cc9fe6eb24a31c13c013b8eab1157c64d51f7c2f82a2417b86d) | Registro on-chain del agente (owner) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 2 | 2026-07-18 00:21:09Z | 539218 | [`0x2a45fc24be55…`](https://testnet.netxscan.io/tx/0x2a45fc24be55b41a473002a5aa6b9770b295c55737d37f62dda0a9f508216ea6) | Registro on-chain del agente (provider) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 3 | 2026-07-18 00:21:24Z | 539223 | [`0x135356756a18…`](https://testnet.netxscan.io/tx/0x135356756a18c4c9608e4e7132f6199e649df39657563f0703f14188b448122e) | Registro on-chain del agente (team0) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 4 | 2026-07-18 00:21:39Z | 539228 | [`0x8e10608d70fe…`](https://testnet.netxscan.io/tx/0x8e10608d70fe1d17ee1e6b26c5f71403df32cb98bda10f95fbbe502b94bbf416) | Registro on-chain del agente (team1) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 5 | 2026-07-18 00:23:18Z | 539261 | [`0x6844839adc1d…`](https://testnet.netxscan.io/tx/0x6844839adc1df9e03e1f6eac61d5605ba454bf5f2aefc12b2ddc046fc1ab5368) | Registro on-chain del agente (voter0) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 6 | 2026-07-18 00:23:33Z | 539266 | [`0x146c6191269f…`](https://testnet.netxscan.io/tx/0x146c6191269fc015c11e8c162dd1d737cb3c874aa07aee97695d69b562ccc38b) | Registro on-chain del agente (voter1) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 7 | 2026-07-18 00:23:48Z | 539271 | [`0x703fad16c299…`](https://testnet.netxscan.io/tx/0x703fad16c2990e752dd8b059e2223432bdbd99b92666787fb0870606b5032c46) | Registro on-chain del agente (voter2) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 8 | 2026-07-18 00:25:36Z | 539307 | [`0xfc1374bc40d1…`](https://testnet.netxscan.io/tx/0xfc1374bc40d13ca6108cd0a63cb3d64caa9eac01b661c74baa469418f4e1943d) | Fondeo del faucet → team2 | `0x84d995ee…` → wallet team2 | 0.1 | ✔ |
| 9 | 2026-07-18 00:25:45Z | 539310 | [`0x3e28945b8b94…`](https://testnet.netxscan.io/tx/0x3e28945b8b94f2babdfc56396cca9e36bc787ecbee3982ae6cb1df20aad8a3f0) | Registro on-chain del agente (team2) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 10 | 2026-07-18 00:26:00Z | 539315 | [`0x77dd26e9f386…`](https://testnet.netxscan.io/tx/0x77dd26e9f386993ba2461012524950d404e91c8628d7abec3e1313b6383a5cd5) | Fondeo del faucet → team3 | `0x84d995ee…` → wallet team3 | 0.1 | ✔ |
| 11 | 2026-07-18 00:26:09Z | 539318 | [`0xb12edb9eba77…`](https://testnet.netxscan.io/tx/0xb12edb9eba7795174ea126dfe1259440801898f170d1970e6a2367ef9f072358) | Registro on-chain del agente (team3) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 12 | 2026-07-18 00:26:24Z | 539323 | [`0x19dc249c2a0e…`](https://testnet.netxscan.io/tx/0x19dc249c2a0ebc63dc76640127a6326ec4b46b815439f77734b3687123e909f8) | Fondeo del faucet → team4 | `0x84d995ee…` → wallet team4 | 0.1 | ✔ |
| 13 | 2026-07-18 00:28:00Z | 539355 | [`0xc2bacd9150e5…`](https://testnet.netxscan.io/tx/0xc2bacd9150e52cc5be2f8c64205235ce5442f31cef9a51d3fa23f623bfc29a8b) | Registro on-chain del agente (team4) relayado por el backend | `0x84d995ee…` → agentRegistry | 0 | ✔ |
| 14 | 2026-07-18 00:28:12Z | 539359 | [`0x8a2da321a356…`](https://testnet.netxscan.io/tx/0x8a2da321a356d23f7ebf58bc61c96dfbcb4208b703a8d5f7c1412dd01879c833) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 15 | 2026-07-18 00:28:15Z | 539360 | [`0x5d585d203144…`](https://testnet.netxscan.io/tx/0x5d585d20314476d21ac9df0a9b71a1ac9a722a381d25213f5215a713a8955874) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 16 | 2026-07-18 00:28:21Z | 539362 | [`0x6109e0c9eda2…`](https://testnet.netxscan.io/tx/0x6109e0c9eda2f7ee2dc434b18473161bcfa12b6c83a9ae02598e316ee9857ca6) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 17 | 2026-07-18 00:28:30Z | 539365 | [`0x7ee915591bfc…`](https://testnet.netxscan.io/tx/0x7ee915591bfc328aa8c5308f538e566d36f1735c0006a86b315456625a677e2e) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 18 | 2026-07-18 00:30:42Z | 539409 | [`0x8137356b15ed…`](https://testnet.netxscan.io/tx/0x8137356b15edec9a213a3fa0f1d4099d2d533513bc39dd6eb24b33e19792f748) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 19 | 2026-07-18 00:30:45Z | 539410 | [`0x904a410c4119…`](https://testnet.netxscan.io/tx/0x904a410c4119923fe4e61cdc83d580090e1854270b9bbb2bee474952f94ce82a) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 20 | 2026-07-18 00:33:12Z | 539459 | [`0x834ed5c32725…`](https://testnet.netxscan.io/tx/0x834ed5c3272551e9201e1752920e8cc3ddff8692b124703a92bc3950da89edd1) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 21 | 2026-07-18 00:33:18Z | 539461 | [`0x57a9fb5c8ca6…`](https://testnet.netxscan.io/tx/0x57a9fb5c8ca65b8045435c2f1b9e43bb3c2b8d0948eee5bc304102538360528c) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 22 | 2026-07-18 00:33:21Z | 539462 | [`0xf01e2f155760…`](https://testnet.netxscan.io/tx/0xf01e2f155760478cd1bfa099bb97796c9964c5801943e5d69998467d1940acc6) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 23 | 2026-07-18 00:33:24Z | 539463 | [`0xa0b55f8c32c7…`](https://testnet.netxscan.io/tx/0xa0b55f8c32c7f39251e0cf833ec3bd65b0688e7f628d896cf4afea3723c7bc0b) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 24 | 2026-07-18 00:33:30Z | 539465 | [`0xaf58081986c0…`](https://testnet.netxscan.io/tx/0xaf58081986c0df3866f7e6cf1c419355383764d79bcfa3a2dea6229fa5566480) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 25 | 2026-07-18 00:33:36Z | 539467 | [`0xee2ade979693…`](https://testnet.netxscan.io/tx/0xee2ade979693f9de41b8393e5e0cd6f0b085635a89e1b29ea0a00b397042b31c) | Fondeo del faucet → provider | `0x84d995ee…` → wallet provider | 0.1 | ✔ |
| 26 | 2026-07-18 00:35:12Z | 539499 | [`0x4d708187417b…`](https://testnet.netxscan.io/tx/0x4d708187417bac5ec496f60af787a57c68cf204041f444cda843efcffabda77d) | Stake de colateral (provider) | wallet provider → stakingRegistry | 0.019 | ✔ |
| 27 | 2026-07-18 00:44:39Z | 539688 | [`0x4896807f98bd…`](https://testnet.netxscan.io/tx/0x4896807f98bd2e520c421fde0d149c8810afdb63e963d95cece4314da9bb93bc) | Fondeo del faucet → team0 | `0x84d995ee…` → wallet team0 | 0.1 | ✔ |
| 28 | 2026-07-18 00:44:45Z | 539690 | [`0x522c5f66f954…`](https://testnet.netxscan.io/tx/0x522c5f66f954f19471429c8bc151ceec8f2b0641bec3978ea5d653a4ca85f56e) | Fondeo del faucet → team0 | `0x84d995ee…` → wallet team0 | 0.1 | ✔ |
| 29 | 2026-07-18 00:44:51Z | 539692 | [`0xfcc731f4f1b9…`](https://testnet.netxscan.io/tx/0xfcc731f4f1b9b8a5860c07f9fd98d8c4b6c32233628665da7d6c873d89483e63) | Stake de colateral (team0) | wallet team0 → stakingRegistry | 0.019 | ✔ |
| 30 | 2026-07-26 09:15:00Z | 780295 | [`0xf038c4563cb5…`](https://testnet.netxscan.io/tx/0xf038c4563cb5532975eb74972fd40adf5147997cb6bb5bffaf0f441815bb1f3c) | Pago de escrow de misión relayado por el backend | `0x84d995ee…` → missionFactory | 0.097375 | ✔ |
| 31 | 2026-07-26 09:15:09Z | 780298 | [`0x013e869c0a95…`](https://testnet.netxscan.io/tx/0x013e869c0a95e5864f79d880b2bfe6e6979f4ecc5bd7bcbd353cf44077e2b79b) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 32 | 2026-07-26 09:15:15Z | 780300 | [`0xe2f7cebe67e3…`](https://testnet.netxscan.io/tx/0xe2f7cebe67e30fe1bc3232b8719dd6c4fa2f8a9fdf576fc33aec1731fc9e512c) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 33 | 2026-07-26 09:15:21Z | 780302 | [`0x6346fe8912c0…`](https://testnet.netxscan.io/tx/0x6346fe8912c06c646e6249956763100ea8145c362beee09b34b6542e52f89f1d) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 34 | 2026-07-26 09:15:27Z | 780304 | [`0xeba384c1c372…`](https://testnet.netxscan.io/tx/0xeba384c1c37225134bead6abfc2914a0a36b543db6eb190c9dc8a39e08f15258) | Fondeo del faucet → owner | `0x84d995ee…` → wallet owner | 0.1 | ✔ |
| 35 | 2026-07-26 09:15:33Z | 780306 | [`0xbaaa6268c4b7…`](https://testnet.netxscan.io/tx/0xbaaa6268c4b7edb01cd894d57061d83b7b75b2df292cae65ff1f88004a0bd1cb) | Intento de pago de escrow desde el cliente (owner) — revertido, ya cubierto por el relayer | wallet owner → missionFactory | 0.097375 | ✖ |

Total: 35 transacciones relacionadas con las wallets del flujo.

## 3. Estado final por wallet

| Rol | Dirección | Agent | Balance | Stake total | Stake bloqueado |
|---|---|---|---|---|---|
| owner | [`0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1`](https://testnet.netxscan.io/address/0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1) | 69 | 0.783069 | 0 | 0 |
| provider | [`0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01`](https://testnet.netxscan.io/address/0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01) | 70 | 0.743325 | 0.019 | 0 |
| team0 | [`0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF`](https://testnet.netxscan.io/address/0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF) | 71 | 0.143325 | 0.019 | 0.019 |
| team1 | [`0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76`](https://testnet.netxscan.io/address/0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76) | 72 | 0 | 0 | 0 |
| team2 | [`0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae`](https://testnet.netxscan.io/address/0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae) | 76 | 0.1 | 0 | 0 |
| team3 | [`0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0`](https://testnet.netxscan.io/address/0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0) | 77 | 0.1 | 0 | 0 |
| team4 | [`0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2`](https://testnet.netxscan.io/address/0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2) | 78 | 0.1 | 0 | 0 |
| voter0 | [`0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F`](https://testnet.netxscan.io/address/0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F) | 73 | 0 | 0 | 0 |
| voter1 | [`0x2AceDe843C30cEe69892D494E01dD23263F690A5`](https://testnet.netxscan.io/address/0x2AceDe843C30cEe69892D494E01dD23263F690A5) | 74 | 0 | 0 | 0 |
| voter2 | [`0xD6D31815C14A84E7c7E32685117818A9290A730A`](https://testnet.netxscan.io/address/0xD6D31815C14A84E7c7E32685117818A9290A730A) | 75 | 0 | 0 | 0 |

## 4. Estado final de la misión (API)

- Misión: `676068cc-05fa-4947-b156-692f1d8a8e7c` — estado `in_progress`
- Propuesta ganadora: `c108f0a4-3358-4ef4-8b1e-8d766d8e84d6` (estado `winner`)
- Colaboración: `470ebaa2-9248-4d2f-af7b-540b0a750d0a` — dag_hash `0xd5a95ee3cae6d91dc202e5fc9f4dfaa02e447ebfc95ae14d41e805b36971b978`, nodos: n1=waiting, n2=waiting, n3=waiting
- Despliegue on-chain de la misión: **desplegada** — contrato [`0x48b7328cd07804025f2835e28f072bb0bf90f83b`](https://testnet.netxscan.io/address/0x48b7328cd07804025f2835e28f072bb0bf90f83b), estado `InProgress`, tx [`0xf038c4563cb5532975eb74972fd40adf5147997cb6bb5bffaf0f441815bb1f3c`](https://testnet.netxscan.io/tx/0xf038c4563cb5532975eb74972fd40adf5147997cb6bb5bffaf0f441815bb1f3c), bloque 780295
- Pago de escrow: ejecutado por el **relayer del backend** (no por el cliente) al detectar ambas firmas — ver tx [`0xf038c4563cb55329…`](https://testnet.netxscan.io/tx/0xf038c4563cb5532975eb74972fd40adf5147997cb6bb5bffaf0f441815bb1f3c) en la sección 2

## 5. Contratos de la plataforma

| Contrato | Dirección |
|---|---|
| missionFactory | [`0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828`](https://testnet.netxscan.io/address/0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828) |
| stakingRegistry | [`0x6F8E4696578447686c8F20270C117ccC46B4f35A`](https://testnet.netxscan.io/address/0x6F8E4696578447686c8F20270C117ccC46B4f35A) |
| reputationRegistry | [`0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6`](https://testnet.netxscan.io/address/0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6) |
| agentRegistry | [`0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902`](https://testnet.netxscan.io/address/0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902) |
| governanceRegistry | [`0x02Fa505012D29c1405EF3592d78f1D9bE9f9bf49`](https://testnet.netxscan.io/address/0x02Fa505012D29c1405EF3592d78f1D9bE9f9bf49) |
| sanctionRegistry | [`0x71D916F5aA56eff03128FE5E9c9E662B224186F0`](https://testnet.netxscan.io/address/0x71D916F5aA56eff03128FE5E9c9E662B224186F0) |
| evidenceAnchor | [`0x55930E18EaA8cDD8a6471FB46E526f2546D49323`](https://testnet.netxscan.io/address/0x55930E18EaA8cDD8a6471FB46E526f2546D49323) |
| investmentVaultFactory | [`0xC7c7d069Ae1bc48F5B7B715BE0B0016BD70ba6da`](https://testnet.netxscan.io/address/0xC7c7d069Ae1bc48F5B7B715BE0B0016BD70ba6da) |
| usdc | [`0xe400c07A1ea70228b2148B934278f1fD7A91F1b7`](https://testnet.netxscan.io/address/0xe400c07A1ea70228b2148B934278f1fD7A91F1b7) |
