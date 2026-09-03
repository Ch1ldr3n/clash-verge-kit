import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL("./scripts/cli.ts", import.meta.url)),
    outDir: "dist",
    emptyOutDir: true,
    copyPublicDir: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "cli/cli.mjs",
      },
    },
  },
  ssr: {
    noExternal: ["yaml"],
  },
});
