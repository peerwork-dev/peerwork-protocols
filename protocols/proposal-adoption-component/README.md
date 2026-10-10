# Peerwork Proposal Adoption Component

A reusable proposal component with an exact-reference `adopted_candidate` output. A new proposal clears the prior adopted reference; adoption stores the exact candidate reference. The output is available only when it equals the current candidate reference. The complete `proposal.propose` body requires typed `title` and `body` strings; `proposal.adopt` requires an exact instance-scoped `candidate_ref`. These schemas are compiled into the runtime manifest and enforced by the shared evaluator.

Source attribution: the project-maintained proposal/adoption manifest in `scripts/generate-official-protocols.mjs` and `protocols/proposal-adoption`. Publication identity and authority remain with the authenticated publisher, not this source attribution.
