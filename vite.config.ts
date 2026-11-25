import { defineScoutThinViteConfig } from "scout-app/vite";

export default defineScoutThinViteConfig({
  product: "Search",
  variant: "search",
  rail: "reading",
  port: 4803,
  serverEntry: "src/server.ts",
});
