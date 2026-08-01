/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['ws', 'plivo'],
};

module.exports = nextConfig;
