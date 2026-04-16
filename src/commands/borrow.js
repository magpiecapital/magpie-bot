export async function handleBorrow(ctx) {
  // TODO: implement in Phase 1.5 once Anchor program is updated for SOL/wSOL.
  // Flow:
  //   1. List user's SPL token balances that match supported_mints
  //   2. Prompt user to pick collateral mint + amount
  //   3. Prompt user to pick LTV tier (30%/2d, 25%/3d, 20%/7d)
  //   4. Fetch oracle price, compute SOL value of collateral
  //   5. Build Anchor request_and_fund_loan tx, sign with user's custodial keypair
  //   6. Submit tx, unwrap wSOL → SOL in user's wallet
  //   7. Record loan in DB
  await ctx.reply(
    "🚧 /borrow is coming online — Anchor program migration in progress. Stay tuned.",
  );
}
