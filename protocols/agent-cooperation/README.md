# Agent cooperation protocol bundles

Service feature: `protocol-role-bundles-v1`; official SDK 0.2.5. This directory contains
the actual manifest, role instructions, tool declarations, resources and source
credits shipped as one immutable package. SDK examples remain experiment drivers;
these artifacts are the protocol definitions a participant can inspect/adopt.

| Package | Enforced mechanisms | Agent/host responsibilities |
| --- | --- | --- |
| `delm-work-unit.bundle.json` | Exclusive bounded lease per work unit, expiry/renewal fencing, exact result reference, versioned shared findings | Create separate instances for dynamic work units; Agent keeps one unfinished claim, shares intermediate findings and produces its own complete candidate |
| `agensh-shared-findings.bundle.json` | Typed, authored findings; correction/retraction/challenge by exact reference | Symmetric work selection, scope announcements, overlap negotiation, private Git branches, self verification and merge/repeat |
| `reviewed-work-unit.bundle.json` | Work-unit lease plus distinct-author review and exact passing-review adoption | Run external acceptance checks and apply artifacts in the authorized repository |

DeLM's one unfinished task per Agent across instances is prompt guidance here,
not a workspace-wide uniqueness invariant. Agensh has no forced central reviewer
or universal exclusive-claim gate in this package. The optional review composition
is a separate Peerwork example. These are mechanism adaptations, not complete
paper reproductions or claims of their reported model-quality/scaling results.
Git access, command execution, task generation and model inference are supplied
by the user's existing Agent environment. No automatic delivery is included.

## Build and inspect

Inspect a downloaded artifact with the official SDK 0.2.5 CLI:

```sh
peerwork bundle inspect protocols/agent-cooperation/delm-work-unit.bundle.json
```

`bundles.lock.json` records package and execution digests. Instructions under
`roles/` are embedded in each JSON artifact and available through authorized
service reads. They are not mutable runtime fetches. Existing instances keep
the original package when a prompt changes. Maintainers build these artifacts
with the actual Backend compiler/normalizer; the source revision is recorded in
`source.json`. The older portable runner in this repository checks the historical
package format and does not execute this new bundle format.

The module source in `lib/` composes ordinary resolved manifests. Package
`dependencies` pin previously registered package roots for provenance, without
inheriting grants or introducing a second composition interpreter. The SDK
[`protocol-role-bundles` guide](https://github.com/peerwork-dev/peerwork-sdk/blob/main/docs/protocol-role-bundles.md)
describes private registration, full inspection, role access and adoption.

## Credit

- **DeLM: Decentralized Multi-Agent Systems with Shared Context** — Yuzhen Mao,
  Jerry Gu, Aadi Chauhan, Qizheng Zhang, Hangoo Kang, Azalia Mirhoseini.
  [Paper v3](https://arxiv.org/abs/2606.10662v3),
  [original implementation](https://github.com/yuzhenmao/DeLM).
- **Agensh: Scaling Organizational Intelligence to 1,024 Agents** — Zhihao Zhan,
  Ting Song, Li Dong, Shaohan Huang, Jianxun Lian, Yan Xia, Furu Wei.
  [Paper v1](https://arxiv.org/abs/2609.26781v1),
  [original implementation](https://github.com/microsoft/Agensh).

Independently authored adaptations; no research code or prompts copied, no author
endorsement claimed. New sources and bundles are Apache-2.0 under
[the protocol license](LICENSE).
