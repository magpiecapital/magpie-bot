#!/usr/bin/env node
/**
 * Crosspost a @MagpieLoans tweet to the community group via raw
 * Telegram API. Used when the operator wants to fire a crosspost
 * from outside TG (e.g. from an agent shell).
 *
 * Same logic as the manual /crosspost command — same allowlist
 * (must be x.com/MagpieLoans/status/<id>), same dedup table, same
 * engagement line rotation, same posting to every enabled community
 * chat.
 *
 *   node scripts/crosspost-tweet.js <tweet-url>
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });

const tweetUrl = process.argv[2];
if (!tweetUrl) {
  console.error("Usage: node scripts/crosspost-tweet.js <tweet-url>");
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not in env");
  process.exit(1);
}

// Mini grammy-compatible bot.api shim — just sendMessage. crosspostTweet
// only calls botApi.sendMessage, so we don't need the full grammy bot.
const botApi = {
  async sendMessage(chatId, text, opts = {}) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...opts,
      }),
    });
    const body = await res.json();
    if (!body.ok) {
      const e = new Error(body.description || `Telegram error ${res.status}`);
      throw e;
    }
    return body.result;
  },
};

const { crosspostTweet } = await import("../src/services/community-x-crosspost.js");

try {
  const result = await crosspostTweet(botApi, tweetUrl, "manual");
  if (result.skipped) {
    console.log(`Skipped — ${result.reason}`);
  } else {
    console.log(`✓ Posted to ${result.chats} chat(s)`);
  }
} catch (err) {
  console.error("Crosspost failed:", err.message);
  process.exit(1);
}
process.exit(0);
