import { Connection } from "@solana/web3.js";
import "dotenv/config";

export const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed",
);
