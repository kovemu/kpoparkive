/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "piscina",
    "thetree",
    "isolated-vm"
  ],
  outputFileTracingIncludes: {
    "/api/wiki-source-preview": [
      "./node_modules/piscina/**/*",
      "./node_modules/thetree/**/*",
      "./node_modules/isolated-vm/**/*"
    ]
  }
};

export default nextConfig;
