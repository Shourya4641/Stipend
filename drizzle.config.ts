import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/facilitator/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  // Prompt before anything destructive. We generate and commit migrations;
  // `push` is never used against a shared database.
  strict: true,
  verbose: true,
});
