import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No app-level overrides today; intentionally empty.
  // Touch this file to invalidate Vercel build cache when needed.
  // Touched 2026-06-02 alongside the vercel.json redirects landing to
  // defensively bust the proxy bundle cache (a stale compiled matcher
  // was the cause of the 4-commit thrash we just reverted).
};

export default nextConfig;
