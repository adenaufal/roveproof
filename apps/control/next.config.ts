import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@roveproof/orchestrator", "@roveproof/store"],
};

export default nextConfig;
