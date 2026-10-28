# Quality Tooling Refresh

## Scope

Update supported dependencies and existing quality tooling under the approved account-wide maintenance request.
Preserve application behavior, existing exclusions, and generated artifacts.

## Acceptance

- Enabled linters use verified current compatible releases.
- Pinact is locked to `4.1.1` with `lint` and `upgrade` enabled.
- The full no-fix Trunk scan and project-specific minimum gates pass.
- Manifest changes have a package-manager-generated lockfile.
- Vulnerability dispositions identify their advisory and supporting evidence.
- Affected documentation commands, paths, versions, and local links agree with the checkout.

## Publication

Keep changes local until the operator approves publication for this repository.
After approval, continue CI and hosted review through the gated merge and requested cleanup and memory record.
