import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge sits on the mic button at phone widths and eats its taps;
  // errors still surface without it.
  devIndicators: false,
};

export default nextConfig;
