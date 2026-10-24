# coral/ — NetX Coral: reconstrucción del Virtual POS

Material de la investigación de **NetX Coral** (`coral.netx.world`), la pasarela de
cobro en stablecoin del ecosistema NetX. El reporte completo (17 secciones) está en
[`../docs/coral-netx-analisis.md`](../docs/coral-netx-analisis.md).

## Contenido

| Archivo | Qué es |
|---|---|
| `vpos-demo-reconstruction.html` | Reconstrucción interactiva y fiel de la "Payment demo" del Virtual POS, a partir de los restos que quedan en el bundle público. Versión local, con el lockup de marca original y banner "RECONSTRUCTION — not the live product". |
| `vpos-demo-public.html` | La misma reconstrucción **sin marca NetX** ("VPOS Recon · Independent · Unaffiliated"), con aviso de no afiliación. Es la que se empaqueta para el despliegue de prueba. |
| `img/` | Capturas de la consola en vivo (guest) y de la reconstrucción (estados, EVM/SOL, 日本語). |

## Qué hace la reconstrucción

Recorre la máquina de estados `Awaiting scan → Paying → Chain confirming → Completed`
(y las ramas `Failed` / `Expired`), en inglés y japonés, con selector EVM/Solana que
muestra la dirección de cobro sandbox real correspondiente.

El **QR es real y escaneable**, pero codifica una **URL `https` informativa**
(`…/demo-env-001?session=…&mode=test&…&to=<dirección>`), **nunca** un URI pagable
`ethereum:` / `solana:`. No tiene backend: ningún estado refleja una transacción real.

Todo lo *verbatim* viene del bundle (etiquetas EN/JA, enum de estados, colores
`.status-*`, paleta, fixtures); lo único reconstruido es el **orden de transiciones**,
que no sobrevivió en el código.

## Cómo verla y verificarla

```bash
# Abrir el HTML en un navegador, o verificarlo con los checks del repo:
node scripts/coral/verify-demo.mjs coral/vpos-demo-reconstruction.html
node scripts/coral/verify-demo.mjs coral/vpos-demo-public.html
```

Para empaquetar la versión pública como Cloudflare Worker de un solo archivo:

```bash
node scripts/coral/build-worker.mjs     # -> runs/coral/worker.js
```

Scripts relacionados en [`../scripts/coral/`](../scripts/coral/); reporte y
reproducción completa en [`../docs/coral-netx-analisis.md`](../docs/coral-netx-analisis.md).
