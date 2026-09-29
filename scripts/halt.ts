// Admin tool: halt or resume all tNVDA transfers.
// Usage: npx ts-node --transpile-only scripts/halt.ts on|off|status
import { setup, configPda, explorerTx } from "./lib";

async function main() {
  const arg = (process.argv[2] ?? "status").toLowerCase();
  const { admin, program } = setup();
  const pda = configPda(program.programId);
  if (arg === "status") {
    const c = await (program.account as any).config.fetch(pda);
    console.log(`Trading halted: ${c.halted}   admin: ${c.admin.toBase58()}`);
    return;
  }
  const halted = arg === "on" || arg === "true" || arg === "halt";
  const sig = await program.methods.setTradingHalt(halted).accountsPartial({ admin: admin.publicKey, config: pda }).rpc();
  console.log(`Trading ${halted ? "HALTED" : "RESUMED"}: ${explorerTx(sig)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
