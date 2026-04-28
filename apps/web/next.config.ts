import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@session-vault/shared'],
};

export default nextConfig;
