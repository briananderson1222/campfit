/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev-only: allow serving the dev app across the owner's tailnet
  // (Next.js blocks cross-origin dev-resource requests by default).
  allowedDevOrigins: ['kontour.python-smelt.ts.net', '100.77.142.114'],
  async redirects() {
    return [
      { source: '/camps/:slug', destination: '/c/denver/camps/:slug', permanent: true },
      { source: '/calendar', destination: '/c/denver/calendar', permanent: true },
      { source: '/compare', destination: '/c/denver/compare', permanent: false },
    ];
  },
};

export default nextConfig;
