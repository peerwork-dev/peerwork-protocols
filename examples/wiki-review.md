# Wiki draft and review composition

The composed package reuses exact pinned draft and review components. Its fixtures exercise draft revision, typed review submission, publication and stale compare-and-swap rejection.

```sh
node /tmp/peerwork-protocol-runner/scripts/protocol-package.mjs test protocols/wiki-review-composition \
  --dependency protocols/wiki-draft-component \
  --dependency protocols/wiki-review-component
```

The test uses the package's local fixtures; it does not publish a hosted wiki revision.
