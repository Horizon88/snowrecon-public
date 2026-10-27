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

Recon missions retain sampled zones from 150 m modeled descent; 250 m is preferred. The existing 200 m cluster-span screen remains a search heuristic, not measured usable ski width. Missing DEM pixels, incomplete slope/trace stencils, and traces reaching the analysis limit retain a cell as `data_review`, even when no qualifying zone was found. A complete sampled screen can still fail the numerical criteria; it does not establish whole-parcel coverage or operational suitability. Existing saved rejections are not automatically rewritten.

Run the dependency-free regression suite with Node.js 22 or newer:

```sh
node --test tests/*.test.mjs
```
