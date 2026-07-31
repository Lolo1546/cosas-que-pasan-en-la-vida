const fs = require("fs");
const puppeteer = require("puppeteer");

const CHANNELS_FILE = "channels.json";
const OUTPUT_FILE = "liga1.m3u";

const PAGE_TIMEOUT_MS = 25000;
const STREAM_WAIT_MS = 12000;
const VALID_STATUS = 200;

// Patrón correcto según lo observado en Network:
// https://khala.skylivehd.com/<canal>/tracks-v1a1/mono.m3u8?ip=...&token=...
const REQUIRED_STREAM_PART = "/tracks-v1a1/mono.m3u8";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    throw new Error(`No existe el archivo ${CHANNELS_FILE}`);
  }

  const raw = fs.readFileSync(CHANNELS_FILE, "utf8");
  const channels = JSON.parse(raw);

  if (!Array.isArray(channels)) {
    throw new Error(`${CHANNELS_FILE} debe contener un arreglo JSON`);
  }

  for (const channel of channels) {
    if (!channel.name || !channel.pageUrl) {
      throw new Error(
        `Cada canal debe tener al menos "name" y "pageUrl": ${JSON.stringify(channel)}`
      );
    }
  }

  return channels;
}

function normalizeLine(line) {
  return line.trim();
}

function readPreviousLinks() {
  const previousLinks = new Map();

  if (!fs.existsSync(OUTPUT_FILE)) {
    return previousLinks;
  }

  const lines = fs.readFileSync(OUTPUT_FILE, "utf8").split(/\r?\n/);

  let currentName = null;

  for (const line of lines) {
    const cleanLine = normalizeLine(line);

    if (cleanLine.startsWith("#EXTINF")) {
      const commaIndex = cleanLine.lastIndexOf(",");
      if (commaIndex !== -1) {
        currentName = cleanLine.slice(commaIndex + 1).trim();
      }
      continue;
    }

    if (currentName && cleanLine.startsWith("http")) {
      previousLinks.set(currentName, cleanLine);
      currentName = null;
    }
  }

  return previousLinks;
}

function isCandidateStream(url, match = ".m3u8") {
  if (!url || typeof url !== "string") {
    return false;
  }

  if (!url.startsWith("http")) {
    return false;
  }

  if (!url.includes(match)) {
    return false;
  }

  // No queremos segmentos de video.
  if (url.includes(".ts?") || url.endsWith(".ts")) {
    return false;
  }

  // No queremos playlists genéricos si ya sabemos que el correcto es mono.m3u8.
  if (url.includes("/index.m3u8")) {
    return false;
  }

  if (url.includes("/master.m3u8")) {
    return false;
  }

  if (url.includes("/playlist.m3u8")) {
    return false;
  }

  // Filtro principal: aceptar solo el patrón correcto observado en Network.
  if (!url.includes(REQUIRED_STREAM_PART)) {
    return false;
  }

  return true;
}

async function findStreamUrl(browser, channel) {
  const page = await browser.newPage();

  let resolved = false;
  let streamUrl = null;
  let totalM3u8Detected = 0;
  let totalRejected = 0;

  try {
    await page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    await page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    const streamPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, STREAM_WAIT_MS);

      page.on("response", async (response) => {
        if (resolved) {
          return;
        }

        const url = response.url();
        const status = response.status();

        if (!url.includes(".m3u8")) {
          return;
        }

        totalM3u8Detected++;

        console.log(`[${channel.name}] .m3u8 detectado: ${url}`);
        console.log(`[${channel.name}] status: ${status}`);

        if (status !== VALID_STATUS) {
          totalRejected++;
          console.log(`[${channel.name}] Rechazado por status distinto de 200`);
          return;
        }

        const match = channel.match || ".m3u8";

        if (!isCandidateStream(url, match)) {
          totalRejected++;
          console.log(`[${channel.name}] Rechazado porque no cumple el patrón correcto`);
          return;
        }

        resolved = true;
        streamUrl = url;
        clearTimeout(timer);

        console.log(`[${channel.name}] Enlace válido encontrado: ${url}`);
        resolve(url);
      });
    });

    console.log("");
    console.log(`Procesando: ${channel.name}`);
    console.log(`Página: ${channel.pageUrl}`);

    await page.goto(channel.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    const result = await streamPromise;

    if (!result) {
      console.log(`[${channel.name}] No se encontró enlace válido`);
      console.log(`[${channel.name}] Total .m3u8 detectados: ${totalM3u8Detected}`);
      console.log(`[${channel.name}] Total rechazados: ${totalRejected}`);
    }

    return result;
  } catch (error) {
    console.log(`[${channel.name}] Error procesando canal: ${error.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function buildM3U(channels, results, previousLinks) {
  const lines = ["#EXTM3U", ""];

  for (const channel of channels) {
    const newUrl = results.get(channel.name);
    const previousUrl = previousLinks.get(channel.name);

    const finalUrl = newUrl || previousUrl;

    lines.push(`#EXTINF:-1,${channel.name}`);

    if (finalUrl) {
      lines.push(finalUrl);
    } else {
      lines.push(`# SIN ENLACE DISPONIBLE PARA ${channel.name}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

function saveIfChanged(content) {
  const previousContent = fs.existsSync(OUTPUT_FILE)
    ? fs.readFileSync(OUTPUT_FILE, "utf8")
    : "";

  if (previousContent === content) {
    console.log("Sin cambios en el archivo M3U.");
    return false;
  }

  fs.writeFileSync(OUTPUT_FILE, content, "utf8");
  console.log(`Archivo actualizado: ${OUTPUT_FILE}`);
  return true;
}

async function run() {
  const channels = loadChannels();
  const previousLinks = readPreviousLinks();
  const results = new Map();

  console.log(`Canales cargados: ${channels.length}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    for (const channel of channels) {
      const streamUrl = await findStreamUrl(browser, channel);

      if (streamUrl) {
        results.set(channel.name, streamUrl);
      } else {
        const previousUrl = previousLinks.get(channel.name);

        if (previousUrl) {
          console.log(`[${channel.name}] Se conserva enlace anterior`);
        } else {
          console.log(`[${channel.name}] No hay enlace anterior para conservar`);
        }
      }

      await sleep(1000);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const newContent = buildM3U(channels, results, previousLinks);
  saveIfChanged(newContent);

  console.log("");
  console.log("Resumen:");
  console.log(`Canales procesados: ${channels.length}`);
  console.log(`Canales actualizados: ${results.size}`);
  console.log(`Canales conservados o sin enlace: ${channels.length - results.size}`);
}

run().catch((error) => {
  console.error("Error general:", error);
  process.exit(1);
});
