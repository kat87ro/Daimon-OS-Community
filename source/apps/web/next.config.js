/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@daimon-os/shared"],
  // Desktop build (DAIMON_DESKTOP=1): emit a static export to apps/web/out that
  // the Electron shell serves over app://. The dashboard is a single client-only
  // island (page.tsx → ssr:false), so there is no SSR to lose. The normal `next
  // dev`/`next start` web build is unaffected.
  ...(process.env.DAIMON_DESKTOP === "1"
    ? { output: "export", images: { unoptimized: true }, trailingSlash: false }
    : {}),
  // LAN access (phone / iOS PWA): the dev server is reached via its LAN IP, not
  // localhost. Next 14.2 warns about cross-origin /_next/* from that host and
  // will block it in a future major — allow private-network hosts explicitly.
  allowedDevOrigins: ["192.168.68.20", "192.168.64.1"],
};

module.exports = nextConfig;
