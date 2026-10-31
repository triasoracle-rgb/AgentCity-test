# Descarga de PDFs de Prensa Histórica — "Lozano Sidro"

Descarga los PDFs de todos los resultados de búsqueda de
https://prensahistorica.mcu.es/es/consulta/busqueda.do

## Uso (en tu ordenador, Node 18+)

```bash
npm install
node scripts/prensahistorica/scrape.mjs --dry-run      # primero: solo lista lo que descargaría
node scripts/prensahistorica/scrape.mjs                # descarga en ./pdfs-lozano-sidro/
```

Opciones:

| opción | defecto | qué hace |
|---|---|---|
| `--query "texto"` | `Lozano Sidro` | término de búsqueda |
| `--no-exact` | (frase exacta) | busca sin comillas |
| `--out dir` | `./pdfs-lozano-sidro` | carpeta de salida |
| `--delay s` | `3` | segundos entre peticiones (súbelo si recibes 429) |
| `--dry-run` | | no descarga, solo muestra nombres y URLs |
| `--debug` | | guarda el HTML recibido en `<out>/_debug/` para ajustar el parser |

## Nombres de fichero

`AAAAMMDD_titulo-del-periodico_pN.pdf`, por ejemplo:

- `18970524_la-correspondencia-de-espana_p1.pdf`
- `18970615_diario-de-cordoba_p3.pdf`
- `18970615_el-comercio-de-cordoba_p3.pdf`

Además se generan `indice.csv` e `indice.json` con fecha, título, página y URLs de cada resultado.
Los ficheros ya descargados se saltan, así que puedes relanzarlo si se corta.
