import { useRust } from "./rust-binding.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HANDY_MODEL_CATALOG_SHA256, HANDY_MODELS } from "./handy-model-catalog.js";
import { rustDomain } from "./rust-domain.js";

export const PLUGIN_ID = "rage";
export const DEFAULT_MODEL_ID = "whisper-small";

const handyCatalogDigest = createHash("sha256").update(JSON.stringify(HANDY_MODELS, null, 2)).digest("hex");
if (handyCatalogDigest !== HANDY_MODEL_CATALOG_SHA256) throw new Error("Handy model catalog integrity check failed");

const BUILTIN_MODELS = [
  {
    id: "whisper-tiny-q5_1",
    name: "Whisper Tiny Q5_1",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-tiny-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
    sizeMB: 31,
    languages: "multilingual",
    description: "Fastest and smallest option. Best for short, clear dictation when accuracy is less important.",
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-tiny.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    sizeMB: 74,
    languages: "multilingual",
    description: "Tiny multilingual model with a little more accuracy than the compact Q5_1 build.",
  },
  {
    id: "whisper-tiny-en",
    name: "Whisper Tiny English",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-tiny.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    sizeMB: 74,
    languages: "English",
    description: "Fastest English-only Whisper model.",
  },
  {
    id: "whisper-base-q5_1",
    name: "Whisper Base Q5_1",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-base-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    sizeMB: 57,
    languages: "multilingual",
    description: "Small multilingual model for lower-memory machines.",
  },
  {
    id: "whisper-base",
    name: "Whisper Base",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    sizeMB: 141,
    languages: "multilingual",
    description: "Balanced small multilingual model.",
  },
  {
    id: "whisper-base-en",
    name: "Whisper Base English",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-base.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    sizeMB: 141,
    languages: "English",
    description: "Balanced small English-only model.",
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    engine: "whisper.cpp",
    implemented: true,
    recommended: true,
    filename: "ggml-small.bin",
    url: "https://blob.handy.computer/ggml-small.bin",
    urls: ["https://blob.handy.computer/ggml-small.bin", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"],
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    sizeMB: 465,
    languages: "multilingual",
    description: "Good first local model. Multilingual, including Russian, but not tiny.",
  },
  {
    id: "whisper-small-q5_1",
    name: "Whisper Small Q5_1",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    sizeMB: 181,
    languages: "multilingual",
    description: "Compact version of Small with a better speed and memory trade-off.",
  },
  {
    id: "whisper-small-en",
    name: "Whisper Small English",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-small.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    sizeMB: 465,
    languages: "English",
    description: "Small English-only model with better English recognition than Tiny or Base.",
  },
  {
    id: "whisper-medium-q5_0",
    name: "Whisper Medium Q5_0",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-medium-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    sizeMB: 514,
    languages: "multilingual",
    description: "Higher-quality multilingual model for machines with more memory.",
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-medium.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    sizeMB: 1463,
    languages: "multilingual",
    description: "Full-precision Medium for higher multilingual accuracy.",
  },
  {
    id: "whisper-medium-en",
    name: "Whisper Medium English",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-medium.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
    sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
    sizeMB: 1463,
    languages: "English",
    description: "Full-precision Medium optimized for English.",
  },
  {
    id: "whisper-medium-q4_1",
    name: "Whisper Medium Q4_1",
    engine: "whisper.cpp",
    implemented: true,
    filename: "whisper-medium-q4_1.bin",
    url: "https://blob.handy.computer/whisper-medium-q4_1.bin",
    urls: ["https://blob.handy.computer/whisper-medium-q4_1.bin"],
    sha256: "79283fc1f9fe12ca3248543fbd54b73292164d8df5a16e095e2bceeaaabddf57",
    sizeMB: 469,
    languages: "multilingual",
    description: "Better accuracy than Small with a quantized model size.",
  },
  {
    id: "whisper-turbo",
    name: "Whisper Turbo",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v3-turbo.bin",
    url: "https://blob.handy.computer/ggml-large-v3-turbo.bin",
    urls: ["https://blob.handy.computer/ggml-large-v3-turbo.bin", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"],
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    sizeMB: 1549,
    languages: "multilingual",
    description: "Large and accurate. Download only if you want the bigger model.",
  },
  {
    id: "whisper-turbo-q5_0",
    name: "Whisper Turbo Q5_0",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    sizeMB: 547,
    languages: "multilingual",
    description: "Quantized Turbo: stronger recognition than Small in less space than full Turbo.",
  },
  {
    id: "whisper-large-q5_0",
    name: "Whisper Large Q5_0",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v3-q5_0.bin",
    url: "https://blob.handy.computer/ggml-large-v3-q5_0.bin",
    urls: ["https://blob.handy.computer/ggml-large-v3-q5_0.bin", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin"],
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    sizeMB: 1031,
    languages: "multilingual",
    description: "Accurate but slower. Good machines only.",
  },
  {
    id: "whisper-large-v1",
    name: "Whisper Large V1",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v1.bin",
    sha256: "7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d",
    sizeMB: 2951,
    languages: "multilingual",
    description: "Original full Large model. Very large and slow on CPU.",
  },
  {
    id: "whisper-large-v2",
    name: "Whisper Large V2",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v2.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin",
    sha256: "9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487",
    sizeMB: 2951,
    languages: "multilingual",
    description: "Second-generation full Large model. Very large and slow on CPU.",
  },
  {
    id: "whisper-large-v3",
    name: "Whisper Large V3",
    engine: "whisper.cpp",
    implemented: true,
    filename: "ggml-large-v3.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    sizeMB: 2952,
    languages: "multilingual",
    description: "Latest full Large model. Highest resource requirement in the Whisper set.",
  },
];

const native = (op, args = {}) => rustDomain("catalog", op, args);
export const MODELS = native("models") ?? [...BUILTIN_MODELS, ...HANDY_MODELS];

export const DEFAULT_SETTINGS = native("defaults") ?? {
  recordingHotkey: "",
  voiceAnimation: true,
  orb: "cycle",
  submitHotkey: "",
  model: DEFAULT_MODEL_ID,
  language: "ru",
  uiLanguage: "auto",
  mic: "",
  autoSubmit: false,
  downloadDir: "",
  onboardingDone: false,
  setupSkipped: false,
};

// MODELS is a public mutable extension seam. A changed catalog must be looked up as exported.
const catalogKeys = ["id", "filename", "sha256", "implemented", "languages", "engine", "name", "sizeMB"];
const original = MODELS.map((m) => Object.fromEntries(catalogKeys.map((k) => [k, m[k]])));
export function originalCatalog() {
  return MODELS.length === original.length && original.every((m, i) =>
    catalogKeys.every((key) => m[key] === MODELS[i]?.[key]));
}
const modelIndices = new Map(original.map((m, i) => [m.id, i]));
const fsMethods = ["readdirSync", "statSync", "readFileSync", "existsSync"].map((key) => [key, fs[key]]);
function nativePaths(op, options, settings, model) {
  if (!useRust() || process.platform === "win32") return;
  const dir = settings.downloadDir || options.downloadDir;
  if (dir && typeof dir !== "string") return;
  if (model && (typeof model.filename !== "string" || (model.sha256 && typeof model.sha256 !== "string"))) return;
  return native(op, { options: { downloadDir: dir || "" }, model: model && { filename: model.filename, sha256: model.sha256 } });
}
const nativeFs = () => fsMethods.every(([key, fn]) => fs[key] === fn);

export function nativePickerRows(options, settings, uiLanguage, words) {
  if (!useRust() || process.platform === "win32" || !originalCatalog() || !nativeFs()) return;
  const dir = settings.downloadDir || options.downloadDir;
  if (dir && typeof dir !== "string") return;
  return native("pickerRows", { options: { downloadDir: dir || "" }, uiLanguage, words });
}

export function expandHome(value) {
  if (!value) return value;
  if (process.platform !== "win32" && typeof value === "string" && (!value.endsWith("/") || value === "~/")) {
    const result = native("expandHome", { value });
    if (result !== undefined) return result;
  }
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getCacheDir(options = {}, settings = {}) {
  const result = nativePaths("getCacheDir", options, settings);
  if (result !== undefined) return result;
  const configured = settings.downloadDir || options.downloadDir || process.env.OPENCODE_VOICE_DIR;
  if (configured) return path.resolve(expandHome(configured));

  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  // Keep downloaded models and engines available to existing voice installations.
  return path.join(xdg, "opencode-voice");
}

export function getModelsDir(options = {}, settings = {}) {
  const result = nativePaths("getModelsDir", options, settings);
  if (result !== undefined) return result;
  return path.join(getCacheDir(options, settings), "models");
}

export function getAudioDir(options = {}, settings = {}) {
  const result = nativePaths("getAudioDir", options, settings);
  if (result !== undefined) return result;
  return path.join(getCacheDir(options, settings), "recordings");
}

export function getEnginesDir(options = {}, settings = {}) {
  const result = nativePaths("getEnginesDir", options, settings);
  if (result !== undefined) return result;
  return path.join(getCacheDir(options, settings), "engines");
}

export function getModel(id) {
  if (useRust() && originalCatalog()) {
    const result = native("getModel", { id: typeof id === "string" ? id : null });
    return MODELS[modelIndices.get(result.id)];
  }
  return MODELS.find((model) => model.id === id) || MODELS.find((model) => model.id === DEFAULT_MODEL_ID);
}

export function getModelPath(model, options = {}, settings = {}) {
  if (!model?.filename) return "";
  const result = nativePaths("getModelPath", options, settings, model);
  if (result !== undefined) return result;
  return path.join(getModelsDir(options, settings), model.filename);
}

export function getModelVerificationPath(model, options = {}, settings = {}) {
  const result = nativePaths("getModelVerificationPath", options, settings, model);
  if (result !== undefined) return result;
  const file = getModelPath(model, options, settings);
  return file ? `${file}.sha256` : "";
}

export function isModelFilePresent(model, options = {}, settings = {}) {
  if (nativeFs()) {
    const result = nativePaths("isModelFilePresent", options, settings, model);
    if (result !== undefined) return result;
  }
  const file = getModelPath(model, options, settings);
  return Boolean(file && fs.existsSync(file) && fs.statSync(file).size > 0);
}

export function isModelDownloaded(model, options = {}, settings = {}) {
  if (!model?.filename) return false;
  if (nativeFs()) {
    const result = nativePaths("isModelDownloaded", options, settings, model);
    if (result !== undefined) return result;
  }
  const stat = fs.statSync(getModelPath(model, options, settings), { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile() || !stat.size) return false;
  if (!model?.sha256) return true;

  const marker = getModelVerificationPath(model, options, settings);
  return markerMatches(marker, model.sha256, stat);
}

export function modelVerificationStamp(digest, stat) {
  if (useRust() && typeof digest === "string" && /^[a-f\d]+$/i.test(digest)) {
    const fields = Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => [key, `${stat[key]}`]));
    return native("modelVerificationStamp", { digest, stat: fields });
  }
  return `${digest.toLowerCase()} ${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function markerMatches(marker, sha256, stat, listing = false) {
  try {
    const value = fs.readFileSync(marker, "utf8").trim().toLowerCase();
    // Legacy receipts are display hints only. Activation rehashes once and upgrades them.
    return value === modelVerificationStamp(sha256, stat) || (listing && value === sha256.toLowerCase());
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function listedNames(dir) {
  try {
    // The listing is only a prefilter. The actual lookup respects the volume's case sensitivity.
    const names = new Set(fs.readdirSync(dir).map((name) => name.toLowerCase()));
    return (name) => names.has(name.toLowerCase());
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return () => false;
    // A searchable directory can permit access to known files without allowing enumeration.
    if (error.code === "EACCES" || error.code === "EPERM") return (name) => fs.existsSync(path.join(dir, name));
    throw error;
  }
}

export function getModelInventory(options = {}, settings = {}) {
  if (useRust() && originalCatalog() && nativeFs()) {
    const result = nativePaths("getModelInventory", options, settings);
    if (result !== undefined) return result.map(({ status }, i) => ({ model: MODELS[i], status }));
  }
  const dir = getModelsDir(options, settings);
  const listed = listedNames(dir);
  function status(model) {
    if (!model.implemented) return "planned";
    if (!model.filename || !listed(model.filename)) return "not downloaded";
    const file = path.join(dir, model.filename);
    let stat;
    try {
      stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
      if (!stat?.isFile() || !stat.size) return "not downloaded";
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") return "not downloaded";
      throw error;
    }
    if (!model.sha256) return "downloaded";
    const verified = listed(`${model.filename}.sha256`) && markerMatches(`${file}.sha256`, model.sha256, stat, true);
    return verified ? "downloaded" : "needs verification";
  }
  return MODELS.map((model) => ({ model, status: status(model) }));
}

export function formatSize(model) {
  if (typeof model?.sizeMB === "number" && Number.isFinite(model.sizeMB)) {
    const result = native("formatSize", { model: { sizeMB: model.sizeMB } });
    if (result !== undefined) return result;
  }
  if (!model?.sizeMB) return "unknown size";
  if (model.sizeMB >= 1000) return `${(model.sizeMB / 1000).toFixed(1)} GB`;
  return `${model.sizeMB} MB`;
}
