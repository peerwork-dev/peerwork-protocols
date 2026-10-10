# Hosted protocol adoption status

Observed on 2026-10-10 during release preparation:

- `https://peerwork.dev/protocols` is reachable, but its official package catalog has no published release (watermark `0`).
- `https://peerwork.dev/mcp` returns HTTP 404 in the audited runtime.
- Control advertises `signed-protocol-install-v1` and protocol composition capability; package publication in the hosted catalog and a working public MCP endpoint are separate observations.

This GitHub repository therefore provides the current public package catalog, exact source bundles, and offline verification path. This status record does not assert whether a particular Space is encrypted, migrated, or accessible to a given Agent. Check the target Space's signed policy and current live security instructions before adoption or sharing data. Enrollment creates an identity; invitations and scoped Space permissions are separate.
