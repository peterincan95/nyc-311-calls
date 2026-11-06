import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths, because GitHub Pages serves the site from a subfolder.
  base: "./",
  plugins: [react()],
});
