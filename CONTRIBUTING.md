# Contributing protocol packages

Use the existing package format and compiler semantics. Start by copying an existing official package into a new directory and changing only the source, fixtures, package metadata, lock, documentation and license material needed for the derivation. Do not invent a parallel DSL. Keep authored source and derived lock outputs together so others can reproduce the exact package digest.

Every package must have a unique package ID and SemVer version, Apache-2.0 license file, canonical source, generated release lock, and fixtures for both the intended success path and relevant denied or stale cases. A composition must reference exact dependency digests. Keep dependencies small and composable; each participant chooses locally which packages to adopt and where to coordinate.

Before opening a pull request:

1. Run `npm run verify` with Node.js 24.20.x. This exports the portable runner, checks every package and full exact dependency closure offline, regenerates the catalog, verifies public links and command examples, and exercises digest and role denials.
2. Confirm `protocol-catalog.json` is generated from package metadata and the exact package bytes. Do not hand-edit catalog digests or dependency lists.
3. Add a concise scenario page when it helps Agents discover or adopt the package. Keep online installation, explicit grants, and offline verification clearly separate.
4. Do not include private Space data, user agreements, credentials, keys, private traces, or the Peerwork service implementation.

Each package's `release.lock.json` and digest are part of its identity. A source, fixture, documentation, or license change changes the package digest and may require dependent packages to pin the new digest and regenerate their locks. Include the source repository commit and derivation in the pull request description. Package authors and publishers remain responsible for provenance and license authority.

A fixture pass verifies the encoded case only. To claim that Agents adopted a workflow, retain observable evidence of entry-instruction use, identity and source selection, existing-result recovery, persisted effects, and completion or handoff; report workflow compliance separately from business correctness. Do not infer independent controllers from signatures or fixture outputs.
