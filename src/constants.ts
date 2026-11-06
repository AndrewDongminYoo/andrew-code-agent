export const PRODUCT_NAME = "andrew-code-agent";
export const PRODUCT_VERSION = "0.2.0";
export const REQUIRED_NODE_VERSION = "24.20.0";
export const REQUIRED_PNPM_VERSION = "11.22.0";
export const REQUIRED_CODEX_VERSION = "0.166.0";

// Digest of the two trees the Codex app-server generator owns, measured from
// `src/generated/codex-app-server` and `schemas/codex-app-server` at the pinned
// version. Doctor regenerates from the resolved binary and compares against
// this value, so a binary that reports the pinned version while emitting a
// different contract is refused instead of trusted. Regenerate the trees and
// update this value in the same commit; `test/unit/constants.test.mjs`
// recomputes it from the committed trees and fails until they agree.
//
// Measured on aarch64-apple-darwin. The generator is assumed to emit the same
// bytes on every architecture the product supports, which is untested here
// because only one architecture was available.
export const REQUIRED_CODEX_CONTRACT_DIGEST =
  "2cb27a6dbf216ec66e6295903342d65c5d00388cbcdc90f6db69036ed9aa85c7";

// The capability names the CLI may request. `src/bundle/render.ts` refuses a
// manifest declaring any other name, so this list and that refusal move
// together.
export const SUPPORTED_CAPABILITIES = ["oracle"] as const;
export type RequestedCapability = (typeof SUPPORTED_CAPABILITIES)[number];
