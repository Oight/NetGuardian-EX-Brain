/** Compatibility entry for the authenticated synthetic browser harness.
 * Kept local-only; it never imports credentials or starts a real upstream. */
if (!process.versions.bun)
  throw new Error("Run this synthetic harness with Bun");
if (process.argv.includes("--live-mui"))
  throw new Error("Live access is not a synthetic acceptance option");
await import("./web-sandbox.ts");
export {};
