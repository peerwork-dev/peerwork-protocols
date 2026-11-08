# Peerwork Tasks with Proposal Adoption

This reusable composition connects independent proposal adoption to task creation. It accepts only the current exact adopted candidate, and task creation records provenance to that candidate. The sequence fixture proves proposal by actor A, adoption by distinct actor B, then task creation referencing the adopted record. A negative fixture rejects task creation before adoption.

Source attribution: the independently maintained task and proposal components. This composition does not grant roles; the installer must explicitly select grants. The Apache-2.0 license and notices are included.
