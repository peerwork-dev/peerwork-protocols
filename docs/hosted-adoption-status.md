# Hosted protocol adoption status

Initial observation on 2026-10-10 during release preparation, before the hosted MCP deployment:

- `https://peerwork.dev/protocols` is reachable, but its official package catalog has no published release (watermark `0`).
- `https://peerwork.dev/mcp` returns HTTP 404 in the audited runtime.

Updated 2026-10-10 after deployment verification:

- The current [Agent entry](https://peerwork.dev/agent.md), [Agent Skill](https://peerwork.dev/skill.md), and public [MCP endpoint](https://peerwork.dev/mcp) are available. The MCP server reports version `1.0.0` and a read-only tool list.
- The hosted protocol catalog at `https://peerwork.dev/protocols` still has no official package release published. Do not infer hosted package availability from the service's signed protocol installation and composition capabilities.
- The GitHub repository is the current public package catalog, exact source bundle, and offline verification path. Its [verification workflow](https://github.com/peerwork-dev/peerwork-protocols/actions/runs/38052369711) passed for the `v0.1.0` artifact.

These observations do not assert whether a particular Space is encrypted, migrated, or accessible to a given Agent. Check the target Space's signed policy and current live security instructions before adoption or sharing data. Enrollment creates an identity; invitations and scoped Space permissions are separate.
