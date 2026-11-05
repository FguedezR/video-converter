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
  hero: { maxHeight: 720, bitrate: 1.5, audio: 0, snippet: "bg" },
  hero1080: { maxHeight: 1080, bitrate: 3, audio: 0, snippet: "block" },
  content: { maxHeight: 1080, bitrate: 4, audio: 128, snippet: "controls" },
};

let source = null; // vídeo analizado: { file, input, videoTrack, audioTrack, width, height, fps, duration, ... }
let trim = { start: 0, end: 0 };
let support = null; // resultado de checkSupport() para la configuración actual
let loadSeq = 0; // descarta análisis obsoletos si se suelta otro vídeo a mitad
let outputs = []; // { kind, blob, url, info } o { kind, error }: resultado de la última conversión
let converting = null; // { conversion, canceled } mientras se codifica
let convertedKey = ""; // ajustes con los que se generaron las salidas actuales

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

// Ruta (o URL completa) donde se publicarán los archivos; el snippet la antepone a cada nombre.
const defaultBasePath = () => "/media/";
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
  $("snippetMode").value = p.snippet;
}

function savePrefs() {
  try {
    localStorage.setItem("video-prefs", JSON.stringify({
      preset: currentPreset(), maxHeight: $("maxHeight").value, bitrate: $("bitrate").value,
      audio: $("audio").value, targetMb: $("targetMb").value, snippetMode: $("snippetMode").value,
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
      if (p.snippetMode) $("snippetMode").value = p.snippetMode;
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
// El tipo de snippet no afecta a la codificación: solo regenera el texto.
$("snippetMode").addEventListener("change", () => { savePrefs(); renderSnippet(); });
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
    updateButtons();
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
  }
  if (bytes > CF_MAX_FILE) {
    const err = document.createElement("span");
    err.className = "err";
    err.textContent = " Cloudflare Pages no publica archivos de más de 25 MiB: recorta o baja el bitrate (o sírvelo desde R2).";
    lines.push(err);
  }
  if (!over) lines.push(`Por debajo del objetivo de ${targetMb.toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB por archivo.`);
  lines.push(` Duración ${num(s.duration)} s · keyframe cada ${KEYFRAME_INTERVAL} s · sin metadatos.`);
  if (s.capped) lines.push(" El bitrate se limita al del original para no inflar el archivo.");
  if (source.fps > MAX_FPS + 0.01) lines.push(` Se baja de ${fmtFps(source.fps)} a ${MAX_FPS} fps.`);
  if (+$("audio").value && !source.audioTrack) lines.push(" El original no tiene audio.");
  lines.push(` Rutas en el snippet: ${s.basePath}${names.webm}`);
  note.append(...lines);

  if (outputs.length) renderResults(); // el slug o la versión cambian los nombres de la tabla
  renderPosterInfo();
  updateButtons();
}

// Cambios que afectan a la configuración del codificador: recalcular soporte, estimación y poster.
let refreshTimer = 0;
function refresh() {
  renderEstimate();
  schedulePoster();
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
    $("dropHint").textContent = "MP4 · MOV · WebM · un vídeo cada vez · opcional: una imagen para el poster";
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
  if (converting) {
    $("summary").textContent = "Espera a que termine la conversión (o cancélala) antes de cargar otro vídeo.";
    return;
  }
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
  clearOutputs();
  resetPoster();
  $("slug").value = slugify(file.name.replace(/\.[^.]+$/, ""));
  trim = { start: 0, end: source.duration };
  setupTrim();
  setupPreview(file);
  renderDrop();
  $("editor").hidden = false;
  $("posterPanel").hidden = false;
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
// Se puede soltar el vídeo junto con una imagen (poster), o solo la imagen si ya hay vídeo.
drop.addEventListener("drop", async (e) => {
  const list = [...e.dataTransfer.files];
  const video = list.find(isVideo);
  const image = list.find(isImage);
  if (!video && image && source && !converting) return setPosterImage(image);
  if (!video) {
    $("summary").textContent = list.length ? "No has soltado ningún vídeo compatible (MP4, MOV o WebM)." : "No se pudo leer lo soltado.";
    return;
  }
  const extra = list.filter((f) => f !== video && f !== image).length + list.filter(isVideo).length - 1;
  await setFile(video, extra > 0 ? ` Solo se procesa un vídeo cada vez: se ha usado «${video.name}».` : "");
  if (image && source?.file === video) setPosterImage(image);
});

/* ---------- Codificación ---------- */

const OUTPUT_KINDS = [
  { kind: "webm", label: "WebM (VP9)", codec: "vp9", audio: "opus", audioLabel: "Opus", mime: "video/webm" },
  { kind: "mp4", label: "MP4 (H.264)", codec: "avc", audio: "aac", audioLabel: "AAC", mime: "video/mp4" },
];
const supportOf = (o) => (o.codec === "vp9" ? support?.vp9 : support?.avc);
const audioSupported = (o) => (o.audio === "opus" ? support?.opus : support?.aac) !== false;

// Lo que obliga a recodificar. El slug y la versión no: solo cambian los nombres.
const settingsKey = (s) => JSON.stringify([source.file.name, source.file.size, s.width, s.height, s.fps, s.videoBitrate, s.audioBitrate, s.trim]);

function updateButtons() {
  const btn = $("convert");
  if (converting) {
    btn.textContent = "Cancelar";
    btn.disabled = !!converting.canceled;
    $("zip").disabled = true;
    return;
  }
  btn.textContent = "Convertir";
  const anyCodec = !support || support.vp9.ok || support.avc.ok;
  const upToDate = !!source && outputs.length > 0 && settingsKey(settings()) === convertedKey;
  btn.disabled = !source || !anyCodec || upToDate;
  // Si cambian ajustes que obligan a recodificar, el ZIP mezclaría vídeos viejos con poster y snippet nuevos.
  $("zip").disabled = !outputs.some((o) => o.blob) || !upToDate || !poster;
  $("zip").title = $("zip").disabled && outputs.length && !upToDate ? "Los ajustes han cambiado: vuelve a convertir" : "";
}

function setBusy(busy) {
  document.querySelectorAll(".controls input, .controls select, .trim input, .trim button, .side input, .side button").forEach((el) => (el.disabled = busy));
  $("drop").classList.toggle("busy", busy);
  $("progress").hidden = !busy;
  if (!busy) $("progressBar").style.width = "0";
}

function clearOutputs() {
  outputs.forEach((o) => o.url && URL.revokeObjectURL(o.url));
  outputs = [];
  convertedKey = "";
  $("results").hidden = true;
  $("results").querySelector("tbody").replaceChildren();
  $("snippetBox").hidden = true;
}

const DISCARD_REASONS = {
  undecodable_source_codec: "el navegador no puede decodificar el original",
  unknown_source_codec: "códec de origen desconocido",
  no_encodable_target_codec: "el navegador no puede codificar este códec",
};

async function encode(o, s, onProgress) {
  const M = window.Mediabunny;
  const format = o.kind === "webm"
    ? new M.WebMOutputFormat()
    // fastStart "in-memory": el índice (moov) se escribe al principio del archivo.
    : new M.Mp4OutputFormat({ fastStart: "in-memory" });
  const output = new M.Output({ format, target: new M.BufferTarget() });
  const withAudio = s.audioBitrate > 0 && audioSupported(o);
  const conversion = await M.Conversion.init({
    input: source.input,
    output,
    tracks: "primary",
    video: {
      codec: o.codec,
      width: s.width,
      height: s.height,
      fit: "cover", // las dimensiones ya conservan la proporción; cover evita bandas por redondeo a par
      ...(source.fps > MAX_FPS + 0.01 ? { frameRate: MAX_FPS } : {}), // por debajo de 30 se respeta el original
      // VP9 (libvpx por software en Chrome) se pasa ~10 % del objetivo en modo variable con vídeos de muchos
      // cortes; en constante clava el peso estimado con la misma calidad que el H.264. H.264 respeta el
      // objetivo en variable, que reparte mejor los bits.
      quality: new M.Quality({ bitrate: s.videoBitrate, bitrateMode: o.codec === "vp9" ? "constant" : "variable" }),
      keyFrameInterval: KEYFRAME_INTERVAL,
      allowTransformationMetadata: false, // la rotación se aplica a los fotogramas, sin metadatos
      forceTranscode: true,
    },
    audio: withAudio
      ? { codec: o.audio, quality: new M.Quality({ bitrate: s.audioBitrate }), forceTranscode: true }
      : { discard: true },
    trim: { start: s.trim.start, end: s.trim.end },
    tags: {}, // sin metadatos descriptivos
    showWarnings: false,
  });
  const lostVideo = conversion.discardedTracks.find((d) => d.track === source.videoTrack);
  if (!conversion.isValid || lostVideo) {
    throw new Error(DISCARD_REASONS[lostVideo?.reason] || "no se pudo preparar la conversión");
  }
  converting.conversion = conversion;
  conversion.onProgress = onProgress;
  await conversion.execute();
  return new Blob([output.target.buffer], { type: o.mime });
}

// Lee la salida con Mediabunny para el informe (lo mismo que se midió del original).
async function probe(blob) {
  const M = window.Mediabunny;
  const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(blob) });
  try {
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    const [width, height, duration, fpsMetrics, videoCodec] = await Promise.all([
      vt.getDisplayWidth(), vt.getDisplayHeight(), input.computeDuration(), vt.computeFrameRateMetrics(), vt.getCodec(),
    ]);
    return {
      width, height, duration, videoCodec,
      fps: fpsMetrics.bestGuessFrameRate,
      bitrate: duration ? blob.size * 8 / duration : 0,
      audioCodec: at ? await at.getCodec() : null,
    };
  } finally {
    input.dispose();
  }
}

function showProgress(o, i, total, p, started) {
  const overall = (i + p) / total;
  $("progressBar").style.width = (overall * 100).toFixed(1) + "%";
  const elapsed = (performance.now() - started) / 1000;
  const eta = p > 0.03 ? Math.max(0, Math.round(elapsed / p * (1 - p))) : null;
  $("summary").textContent = `Codificando ${o.label} · ${i + 1} de ${total} · ${Math.round(p * 100)} %${eta !== null ? ` · ≈ ${eta} s restantes` : ""}`;
}

function renderResults() {
  const s = settings();
  const target = Math.max(0.1, +$("targetMb").value || 8) * 1048576;
  const tbody = $("results").querySelector("tbody");
  const orig = document.createElement("tr");
  orig.append(
    cell(source.file.name + " (original)", "dim"),
    cell(fmt(source.file.size), "num dim"),
    cell(source.bitrate ? fmtRate(source.bitrate) : "—", "num dim"),
    cell(`${source.width}×${source.height}`, "num dim"),
    cell(source.fps ? fmtFps(source.fps) : "—", "num dim"),
    cell(num(source.duration) + " s", "num dim"),
    cell(""),
  );
  const rows = [orig];
  for (const o of outputs) {
    const def = OUTPUT_KINDS.find((k) => k.kind === o.kind);
    const tr = document.createElement("tr");
    if (o.error) {
      tr.append(cell(def.label), cell("Error: " + o.error, "err"));
      tr.lastChild.colSpan = 6;
      rows.push(tr);
      continue;
    }
    const name = fileNames({ ...s, height: o.info.height })[o.kind];
    const saving = Math.round((1 - o.blob.size / source.file.size) * 100);
    const codecs = codecName(o.info.videoCodec) + (o.info.audioCodec ? " + " + codecName(o.info.audioCodec) : " · sin audio");
    tr.append(
      cell(`${name} · ${codecs}`),
      cell(`${fmt(o.blob.size)} (−${saving} %)`, "num " + (o.blob.size > target ? "over" : "ok")),
      cell(fmtRate(o.info.bitrate), "num"),
      cell(`${o.info.width}×${o.info.height}`, "num"),
      cell(fmtFps(o.info.fps), "num"),
      cell(num(o.info.duration) + " s", "num"),
    );
    const td = document.createElement("td");
    td.className = "num";
    const a = Object.assign(document.createElement("a"), { href: o.url, download: name, textContent: "↓ ." + o.kind });
    td.appendChild(a);
    tr.appendChild(td);
    rows.push(tr);
  }
  // El poster no depende de la conversión: se muestra el actual (cambiarlo no obliga a recodificar).
  if (poster) {
    const name = fileNames(s).poster;
    const tr = document.createElement("tr");
    tr.append(
      cell(`${name} · WebP`),
      cell(fmt(poster.blob.size), "num ok"),
      cell("—", "num dim"),
      cell(`${poster.width}×${poster.height}`, "num"),
      cell("—", "num dim"),
      cell("—", "num dim"),
    );
    const td = document.createElement("td");
    td.className = "num";
    td.appendChild(Object.assign(document.createElement("a"), { href: poster.url, download: name, textContent: "↓ .webp" }));
    tr.appendChild(td);
    rows.push(tr);
  }
  tbody.replaceChildren(...rows);
  $("results").hidden = false;
  renderSnippet();
}

async function convert() {
  const s = settings();
  const key = settingsKey(s);
  clearOutputs();
  converting = { conversion: null, canceled: false };
  setBusy(true);
  updateButtons();
  const t0 = performance.now();
  const todo = OUTPUT_KINDS.filter((o) => supportOf(o)?.ok !== false);
  for (const o of OUTPUT_KINDS) {
    if (!todo.includes(o)) outputs.push({ kind: o.kind, error: "este navegador no puede codificarlo" });
  }
  for (const [i, o] of todo.entries()) {
    if (converting.canceled) break;
    const started = performance.now();
    showProgress(o, i, todo.length, 0, started);
    try {
      const blob = await encode(o, s, (p) => showProgress(o, i, todo.length, p, started));
      if (converting.canceled) break;
      const info = await probe(blob);
      outputs.push({ kind: o.kind, blob, info, url: URL.createObjectURL(blob) });
    } catch (err) {
      if (converting.canceled || err instanceof window.Mediabunny.ConversionCanceledError) break;
      console.error(err);
      outputs.push({ kind: o.kind, error: err.message || String(err) });
    }
    outputs.sort((a, b) => OUTPUT_KINDS.findIndex((k) => k.kind === a.kind) - OUTPUT_KINDS.findIndex((k) => k.kind === b.kind));
    renderResults();
  }
  const canceled = converting.canceled;
  converting = null;
  setBusy(false);
  const secs = Math.round((performance.now() - t0) / 1000);
  if (canceled) {
    clearOutputs();
    $("summary").textContent = "Conversión cancelada.";
  } else {
    convertedKey = key;
    const done = outputs.filter((o) => o.blob);
    $("summary").textContent = done.length
      ? `Listo en ${secs} s: ${done.map((o) => `${o.kind.toUpperCase()} ${fmt(o.blob.size)}`).join(" · ")} (original ${fmt(source.file.size)}).`
      : "No se pudo generar ninguna salida.";
    renderResults();
  }
  updateButtons();
  if (!poster) schedulePoster(0); // por si se pidió mientras se codificaba
}

$("convert").addEventListener("click", async () => {
  if (!converting) return convert();
  converting.canceled = true;
  updateButtons();
  $("summary").textContent = "Cancelando…";
  try { await converting.conversion?.cancel(); } catch (e) {}
});

/* ---------- Snippet, cabeceras y ZIP ---------- */

// Datos comunes a snippet.html y _headers, sacados de las salidas reales.
function deliverables(s) {
  const done = outputs.filter((o) => o.blob);
  if (!done.length || !poster) return null;
  const { width, height } = done[0].info;
  const names = fileNames({ ...s, height });
  const has = (kind) => done.some((o) => o.kind === kind);
  const mode = $("snippetMode").value;
  return {
    mode,
    // El id del hero contiene «hv-hero»: es la palabra a excluir en optimizadores que retrasan
    // scripts inline buscando texto en su contenido.
    id: `hv-${mode === "controls" ? "player" : "hero"}-${s.slug}-v${s.version}`,
    width, height,
    base: s.basePath,
    webm: has("webm") ? names.webm : null,
    mp4: has("mp4") ? names.mp4 : null,
    poster: names.poster,
    slug: s.slug,
    version: s.version,
  };
}

function renderSnippet() {
  const d = source && deliverables(settings());
  $("snippetBox").hidden = !d;
  if (d) $("snippetCode").textContent = buildSnippet(d);
}

$("copySnippet").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("snippetCode").textContent);
    $("copySnippet").textContent = "Copiado";
  } catch (e) {
    $("copySnippet").textContent = "No se pudo copiar";
  }
  setTimeout(() => ($("copySnippet").textContent = "Copiar"), 2000);
});

// ZIP final: vídeos, poster, snippet.html y _headers (Cloudflare).
async function buildZip(s) {
  const zip = new JSZip();
  for (const o of outputs.filter((o) => o.blob)) {
    zip.file(fileNames({ ...s, height: o.info.height })[o.kind], o.blob);
  }
  if (poster) zip.file(fileNames(s).poster, poster.blob);
  const d = deliverables(s);
  if (d) {
    zip.file("snippet.html", buildSnippet(d), { compression: "DEFLATE" });
    zip.file("_headers", buildHeaders(d), { compression: "DEFLATE" });
  }
  // Vídeo e imágenes ya van comprimidos: STORE evita gastar tiempo en deflate (los textos sí van con DEFLATE).
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

$("zip").addEventListener("click", async () => {
  const s = settings();
  const blob = await buildZip(s);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.slug}-v${s.version}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
  syncPosterTime();
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

/* ---------- Poster ---------- */

const POSTER_QUALITY = 0.75;
const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif)$/i;
const isImage = (f) => IMAGE_EXT.test(f.name) || f.type.startsWith("image/");

let poster = null; // { blob, url, width, height } con los ajustes actuales
let posterImage = null; // { file, bitmap } si se usa una imagen propia
let posterTime = 0;
let posterTimeTouched = false; // mientras no se toque, el poster sigue al inicio del recorte
let posterSink = null;
let posterSinkKey = "";
let posterSeq = 0;
let posterTimer = 0;
let posterNote = "";

const posterMode = () => document.querySelector('input[name="posterMode"]:checked').value;
function setPosterMode(mode) {
  document.querySelectorAll('input[name="posterMode"]').forEach((r) => (r.checked = r.value === mode));
  $("posterTimeField").hidden = mode !== "frame";
  $("posterImageField").hidden = mode !== "image";
}

function resetPoster() {
  if (poster) URL.revokeObjectURL(poster.url);
  poster = null;
  posterImage?.bitmap.close();
  posterImage = null;
  posterSink = null;
  posterSinkKey = "";
  posterTime = 0;
  posterTimeTouched = false;
  $("posterImageName").textContent = "Sin imagen";
  setPosterMode("frame");
}

// El slider del poster se limita al tramo recortado. Por defecto, el primer fotograma:
// así el fundido del snippet del poster al vídeo no tiene salto.
function syncPosterTime() {
  const range = $("posterTime");
  range.min = trim.start.toFixed(2);
  range.max = Math.max(trim.start, trim.end - 0.04).toFixed(2);
  if (!posterTimeTouched) posterTime = trim.start;
  posterTime = Math.min(Math.max(posterTime, trim.start), +range.max);
  range.value = posterTime;
  $("posterTimeOut").textContent = fmtTime(posterTime);
  if (posterMode() === "frame") schedulePoster();
}

function schedulePoster(delay = 120) {
  if (!source) return;
  clearTimeout(posterTimer);
  posterTimer = setTimeout(updatePoster, delay);
}

async function canvasToWebp(canvas) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/webp", quality: POSTER_QUALITY })
    : await new Promise((res) => canvas.toBlob(res, "image/webp", POSTER_QUALITY));
  if (!blob || blob.type !== "image/webp") throw new Error("este navegador no puede exportar WebP");
  return blob;
}

async function frameCanvas(s) {
  const key = `${s.width}x${s.height}`;
  if (!posterSink || posterSinkKey !== key) {
    // Mismo tamaño y encuadre que el vídeo de salida (cover sobre dimensiones pares).
    posterSink = new window.Mediabunny.CanvasSink(source.videoTrack, { width: s.width, height: s.height, fit: "cover" });
    posterSinkKey = key;
  }
  const frame = (await posterSink.getCanvas(posterTime))
    || (await posterSink.getCanvas(await source.videoTrack.getFirstTimestamp()));
  if (!frame) throw new Error("no se pudo extraer el fotograma");
  posterNote = "";
  return frame.canvas;
}

// La imagen propia se recorta (cover) a la proporción del vídeo, para que el width/height del
// snippet sea el mismo en poster y vídeo y no haya salto de layout.
function imageCanvas(s) {
  const { bitmap, file } = posterImage;
  const canvas = document.createElement("canvas");
  canvas.width = s.width;
  canvas.height = s.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  const scale = Math.max(s.width / bitmap.width, s.height / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (s.width - w) / 2, (s.height - h) / 2, w, h);
  const notes = [];
  if (Math.abs(bitmap.width / bitmap.height - s.width / s.height) > 0.01) {
    notes.push(`«${file.name}» (${bitmap.width}×${bitmap.height}) se recorta al centro para encajar en la proporción del vídeo.`);
  }
  if (scale > 1.01) notes.push("La imagen es más pequeña que el vídeo: se amplía y puede verse borrosa.");
  posterNote = notes.join(" ");
  return canvas;
}

async function updatePoster() {
  if (!source || converting) return;
  const seq = ++posterSeq;
  const s = settings();
  const usingImage = posterMode() === "image" && posterImage;
  try {
    const canvas = usingImage ? imageCanvas(s) : await frameCanvas(s);
    if (seq !== posterSeq) return;
    const view = $("posterCanvas");
    view.width = canvas.width;
    view.height = canvas.height;
    view.getContext("2d").drawImage(canvas, 0, 0);
    const blob = await canvasToWebp(canvas);
    if (seq !== posterSeq) return;
    if (poster) URL.revokeObjectURL(poster.url);
    poster = { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
  } catch (err) {
    if (seq !== posterSeq) return;
    if (poster) URL.revokeObjectURL(poster.url);
    poster = null;
    posterNote = "No se pudo generar el poster: " + err.message + ".";
  }
  renderPosterInfo();
  if (outputs.length) renderResults();
  updateButtons();
}

function renderPosterInfo() {
  const info = $("posterInfo");
  if (!source) return info.replaceChildren();
  const parts = [];
  if (poster) {
    const what = posterMode() === "image" && posterImage ? "imagen propia" : `fotograma ${fmtTime(posterTime)}`;
    parts.push(`${fileNames(settings()).poster} · ${poster.width}×${poster.height} · WebP calidad ${Math.round(POSTER_QUALITY * 100)} · ${fmt(poster.blob.size)} · ${what}.`);
  }
  if (posterMode() === "image" && !posterImage) parts.push("Elige una imagen; mientras tanto se usa el fotograma.");
  if (posterNote) parts.push(posterNote);
  info.textContent = parts.join(" ");
  info.classList.toggle("err", !poster);
}

async function setPosterImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    posterImage?.bitmap.close();
    posterImage = { file, bitmap };
    $("posterImageName").textContent = file.name;
    setPosterMode("image");
    $("summary").textContent = `Poster: se usará «${file.name}».`;
    schedulePoster(0);
  } catch (err) {
    $("summary").textContent = `No se pudo leer la imagen «${file.name}»: formato no compatible.`;
  }
}

$("posterTime").addEventListener("input", () => {
  posterTimeTouched = true;
  posterTime = +$("posterTime").value;
  $("posterTimeOut").textContent = fmtTime(posterTime);
  schedulePoster(60);
});
document.querySelectorAll('input[name="posterMode"]').forEach((r) => r.addEventListener("change", () => {
  setPosterMode(r.value);
  if (r.value === "image" && !posterImage) $("posterFile").click();
  schedulePoster(0);
}));
$("pickPoster").addEventListener("click", () => $("posterFile").click());
$("posterFile").addEventListener("change", (e) => {
  if (e.target.files[0]) setPosterImage(e.target.files[0]);
  e.target.value = "";
});

/* ---------- Inicio ---------- */

loadPrefs();
renderEstimate();
refreshSupport();
