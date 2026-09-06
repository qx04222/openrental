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
    sourcemap: process.env.GENERATE_SOURCEMAP === "true",
    manifest: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Capture shared React before chart dependencies can absorb it.
            { name: "react-vendor", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 100 },
            { name: "react-store-vendor", test: /use-sync-external-store/, priority: 90 },
            { name: "react-compat-vendor", test: /react-is/, priority: 90 },
            { name: "query-vendor", test: /@tanstack[\\/]react-query|@trpc/, priority: 80 },
            { name: "radix-vendor", test: /@radix-ui/, priority: 70 },
            { name: "charts-vendor", test: /d3-|recharts|react-smooth|victory-vendor/, priority: 40 },
            { name: "date-vendor", test: /date-fns/, priority: 30 },
            { name: "form-vendor", test: /react-hook-form/, priority: 30 },
          ],
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
