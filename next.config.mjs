/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/wiki-source-preview": [
      "./node_modules/thetree/utils/namumark/**/*",
      "./node_modules/thetree/utils/global.js",
      "./node_modules/thetree/utils/types.js",
      "./node_modules/thetree/utils/index.js"
    ]
  }
};

export default nextConfig;
