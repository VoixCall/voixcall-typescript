import { defineConfig } from '@hey-api/openapi-ts';

// Generated from openapi.json, which `npm run fetch-spec` downloads from
// https://api.voixcall.com/v1/openapi.json. CI regenerates src/gen from the
// committed openapi.json and fails on drift, so never edit src/gen by hand.
export default defineConfig({
  input: './openapi.json',
  output: {
    path: './src/gen',
    // Fully specified imports for Node ESM (moduleResolution NodeNext).
    module: { extension: '.js' },
    tsConfigPath: './tsconfig.json',
  },
  plugins: [
    // Bundled fetch client: no runtime dependency.
    '@hey-api/client-fetch',
    '@hey-api/typescript',
    '@hey-api/sdk',
  ],
});
