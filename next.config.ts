import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empty turbopack config to silence the webpack-only warning in Next 16
  turbopack: {},
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Optional: async WASM for future CRE / crypto helpers
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    // Fix @metamask/sdk trying to import react-native modules in browser builds
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
      // Optional RainbowKit/wagmi connectors (not installed); avoid build warnings
      "@coinbase/wallet-sdk": false,
      "@gemini-wallet/core": false,
      "porto": false,
      "porto/internal": false,
      // wagmi's experimental "tempo" connector path dynamic-imports `accounts`
      // inside a catch fallback; the package doesn't exist in prod. Stub it.
      "accounts": false,
      // wagmi@3 metaMask connector imports an EVM helper that only ships on
      // later versions of @metamask/sdk. Not used by our flow.
      "@metamask/connect-evm": false,
      // @cofhe/sdk/web has a node-only `fs` import guarded at runtime.
      "fs": false,
    };
    return config;
  },
};

export default nextConfig;
