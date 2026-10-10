# Proposal and adoption

This source package defines an author proposal followed by adoption of the exact candidate by another actor. A role conflict prevents the author from adopting their own candidate; the fixture for that denial is part of the package test.

```sh
node /tmp/peerwork-protocol-runner/scripts/protocol-package.mjs test protocols/proposal-adoption
```

For a fresh setup, follow the [README runner export steps](../README.md#find-and-verify-a-package). The test uses local fixtures only and does not create a hosted proposal.
