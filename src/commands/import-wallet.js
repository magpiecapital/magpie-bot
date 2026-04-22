import { upsertUser } from "../services/users.js";
import { importWallet } from "../services/wallet.js";

export async function handleImport(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  // Immediately delete the message containing the private key.
  try { await ctx.deleteMessage(); } catch (_) {}

  const key = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!key) {
    return ctx.reply(
      [
        "Import an existing Solana wallet by sending your private key.",
        "",
        "Usage: `/import <base58 private key>`",
        "",
        "Your message will be deleted immediately for security.",
        "The key is encrypted and stored the same way as generated wallets.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Validate the key before importing.
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    const decoded = bs58.default.decode(key);
    Keypair.fromSecretKey(decoded);
  } catch (_) {
    return ctx.reply("Invalid private key. Please provide a valid base58 Solana private key.");
  }

  const user = await upsertUser(tgUser.id, tgUser.username);

  try {
    const { publicKey } = await importWallet(user.id, key);
    await ctx.reply(
      [
        "Wallet imported successfully.",
        "",
        `Address: \`${publicKey}\``,
        "",
        "This wallet will now be used for all Magpie operations.",
        "Your tokens are ready to use as collateral — no transfers needed.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.error("Import wallet error:", err);
    await ctx.reply("Failed to import wallet. Please try again.");
  }
}
