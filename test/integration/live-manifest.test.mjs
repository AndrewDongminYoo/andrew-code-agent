import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const artifactModule = await import("../../dist/bundle/artifact.js").catch(
  () => null,
);
const sourceRoot = process.env.ANDREW_AGENT_CODEX_SOURCE;

test(
  "the clean live manifest produces one deterministic artifact digest",
  { skip: sourceRoot === undefined },
  async () => {
    assert.notEqual(
      artifactModule,
      null,
      "the built artifact module must be available",
    );
    const artifactsRoot = await mkdtemp(
      join(tmpdir(), "andrew-code-agent-live-artifacts-"),
    );
    try {
      const input = {
        sourceRoot,
        artifactsRoot,
        requestedCapabilities: ["oracle"],
        capabilityInputs: {},
        builderVersion: "0.1.0-test",
      };
      const first = await artifactModule.buildBundle(input);
      const second = await artifactModule.buildBundle(input);

      assert.equal(
        first.metadata.sourceRevision,
        second.metadata.sourceRevision,
      );
      assert.equal(first.metadata.bundleDigest, second.metadata.bundleDigest);
      assert.deepEqual(first.metadata, second.metadata);
      assert.equal(first.artifactRoot, second.artifactRoot);
      assert.equal(
        await readFile(
          join(first.artifactRoot, "bundle-metadata.json"),
          "utf8",
        ),
        `${JSON.stringify(first.metadata, null, 2)}\n`,
      );
      console.log(
        `sourceRevision=${first.metadata.sourceRevision} bundleDigest=${first.metadata.bundleDigest}`,
      );
    } finally {
      await rm(artifactsRoot, { recursive: true, force: true });
    }
  },
);
