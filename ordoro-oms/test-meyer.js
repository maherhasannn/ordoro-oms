import "dotenv/config";
import * as meyer from "./suppliers/meyer.js";

console.log("=== Testing Meyer Feed Sync ===\n");
console.log("MEYER_SFTP_HOST:", process.env.MEYER_SFTP_HOST ? "set" : "NOT SET");
console.log("MEYER_SFTP_USER:", process.env.MEYER_SFTP_USER ? "set" : "NOT SET");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "set" : "NOT SET");
console.log("Node version:", process.version);
console.log();

try {
  await meyer.syncFeed();
  console.log("\n=== SUCCESS ===");
} catch (err) {
  console.error("\n=== FAILED ===");
  console.error(err);
}
process.exit(0);
