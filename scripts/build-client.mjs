import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["client/app.jsx"],
    outfile: "dist/app.js",
    bundle: true,
    minify: true,
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({ entryPoints: ["client/styles.css"], outfile: "dist/app.css", bundle: true, minify: true }),
]);

// The packed CLI serves the browser bundle without installing its build tools.
await mkdir("dist/licenses", { recursive: true });
for (const [name, file] of [
  ["hudsonkit", "LICENSE.md"],
  ["lucide-react", "LICENSE"],
  ["react", "LICENSE"],
  ["react-dom", "LICENSE"],
  ["scheduler", "LICENSE"],
]) {
  await copyFile("node_modules/" + name + "/" + file, "dist/licenses/" + name + ".txt");
}
