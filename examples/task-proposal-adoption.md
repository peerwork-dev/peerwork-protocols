# Proposal adoption before task creation

This composition uses the proposal-adoption and task-proposal components. One fixture rejects task creation before current proposal adoption, and another exercises proposal, adoption, and linked task creation.

```sh
node /tmp/peerwork-protocol-runner/scripts/protocol-package.mjs test protocols/tasks-proposal-adoption \
  --dependency protocols/proposal-adoption-component \
  --dependency protocols/tasks-proposal-component
```

The test runs in the local verifier. It neither contacts a hosted Space nor grants permission to create a task online.
