// Node 20, ESM
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sources (server-rendered HTML)
const COMPS_URL = "https://tactics.tools/team-compositions";  // Diamond+ / 15.4 default
const UNITS_URL = "https://tactics.tools/info/units";         // list of all unit names in Set 15

async function getHTML(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TFTMetaApp/1.0)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function getUnitNameSet() {
  const html = await getHTML(UNITS_URL);
  const $ = cheerio.load(html);
  // unit names appear as headings/links at the start of each block (e.g., "Aatrox", "Ezreal", ...)
  const names = new Set();
  $("a[href^='/info/units/'], h2, h3").each((_, el) => {
    const t = $(el).text().trim();
    // Keep likely champion tokens (one or two words, letters/.'s only)
    if (/^[A-Za-z'.\s-]{2,}$/.test(t) && t.length <= 20) {
      // Filter obvious non-names
      const blacklist = new Set(["Ability", "Traits", "Stats", "Set 15 Info", "Any Origin", "Any Class", "Any Cost"]);
      if (!blacklist.has(t)) names.add(t);
    }
  });
  // Add common apostrophe variants
  ["Kai'Sa", "K'Sante"].forEach(n => names.add(n));
  return names;
}

function normalizeItemName(name) {
  // Normalize some tooltip/alt variants if needed
  return name
    .replace(/\s+/g, " ")
    .replace(/’/g, "'")
    .trim();
}

function isLikelyStatText(s) {
  return /Play Rate|Place|Top 4|Win %|Details/i.test(s);
}

async function scrapeComps(unitSet) {
  const html = await getHTML(COMPS_URL);
  const $ = cheerio.load(html);

  // Each composition card is a block that contains a title like "Protector Xayah & Rakan"
  // followed by a sequence of <img alt="..."> icons (units and items) and stat labels.
  const comps = [];

  // Find composition sections by locating headers that look like "Something X & Y"
  $("h4, h3, h2").each((_, h) => {
    const title = $(h).text().trim();
    if (!title || !/ [A-Za-z].+? & [A-Za-z]/.test(title)) return;

    // Gather the sibling block that holds images and stats for this comp.
    // We scan forward through the sibling nodes until the next comp header.
    const block = [];
    let cur = $(h).next();
    while (cur.length && !/ [A-Za-z].+? & [A-Za-z]/.test(cur.text().trim())) {
      block.push(cur);
      cur = cur.next();
    }

    // Extract in-order alt texts of all images inside the block
    const tokens = [];
    block.forEach($node => {
      $node.find("img[alt]").each((__, img) => tokens.push($(img).attr("alt")?.trim() || ""));
      // also collect simple text snippets to capture stats
      const txt = $node.text().replace(/\s+/g, " ").trim();
      if (txt) tokens.push(`__TXT__${txt}`);
    });

    // Parse: walk tokens; whenever we see a unit name, start a unit; after a unit,
    // capture up to 3 consecutive item names (based on not-in-unitSet).
    const units = [];
    let idx = 0;
    while (idx < tokens.length) {
      const tk = tokens[idx];

      if (typeof tk === "string" && !tk.startsWith("__TXT__")) {
        const name = tk;
        const isUnit = unitSet.has(name);
        if (isUnit) {
          const unit = { name, items: [] };
          idx++;
          // collect up to 3 item names that are not units and not empty
          while (idx < tokens.length && unit.items.length < 3) {
            const maybe = tokens[idx];
            if (typeof maybe !== "string" || maybe.startsWith("__TXT__")) break;
            if (unitSet.has(maybe)) break;
            unit.items.push(normalizeItemName(maybe));
            idx++;
          }
          units.push(unit);
          continue;
        }
      } else if (typeof tk === "string" && tk.startsWith("__TXT__")) {
        // Stop parsing items once we hit the stats block
        if (isLikelyStatText(tk)) break;
      }
      idx++;
    }

    // Extract stats from joined text
    const joined = block.map(n => n.text().replace(/\s+/g, " ").trim()).join(" ");
    const mPlay = joined.match(/Play Rate\s+([0-9.]+)/i);
    const mPlace = joined.match(/Place\s+([0-9.]+)/i);
    const mTop4 = joined.match(/Top 4 %\s+([0-9.]+)/i);
    const mWin = joined.match(/Win %\s+([0-9.]+)/i);

    comps.push({
      name: title,
      avg_place: mPlace ? Number(mPlace[1]) : null,
      play_rate: mPlay ? Number(mPlay[1]) : null,
      top4_rate: mTop4 ? Number(mTop4[1]) : null,
      win_rate: mWin ? Number(mWin[1]) : null,
      units: units.filter(u => u.items.length) // keep units we actually matched items for
    });
  });

  // De-dup and keep the first 20 with a valid avg_place
  const seen = new Set();
  const top = comps
    .filter(c => typeof c.avg_place === "number")
    .filter(c => {
      const key = c.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.avg_place - b.avg_place)
    .slice(0, 20);

  return top;
}

function writeMeta(topComps) {
  const outDir = `${__dirname}/../data`;
  mkdirSync(outDir, { recursive: true });

  const meta = {
    generated_at: new Date().toISOString(),
    patch: "15.4",
    source: {
      comps: COMPS_URL,
      units: UNITS_URL
    },
    comps_top20: topComps.map(c => ({
      comp_name: c.name,
      avg_place: c.avg_place,
      play_rate: c.play_rate,
      top4_rate: c.top4_rate,
      win_rate: c.win_rate,
      unit_set: c.units.map(u => ({
        unit: u.name,
        top_items: u.items
      }))
    }))
  };

  const pretty = JSON.stringify(meta, null, 2);
  writeFileSync(`${outDir}/meta_current.json`, pretty);
  writeFileSync(`${outDir}/meta_15.4.json`, pretty);
  console.log(`[Write] data/meta_current.json (${topComps.length} comps)`);
}

(async () => {
  try {
    console.log("[Units] fetching unit list…");
    const unitSet = await getUnitNameSet();
    console.log(`[Units] ${unitSet.size} unit names loaded`);

    console.log("[Comps] scraping Diamond+ / Patch 15.4…");
    const comps = await scrapeComps(unitSet);
    console.log(`[Comps] captured ${comps.length} comps`);

    writeMeta(comps);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
