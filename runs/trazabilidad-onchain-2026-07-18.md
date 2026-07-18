# Trazabilidad on-chain de las wallets (testnet NETX)

Generado: 2026-07-18T03:07:41.851Z
Red: chain id 587 (netx-testnet) · Bloque actual: 542538
RPC: https://testnetrpc.netxscan.io · Explorador: https://testnet.netxscan.io

Las claves privadas de estas wallets están persistidas en `runs/state.json`
(fuera de git) para su exportación posterior; este documento solo contiene datos
públicos on-chain.

## Wallets

| Rol | Dirección | Agent on-chain | Balance (tNETX) | Txs enviadas | Registro on-chain | Stake total |
|---|---|---|---|---|---|---|
| owner | [`0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1`](https://testnet.netxscan.io/address/0xEB9DaBB66448a8F0dFF3a6580ffeA8B8845917C1) | 69 | 0.400000 | 0 | active | 0 tNETX |
| provider | [`0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01`](https://testnet.netxscan.io/address/0x18d07Bcf67a70C0Dd9ff3a42F0dB2BEeF8E7Ee01) | 70 | 0.743325 | 1 | active | 0.019 tNETX |
| team0 | [`0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF`](https://testnet.netxscan.io/address/0xe2C3F65EdF0Ce588242F2b4B2730D3B025629EFF) | 71 | 0.143325 | 1 | active | 0.019 tNETX |
| team1 | [`0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76`](https://testnet.netxscan.io/address/0x938508B138250ED60Ad0b2e6D3eFD4F93515Ac76) | 72 | 0.000000 | 0 | active | 0 tNETX |
| team2 | [`0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae`](https://testnet.netxscan.io/address/0xE5C7a4b1cFccE545A20814398B40bb5Dce6258Ae) | 76 | 0.100000 | 0 | active | 0 tNETX |
| team3 | [`0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0`](https://testnet.netxscan.io/address/0x0e3dCf117e2064AbdFdd51Ad8cF6135453E3BAA0) | 77 | 0.100000 | 0 | active | 0 tNETX |
| team4 | [`0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2`](https://testnet.netxscan.io/address/0x63c4e8BDb43A41DdE7E29c6e75819BE89220a7e2) | 78 | 0.100000 | 0 | active | 0 tNETX |
| voter0 | [`0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F`](https://testnet.netxscan.io/address/0x05080Ea159922ef2348AA240Ae63F12CF10D9D2F) | 73 | 0.000000 | 0 | active | 0 tNETX |
| voter1 | [`0x2AceDe843C30cEe69892D494E01dD23263F690A5`](https://testnet.netxscan.io/address/0x2AceDe843C30cEe69892D494E01dD23263F690A5) | 74 | 0.000000 | 0 | active | 0 tNETX |
| voter2 | [`0xD6D31815C14A84E7c7E32685117818A9290A730A`](https://testnet.netxscan.io/address/0xD6D31815C14A84E7c7E32685117818A9290A730A) | 75 | 0.000000 | 0 | active | 0 tNETX |

Las wallets sin txs enviadas (nonce 0) operan por firmas relayadas: el registro
on-chain lo ejecuta el relayer del backend con la firma EIP-712 del agente, por lo
que su actividad aparece en el contrato AgentRegistry y no como txs salientes de
la wallet.

## Registro de delegate agents

- **owner** (agent 69): estado `active`, verificado: true
- **provider** (agent 70): estado `active`, verificado: true
- **team0** (agent 71): estado `active`, verificado: true
- **team1** (agent 72): estado `active`, verificado: true
- **team2** (agent 76): estado `active`, verificado: true
- **team3** (agent 77): estado `active`, verificado: true
- **team4** (agent 78): estado `active`, verificado: true
- **voter0** (agent 73): estado `active`, verificado: true
- **voter1** (agent 74): estado `active`, verificado: true
- **voter2** (agent 75): estado `active`, verificado: true

## Transacciones enviadas desde este cliente

| Tx | Propósito | Bloque | Estado | Destino |
|---|---|---|---|---|
| [`0x4d708187417bac5e…`](https://testnet.netxscan.io/tx/0x4d708187417bac5ec496f60af787a57c68cf204041f444cda843efcffabda77d) | Stake 0.019 tNETX (agent 70, provider) | 539499 | success | `0x6f8e4696578447686c8f20270c117ccc46b4f35a` |
| [`0xfcc731f4f1b9b8a5…`](https://testnet.netxscan.io/tx/0xfcc731f4f1b9b8a5860c07f9fd98d8c4b6c32233628665da7d6c873d89483e63) | Stake 0.019 tNETX (agent 71, team0/líder) | 539692 | success | `0x6f8e4696578447686c8f20270c117ccc46b4f35a` |

Además, cada llamada a `/api/faucet/native` generó una tx de fondeo (0.1 tNETX)
desde la wallet del relayer del faucet hacia las wallets de la tabla; se pueden ver
en el historial de cada dirección en el explorador.

## Contratos de la plataforma (chain 587)

| Contrato | Dirección |
|---|---|
| AgentRegistry | `0x2ba3C3b8aa9AFceFF6501E979d2c62566Ee20902` |
| StakingRegistry | `0x6F8E4696578447686c8F20270C117ccC46B4f35A` |
| MissionFactory | `0xEf215Dd0e57959424Ab6f90D7B57C90A4e44A828` |
| ReputationRegistry | `0x450Baee675f7c518755F68FFFCEb0C01e3dACAF6` |
| GovernanceRegistry | `0x02Fa505012D29c1405EF3592d78f1D9bE9f9bf49` |
| SanctionRegistry | `0x71D916F5aA56eff03128FE5E9c9E662B224186F0` |
| EvidenceAnchor | `0x55930E18EaA8cDD8a6471FB46E526f2546D49323` |
| USDC (mock) | `0xe400c07A1ea70228b2148B934278f1fD7A91F1b7` |
