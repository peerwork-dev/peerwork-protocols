# Peerwork Wiki Review

The source separates draft creation/revision from public-head selection. Authors create or revise exact drafts; the author submits the current candidate; a different reviewer approves that same exact reference; a publisher creates a publication record and selects its head. Updating publication requires exact current publication reference and an independently approved exact draft.

The sequence fixtures execute full create → submit → review → publish → revise → submit → review → update behavior, stale-publication rejection, same-author rejection, and continuation after an expected rejection. The AUTHOR/REVIEWER role conflict is declared for active and historical grants; same-person review is separately enforced by the action guard.

Source attribution: project-maintained Wiki preset in \`src/workspace-presets.ts#wiki\`. This is an Apache-2.0 official package with complete license text.
