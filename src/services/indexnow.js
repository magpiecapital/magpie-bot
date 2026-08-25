/**
 * indexnow.js — instant search-index pings for newly listed collateral.
 *
 * Why (2026-08-25): tokens are listed while they're TRENDING, and the
 * attention window is hours. IndexNow tells Bing/Yandex/Seznam/Naver about
 * the token's borrow landing page within minutes of listing — and Bing's
 * index feeds the browsing stacks behind several LLM assistants, which is
 * exactly where "what is $<token>" questions get answered. Google ignores
 * IndexNow but re-reads our live sitemap hourly, so it catches up on its own.
 *
 * Fail-soft by design: an indexing ping must never block or fail an
 * announcement. No key configured → silently disabled.
 */
import axios from "axios";

const SITE_HOST = "www.magpie.capital";
const KEY = process.env.INDEXNOW_KEY || null;

export async function pingIndexNowForListing(symbol) {
  if (!KEY) return false;
  const slug = encodeURIComponent(String(symbol || "").toLowerCase());
  if (!slug) return false;
  const urlList = [
    `https://${SITE_HOST}/borrow/${slug}`,
    `https://${SITE_HOST}/tokens`,
  ];
  try {
    const res = await axios.post(
      "https://api.indexnow.org/indexnow",
      {
        host: SITE_HOST,
        key: KEY,
        keyLocation: `https://${SITE_HOST}/${KEY}.txt`,
        urlList,
      },
      { timeout: 10_000, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
    console.log(`[indexnow] pinged for $${symbol} (status ${res.status})`);
    return true;
  } catch (e) {
    console.warn(`[indexnow] ping failed for $${symbol}: ${e.response?.status ?? e.code ?? e.message?.slice(0, 80)}`);
    return false;
  }
}
