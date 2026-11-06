// Where each @betterdraw/* package's source is, for Vite and Vitest. The packages are compiled from source by the
// app's own build and never published. TypeScript reads the same map from tsconfig.paths.json.
import { fileURLToPath } from "node:url";

const entries = {
  common: "common/src/index.ts",
  editor: "editor/index.tsx",
  element: "element/src/index.ts",
  "fractional-indexing": "fractional-indexing/src/index.ts",
  "laser-pointer": "laser-pointer/src/index.ts",
  math: "math/src/index.ts",
  utils: "utils/src/index.ts",
};

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export const aliases = Object.entries(entries).flatMap(([name, entry]) => [
  { find: new RegExp(`^@betterdraw/${name}$`), replacement: here(entry) },
  // a module inside the package, from the folder of its entry: @betterdraw/element/types is element/src/types
  { find: new RegExp(`^@betterdraw/${name}/(.*)$`), replacement: here(entry.replace(/[^/]+$/, "")) + "$1" },
]);
