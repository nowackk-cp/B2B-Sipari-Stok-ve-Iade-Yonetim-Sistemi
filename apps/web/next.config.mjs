/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is run once at the repo root (`pnpm lint`); skip Next's own pass.
  eslint: { ignoreDuringBuilds: true },
  // Type errors must still fail the build.
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // Workspace packages are published as compiled dist; nothing extra needed.
  },
};

export default nextConfig;
