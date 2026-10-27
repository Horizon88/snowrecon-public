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

## Evidence labels

Recon mission cards describe the stored qualifying sample count, terrain completeness and modeled cat-route status. A modeled route does not establish legal access. Fixed confidence percentages are no longer generated or displayed; legacy confidence fields remain untouched in saved mission data in browser storage. Missing completeness information on older records is shown as unknown.

## Saved mission history

Clear saves a complete snapshot before removing an idle mission. Starting another mission after completion also preserves the previous mission, including candidates, parcel evidence, exclusions and manual review history. Each snapshot stays separate in this browser’s local storage; existing snapshots are never replaced. If history cannot be saved, Clear or replacement stops and the current mission is retained.

Use **Export History** to download the current mission and archived snapshots, including any unreadable stored history as its original text. This is local browser storage, not a cloud backup. Clearing browser data removes it. Clear during active work still stops workers first and retains the mission for resume.

Storage failures stop new work without discarding in-memory results or the last saved mission. The persistent unsaved warning remains until a save succeeds. Workers already in flight settle before a new mission can start. If storage fills, **Export History**, save and open the downloaded file, then use **Remove exported archives** and explicitly confirm. This removes only unchanged archive records included in that export, never the active mission or later archives. Nothing is purged automatically. Keep the export: removed archives are no longer available in this browser.

Unreadable active mission data is exported as `activeRaw` and must be archived intact before Clear or replacement can proceed. Exports also include exact archive text. An archive captures pending parcel checks as they were at that moment; late responses do not rewrite an archived mission.

If the mission itself leaves too little room for even its first browser archive, export it first. Only after a browser archive write fails, and only while both the current results and saved active bytes exactly match that export, Clear or replacement can offer a separate confirmation to use the downloaded file as the **only** archive. Confirm only after saving and opening the file. Changed results, a failed export, or cancellation keep the mission in the browser.
