import type { NextConfig } from "next";
import path from "node:path";
/**
 * NEXT_BUILD_MODE=desktop  →  static export for Electron (FloDesktop)
 * NEXT_BUILD_MODE unset    →  standard Next.js server mode (FloPOS cloud)
 */
const isDesktop = process.env.NEXT_BUILD_MODE === "desktop";

const nextConfig: NextConfig = {
  // Static export: required for Electron — served via embedded Express,
  // not file:// so no CORS/routing issues.
  output: isDesktop ? "export" : undefined,

  // Trailing slashes make static paths predictable: /pos → /pos/index.html
  trailingSlash: isDesktop,

  // next/image optimisation requires a running server; disable for static export.
  images: {
    unoptimized: isDesktop,
  },

  // Silence the "multiple lockfiles / inferred workspace root" warning.
  // Allow imports from /main (countries derivation shared with backend) via alias;
  // root must encompass both frontend/ and main/, so it points at the repo root.
  turbopack: {
    root: path.resolve(process.cwd(), '..'),
    resolveAlias: {
      '@countries': '../main/countries.ts',
      // Weighed-goods vocabulary and scale-label decoding are shared with the
      // main process so the till, the stored order and the receipt agree on
      // one rounding and one label format. Both modules are dependency-free.
      '@units': '../main/lib/units.ts',
      '@scale-barcode': '../main/lib/scale-barcode.ts',
    },
  },
};

export default nextConfig;
