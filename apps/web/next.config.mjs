// The browser talks to the API through this same-origin rewrite, so the session cookie is
// first-party and the API needs no CORS policy. FLEETOS_API_URL is read when the app is built.
const API_ORIGIN = process.env.FLEETOS_API_URL ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/fleetos-api/:path*", destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
  async headers() {
    return [{ source: "/driver/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] }];
  },
};
export default nextConfig;
