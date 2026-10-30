# Snowbunker Recon — Public Map

Browser-based terrain and land-recon workspace for Japan, the western United States, and Canada.

Open `index.html` through GitHub Pages or GitHack. The public build reads elevation, map, road, and Japan parcel data directly from their public upstream services; no private research files or personal contact information are included.

North American Recon Mission candidates can be matched to official parcel data where a jurisdiction adapter is available. Montana is the first supported statewide adapter and returns the mapped parcel boundary, parcel ID, acreage, owner/classification, property type, and source date. The app ranks private purchase leads separately from public-land permit paths.

## Important limitations

- Recon candidates are screening leads, not acquisition recommendations.
- Avalanche scenario outputs are not operational safety clearance.
- Approximate candidate footprints are not legal parcel boundaries.
- Road presence does not establish legal or winter access.
- Verify parcels, title, easements, protected status, terrain, and access with authoritative local sources and qualified professionals.

## Terrain screen and local tests

Recon missions retain sampled zones from 150 m modeled descent; 250 m is preferred. The existing 200 m cluster-span screen remains a search heuristic, not measured usable ski width. Missing DEM pixels, incomplete slope/trace stencils, and traces reaching the analysis limit retain a cell as `data_review`, even when no qualifying zone was found. A complete sampled screen can still fail the numerical criteria; it does not establish whole-parcel coverage or operational suitability. Existing saved rejections are not automatically rewritten. Tile preparation uses the actual z14 bounds plus a margin, and descent stencils request additional tiles as needed, with at most 512 new tile requests per scan. Budget-deferred samples are recorded separately from failed/missing DEM.

Every screened zone is retained, including the fourth and later zones in each cell. Automatic route and parcel enrichment still runs only for the first three ranked zones. Later candidates carry `researchPending: true` and `research_deferred`; these indicate deferred follow-up, not a failed access check. Existing exclusion and duplicate-review rules still apply. A deferred variant matching an existing candidate leaves that saved candidate unchanged, including its geometry and enriched evidence. Higher-ranked variants also preserve candidates that already have parcel-check evidence or cached parcel geometry. Both workers share a temporary set of processed candidate IDs for the current run, keeping automatic parcel requests tied to their original geometry and preventing duplicate queue entries. Pausing and resuming that run retains its set. A later accepted Retry or Resume starts a fresh set, so an unbound saved lead can refresh even when its persisted `researchPending` is false. Complete terrain evidence can replace an equal-scoring incomplete review; lower-scoring variants still need an access improvement. Existing user decisions remain preserved. Parcel evidence, including a pending check, stays bound across runs. This does not make a retained lead operationally qualified.

A mission with unresolved cells offers a separate **Retry data review** control; Launch continues to create or resume missions and retains prior exclusions when creating a new one. This explicit action preserves its ID, candidates, exclusions and a snapshot of the prior evidence. It refreshes only recorded failed/incomplete tiles, runs one bounded pass, and preserves user rejection/sidelining decisions; mapped exclusions still take precedence. There is no automatic retry loop. Retry snapshots retain affected cell/candidate evidence and preserve every existing history entry. Storage is checked before a new run or retry begins; a failed write stops research without replacing the last successful saved snapshot. Unsaved current evidence remains available through **Export mission JSON**. No history is silently truncated to make space.

After a page reload, a saved parcel check that was still checking is marked as interrupted. Its existing coordinates and evidence remain intact, and the card's **Recheck land** action starts a new explicit check. Current-session requests and other saved land-check states are unchanged.

Run the dependency-free regression suite with Node.js 22 or newer:

```sh
node --test tests/*.test.mjs
```
