export const PRODUCT_NAME = "andrew-code-agent";
export const PRODUCT_VERSION = "0.2.0";
export const REQUIRED_NODE_VERSION = "24.19.0";
export const REQUIRED_PNPM_VERSION = "11.22.0";
export const REQUIRED_CODEX_VERSION = "0.148.0";

// The capability names the CLI may request. `src/bundle/render.ts` refuses a
// manifest declaring any other name, so this list and that refusal move
// together.
export const SUPPORTED_CAPABILITIES = ["oracle"] as const;
export type RequestedCapability = (typeof SUPPORTED_CAPABILITIES)[number];
