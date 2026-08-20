import pg from "pg";
const IDS = ['116797534459647107','116799678577950999'];
const POLL_MS = 30*60*1000;      // poll every 30 min
const MAX_MS  = 26*60*60*1000;   // ~26h horizon (covers both maturities)
const t0 = Date.now();
const est = () => new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function check(){
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await c.connect();
  const { rows } = await c.query(
    `SELECT loan_id, status, (due_timestamp < NOW()) past_due,
            to_char(due_timestamp AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI:SS') due_est,
            (loan_amount_lamports/1e9)::numeric(20,3) loan_sol, borrower_wallet
       FROM loans WHERE loan_id = ANY($1::numeric[])`, [IDS]);
  await c.end();
  return rows;
}
console.log(`[${est()}] $MU default-watcher started; watching ${IDS.join(', ')}`);
while (Date.now()-t0 < MAX_MS){
  let rows;
  try { rows = await check(); }
  catch(e){ console.log(`[${est()}] check error: ${e.message}`); await sleep(5*60*1000); continue; }
  const defaulted = rows.filter(r => ['liquidated','defaulted'].includes(r.status) || (r.status==='active' && r.past_due));
  console.log(`[${est()}] ` + rows.map(r=>`#${String(r.loan_id).slice(-6)}:${r.status}${r.past_due?'/PASTDUE':''}`).join('  '));
  if (defaulted.length){
    console.log('DEFAULT_DETECTED');
    for (const r of defaulted) console.log(`  loan#${r.loan_id}  status=${r.status}  ${r.loan_sol} SOL  due=${r.due_est} EST  borrower=${r.borrower_wallet}`);
    process.exit(10);
  }
  if (rows.every(r => r.status!=='active')){ console.log('ALL_RESOLVED_NO_DEFAULT'); process.exit(0); }
  await sleep(POLL_MS);
}
console.log('WATCH_TIMEOUT'); process.exit(1);
