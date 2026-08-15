/**
 * Tokenized-collectible inventory indexer — the protocol's ongoing knowledge
 * of what is ALREADY vaulted on-chain at the partner platforms (operator
 * mandate 2026-08-15: "full knowledge at all times of what tokenized
 * collectibles are already vaulted on chain… ongoing because stuff is added
 * all the time").
 *
 * Enumerates each configured partner collection via the DAS API
 * (getAssetsByGroup, page-by-page), stores every asset's name + mint, and
 * tags each row with the matching public-catalog slug so the site can say
 * "N copies of this exact card are tokenized on <platform> right now" with
 * a direct marketplace link — or fall back to the tokenize-partner referral
 * when the count is zero.
 *
 * Collections are DB-configured (collectible_partner_collections) so new
 * partner collections can be added without a deploy. Runs a full sweep every
 * REFRESH_HOURS; each sweep is upsert-based and prunes rows not seen in the
 * latest pass for that collection (burn/redeem = card left the vault).
 */
import { query } from "../db/pool.js";

const HELIUS_URL = process.env.SOLANA_RPC_URL
  || process.env.HELIUS_RPC_URL
  || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;

const REFRESH_HOURS = Number(process.env.COLLECTIBLE_INDEX_REFRESH_HOURS) || 12;
const PAGE_LIMIT = 1000;
const MAX_PAGES = Number(process.env.COLLECTIBLE_INDEX_MAX_PAGES) || 400; // 400k assets ceiling

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  await query(
    `CREATE TABLE IF NOT EXISTS collectible_partner_collections (
       collection_address TEXT PRIMARY KEY,
       platform TEXT NOT NULL,
       label TEXT,
       enabled BOOLEAN DEFAULT TRUE,
       added_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS collectible_tokenized_inventory (
       mint TEXT PRIMARY KEY,
       collection_address TEXT NOT NULL,
       platform TEXT NOT NULL,
       name TEXT NOT NULL,
       catalog_slug TEXT,
       last_seen_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_cti_slug ON collectible_tokenized_inventory (catalog_slug) WHERE catalog_slug IS NOT NULL`,
  );
  _ready = true;
}

/**
 * Catalog matchers — keyword rules mapping a partner NFT's display name to a
 * public-catalog slug. Deliberately conservative: a rule needs EVERY group of
 * its terms present (case-insensitive), so "1999 Pokemon Base Set Charizard
 * Holo PSA 10" matches charizard-base-set but "Charizard VMAX" does not.
 * Order matters: first hit wins, most-specific rules first.
 */
const MATCHERS = [
  { slug: "umbreon-vmax-alt", all: ["umbreon", "vmax"], any: ["215", "alt"] },
  { slug: "evolving-skies-alt-vmax", all: ["vmax"], any: ["rayquaza", "sylveon", "glaceon"] },
  { slug: "modern-chase-staples", all: ["charizard", "ex"], any: ["151", "199"] },
  { slug: "charizard-v-alt-brilliant-stars", all: ["charizard v"], not: ["vmax", "vstar"] },
  { slug: "lugia-v-alt", all: ["lugia v"], not: ["vstar"] },
  { slug: "giratina-v-alt", all: ["giratina v"], not: ["vstar"] },
  { slug: "umbreon-v-alt", all: ["umbreon v"], not: ["vmax"] },
  { slug: "blastoise-ex-151", all: ["blastoise", "ex"], any: ["151", "200"] },
  { slug: "venusaur-ex-151", all: ["venusaur", "ex"], any: ["151", "198"] },
  { slug: "charizard-base-set", all: ["charizard", "base"], not: ["ex", "vmax", "v ", "gx", "dark"] },
  { slug: "blastoise-base-set", all: ["blastoise", "base"], not: ["ex"] },
  { slug: "venusaur-base-set", all: ["venusaur", "base"], not: ["ex"] },
  { slug: "lugia-neo-genesis", all: ["lugia"], any: ["neo", "genesis"] },
  { slug: "dark-charizard-team-rocket", all: ["dark charizard"] },
  { slug: "typhlosion-neo-genesis", all: ["typhlosion"], any: ["neo", "genesis"] },
  { slug: "ninetales-base-set", all: ["ninetales", "base"] },
  { slug: "gyarados-base-set", all: ["gyarados", "base"] },
  { slug: "raichu-base-set", all: ["raichu", "base"] },
  { slug: "clefairy-base-set", all: ["clefairy", "base"] },
  { slug: "hitmonchan-base-set", all: ["hitmonchan", "base"] },
  { slug: "magneton-base-set", all: ["magneton", "base"] },
  { slug: "poliwrath-base-set", all: ["poliwrath", "base"] },
  { slug: "nidoking-base-set", all: ["nidoking", "base"] },
  { slug: "snorlax-jungle", all: ["snorlax", "jungle"] },
  { slug: "vaporeon-jungle", all: ["vaporeon", "jungle"] },
  { slug: "jolteon-jungle", all: ["jolteon", "jungle"] },
  { slug: "scyther-jungle", all: ["scyther", "jungle"] },
  { slug: "gengar-fossil", all: ["gengar", "fossil"] },
  { slug: "articuno-fossil", all: ["articuno", "fossil"] },
  { slug: "aerodactyl-fossil", all: ["aerodactyl", "fossil"] },
  { slug: "lapras-fossil", all: ["lapras", "fossil"] },
  { slug: "base-set-holo-rares", all: ["base"], any: ["zapdos", "chansey", "mewtwo", "alakazam"] },
  { slug: "jungle-fossil-holos", any: ["jungle", "fossil"] },
  { slug: "jordan-fleer-86", all: ["jordan"], any: ["1986", "fleer"] },
  { slug: "lebron-topps-chrome", all: ["lebron"], any: ["topps chrome", "2003"] },
  { slug: "kobe-bryant-1996-topps", all: ["kobe"], any: ["1996", "topps"] },
  { slug: "curry-2009-topps", all: ["curry"], any: ["2009", "topps"] },
  { slug: "durant-2007-topps", all: ["durant"], any: ["2007", "topps"] },
  { slug: "giannis-2013-prizm", all: ["giannis"], any: ["prizm", "2013"] },
  { slug: "tatum-2017-prizm", all: ["tatum"], any: ["prizm", "2017"] },
  { slug: "jokic-2015-prizm", all: ["jokic"], any: ["prizm", "2015"] },
  { slug: "lamelo-2020-prizm", all: ["lamelo"], any: ["prizm", "2020"] },
  { slug: "anthony-edwards-2020-prizm", all: ["edwards"], any: ["prizm", "2020"] },
  { slug: "lillard-2012-prizm", all: ["lillard"], any: ["prizm", "2012"] },
  { slug: "booker-2015-prizm", all: ["booker"], any: ["prizm", "2015"] },
  { slug: "barkley-1986-fleer", all: ["barkley"], any: ["1986", "fleer"] },
  { slug: "ewing-1986-fleer", all: ["ewing"], any: ["1986", "fleer"] },
  { slug: "wade-2003-topps-chrome", all: ["wade"], any: ["topps chrome", "2003"] },
  { slug: "carmelo-2003-topps-chrome", all: ["carmelo"], any: ["topps chrome", "2003"] },
  { slug: "herbert-2020-prizm", all: ["herbert"], any: ["prizm", "2020"] },
  { slug: "burrow-2020-prizm", all: ["burrow"], any: ["prizm", "2020"] },
  { slug: "josh-allen-2018-prizm", all: ["josh allen"], any: ["prizm", "2018"] },
  { slug: "lamar-2018-prizm", all: ["lamar"], any: ["prizm", "2018"] },
  { slug: "jefferson-2020-prizm", all: ["jefferson"], any: ["prizm", "2020"] },
  { slug: "rodgers-2005-topps", all: ["rodgers"], any: ["2005", "topps"] },
  { slug: "manning-1998-topps", all: ["peyton"], any: ["1998", "topps"] },
  { slug: "brees-2001-topps", all: ["brees"], any: ["2001", "topps"] },
  { slug: "montana-1981-topps", all: ["montana"], any: ["1981", "topps"] },
  { slug: "griffey-1989-upper-deck", all: ["griffey"], any: ["1989", "upper deck"] },
  { slug: "trout-2011-topps-update", all: ["trout"], any: ["2011", "update"] },
  { slug: "ohtani-2018-topps", all: ["ohtani"], any: ["2018", "topps"] },
  { slug: "rivera-1992-bowman", all: ["rivera"], any: ["1992", "bowman"] },
  { slug: "henderson-1980-topps", all: ["rickey", "henderson"] },
  { slug: "mattingly-1984-donruss", all: ["mattingly"], any: ["1984", "donruss"] },
  { slug: "mcgwire-1985-topps", all: ["mcgwire"], any: ["1985", "topps"] },
  { slug: "frank-thomas-1990-leaf", all: ["frank thomas"], any: ["1990", "leaf"] },
  { slug: "chipper-1991-topps", all: ["chipper"], any: ["1991", "topps"] },
  { slug: "gwynn-1983-topps", all: ["gwynn"], any: ["1983", "topps"] },
  { slug: "boggs-1983-topps", all: ["boggs"], any: ["1983", "topps"] },
  { slug: "puckett-1985-topps", all: ["puckett"], any: ["1985", "topps"] },
  { slug: "crosby-2005-ud-yg", all: ["crosby"], any: ["young guns", "2005"] },
  { slug: "mcdavid-2015-ud-yg", all: ["mcdavid"], any: ["young guns", "2015"] },
  { slug: "matthews-2016-ud-yg", all: ["auston", "matthews"] },
  { slug: "roy-1986-opc", all: ["patrick roy"] },
  { slug: "mbappe-2018-prizm-wc", all: ["mbappe"], any: ["prizm", "2018"] },
  { slug: "messi-2018-prizm-wc", all: ["messi"], any: ["prizm", "2018"] },
  { slug: "prizm-rookie-benchmarks", all: ["prizm"], any: ["wembanyama", "doncic", "mahomes"] },
  { slug: "one-piece-manga-rares", any: ["shanks", "gear 5"], all: ["op01"] },
  { slug: "luffy-op01-alt", all: ["luffy", "op01"] },
  { slug: "nami-op01-alt", all: ["nami", "op01"] },
  { slug: "zoro-op01-alt", all: ["zoro", "op01"] },
  { slug: "blue-eyes-lob", all: ["blue-eyes"], any: ["lob"] },
  { slug: "blue-eyes-sdk", all: ["blue-eyes"], any: ["sdk"] },
  { slug: "dark-magician-girl-mfc", all: ["dark magician girl"] },
  { slug: "dark-magician-lob", all: ["dark magician"], any: ["lob"], not: ["girl"] },
  { slug: "red-eyes-lob", all: ["red-eyes"], any: ["lob"] },
  { slug: "exodia-lob", all: ["exodia"] },
  { slug: "autographed-rookies", all: ["auto"], any: ["psa/dna", "autograph"] },
];

export function matchCatalogSlug(name) {
  const n = (name || "").toLowerCase();
  if (!n) return null;
  for (const m of MATCHERS) {
    if (m.not && m.not.some((t) => n.includes(t))) continue;
    if (m.all && !m.all.every((t) => n.includes(t))) continue;
    if (m.any && !m.any.some((t) => n.includes(t))) continue;
    if (!m.all && !m.any) continue;
    return m.slug;
  }
  return null;
}

async function dasPage(collection, page) {
  const res = await fetch(HELIUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "cti",
      method: "getAssetsByGroup",
      params: { groupKey: "collection", groupValue: collection, page, limit: PAGE_LIMIT },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DAS ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`DAS: ${j.error.message?.slice(0, 80)}`);
  return j.result?.items ?? [];
}

async function sweepCollection({ collection_address, platform }) {
  const sweepStart = new Date();
  let total = 0;
  let matched = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await dasPage(collection_address, page);
    if (items.length === 0) break;
    for (const a of items) {
      const name = a.content?.metadata?.name || "";
      if (a.burnt) continue;
      const slug = matchCatalogSlug(name);
      if (slug) matched++;
      await query(
        `INSERT INTO collectible_tokenized_inventory (mint, collection_address, platform, name, catalog_slug, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (mint) DO UPDATE SET name = EXCLUDED.name, catalog_slug = EXCLUDED.catalog_slug, last_seen_at = NOW()`,
        [a.id, collection_address, platform, name.slice(0, 200), slug],
      );
    }
    total += items.length;
    if (items.length < PAGE_LIMIT) break;
  }
  // Prune assets that left the collection (redeemed/burnt) — anything this
  // sweep didn't touch.
  const pruned = await query(
    `DELETE FROM collectible_tokenized_inventory
      WHERE collection_address = $1 AND last_seen_at < $2`,
    [collection_address, sweepStart],
  );
  console.log(`[cti] swept ${platform} ${collection_address.slice(0, 8)}: ${total} assets, ${matched} catalog-matched, ${pruned.rowCount} pruned`);
  return total;
}

export async function runInventorySweep() {
  await ensureTables();
  const { rows } = await query(
    `SELECT collection_address, platform FROM collectible_partner_collections WHERE enabled = TRUE`,
  );
  if (rows.length === 0) {
    console.log("[cti] no partner collections configured yet — sweep skipped");
    return;
  }
  for (const c of rows) {
    try {
      await sweepCollection(c);
    } catch (e) {
      console.warn(`[cti] sweep failed for ${c.collection_address.slice(0, 8)}: ${e.message?.slice(0, 100)}`);
    }
  }
}

export function startCollectibleInventoryIndexer() {
  runInventorySweep().catch((e) => console.warn("[cti] initial sweep:", e.message?.slice(0, 100)));
  setInterval(
    () => runInventorySweep().catch((e) => console.warn("[cti] sweep:", e.message?.slice(0, 100))),
    REFRESH_HOURS * 3_600_000,
  );
  console.log(`[cti] collectible inventory indexer started (every ${REFRESH_HOURS}h)`);
}
