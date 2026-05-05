/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Tell Next not to bundle these — they ship native binaries / dynamic requires.
    serverComponentsExternalPackages: [
      "playwright",
      "lighthouse",
      "chrome-launcher",
      "@axe-core/playwright",
    ],
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
};

module.exports = nextConfig;
