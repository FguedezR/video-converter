const $ = (id) => document.getElementById(id);
const MEDIABUNNY = "vendor/mediabunny-1.62.0.min.js";
const EXT = /\.(mp4|m4v|mov|webm)$/i;

// Para comparar acentos: ?accent=blue | ?accent=green
const accentParam = new URLSearchParams(location.search).get("accent");
if (accentParam === "blue" || accentParam === "green") document.documentElement.dataset.accent = accentParam;

// Normas fijas (ver CLAUDE.md): no se exponen en la interfaz.
const MAX_FPS = 30;
const KEYFRAME_INTERVAL = 2; // segundos
const MIN_DURATION = 0.5; // recorte mínimo, en segundos
const OVERHEAD = 1.02; // cabeceras del contenedor sobre bitrate × duración

const PRESETS = {
  hero: { maxHeight: 720, bitrate: 1.5, audio: 0 },
  hero1080: { maxHeight: 1080, bitrate: 3, audio: 0 },
  content: { maxHeight: 1080, bitrate: 4, audio: 128 },
};

let source = null; // vídeo analizado: { file, input, videoTrack, audioTrack, width, height, fps, duration, ... }
let trim = { start: 0, end: 0 };
let support = null; // resultado de checkSupport() para la configuración actual
let loadSeq = 0; // descarta análisis obsoletos si se suelta otro vídeo a mitad
let outputs = []; // { name, blob } — se rellena en la fase 2

/* ---------- Formato ---------- */

const num = (n, d = 1) => n.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (b) => b >= 1048576 ? num(b / 1048576) + " MB" : Math.round(b / 1024) + " KB";
const fmtRate = (bps) => bps >= 1e6 ? num(bps / 1e6, 2) + " Mbps" : Math.round(bps / 1000) + " kbps";
const fmtFps = (f) => (Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : num(f, 2));
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}
const CODEC_NAMES = { avc: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", prores: "ProRes", aac: "AAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis", flac: "FLAC" };
const codecName = (c) => CODEC_NAMES[c] || (c ? c.toUpperCase() : "desconocido");

const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "video";

function defaultBasePath() {
  const d = new Date();
  return `/wp-content/uploads/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/`;
}
function basePath() {
  let p = $("basePath").value.trim() || defaultBasePath();
  if (!p.endsWith("/")) p += "/";
  return p;
}

/* ---------- Ajustes y preferencias ---------- */

const presetRadios = [...document.querySelectorAll('input[name="preset"]')];
const currentPreset = () => presetRadios.find((r) => r.checked).value;

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  $("maxHeight").value = p.maxHeight;
  $("bitrate").value = p.bitrate;
  $("audio").value = p.audio;
}

function savePrefs() {
  try {
    localStorage.setItem("video-prefs", JSON.stringify({
      preset: currentPreset(), maxHeight: $("maxHeight").value, bitrate: $("bitrate").value,
      audio: $("audio").value, targetMb: $("targetMb").value,
    }));
  } catch (e) {}
}

function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem("video-prefs")); } catch (e) {}
  if (p && presetRadios.some((r) => r.value === p.preset)) {
    presetRadios.forEach((r) => (r.checked = r.value === p.preset));
    if (p.preset === "custom") {
      $("maxHeight").value = p.maxHeight;
      $("bitrate").value = p.bitrate;
      $("audio").value = p.audio;
    }
  }
  if (p && +p.targetMb > 0) $("targetMb").value = p.targetMb;
  if (currentPreset() !== "custom") applyPreset(currentPreset());
  $("basePath").value = defaultBasePath();
}

presetRadios.forEach((r) => r.addEventListener("change", () => {
  applyPreset(r.value);
  savePrefs();
  refresh();
}));

// Tocar un valor a mano convierte el preset en «Personalizado».
["maxHeight", "bitrate", "audio"].forEach((id) => $(id).addEventListener("input", () => {
  presetRadios.forEach((r) => (r.checked = r.value === "custom"));
  savePrefs();
  refresh();
}));
$("targetMb").addEventListener("input", () => { savePrefs(); renderEstimate(); });
["slug", "version", "basePath"].forEach((id) => $(id).addEventListener("input", renderEstimate));
$("slug").addEventListener("change", () => { $("slug").value = slugify($("slug").value); renderEstimate(); });
$("basePath").addEventListener("change", () => { $("basePath").value = basePath(); });

/* ---------- Cálculo de la salida ---------- */

// Dimensiones pares y nunca por encima del original. El límite se aplica al lado corto,
// así un vídeo vertical a «720p» sale a 720 de ancho.
function outputSize(maxHeight) {
  const { width: w, height: h } = source;
  const scale = maxHeight ? Math.min(1, maxHeight / Math.min(w, h)) : 1;
  const even = (n) => Math.max(2, 2 * Math.floor(n / 2));
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

function settings() {
  const requested = Math.min(50, Math.max(0.2, +$("bitrate").value || 1.5)) * 1e6;
  const audioKbps = +$("audio").value;
  const size = outputSize(+$("maxHeight").value);
  // No se sube el bitrate por encima del original: engordaría el archivo sin ganar calidad.
  const capped = source.videoBitrate > 0 && source.videoBitrate < requested;
  return {
    ...size,
    fps: Math.min(MAX_FPS, source.fps || MAX_FPS),
    videoBitrate: capped ? Math.round(source.videoBitrate) : requested,
    capped,
    audioBitrate: audioKbps && source.audioTrack ? audioKbps * 1000 : 0,
    keyFrameInterval: KEYFRAME_INTERVAL,
    trim: { ...trim },
    duration: trim.end - trim.start,
    slug: slugify($("slug").value || source.file.name.replace(/\.[^.]+$/, "")),
    version: Math.max(1, Math.round(+$("version").value || 1)),
    basePath: basePath(),
  };
}

const fileNames = (s) => ({
  webm: `${s.slug}-${s.height}p-v${s.version}.webm`,
  mp4: `${s.slug}-${s.height}p-v${s.version}.mp4`,
  poster: `${s.slug}-poster-v${s.version}.webp`,
});

const estimateBytes = (s) => (s.videoBitrate + s.audioBitrate) * s.duration / 8 * OVERHEAD;

/* ---------- Soporte del navegador ---------- */

// Cadenas de códec con el nivel adecuado a la resolución (H.264 High, VP9 perfil 0 a 8 bits),
// equivalentes a las que genera Mediabunny al codificar.
function avcCodec(w, h) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const level = mbs <= 3600 ? 0x1f : mbs <= 8192 ? 0x28 : mbs <= 22080 ? 0x33 : 0x34;
  return "avc1.6400" + level.toString(16);
}
function vp9Codec(w, h) {
  const px = w * h;
  return `vp09.00.${px <= 983040 ? "31" : px <= 2228224 ? "40" : px <= 8912896 ? "50" : "60"}.08`;
}

async function isSupported(Encoder, config) {
  try { return (await Encoder.isConfigSupported(config)).supported === true; } catch (e) { return false; }
}

async function checkVideo(codec, base) {
  const ok = await isSupported(VideoEncoder, { ...base, codec });
  if (!ok) return { ok: false };
  const hw = await isSupported(VideoEncoder, { ...base, codec, hardwareAcceleration: "prefer-hardware" });
  return { ok: true, hw };
}

async function checkSupport(width, height, bitrate, fps, audioBitrate) {
  const result = { webcodecs: "VideoEncoder" in window, vp9: { ok: false }, avc: { ok: false }, opus: true, aac: true };
  if (!result.webcodecs) return result;
  const base = { width, height, bitrate, framerate: fps };
  [result.vp9, result.avc] = await Promise.all([
    checkVideo(vp9Codec(width, height), base),
    checkVideo(avcCodec(width, height), { ...base, avc: { format: "avc" } }),
  ]);
  if (audioBitrate) {
    const audio = { sampleRate: 48000, numberOfChannels: 2, bitrate: audioBitrate };
    const hasAudioEncoder = "AudioEncoder" in window;
    [result.opus, result.aac] = hasAudioEncoder
      ? await Promise.all([isSupported(AudioEncoder, { ...audio, codec: "opus" }), isSupported(AudioEncoder, { ...audio, codec: "mp4a.40.2" })])
      : [false, false];
  }
  return result;
}

function renderSupport(s, size) {
  const box = $("support");
  const msgs = [];
  if (!s.webcodecs) {
    msgs.push("Este navegador no tiene WebCodecs, así que no puede codificar vídeo. Usa Chrome o Edge de escritorio (y la página por HTTPS).");
  } else {
    const res = size ? ` a ${size.width}×${size.height}` : "";
    if (!s.vp9.ok && !s.avc.ok) msgs.push(`Este navegador no puede codificar ni VP9 ni H.264${res}. Usa Chrome o Edge de escritorio.`);
    else if (!s.vp9.ok) msgs.push(`Este navegador no puede codificar VP9${res}: solo se generará el MP4 (H.264). Para tener también el WebM, usa Chrome o Edge de escritorio.`);
    else if (!s.avc.ok) msgs.push(`Este navegador no puede codificar H.264${res}: solo se generará el WebM (VP9), y Safari/iOS se quedarán con el poster. Para tener también el MP4, usa Chrome o Edge de escritorio.`);
    if (!s.opus) msgs.push("No se puede codificar audio Opus: el WebM saldrá sin sonido.");
    if (!s.aac) msgs.push("No se puede codificar audio AAC: el MP4 saldrá sin sonido.");
  }
  box.replaceChildren(...msgs.map((t) => Object.assign(document.createElement("p"), { textContent: t })));
  box.classList.toggle("warn", msgs.length > 0);
  box.hidden = msgs.length === 0;
}

// Se vuelve a comprobar cuando cambian resolución, bitrate o audio (afectan al nivel del códec).
let supportSeq = 0;
async function refreshSupport() {
  const seq = ++supportSeq;
  const s = source ? settings() : null;
  const result = s
    ? await checkSupport(s.width, s.height, s.videoBitrate, s.fps, s.audioBitrate)
    : await checkSupport(1280, 720, 1.5e6, 30, 0);
  if (seq !== supportSeq) return;
  support = result;
  renderSupport(result, s);
  renderEstimate();
}

/* ---------- Estimación ---------- */

function cell(text, cls = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function renderEstimate() {
  const tbody = $("estimate").querySelector("tbody");
  const note = $("estimateNote");
  note.replaceChildren();
  if (!source) {
    tbody.replaceChildren();
    const tr = document.createElement("tr");
    tr.appendChild(cell("Suelta un vídeo para ver la estimación.", "dim")).colSpan = 6;
    tbody.appendChild(tr);
    $("convert").disabled = true;
    return;
  }
  const s = settings();
  const names = fileNames(s);
  const targetMb = Math.max(0.1, +$("targetMb").value || 8);
  const target = targetMb * 1048576;
  const bytes = estimateBytes(s);
  const over = bytes > target;
  const rows = [];

  const orig = document.createElement("tr");
  orig.append(
    cell(source.file.name + " (original)", "dim"),
    cell(codecName(source.videoCodec) + (source.audioTrack ? " + " + codecName(source.audioCodec) : ""), "dim"),
    cell(`${source.width}×${source.height}`, "num dim"),
    cell(source.fps ? fmtFps(source.fps) : "—", "num dim"),
    cell(source.bitrate ? fmtRate(source.bitrate) : "—", "num dim"),
    cell(fmt(source.file.size) + (s.duration < source.duration - 0.05 ? ` · ≈ ${fmt(source.file.size * s.duration / source.duration)} recortado` : ""), "num dim"),
  );
  rows.push(orig);

  const outs = [
    { name: names.webm, codec: "VP9", audio: "Opus", info: support?.vp9 },
    { name: names.mp4, codec: "H.264", audio: "AAC", info: support?.avc },
  ];
  for (const o of outs) {
    const tr = document.createElement("tr");
    const ok = !support || o.info.ok;
    const hw = ok && support ? (o.info.hw ? " · hardware" : " · software") : "";
    tr.append(
      cell(o.name),
      cell(o.codec + (s.audioBitrate ? " + " + o.audio : "") + hw, "nowrap"),
      cell(`${s.width}×${s.height}`, "num"),
      cell(fmtFps(s.fps), "num"),
      cell(fmtRate(s.videoBitrate + s.audioBitrate), "num"),
      ok ? cell("≈ " + fmt(bytes), "num " + (over ? "over" : "ok")) : cell("No compatible", "num over"),
    );
    rows.push(tr);
  }
  tbody.replaceChildren(...rows);

  const lines = [];
  if (over) {
    const maxDur = target * 8 / OVERHEAD / (s.videoBitrate + s.audioBitrate);
    const maxRate = target * 8 / OVERHEAD / s.duration - s.audioBitrate;
    const err = document.createElement("span");
    err.className = "err";
    err.textContent = `Supera el objetivo de ${targetMb.toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB por archivo.`;
    const fixes = [`recorta a ≤ ${num(maxDur)} s`];
    if (maxRate >= 200000) fixes.push(`baja el vídeo a ≤ ${num(maxRate / 1e6, 2)} Mbps`);
    if (s.audioBitrate) fixes.push("quita el audio");
    lines.push(err, ` Para entrar: ${fixes.join(", o ")}.`);
  } else {
    lines.push(`Por debajo del objetivo de ${targetMb.toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB por archivo.`);
  }
  lines.push(` Duración ${num(s.duration)} s · keyframe cada ${KEYFRAME_INTERVAL} s · sin metadatos.`);
  if (s.capped) lines.push(" El bitrate se limita al del original para no inflar el archivo.");
  if (source.fps > MAX_FPS + 0.01) lines.push(` Se baja de ${fmtFps(source.fps)} a ${MAX_FPS} fps.`);
  if (+$("audio").value && !source.audioTrack) lines.push(" El original no tiene audio.");
  lines.push(` Rutas en el snippet: ${s.basePath}${names.webm}`);
  note.append(...lines);

  // El motor de codificación llega en la fase 2.
  $("convert").disabled = true;
}

// Cambios que afectan a la configuración del codificador: recalcular soporte y estimación.
let refreshTimer = 0;
function refresh() {
  renderEstimate();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshSupport, 150);
}

/* ---------- Carga y análisis del vídeo ---------- */

// Carga una librería de vendor/ solo la primera vez que hace falta.
const scriptCache = {};
function loadScript(src) {
  return (scriptCache[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete scriptCache[src]; reject(new Error("no se pudo cargar " + src)); };
    document.head.appendChild(s);
  }));
}

const isVideo = (f) => EXT.test(f.name) || f.type.startsWith("video/");

async function analyze(file) {
  await loadScript(MEDIABUNNY);
  const { Input, ALL_FORMATS, BlobSource } = window.Mediabunny;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("el archivo no tiene pista de vídeo");
    const audioTrack = await input.getPrimaryAudioTrack();
    const [width, height, duration, videoCodec, canDecode] = await Promise.all([
      videoTrack.getDisplayWidth(), videoTrack.getDisplayHeight(), input.computeDuration(),
      videoTrack.getCodec(), videoTrack.canDecode(),
    ]);
    if (!canDecode) throw new Error(`este navegador no puede decodificar ${codecName(videoCodec)}`);
    const [fpsMetrics, vStats, aStats, audioCodec] = await Promise.all([
      videoTrack.computeFrameRateMetrics(),
      videoTrack.computePacketStats(),
      audioTrack ? audioTrack.computePacketStats() : null,
      audioTrack ? audioTrack.getCodec() : null,
    ]);
    const usableAudio = audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;
    return {
      file, input, videoTrack, audioTrack: usableAudio, hadAudio: !!audioTrack,
      width, height, duration, videoCodec, audioCodec,
      fps: fpsMetrics.bestGuessFrameRate || 0,
      videoBitrate: vStats.averageBitrate || 0,
      bitrate: (vStats.averageBitrate || 0) + (aStats?.averageBitrate || 0),
    };
  } catch (err) {
    input.dispose();
    throw err;
  }
}

function renderDrop() {
  const loaded = !!source;
  $("drop").classList.toggle("loaded", loaded);
  $("iconVideo").toggleAttribute("hidden", !loaded);
  if (!loaded) {
    $("dropTitle").textContent = "Suelta un vídeo";
    $("dropHint").textContent = "MP4 · MOV · WebM · un vídeo cada vez";
    return;
  }
  const s = source;
  $("dropTitle").textContent = s.file.name;
  $("dropHint").textContent = [
    `${s.width}×${s.height}`, s.fps ? fmtFps(s.fps) + " fps" : null, fmtTime(s.duration),
    codecName(s.videoCodec) + (s.audioTrack ? " + " + codecName(s.audioCodec) : s.hadAudio ? " + audio no decodificable" : " · sin audio"),
    s.bitrate ? fmtRate(s.bitrate) : null, fmt(s.file.size),
  ].filter(Boolean).join(" · ");
}

async function setFile(file, note = "") {
  if (!isVideo(file)) {
    $("summary").textContent = `«${file.name}» no es un vídeo compatible: suelta un MP4, MOV o WebM.`;
    return;
  }
  const seq = ++loadSeq;
  $("summary").textContent = "Analizando el vídeo…";
  try {
    const info = await analyze(file);
    if (seq !== loadSeq) { info.input.dispose(); return; }
    if (source) source.input.dispose();
    source = info;
  } catch (err) {
    if (seq !== loadSeq) return;
    $("summary").textContent = `No se pudo leer «${file.name}»: ${err.message}.`;
    return;
  }
  outputs = [];
  $("zip").disabled = true;
  $("results").hidden = true;
  $("slug").value = slugify(file.name.replace(/\.[^.]+$/, ""));
  trim = { start: 0, end: source.duration };
  setupTrim();
  setupPreview(file);
  renderDrop();
  $("editor").hidden = false;
  $("summary").textContent = `Vídeo listo. Elige preset y recorte.${note}`;
  refresh();
}

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) setFile(e.target.files[0]);
  e.target.value = ""; // permite volver a elegir el mismo archivo
});

// Evita que soltar fuera de la zona haga que el navegador abra el archivo.
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));

const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, () => drop.classList.add("over")));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
});
drop.addEventListener("drop", (e) => {
  const list = [...e.dataTransfer.files];
  const video = list.find(isVideo);
  if (!video) {
    $("summary").textContent = list.length ? "No has soltado ningún vídeo compatible (MP4, MOV o WebM)." : "No se pudo leer lo soltado.";
    return;
  }
  setFile(video, list.length > 1 ? ` Solo se procesa un vídeo cada vez: se ha usado «${video.name}».` : "");
});

/* ---------- Vista previa y recorte ---------- */

const preview = $("preview");
let previewUrl = null;

function setupPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $("previewError").hidden = true;
  stopTrimPlayback();
  preview.src = previewUrl;
}
preview.addEventListener("error", () => { if (preview.src) $("previewError").hidden = false; });
preview.addEventListener("loadedmetadata", () => { preview.currentTime = trim.start; });

function setupTrim() {
  for (const id of ["trimStart", "trimEnd"]) {
    $(id).max = source.duration.toFixed(1);
  }
  $("trimStart").value = 0;
  $("trimEnd").value = source.duration.toFixed(1);
  renderTrim();
}

function renderTrim() {
  $("startOut").textContent = fmtTime(trim.start);
  $("endOut").textContent = fmtTime(trim.end);
  $("durOut").textContent = num(trim.end - trim.start) + " s";
}

function onTrimInput(which) {
  const d = source.duration;
  let start = +$("trimStart").value;
  let end = Math.min(d, +$("trimEnd").value);
  // El slider que se mueve empuja al otro para mantener una duración mínima.
  if (end - start < MIN_DURATION) {
    if (which === "start") { start = Math.max(0, end - MIN_DURATION); $("trimStart").value = start; }
    else { end = Math.min(d, start + MIN_DURATION); $("trimEnd").value = end; }
  }
  // El último paso del slider puede quedar por debajo de la duración real: se ajusta al final exacto.
  if (end >= d - 0.05) end = d;
  trim = { start, end };
  renderTrim();
  stopTrimPlayback();
  if (preview.readyState >= 1) preview.currentTime = which === "start" ? start : Math.max(start, end - 0.05);
  renderEstimate();
}
$("trimStart").addEventListener("input", () => onTrimInput("start"));
$("trimEnd").addEventListener("input", () => onTrimInput("end"));
$("resetTrim").addEventListener("click", () => {
  if (!source) return;
  $("trimStart").value = 0;
  $("trimEnd").value = $("trimEnd").max;
  trim = { start: 0, end: source.duration };
  renderTrim();
  stopTrimPlayback();
  if (preview.readyState >= 1) preview.currentTime = 0;
  renderEstimate();
});

function stopTrimPlayback() {
  preview.pause();
  $("playTrim").textContent = "▶ Reproducir recorte";
}
$("playTrim").addEventListener("click", () => {
  if (!source) return;
  if (!preview.paused) return stopTrimPlayback();
  if (preview.currentTime < trim.start || preview.currentTime >= trim.end - 0.05) preview.currentTime = trim.start;
  preview.play().then(() => { $("playTrim").textContent = "❚❚ Pausar"; }, () => {});
});
// Reproduce en bucle solo el tramo recortado.
preview.addEventListener("timeupdate", () => {
  if (!preview.paused && preview.currentTime >= trim.end) preview.currentTime = trim.start;
});

/* ---------- Inicio ---------- */

loadPrefs();
renderEstimate();
refreshSupport();
