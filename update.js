const fs = require("fs");
const puppeteer = require("puppeteer");

const CHANNELS_FILE = "channels.json";
const OUTPUT_FILE = "liga1.m3u";

const PAGE_TIMEOUT_MS = 45000;
const STREAM_WAIT_MS = 25000;
const VALID_STATUS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    throw new Error(`No existe ${CHANNELS_FILE}`);
  }

  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));

  if (!Array.isArray(channels)) {
    throw new Error(`${CHANNELS_FILE} debe contener un arreglo de canales`);
  }

  return channels.map((channel, index) => {
    if (!channel.name || !channel.pageUrl) {
      throw new Error(`Canal inválido en posición ${index + 1}: falta name o pageUrl`);
    }

    return {
      name: String(channel.name).trim(),
      pageUrl: String(channel.pageUrl).trim(),
      match: String(channel.match || ".m3u8").trim(),
    };
  });
}

function readPreviousLinks() {
  const links = new Map();

  if (!fs.existsSync(OUTPUT_FILE)) {
    return links;
  }

  const lines = fs.readFileSync(OUTPUT_FILE, "utf8").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line.startsWith("#EXTINF")) {
      continue;
    }

    const commaIndex = line.lastIndexOf(",");
    if (commaIndex === -1) {
      continue;
    }

    const channelName = line.slice(commaIndex + 1).trim();
    const nextLine = (lines[i + 1] || "").trim();

    if (channelName && nextLine.startsWith("http")) {
      links.set(channelName, nextLine);
    }
  }

  return links;
}

function isCandidateStream(url, match) {
  if (!url || !url.startsWith("http")) {
    return false;
  }

  if (!url.includes(match)) {
    return false;
  }

  // El enlace final debe ser playlist .m3u8, no segmentos temporales .ts.
  if (url.includes(".ts")) {
    return false;
  }

  return true;
}

async function findStreamUrl(browser, channel) {
  const page = await browser.newPage();
  let resolved = false;
  let streamUrl = null;

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  });

  const streamPromise = new Promise((resolve) => {
    const onResponse = async (response) => {
      if (resolved) {
        return;
      }

      const url = response.url();
      const status = response.status();

      if (!isCandidateStream(url, channel.match)) {
        return;
      }

      console.log(`[${channel.name}] Detectado candidato: ${url}`);
      console.log(`[${channel.name}] Status: ${status}`);

      if (status === VALID_STATUS) {
        resolved = true;
        streamUrl = url;
        page.off("response", onResponse);
        resolve(url);
      }
    };

    page.on("response", onResponse);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        page.off("response", onResponse);
        resolve(null);
      }
    }, STREAM_WAIT_MS);
  });

  try {
    console.log(`\nProcesando: ${channel.name}`);
    console.log(`Página: ${channel.pageUrl}`);

    await page.goto(channel.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Tiempo adicional para que el reproductor cargue y dispare solicitudes de red.
    await sleep(3000);

    const found = await streamPromise;
    return found || streamUrl;
  } catch (error) {
    console.log(`[${channel.name}] Error al procesar página: ${error.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function buildM3U(channels, newLinks, previousLinks) {
  const lines = ["#EXTM3U", ""];

  for (const channel of channels) {
    const newLink = newLinks.get(channel.name);
    const previousLink = previousLinks.get(channel.name);
    const finalLink = newLink || previousLink;

    if (!finalLink) {
      console.log(`[${channel.name}] Sin enlace nuevo y sin enlace anterior. Se omite.`);
      continue;
    }

    if (!newLink && previousLink) {
      console.log(`[${channel.name}] Se conserva enlace anterior.`);
    }

    lines.push(`#EXTINF:-1,${channel.name}`);
    lines.push(finalLink);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function saveIfChanged(content) {
  const previousContent = fs.existsSync(OUTPUT_FILE)
    ? fs.readFileSync(OUTPUT_FILE, "utf8")
    : "";

  if (previousContent === content) {
    console.log("\nSin cambios en el archivo M3U.");
    return false;
  }

  fs.writeFileSync(OUTPUT_FILE, content, "utf8");
  console.log(`\nArchivo actualizado: ${OUTPUT_FILE}`);
  return true;
}

async function run() {
  const channels = loadChannels();
  const previousLinks = readPreviousLinks();
  const newLinks = new Map();

  console.log(`Canales configurados: ${channels.length}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const channel of channels) {
      const streamUrl = await findStreamUrl(browser, channel);

      if (streamUrl) {
        newLinks.set(channel.name, streamUrl);
        console.log(`[${channel.name}] Enlace válido guardado.`);
      } else {
        console.log(`[${channel.name}] No se encontró enlace .m3u8 válido con status 200.`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const content = buildM3U(channels, newLinks, previousLinks);
  saveIfChanged(content);

  console.log("\nResumen:");
  console.log(`Canales procesados: ${channels.length}`);
  console.log(`Enlaces nuevos encontrados: ${newLinks.size}`);
  console.log(`Enlaces anteriores disponibles: ${previousLinks.size}`);
}

run().catch((error) => {
  console.error("Error general:", error);
  process.exit(1);
});
