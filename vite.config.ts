import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ["@trpc/react-query", "@trpc/client"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@server": path.resolve(import.meta.dirname, "server"),
      "@db": path.resolve(import.meta.dirname, "server", "db"),
      "@core": path.resolve(import.meta.dirname, "server", "_core"),
    },
    dedupe: ["react", "react-dom"],
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== "production",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          // wouter uses use-sync-external-store on first load. Keep that
          // tiny shared shim out of chart chunks so charts stay lazy-loaded.
          if (id.includes("use-sync-external-store")) return "react-store-vendor";
          if (id.includes("react-is")) return "react-compat-vendor";
          // recharts + d3 are heavy and should only load with lazy report pages.
          if (id.includes("d3-") || id.includes("recharts") || id.includes("react-smooth") || id.includes("victory-vendor")) return "charts-vendor";
          if (id.includes("date-fns")) return "date-vendor";
          if (id.includes("react-hook-form")) return "form-vendor";
          if (id.includes("@tanstack/react-query") || id.includes("@trpc")) return "query-vendor";
          if (id.includes("@radix-ui")) return "radix-vendor";
          return undefined;
        },
        chunkFileNames: "assets/js/[name]-[hash].js",
        entryFileNames: "assets/js/[name]-[hash].js",
      },
    },
    minify: "esbuild",
  },
  server: {
    host: true,
    allowedHosts: [".openrental.example", "localhost", "127.0.0.1"],
    fs: { strict: true, deny: ["**/.*"] },
  },
});
