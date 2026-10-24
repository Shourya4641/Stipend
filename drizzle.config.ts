import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/facilitator/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  // Migrations are generated and committed. `push` is never used against a
  // shared database — strict prompts before anything destructive.
  strict: true,
  verbose: true,
});
