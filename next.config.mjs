/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/camps/:slug', destination: '/c/denver/camps/:slug', permanent: true },
      { source: '/calendar', destination: '/c/denver/calendar', permanent: true },
      { source: '/compare', destination: '/c/denver/compare', permanent: false },
    ];
  },
};

export default nextConfig;
