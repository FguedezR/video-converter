# Video Converter (herramienta interna de Hadock)

Compresor de vídeos para heros de fondo. Todo se procesa en el navegador con WebCodecs
(librería Mediabunny); no se sube nada a ningún servidor. Se publica en GitHub y se aloja en
Cloudflare Pages; lo que genera (snippet y cabeceras) es genérico, sin dependencias de
WordPress, Divi ni plugins.
Hermano del WebP Converter (https://webp.ferguedez.dev/, repo FguedezR/webp-converter),
del que hereda estructura, estilo y front.

## Estructura (igual que el WebP Converter)

```
index.html      # una sola página, lang="es", data-accent="blue"
style.css       # tokens en :root, sin preprocesador
app.js          # script clásico (no type="module"), cargado al final de <body>
generators.js   # funciones puras que generan snippet.html y _headers (cargado antes de app.js)
vendor/         # librerías de terceros ya minificadas, versión fijada en el nombre o cabecera
fonts/          # GeistMono-Variable.woff2, GeistPixel-Square.woff2 + LICENSE-Geist-OFL.txt
favicon.svg / favicon.ico
_headers        # cabeceras de Cloudflare Pages
.gitignore      # .DS_Store y _test/ (vídeos de prueba locales)
```

- **Sin build step**: nada de package.json, npm, bundler, TypeScript ni frameworks. Lo que
  hay en el repo es exactamente lo que se despliega.
- Librerías en `vendor/`, nunca desde CDN. Versión fijada y con al menos dos semanas de
  antigüedad al añadirla; conservar la licencia junto al archivo si la exige (MPL-2.0 en
  Mediabunny).
- Las librerías pesadas se cargan bajo demanda con `loadScript(src)` (promesa cacheada por
  URL); las imprescindibles (JSZip), con `<script>` al final del `<body>`.
- Mediabunny: bundle IIFE `vendor/mediabunny-<versión>.min.js` (expone `window.Mediabunny`).
  Consultar https://mediabunny.dev/guide/ o `mediabunny.d.ts` de la versión fijada antes de
  usar cualquier API; no asumirla de memoria.
- Prohibido ffmpeg.wasm.

## HTML

- Textos de interfaz en español. Comillas latinas «», separador `·`, flechas `↗ ↓ →`.
- `meta color-scheme="dark"`, `theme-color="#07090d"`, `preload` de las dos fuentes.
- Accesibilidad: `role="status" aria-live="polite"` en la línea de estado, `aria-label` en
  secciones, iconos SVG con `aria-hidden`. Los `<svg>` se ocultan con el atributo `hidden`
  (`toggleAttribute`), no con la propiedad `.hidden`.

## CSS

- Tokens: `--bg --surface --line --line-strong --fg --muted --accent --on-accent --danger
  --mono --pixel`. Acento por `:root[data-accent="blue"]` (#3d6bff). No introducir colores
  sueltos: si hace falta uno nuevo, se añade como token.
- Estética: oscuro, esquinas rectas (`border-radius: 0`), bordes de 1px, etiquetas en
  mayúsculas 11px con `letter-spacing: .12em`, títulos en Geist Pixel, cuerpo 13px Geist Mono.
- Reglas compactas en una línea cuando son cortas. `max-width: 860px`, gutter 16px,
  breakpoint móvil 560px, `prefers-reduced-motion` respetado.
- `color-mix()` permitido (objetivo: Chrome/Edge de escritorio).

## JavaScript

- Vanilla, script clásico. Helper `const $ = (id) => document.getElementById(id);`.
- 2 espacios, comillas dobles, punto y coma, funciones flecha, plantillas literales.
- Estado en `let` de nivel superior (p. ej. `files`, `outputs`); funciones pequeñas con nombre.
- Comentarios en español y solo para explicar el porqué (restricciones del navegador,
  decisiones no obvias).
- Nunca `innerHTML` con datos del usuario (nombres de archivo): `textContent`.
- `localStorage` siempre dentro de `try/catch` y solo para preferencias del usuario.
- `URL.createObjectURL` siempre con su `revokeObjectURL`.
- Errores visibles: en `#summary` (estado general) y en la fila de la tabla (`.err`), nunca
  solo en consola. Si falta soporte del navegador, aviso claro en lugar de fallar.
- Tamaños con `fmt(bytes)` (KB/MB); `?accent=blue|green` para comparar acentos.

## Reglas de dominio (no cambiar sin consultar)

- Dimensiones pares, sin escalar hacia arriba, máx. 30 fps, keyframe cada ~2 s, metadatos
  eliminados, MP4 con moov al principio (fast start).
- Nombres versionados: `[slug]-[alto]p-v[n].webm|mp4`, `[slug]-poster-v[n].webp`.
- El snippet generado es HTML/CSS/JS genérico (nada de WordPress, Divi ni plugins), usa
  prefijo `hv-`, el poster `<img>` es el LCP y el `<video>` se crea por JS tras `load`; nunca
  en viewport < 981 px, `prefers-reduced-motion` o `saveData`. Rutas = «Ruta base o URL» +
  nombre de archivo.
- Cabeceras: archivo `_headers` de Cloudflare (una regla por extensión; un solo `*` por patrón;
  reglas que coinciden se suman con comas, así que nunca dos Cache-Control activos para la
  misma URL). `immutable` solo en vídeo por defecto; variante sin immutable comentada.
- Cloudflare Pages no admite archivos de más de 25 MiB: avisar antes de codificar.

## Git y despliegue

- Mensajes de commit en español, breves y descriptivos («Enlaces a ferguedez.dev y GitHub
  en la cabecera»).
- Despliegue en Cloudflare Pages directamente desde la raíz del repo (sin comando de build,
  directorio de salida `/`).
