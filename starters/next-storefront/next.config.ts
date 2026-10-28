import type { NextConfig } from 'next';

// Products' images come from the shop's storefront, at its own address or its handle's.
const config: NextConfig = {
  // This folder is its own project, whatever lockfiles are above it.
  outputFileTracingRoot: process.cwd(),
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: process.env.HATTI_STORE_DOMAIN ?? 'example.hatti.pk' },
      { protocol: 'https', hostname: '*.hatti.pk' },
    ],
  },
};

export default config;
