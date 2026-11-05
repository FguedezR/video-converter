// Generadores de snippet.html y _headers (Cloudflare). Funciones puras: reciben datos y devuelven texto.
// El snippet es HTML/CSS/JS genérico: no depende de ningún CMS ni builder.

/* exported buildSnippet, buildHeaders, MIN_DESKTOP_WIDTH, CF_MAX_FILE */

const MIN_DESKTOP_WIDTH = 981; // por debajo de este ancho no se carga el vídeo (se queda el poster)
const CF_MAX_FILE = 25 * 1024 * 1024; // Cloudflare Pages / Workers: máximo 25 MiB por archivo

// d = { mode: "bg"|"block"|"controls", id, width, height, base, webm, mp4, poster, slug, version }
// webm/mp4 pueden ser null si esa salida no se generó. base puede ser una ruta o una URL completa.
function buildSnippet(d) {
  const url = (name) => d.base + name;
  const lines = d.mode === "controls" ? controlsSnippet(d, url) : heroSnippet(d, url);
  return lines.filter((l) => l !== null).join("\n") + "\n";
}

function filesLine(d) {
  return `Archivos: ${[d.webm, d.mp4, d.poster].filter(Boolean).join(", ")} → en ${d.base}`;
}

function heroSnippet(d, url) {
  const bg = d.mode === "bg";
  const sources = [d.webm && [url(d.webm), "video/webm"], d.mp4 && [url(d.mp4), "video/mp4"]].filter(Boolean);
  return [
    `<!-- Hero de vídeo · ${d.slug} v${d.version} · Video Converter de Hadock`,
    filesLine(d),
    bg
      ? "Fondo: el contenido de .hv-content va encima del vídeo. El hero mide al menos la proporción del vídeo y crece con el contenido."
      : "Bloque: ocupa el ancho de su contenedor con la proporción del vídeo.",
    `El <video> se crea por JS tras «load», solo con ${MIN_DESKTOP_WIDTH} px de ancho o más, sin «reducir movimiento»`,
    "y sin ahorro de datos. En los demás casos se queda la imagen, que es el elemento LCP.",
    "Si un optimizador retrasa los scripts inline hasta la primera interacción, excluye este (contiene «hv-hero»).",
    "-->",
    `<div id="${d.id}" class="hv-hero${bg ? " hv-bg" : ""}">`,
    // OPTIMIZACIÓN: poster como <img> real (no fondo CSS) para que el navegador lo descubra en el HTML.
    `<img class="hv-poster" src="${url(d.poster)}" width="${d.width}" height="${d.height}" alt="" fetchpriority="high" loading="eager">`,
    bg ? `<div class="hv-content">` : null,
    bg ? "<!-- Tu contenido (título, texto, botón) -->" : null,
    bg ? "</div>" : null,
    "</div>",
    "<style>",
    // OPTIMIZACIÓN: aspect-ratio + width/height reservan el espacio desde el primer pintado (sin CLS).
    ".hv-hero{position:relative;width:100%;overflow:hidden;background:#000}",
    `#${d.id}{aspect-ratio:${d.width}/${d.height}}`,
    ".hv-hero .hv-poster,.hv-hero .hv-video{position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;margin:0;object-fit:cover}",
    ".hv-hero .hv-video{opacity:0;transition:opacity .6s ease}",
    ".hv-hero.hv-is-playing .hv-video{opacity:1}",
    bg ? ".hv-bg .hv-content{position:relative;z-index:1}" : null,
    bg ? "/* Para oscurecer el vídeo bajo el texto: .hv-bg::after{background:rgba(0,0,0,.35)} */" : null,
    bg ? ".hv-bg::after{content:\"\";position:absolute;inset:0;pointer-events:none}" : null,
    "</style>",
    "<script>",
    "(function () {",
    `  var root = document.getElementById(${JSON.stringify(d.id)});`,
    "  if (!root) return;",
    "  if (!window.matchMedia) return;",
    `  var desktop = window.matchMedia("(min-width: ${MIN_DESKTOP_WIDTH}px)");`,
    "  var calm = window.matchMedia(\"(prefers-reduced-motion: reduce)\");",
    "  var started = false;",
    "  function allowed() {",
    "    if (!desktop.matches) return false;",
    "    if (calm.matches) return false;",
    "    if (navigator.connection) { if (navigator.connection.saveData) return false; }",
    "    return true;",
    "  }",
    "  function addSource(video, src, type) {",
    "    var s = document.createElement(\"source\");",
    "    s.src = src;",
    "    s.type = type;",
    "    video.appendChild(s);",
    "  }",
    "  function start() {",
    "    if (started) return;",
    "    if (!allowed()) return;",
    "    started = true;",
    "    var v = document.createElement(\"video\");",
    "    v.className = \"hv-video\";",
    "    v.muted = true;",
    "    v.defaultMuted = true;",
    "    v.loop = true;",
    "    v.autoplay = true;",
    "    v.playsInline = true;",
    "    v.preload = \"auto\";",
    `    v.width = ${d.width};`,
    `    v.height = ${d.height};`,
    "    v.disablePictureInPicture = true;",
    "    v.setAttribute(\"muted\", \"\");",
    "    v.setAttribute(\"playsinline\", \"\");",
    "    v.setAttribute(\"aria-hidden\", \"true\");",
    "    v.setAttribute(\"tabindex\", \"-1\");",
    // WebM (VP9) primero: el navegador usa la primera fuente que sabe reproducir.
    ...sources.map(([src, type]) => `    addSource(v, ${JSON.stringify(src)}, ${JSON.stringify(type)});`),
    "    v.addEventListener(\"playing\", function () { root.classList.add(\"hv-is-playing\"); }, { once: true });",
    // El vídeo va antes del contenido para quedar debajo de él.
    `    root.insertBefore(v, ${bg ? "root.querySelector(\".hv-content\")" : "null"});`,
    // OPTIMIZACIÓN: pausa fuera de pantalla para no gastar CPU ni batería.
    "    if (\"IntersectionObserver\" in window) {",
    "      new IntersectionObserver(function (entries) {",
    "        entries.forEach(function (e) {",
    "          if (e.isIntersecting) { var p = v.play(); if (p) p.catch(function () {}); }",
    "          else { v.pause(); }",
    "        });",
    "      }).observe(root);",
    "    }",
    "  }",
    // OPTIMIZACIÓN: el vídeo se crea tras load y en un momento ocioso, sin competir con el LCP.
    "  function schedule() {",
    "    if (\"requestIdleCallback\" in window) requestIdleCallback(start, { timeout: 2000 });",
    "    else setTimeout(start, 200);",
    "  }",
    // Si el script se ejecuta tarde (diferido o retrasado), load ya pasó: se programa directamente.
    "  if (document.readyState === \"complete\") schedule();",
    "  else window.addEventListener(\"load\", schedule, { once: true });",
    "  if (desktop.addEventListener) desktop.addEventListener(\"change\", schedule);",
    "})();",
    "</script>",
  ];
}

function controlsSnippet(d, url) {
  return [
    `<!-- Vídeo con controles · ${d.slug} v${d.version} · Video Converter de Hadock`,
    filesLine(d),
    "preload=none: no se descarga nada del vídeo hasta que se pulsa reproducir.",
    "-->",
    `<div id="${d.id}" class="hv-player">`,
    `<video controls playsinline preload="none" poster="${url(d.poster)}" width="${d.width}" height="${d.height}">`,
    d.webm ? `<source src="${url(d.webm)}" type="video/webm">` : null,
    d.mp4 ? `<source src="${url(d.mp4)}" type="video/mp4">` : null,
    "</video>",
    "</div>",
    "<style>",
    ".hv-player{width:100%;background:#000}",
    `#${d.id}{aspect-ratio:${d.width}/${d.height}}`,
    ".hv-player video{display:block;width:100%;height:100%;max-width:none;object-fit:contain}",
    "</style>",
  ];
}

// Archivo _headers de Cloudflare Pages / Workers static assets para la carpeta de los vídeos.
// d = { base, webm, mp4, poster }
function buildHeaders(d) {
  let prefix = "/";
  let host = "";
  if (/^https?:\/\//i.test(d.base)) {
    const u = new URL(d.base);
    prefix = u.pathname;
    host = u.host;
  } else if (d.base.startsWith("/")) {
    prefix = d.base;
  }
  const VIDEO = ["webm", "mp4"];
  const STATIC = ["webp", "avif", "jpg", "jpeg", "png", "svg", "woff2", "woff"];
  const year = "31536000";
  // Una regla por extensión: Cloudflare solo admite un * por patrón, y si dos reglas coinciden con
  // la misma URL junta sus valores con comas (dos Cache-Control acabarían mezclados).
  const rules = (exts, value, comment = "") => exts.flatMap((ext) => [
    `${comment}${prefix}*.${ext}`,
    `${comment}  Cache-Control: ${value}`,
    "",
  ]);
  const sample = d.webm || d.mp4 || d.poster;

  return [
    "# _headers · Cloudflare Pages / Workers static assets · Video Converter de Hadock",
    `# Archivos de este vídeo: ${[d.webm, d.mp4, d.poster].filter(Boolean).join(", ")}`,
    host
      ? `# Va en la raíz del directorio publicado del proyecto de Cloudflare que sirve ${host}.`
      : "# Va en la raíz del directorio publicado del proyecto de Cloudflare (junto al index.html).",
    "# Si ya existe un _headers, añade estas reglas al final. Máximo 100 reglas por archivo.",
    prefix === "/" && !d.base.startsWith("/") && !host
      ? "# La ruta base es relativa: las reglas se aplican a todo el sitio. Usa una ruta absoluta para acotarlas."
      : `# Las reglas solo afectan a ${prefix}`,
    "#",
    "# POR QUÉ",
    "# Vídeo, imágenes y fuentes se guardan 1 año en la caché del navegador (max-age=31536000).",
    "# «immutable» va más allá: el navegador no vuelve a preguntar por el archivo mientras lo tenga",
    "# guardado, ni siquiera al recargar. Solo es seguro si el contenido de una URL no cambia nunca:",
    "# por eso el conversor genera nombres versionados (-v1, -v2…). Para cambiar el vídeo se publica",
    "# uno nuevo con otra versión y se actualiza el snippet; la URL antigua no se toca.",
    "# Si alguna vez se sustituye un archivo conservando el nombre, quien ya lo tuviera seguiría viendo",
    "# el antiguo hasta un año. De ahí las dos variantes:",
    "#   A) immutable solo en vídeo; imágenes y fuentes, 1 año sin immutable. ACTIVA.",
    "#   B) sin immutable en nada. Para usarla, comenta A y quita el «# » de B.",
    "# No dejes las dos activas: Cloudflare juntaría los dos Cache-Control en uno.",
    "#",
    "# Comprobación tras desplegar:",
    `#   curl -sI ${host ? "https://" + host + prefix : "https://TU-DOMINIO" + prefix}${sample} | grep -i cache-control`,
    "",
    "# Variante A: immutable solo en vídeo",
    ...rules(VIDEO, `public, max-age=${year}, immutable`),
    ...rules(STATIC, `public, max-age=${year}`),
    "# Variante B: sin immutable",
    ...rules([...VIDEO, ...STATIC], `public, max-age=${year}`, "# "),
  ].join("\n");
}
