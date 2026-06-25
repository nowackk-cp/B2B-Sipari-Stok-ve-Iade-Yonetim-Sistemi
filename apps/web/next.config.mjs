/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is run once at the repo root (`pnpm lint`); skip Next's own pass.
  eslint: { ignoreDuringBuilds: true },
  // Type errors must still fail the build.
  typescript: { ignoreBuildErrors: false },
  // Workspace packages ship compiled dist. In `next dev`, react-refresh injects
  // `import.meta.webpackHot` into consumed modules; webpack then refuses to parse
  // the CJS dist ("Cannot use 'import.meta' outside a module"). Transpiling the
  // package through Next's own pipeline resolves it (no effect on prod builds).
  transpilePackages: ['@b2b/ui'],
};

export default nextConfig;
