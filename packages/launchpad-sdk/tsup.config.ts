import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The venue SDKs stay dependencies of the installer; nothing is bundled in.
  splitting: false,
  // `import.meta.url` in the CommonJS build (src/pump-sdk.ts loads pump.fun's SDK with `createRequire`).
  shims: true,
});
