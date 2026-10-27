// ===== SNOWBUNKER RUN ENGINE v1.1 =====
// Parsed tile cache, downhill tracer, ridgeline finder, road proximity, scoring, naming

const RunEngine = (() => {

  // ===== PARSED TILE CACHE =====
  let parsedCache = {}; // key: "z/x/y" -> Float32Array(65536) or null
  let pendingFetches = {}; // key -> Promise, for deduplication

  // Which DEM the server should serve. Tile keys are identical between regions, so
  // the parsed cache MUST be dropped on a switch or Utah renders with Hokkaido terrain.
  let region = 'japan';
  function setRegion(r) {
    const next = (r === 'usa') ? 'usa' : 'japan';
    if (next === region) return region;
    region = next;
    parsedCache = {};
    pendingFetches = {};
    return region;
  }
  function getRegion() { return region; }

  function parseDEMText(text) {
    const arr = new Float32Array(256 * 256).fill(NaN);
    const lines = text.trim().split('\n');
    for (let r = 0; r < Math.min(lines.length, 256); r++) {
      const cols = lines[r].split(',');
      for (let c = 0; c < Math.min(cols.length, 256); c++) {
        const v = cols[c].trim();
        arr[r * 256 + c] = (v === 'e' || v === '') ? NaN : parseFloat(v);
      }
    }
    return arr;
  }

  function latLngToTile(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const tileX = Math.floor((lng + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    const pixelX = Math.floor(((lng + 180) / 360 * n - tileX) * 256);
    const pixelY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256);
    return { tileX, tileY, pixelX: Math.min(Math.max(pixelX, 0), 255), pixelY: Math.min(Math.max(pixelY, 0), 255) };
  }

  async function fetchAndParseTile(zoom, tileX, tileY) {
    const key = `${zoom}/${tileX}/${tileY}`;
    if (parsedCache[key] !== undefined) return parsedCache[key];
    if (pendingFetches[key]) return pendingFetches[key];

    const promise = (async () => {
      try {
        const resp = await fetch(`/api/dem/${key}${region === 'usa' ? '?region=usa' : ''}`);
        if (resp.ok) {
          const text = await resp.text();
          if (text.trim().length > 0 && !text.includes('No elevation')) {
            const arr = parseDEMText(text);
            parsedCache[key] = arr;
            return arr;
          }
        }
      } catch (e) { /* fall through */ }
      parsedCache[key] = null;
      return null;
    })();

    pendingFetches[key] = promise;
    const result = await promise;
    delete pendingFetches[key];
    return result;
  }

  // Synchronous elevation lookup from parsed cache
  function getElevationFast(lat, lng) {
    const zoom = 14;
    const { tileX, tileY, pixelX, pixelY } = latLngToTile(lat, lng, zoom);
    const key = `${zoom}/${tileX}/${tileY}`;
    const arr = parsedCache[key];
    if (!arr) return NaN;
    return arr[pixelY * 256 + pixelX];
  }

  // Async elevation lookup (fetches if needed)
  async function getElevation(lat, lng) {
    const zoom = 14;
    const { tileX, tileY, pixelX, pixelY } = latLngToTile(lat, lng, zoom);
    await fetchAndParseTile(zoom, tileX, tileY);
    return getElevationFast(lat, lng);
  }

  // Prefetch tiles in a neighborhood around a point
  async function prefetchTiles(lat, lng, radius) {
    const zoom = 14;
    const center = latLngToTile(lat, lng, zoom);
    const promises = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        promises.push(fetchAndParseTile(zoom, center.tileX + dx, center.tileY + dy));
      }
    }
    await Promise.all(promises);
  }

  // ===== TERRAIN ANALYSIS =====
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const METERS_PER_DEG_LAT = 111320;

  function metersPerDegLng(lat) {
    return METERS_PER_DEG_LAT * Math.cos(lat * DEG2RAD);
  }

  // Compute slope and aspect at a point using the fast cache
  function analyzeFast(lat, lng, delta) {
    delta = delta || 0.00027; // ~30m
    const elC = getElevationFast(lat, lng);
    const elN = getElevationFast(lat + delta, lng);
    const elS = getElevationFast(lat - delta, lng);
    const elE = getElevationFast(lat, lng + delta);
    const elW = getElevationFast(lat, lng - delta);

    if (isNaN(elC)) return null;
    if (isNaN(elN) || isNaN(elS) || isNaN(elE) || isNaN(elW)) return { elevation: elC, slope: NaN, aspect: NaN };

    const dLat = METERS_PER_DEG_LAT * delta;
    const dLng = metersPerDegLng(lat) * delta;
    const dzdx = (elE - elW) / (2 * dLng);
    const dzdy = (elN - elS) / (2 * dLat);

    const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * RAD2DEG;
    let aspect = Math.atan2(-dzdy, -dzdx) * RAD2DEG;
    aspect = (90 - aspect + 360) % 360;

    return { elevation: elC, slope, aspect, dzdx, dzdy };
  }

  function aspectDir(deg) {
    if (isNaN(deg) || deg === null || deg === undefined) return '?';
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  function isNorthFacing(deg) {
    if (isNaN(deg) || deg === null || deg === undefined) return false;
    return ['N','NW','NE'].includes(aspectDir(deg));
  }

  // ===== SMOOTH GRADIENT (8-direction weighted) =====
  // Samples elevation in 8 directions around a point.
  // Returns a weighted descent vector using the 3 steepest downhill directions.
  function smoothGradient(lat, lng, delta) {
    delta = delta || 0.00027;
    const elC = getElevationFast(lat, lng);
    if (isNaN(elC)) return null;

    // 8 directions: N, NE, E, SE, S, SW, W, NW
    const directions = [
      { dlat:  1, dlng:  0 }, // N
      { dlat:  1, dlng:  1 }, // NE
      { dlat:  0, dlng:  1 }, // E
      { dlat: -1, dlng:  1 }, // SE
      { dlat: -1, dlng:  0 }, // S
      { dlat: -1, dlng: -1 }, // SW
      { dlat:  0, dlng: -1 }, // W
      { dlat:  1, dlng: -1 }, // NW
    ];

    const mLng = metersPerDegLng(lat);
    const samples = [];

    for (const dir of directions) {
      const diagScale = (dir.dlat !== 0 && dir.dlng !== 0) ? Math.SQRT1_2 : 1;
      const sLat = lat + dir.dlat * delta * diagScale;
      const sLng = lng + dir.dlng * delta * diagScale;
      const elev = getElevationFast(sLat, sLng);
      if (isNaN(elev)) continue;

      const drop = elC - elev; // positive = downhill
      const distLat = dir.dlat * delta * diagScale * METERS_PER_DEG_LAT;
      const distLng = dir.dlng * delta * diagScale * mLng;
      const dist = Math.sqrt(distLat * distLat + distLng * distLng);
      if (dist === 0) continue;

      const gradient = drop / dist; // positive = downhill slope
      samples.push({
        gradient,
        dxNorm: distLng / dist,
        dyNorm: distLat / dist,
      });
    }

    // Keep only downhill samples
    const downhill = samples.filter(s => s.gradient > 0);
    if (downhill.length === 0) return null;

    // Sort by steepest gradient descending
    downhill.sort((a, b) => b.gradient - a.gradient);

    // Weighted average of the top 3 (or fewer) steepest directions
    const top = downhill.slice(0, 3);
    const totalWeight = top.reduce((sum, s) => sum + s.gradient, 0);
    if (totalWeight === 0) return null;

    let wx = 0, wy = 0;
    for (const s of top) {
      const w = s.gradient / totalWeight;
      wx += s.dxNorm * w;
      wy += s.dyNorm * w;
    }

    const mag = Math.sqrt(wx * wx + wy * wy);
    if (mag < 1e-9) return null;

    return { dxNorm: wx / mag, dyNorm: wy / mag, elevation: elC };
  }

  // ===== DOWNHILL RUN TRACER =====
  let minVerticalDrop = 300; // Default; configurable via setMinVert()

  function setMinVert(meters) { minVerticalDrop = meters; }
  function getMinVert() { return minVerticalDrop; }

  async function traceRun(startLat, startLng, onProgress) {
    // Prefetch tiles
    await prefetchTiles(startLat, startLng, 2);

    const stepDelta = 0.00027; // ~30m sampling
    const stepMeters = 30;
    const maxSteps = 500;
    const points = [];
    let lat = startLat, lng = startLng;
    let flatAccum = 0; // meters of flat terrain
    let flatSpots = 0;
    let totalHorizDist = 0;
    let runningMinElev = Infinity;

    for (let i = 0; i < maxSteps; i++) {
      const analysis = analyzeFast(lat, lng, stepDelta);
      if (!analysis || isNaN(analysis.elevation)) break;

      const elev = analysis.elevation;

      // Track running minimum elevation
      if (elev < runningMinElev) runningMinElev = elev;

      // Terminate if current elevation exceeds running minimum by 10m
      // (allows undulations over small bumps but catches real uphills)
      if (points.length > 3 && elev > runningMinElev + 10) break;

      points.push({
        lat, lng,
        elevation: elev,
        slope: isNaN(analysis.slope) ? 0 : analysis.slope,
        aspect: isNaN(analysis.aspect) ? 0 : analysis.aspect,
      });

      // Flat tracking
      if (!isNaN(analysis.slope) && analysis.slope < 15) {
        flatAccum += stepMeters;
        if (flatAccum > 100 && flatAccum - stepMeters <= 100) {
          flatSpots++;
        }
      } else {
        flatAccum = 0;
      }

      // Termination: definitive flat runout (only after we've had some steep terrain)
      if (!isNaN(analysis.slope) && analysis.slope < 3 && flatAccum > 300) break;
      // Termination: too far horizontally
      if (totalHorizDist > 6000) break;

      // Step downhill using smooth 8-direction gradient
      const sg = smoothGradient(lat, lng, stepDelta);
      if (!sg) {
        // Fallback to standard gradient if smooth fails
        if (isNaN(analysis.dzdx) || isNaN(analysis.dzdy)) break;
        const gradMag = Math.sqrt(analysis.dzdx * analysis.dzdx + analysis.dzdy * analysis.dzdy);
        if (gradMag < 0.0003) break;
        const dxNorm = -analysis.dzdx / gradMag;
        const dyNorm = -analysis.dzdy / gradMag;
        const dlat = (dyNorm * stepMeters) / METERS_PER_DEG_LAT;
        const dlng = (dxNorm * stepMeters) / metersPerDegLng(lat);
        lat += dlat;
        lng += dlng;
      } else {
        const dlat = (sg.dyNorm * stepMeters) / METERS_PER_DEG_LAT;
        const dlng = (sg.dxNorm * stepMeters) / metersPerDegLng(lat);
        lat += dlat;
        lng += dlng;
      }

      totalHorizDist += stepMeters;

      // Check if we need to fetch new tiles
      const { tileX, tileY } = latLngToTile(lat, lng, 14);
      const tileKey = `14/${tileX}/${tileY}`;
      if (parsedCache[tileKey] === undefined) {
        await prefetchTiles(lat, lng, 1);
      }

      if (onProgress && i % 20 === 0) onProgress(i, maxSteps);
    }

    if (points.length < 5) return null;

    // Trim flat tail: remove trailing points where slope < 10 degrees
    while (points.length > 5 && points[points.length - 1].slope < 10) {
      points.pop();
    }

    if (points.length < 5) return null;

    // Post-process
    const startElev = points[0].elevation;
    const endElev = points[points.length - 1].elevation;
    const verticalDrop = startElev - endElev;

    if (verticalDrop < minVerticalDrop) return null; // Below minimum

    // Compute metrics
    const slopes = points.map(p => p.slope).filter(s => s > 0);
    const avgSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
    const slopeVariance = slopes.reduce((a, s) => a + (s - avgSlope) ** 2, 0) / slopes.length;
    const slopeStdDev = Math.sqrt(slopeVariance);

    const northCount = points.filter(p => isNorthFacing(p.aspect)).length;
    const northFacingPct = northCount / points.length;

    const totalFlatDist = points.filter(p => p.slope < 15).length * stepMeters;

    // Horizontal distance (sum of segments)
    let horizDist = 0;
    for (let i = 1; i < points.length; i++) {
      const dlat = (points[i].lat - points[i-1].lat) * METERS_PER_DEG_LAT;
      const dlng = (points[i].lng - points[i-1].lng) * metersPerDegLng(points[i].lat);
      horizDist += Math.sqrt(dlat * dlat + dlng * dlng);
    }

    return {
      id: 'run-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      points,
      startElev,
      endElev,
      verticalDrop,
      horizontalDistance: horizDist,
      avgSlope,
      slopeStdDev,
      northFacingPct,
      flatSpots,
      flatDistance: totalFlatDist,
      name: '', // filled by generateName
      nameOverride: null,
      forestStatus: 'unknown',
      roadDistance: null,
      score: 0,
      checked: false,
    };
  }

  // ===== RIDGELINE DETECTION =====
  // Yield to browser event loop
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function findRidgelines(bounds, gridSize, onProgress) {
    const latStep = (bounds.north - bounds.south) / gridSize;
    const lngStep = (bounds.east - bounds.west) / gridSize;
    const neighborOffset = 0.0018; // ~200m
    const candidates = [];

    let processed = 0;
    const total = gridSize * gridSize;

    for (let i = 0; i < gridSize; i++) {
      // Prefetch tiles for this row and neighbors
      const rowLat = bounds.south + latStep * (i + 0.5);
      await prefetchTiles(rowLat, (bounds.east + bounds.west) / 2,
        Math.max(2, Math.ceil((bounds.east - bounds.west) / 0.044 / 2)));

      // Yield to UI between rows so browser stays responsive
      await yieldToUI();

      for (let j = 0; j < gridSize; j++) {
        const lat = rowLat;
        const lng = bounds.west + lngStep * (j + 0.5);

        // Use async getElevation to ensure tile is loaded
        const elev = await getElevation(lat, lng);
        processed++;
        if (onProgress) onProgress(processed, total, 'Scanning grid');

        if (isNaN(elev) || elev < 400) continue;

        // Check neighbors — also use async to ensure tiles loaded
        const [nN, nS, nE, nW] = await Promise.all([
          getElevation(lat + neighborOffset, lng),
          getElevation(lat - neighborOffset, lng),
          getElevation(lat, lng + neighborOffset),
          getElevation(lat, lng - neighborOffset),
        ]);

        let higherCount = 0;
        let maxDrop = 0;
        const neighborDrops = [];
        for (const ne of [nN, nS, nE, nW]) {
          if (isNaN(ne)) continue;
          if (elev > ne) {
            higherCount++;
            const drop = elev - ne;
            maxDrop = Math.max(maxDrop, drop);
            neighborDrops.push({ elev: ne, drop });
          }
        }

        // Ridgeline: higher than 2+ neighbors with significant drop available
        if (higherCount >= 2 && maxDrop > 50) {
          // Sort neighbor drops descending to identify the two steepest downhill directions
          neighborDrops.sort((a, b) => b.drop - a.drop);
          candidates.push({ lat, lng, elevation: elev, maxDrop, neighborDrops });
        }
      }
    }

    return candidates;
  }

  // Find the two steepest downhill directions from a ridgeline point
  // Returns up to 2 offset vectors [{dlat, dlng}] representing distinct descent directions
  function findSteepestDirections(lat, lng) {
    const delta = 0.0018; // ~200m
    // 8 directions
    const directions = [
      { dlat:  delta, dlng:  0 },     // N
      { dlat:  delta, dlng:  delta },  // NE
      { dlat:  0,     dlng:  delta },  // E
      { dlat: -delta, dlng:  delta },  // SE
      { dlat: -delta, dlng:  0 },      // S
      { dlat: -delta, dlng: -delta },  // SW
      { dlat:  0,     dlng: -delta },  // W
      { dlat:  delta, dlng: -delta },  // NW
    ];

    const elC = getElevationFast(lat, lng);
    if (isNaN(elC)) return [];

    const drops = [];
    for (const dir of directions) {
      const elev = getElevationFast(lat + dir.dlat, lng + dir.dlng);
      if (isNaN(elev)) continue;
      if (elC > elev) {
        drops.push({ dlat: dir.dlat, dlng: dir.dlng, drop: elC - elev });
      }
    }

    if (drops.length === 0) return [];

    // Sort by drop descending
    drops.sort((a, b) => b.drop - a.drop);

    // Take steepest
    const result = [drops[0]];

    // Find second steepest that is roughly opposite or at least > 90 degrees away
    for (let i = 1; i < drops.length; i++) {
      const dot = drops[0].dlat * drops[i].dlat + drops[0].dlng * drops[i].dlng;
      // Negative or zero dot product means >= 90 degrees apart
      if (dot <= 0) {
        result.push(drops[i]);
        break;
      }
    }

    return result;
  }

  async function autoFindRuns(bounds, onProgress) {
    if (onProgress) onProgress(0, 1, 'Finding ridgelines...');

    const candidates = await findRidgelines(bounds, 16, (done, total) => {
      if (onProgress) onProgress(done, total, 'Scanning grid...');
    });

    if (onProgress) onProgress(0, candidates.length, `Found ${candidates.length} ridgeline candidates`);

    const runs = [];
    const batchSize = 4;

    // For each candidate, trace from the two steepest downhill directions
    const traceJobs = [];
    for (const c of candidates) {
      const dirs = findSteepestDirections(c.lat, c.lng);
      if (dirs.length === 0) {
        // Fallback: trace from the candidate point itself
        traceJobs.push({ lat: c.lat, lng: c.lng });
      } else {
        for (const dir of dirs) {
          // Start trace slightly offset in the downhill direction
          const startLat = c.lat + dir.dlat * 0.15; // small nudge downhill
          const startLng = c.lng + dir.dlng * 0.15;
          traceJobs.push({ lat: startLat, lng: startLng });
        }
      }
    }

    for (let i = 0; i < traceJobs.length; i += batchSize) {
      const batch = traceJobs.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(j => traceRun(j.lat, j.lng)));

      for (const run of batchResults) {
        if (run) runs.push(run);
      }

      if (onProgress) onProgress(Math.min(i + batchSize, traceJobs.length), traceJobs.length, 'Tracing runs...');
    }

    // Deduplicate: runs with start points within 200m
    const deduped = [];
    for (const run of runs) {
      let isDupe = false;
      for (const existing of deduped) {
        const dlat = (run.points[0].lat - existing.points[0].lat) * METERS_PER_DEG_LAT;
        const dlng = (run.points[0].lng - existing.points[0].lng) * metersPerDegLng(run.points[0].lat);
        const dist = Math.sqrt(dlat * dlat + dlng * dlng);
        if (dist < 200) {
          // Keep higher scoring one
          if (run.verticalDrop > existing.verticalDrop) {
            const idx = deduped.indexOf(existing);
            deduped[idx] = run;
          }
          isDupe = true;
          break;
        }
      }
      if (!isDupe) deduped.push(run);
    }

    return deduped;
  }

  // ===== ROAD PROXIMITY =====
  let cachedRoads = null;
  let cachedRoadsBounds = null;

  async function fetchRoads(bounds) {
    // Check if we already have roads for this area
    if (cachedRoads && cachedRoadsBounds &&
        bounds.south >= cachedRoadsBounds.south && bounds.north <= cachedRoadsBounds.north &&
        bounds.west >= cachedRoadsBounds.west && bounds.east <= cachedRoadsBounds.east) {
      return cachedRoads;
    }

    // Include non-public and informal access candidates. OSM `track`, `service`,
    // and many `path` ways cover forestry roads, ranch roads, skid roads and old
    // approaches that matter to acquisition research. We retain access metadata;
    // presence on the map is not a claim of a public right-of-way.
    const query = `[out:json][timeout:30];
(
  way["highway"~"primary|secondary|tertiary|unclassified|residential|service|track|path"]
    (${bounds.south},${bounds.west},${bounds.north},${bounds.east});
);
out geom;`;

    try {
      let resp = await fetch('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
      });
      // Static/public builds do not have the SnowRecon proxy. Overpass supports
      // browser CORS, so fall back to its public interpreter for road-only lookup.
      if (!resp.ok) {
        resp = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
      }
      if (!resp.ok) throw new Error(`Overpass: ${resp.status}`);
      const data = await resp.json();

      // Extract road segments as arrays of [lat, lng]
      const roads = [];
      for (const element of (data.elements || [])) {
        if (element.type === 'way' && element.geometry) {
          const coords = element.geometry.map(p => [p.lat, p.lon]);
          roads.push({
            coords,
            type: element.tags?.highway || 'unknown',
            access: element.tags?.access || 'unknown',
            surface: element.tags?.surface || 'unknown',
            tracktype: element.tags?.tracktype || null,
            name: element.tags?.name || element.tags?.ref || null,
            osmId: element.id,
          });
        }
      }

      cachedRoads = roads;
      cachedRoadsBounds = { ...bounds };
      return roads;
    } catch (e) {
      console.error('Road fetch failed:', e);
      return [];
    }
  }

  function pointToSegmentDist(lat, lng, lat1, lng1, lat2, lng2) {
    const mLat = METERS_PER_DEG_LAT;
    const mLng = metersPerDegLng(lat);
    const px = (lng - lng1) * mLng, py = (lat - lat1) * mLat;
    const dx = (lng2 - lng1) * mLng, dy = (lat2 - lat1) * mLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt(px * px + py * py);
    let t = (px * dx + py * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = px - t * dx, cy = py - t * dy;
    return Math.sqrt(cx * cx + cy * cy);
  }

  // Return the closest point on a road segment, rather than just measuring to it.
  // The old cat tracer snapped to OSM vertices, which can be hundreds of metres
  // apart on rural roads and produced visibly bad access starts.
  function closestPointOnSegment(lat, lng, lat1, lng1, lat2, lng2) {
    const mLng = metersPerDegLng(lat);
    const px = (lng - lng1) * mLng, py = (lat - lat1) * METERS_PER_DEG_LAT;
    const dx = (lng2 - lng1) * mLng, dy = (lat2 - lat1) * METERS_PER_DEG_LAT;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
    const pointLat = lat1 + (lat2 - lat1) * t;
    const pointLng = lng1 + (lng2 - lng1) * t;
    const ex = px - t * dx, ey = py - t * dy;
    return { lat: pointLat, lng: pointLng, distance: Math.sqrt(ex * ex + ey * ey) };
  }

  function distanceToNearestRoad(lat, lng, roads) {
    let minDist = Infinity;
    for (const road of roads) {
      for (let i = 0; i < road.coords.length - 1; i++) {
        const d = pointToSegmentDist(lat, lng,
          road.coords[i][0], road.coords[i][1],
          road.coords[i+1][0], road.coords[i+1][1]);
        if (d < minDist) minDist = d;
      }
    }
    return minDist === Infinity ? null : minDist;
  }

  async function computeRoadDistances(runs, bounds) {
    const roads = await fetchRoads(bounds);
    for (const run of runs) {
      const endPoint = run.points[run.points.length - 1];
      run.roadDistance = distanceToNearestRoad(endPoint.lat, endPoint.lng, roads);
    }
    return roads; // Return for optional map display
  }

  // ===== CAT ACCESS ROUTE TRACER =====
  // Traces a snowcat route from a real projected road point to a run's ridgeline.
  // Uses a best-first terrain search so it can switchback around steep ground instead
  // of getting trapped by the old greedy five-direction walker.

  async function traceCatRoute(targetLat, targetLng, roads) {
    if (!roads || roads.length === 0) return null;

    // Find the closest point along each road segment. Prefer tracks/unclassified roads
    // for practical snowcat access when the distance difference is small.
    const roadPenalty = { track: 0, service: 20, path: 45, unclassified: 55,
      residential: 100, tertiary: 140, secondary: 180, primary: 240 };
    let nearestRoadPt = null, nearestDist = Infinity, bestRoadScore = Infinity;
    for (const road of roads) {
      for (let i = 0; i < road.coords.length - 1; i++) {
        const a = road.coords[i], b = road.coords[i + 1];
        const p = closestPointOnSegment(targetLat, targetLng, a[0], a[1], b[0], b[1]);
        const score = p.distance + (roadPenalty[road.type] ?? 120);
        if (score < bestRoadScore) {
          bestRoadScore = score;
          nearestDist = p.distance;
          nearestRoadPt = { lat: p.lat, lng: p.lng, roadType: road.type,
            roadAccess: road.access, roadSurface: road.surface, roadName: road.name };
        }
      }
    }

    if (!nearestRoadPt || nearestDist > 5000) return null; // No road within 5km

    // Warm a narrow corridor of DEM tiles. This is faster and more reliable than a
    // large square around the midpoint, especially on 3–5 km access approaches.
    const samples = Math.max(2, Math.ceil(nearestDist / 900));
    await Promise.all(Array.from({ length: samples + 1 }, (_, i) => {
      const t = i / samples;
      return prefetchTiles(nearestRoadPt.lat + (targetLat - nearestRoadPt.lat) * t,
        nearestRoadPt.lng + (targetLng - nearestRoadPt.lng) * t, 1);
    }));

    const stepMeters = 60, maxSlope = 18, absoluteMaxSlope = 24;
    const cosLat = Math.cos(targetLat * DEG2RAD);
    const toLatLng = (x, y) => ({
      lat: nearestRoadPt.lat + y / METERS_PER_DEG_LAT,
      lng: nearestRoadPt.lng + x / (METERS_PER_DEG_LAT * cosLat),
    });
    const targetX = (targetLng - nearestRoadPt.lng) * METERS_PER_DEG_LAT * cosLat;
    const targetY = (targetLat - nearestRoadPt.lat) * METERS_PER_DEG_LAT;
    const keyOf = (x, y) => `${Math.round(x / stepMeters)},${Math.round(y / stepMeters)}`;
    const heuristic = (x, y) => Math.hypot(targetX - x, targetY - y);
    const open = [{ x: 0, y: 0, g: 0, f: heuristic(0, 0), parent: null, slope: 0 }];
    const bestCost = new Map([[keyOf(0, 0), 0]]);
    let goal = null;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

    for (let searched = 0; open.length && searched < 7000; searched++) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (heuristic(cur.x, cur.y) < 90) { goal = cur; break; }
      const curLL = toLatLng(cur.x, cur.y);
      const curElev = getElevationFast(curLL.lat, curLL.lng);
      if (isNaN(curElev)) continue;

      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx * stepMeters, ny = cur.y + dy * stepMeters;
        // Bound detours to a useful search envelope around the direct approach.
        if (Math.hypot(nx, ny) > nearestDist * 1.8 + 600) continue;
        const ll = toLatLng(nx, ny), elev = getElevationFast(ll.lat, ll.lng);
        if (isNaN(elev)) continue;
        const moveDist = stepMeters * (dx && dy ? Math.SQRT2 : 1);
        const slope = Math.abs(Math.atan((elev - curElev) / moveDist) * RAD2DEG);
        if (slope > absoluteMaxSlope) continue;
        const uphill = Math.max(0, elev - curElev);
        const steepPenalty = slope > maxSlope ? (slope - maxSlope) ** 2 * 18 : slope ** 1.7 * 0.32;
        const downhillPenalty = Math.max(0, curElev - elev) * 1.5; // avoid wasteful loss/reclimb
        const g = cur.g + moveDist + uphill * 1.3 + steepPenalty + downhillPenalty;
        const k = keyOf(nx, ny);
        if (g >= (bestCost.get(k) ?? Infinity)) continue;
        bestCost.set(k, g);
        open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny) * 1.08,
          parent: cur, slope });
      }
    }

    const chain = [];
    for (let n = goal; n; n = n.parent) chain.push(n);
    chain.reverse();
    const points = chain.map(n => {
      const ll = toLatLng(n.x, n.y);
      return { ...ll, elevation: getElevationFast(ll.lat, ll.lng), slope: n.slope };
    });
    if (goal) points.push({ lat: targetLat, lng: targetLng,
      elevation: getElevationFast(targetLat, targetLng), slope: goal.slope });

    let totalDist = 0, elevGain = 0, maxSlopeFound = 0;
    for (let i = 1; i < points.length; i++) {
      totalDist += Math.hypot((points[i].lat - points[i-1].lat) * METERS_PER_DEG_LAT,
        (points[i].lng - points[i-1].lng) * metersPerDegLng(points[i].lat));
      elevGain += Math.max(0, points[i].elevation - points[i-1].elevation);
      maxSlopeFound = Math.max(maxSlopeFound, points[i].slope || 0);
    }
    const reachedTarget = !!goal;
    const feasible = reachedTarget && maxSlopeFound <= absoluteMaxSlope;
    const end = points[points.length - 1] || nearestRoadPt;

    return {
      points,
      startLat: nearestRoadPt.lat,
      startLng: nearestRoadPt.lng,
      roadType: nearestRoadPt.roadType,
      roadAccess: nearestRoadPt.roadAccess,
      roadSurface: nearestRoadPt.roadSurface,
      roadName: nearestRoadPt.roadName,
      roadDistance: nearestDist,
      endLat: end.lat,
      endLng: end.lng,
      distance: totalDist,
      elevGain,
      maxSlope: maxSlopeFound,
      feasible,
      reachedTarget,
    };
  }

  // ===== PROTECTED AREAS =====
  let cachedProtectedAreas = null;
  let cachedProtectedBounds = null;

  async function fetchProtectedAreas(bounds) {
    // Check if we already have protected areas for this area
    if (cachedProtectedAreas && cachedProtectedBounds &&
        bounds.south >= cachedProtectedBounds.south && bounds.north <= cachedProtectedBounds.north &&
        bounds.west >= cachedProtectedBounds.west && bounds.east <= cachedProtectedBounds.east) {
      return cachedProtectedAreas;
    }

    const query = `[out:json][timeout:60];
(
  way["boundary"="national_park"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
  relation["boundary"="national_park"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
  way["boundary"="protected_area"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
  relation["boundary"="protected_area"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
  way["leisure"="nature_reserve"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
  relation["leisure"="nature_reserve"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
);
out body geom;`;

    try {
      const resp = await fetch('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
      });
      if (!resp.ok) throw new Error(`Overpass: ${resp.status}`);
      const data = await resp.json();

      const areas = [];
      for (const element of (data.elements || [])) {
        const name = element.tags?.name || element.tags?.['name:en'] || element.tags?.['name:ja'] || 'Protected Area';
        const type = element.tags?.boundary || element.tags?.leisure || 'protected';

        if (element.type === 'way' && element.geometry) {
          const coords = element.geometry.map(p => [p.lat, p.lon]);
          areas.push({ name, type, polygons: [coords] });
        } else if (element.type === 'relation' && element.members) {
          const polygons = [];
          for (const member of element.members) {
            if (member.type === 'way' && member.geometry) {
              const coords = member.geometry.map(p => [p.lat, p.lon]);
              polygons.push(coords);
            }
          }
          if (polygons.length > 0) {
            areas.push({ name, type, polygons });
          }
        }
      }

      // Deduplicate by name
      const seen = new Set();
      const deduped = [];
      for (const area of areas) {
        if (!seen.has(area.name)) {
          seen.add(area.name);
          deduped.push(area);
        } else {
          // Merge polygons into existing area with same name
          const existing = deduped.find(a => a.name === area.name);
          if (existing) {
            existing.polygons.push(...area.polygons);
          }
        }
      }

      cachedProtectedAreas = deduped;
      cachedProtectedBounds = { ...bounds };
      return deduped;
    } catch (e) {
      console.error('Protected area fetch failed:', e);
      return [];
    }
  }

  // Ray casting point-in-polygon test
  function pointInPolygon(lat, lng, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const yi = polygon[i][0], xi = polygon[i][1];
      const yj = polygon[j][0], xj = polygon[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function isInProtectedArea(lat, lng, protectedAreas) {
    for (const area of protectedAreas) {
      for (const polygon of area.polygons) {
        if (pointInPolygon(lat, lng, polygon)) {
          return area;
        }
      }
    }
    return null;
  }

  // ===== NAMING =====
  const LANDMARKS = [
    { name: 'Yotei', lat: 42.826, lng: 140.811 },
    { name: 'Rankoshi', lat: 42.886, lng: 140.503 },
    { name: 'Akaigawa', lat: 43.055, lng: 140.686 },
    { name: 'Kiroro', lat: 42.975, lng: 140.985 },
    { name: 'Otaru', lat: 43.191, lng: 140.995 },
    { name: 'Niseko', lat: 42.931, lng: 140.345 },
    { name: 'Annupuri', lat: 42.893, lng: 140.590 },
    { name: 'Shakotan', lat: 43.300, lng: 140.450 },
  ];

  function generateName(run, existingNames) {
    if (run.nameOverride) return run.nameOverride;

    const startLat = run.points[0].lat;
    const startLng = run.points[0].lng;

    // Find nearest landmark
    let nearest = LANDMARKS[0], nearestDist = Infinity;
    for (const lm of LANDMARKS) {
      const d = Math.sqrt((startLat - lm.lat) ** 2 + (startLng - lm.lng) ** 2);
      if (d < nearestDist) { nearest = lm; nearestDist = d; }
    }

    // Direction from landmark to run
    const dlat = startLat - nearest.lat;
    const dlng = startLng - nearest.lng;
    const bearing = (Math.atan2(dlng, dlat) * RAD2DEG + 360) % 360;
    const dirNames = ['North', 'NE', 'East', 'SE', 'South', 'SW', 'West', 'NW'];
    const dir = dirNames[Math.round(bearing / 45) % 8];

    // Descriptor based on terrain
    let descriptor;
    if (run.verticalDrop > 800) descriptor = 'Face';
    else if (run.slopeStdDev > 8) descriptor = 'Bowl';
    else if (run.avgSlope > 35) descriptor = 'Chute';
    else descriptor = 'Glade';

    let baseName = `${nearest.name} ${dir} ${descriptor}`;

    // Add number if duplicate
    let count = 1;
    let name = baseName;
    while (existingNames && existingNames.has(name)) {
      count++;
      name = `${baseName} ${count}`;
    }

    return name;
  }

  // ===== SCORING =====
  function scoreRun(run) {
    // Vertical drop: minVert=0, 2*minVert=25
    const vertScore = Math.min(25, Math.max(0, (run.verticalDrop - minVerticalDrop) / minVerticalDrop * 25));

    // Slope consistency: stddev < 3 = 20, > 10 = 0
    const consistScore = Math.min(20, Math.max(0, (10 - run.slopeStdDev) / 7 * 20));

    // Aspect bonus: all aspects valid, slight bonus for consistency
    const aspectScore = run.northFacingPct > 0.5 ? 10 : 5; // consistent aspect gets more

    // Runout quality: 0 flat spots = 20, 1=14, 2=7, 3+=0
    const runoutScore = Math.max(0, 20 - run.flatSpots * 7);

    // Road proximity: <500m=10, 500-1000=7, 1000-2000=4, 2000-5000=2, >5000=0
    let roadScore = 0;
    if (run.roadDistance !== null) {
      if (run.roadDistance < 500) roadScore = 10;
      else if (run.roadDistance < 1000) roadScore = 7;
      else if (run.roadDistance < 2000) roadScore = 4;
      else if (run.roadDistance < 5000) roadScore = 2;
    }

    // Slope sweetness: peak at 28 degrees (cat ski ideal)
    const sweetScore = Math.max(0, 15 * (1 - Math.abs(run.avgSlope - 28) / 15));

    const total = Math.round(vertScore + consistScore + aspectScore + runoutScore + roadScore + sweetScore);
    return Math.min(100, total);
  }

  // ===== PERSISTENCE =====
  function saveRuns(runs) {
    try {
      const data = runs.map(r => ({
        id: r.id,
        name: r.name,
        nameOverride: r.nameOverride,
        startElev: r.startElev,
        endElev: r.endElev,
        verticalDrop: r.verticalDrop,
        horizontalDistance: r.horizontalDistance,
        avgSlope: r.avgSlope,
        slopeStdDev: r.slopeStdDev,
        northFacingPct: r.northFacingPct,
        flatSpots: r.flatSpots,
        flatDistance: r.flatDistance,
        forestStatus: r.forestStatus,
        roadDistance: r.roadDistance,
        score: r.score,
        checked: r.checked,
        startLat: r.points && r.points.length > 0 ? r.points[0].lat : null,
        startLng: r.points && r.points.length > 0 ? r.points[0].lng : null,
        endLat: r.points && r.points.length > 0 ? r.points[r.points.length - 1].lat : null,
        endLng: r.points && r.points.length > 0 ? r.points[r.points.length - 1].lng : null,
      }));
      localStorage.setItem('snowbunker-runs', JSON.stringify(data));
    } catch (e) { /* storage full or unavailable */ }
  }

  function loadRuns() {
    try {
      return JSON.parse(localStorage.getItem('snowbunker-runs') || '[]');
    } catch (e) {
      return [];
    }
  }

  // ===== GEOJSON EXPORT =====
  function exportGeoJSON(runs) {
    return {
      type: 'FeatureCollection',
      features: runs.map(r => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: r.points.map(p => [p.lng, p.lat, p.elevation]),
        },
        properties: {
          name: r.nameOverride || r.name,
          score: r.score,
          verticalDrop: r.verticalDrop,
          avgSlope: r.avgSlope,
          northFacingPct: r.northFacingPct,
          roadDistance: r.roadDistance,
          forestStatus: r.forestStatus,
          checked: r.checked,
        },
      })),
    };
  }

  // ===== ZONE SCANNER (sustained vertical heatmap) =====
  // For each grid point, walk downhill and measure how much vertical
  // you can descend while the terrain stays steep (>= slopeThreshold).
  // Returns { samples, coverage }; coverage describes this bounded sampled screen,
  // never full parcel coverage or proof that all possible descents were searched.

  // Configurable zone scan sensitivity
  let zoneSlopeThreshold = 12; // minimum slope to count as "steep" (default: moderate)
  let zoneFlatTolerance = 200; // meters of flat allowed before terminating

  function setZoneSensitivity(slopeThresh, flatTol) {
    zoneSlopeThreshold = slopeThresh;
    zoneFlatTolerance = flatTol;
  }
  function getZoneSensitivity() { return { slopeThreshold: zoneSlopeThreshold, flatTolerance: zoneFlatTolerance }; }

  async function scanZones(bounds, gridSize, onProgress, options) {
    options = options || {};
    const latStep = (bounds.north - bounds.south) / gridSize;
    const lngStep = (bounds.east - bounds.west) / gridSize;
    const slopeThreshold = zoneSlopeThreshold;
    const stepMeters = 40;
    const stepDelta = 0.00036; // ~40m
    const maxSteps = 200;
    const results = [];
    let processed = 0;
    const total = gridSize * gridSize;
    const coverage = { scope: 'sampled_grid_and_traces', totalSamples: total,
      measuredSamples: 0, missingElevationSamples: 0, missingSlopeSamples: 0,
      incompleteTraces: 0, limitedTraces: 0, complete: false };

    for (let i = 0; i < gridSize; i++) {
      const rowLat = bounds.south + latStep * (i + 0.5);
      // Prefetch tiles for this row
      await prefetchTiles(rowLat, (bounds.east + bounds.west) / 2,
        Math.max(2, Math.ceil((bounds.east - bounds.west) / 0.044 / 2)));
      await yieldToUI();

      for (let j = 0; j < gridSize; j++) {
        const lat = rowLat;
        const lng = bounds.west + lngStep * (j + 0.5);
        processed++;

        if (onProgress && processed % 10 === 0) onProgress(processed, total, 'Scanning terrain');

        const elev = getElevationFast(lat, lng);
        if (!Number.isFinite(elev)) { coverage.missingElevationSamples++; continue; }
        if (elev < (options.minElevation ?? 300)) { coverage.measuredSamples++; continue; }

        const analysis = analyzeFast(lat, lng, 0.0005);
        if (!analysis || !Number.isFinite(analysis.slope)) { coverage.missingSlopeSamples++; continue; }
        coverage.measuredSamples++;
        if (analysis.slope < slopeThreshold) continue;

        // Walk downhill from this point, counting how much vert we get
        // while the slope stays above threshold
        let curLat = lat, curLng = lng;
        let steepVert = 0;
        let totalAspectSin = 0, totalAspectCos = 0;
        let steepCount = 0;
        let prevElev = elev;
        let flatStreak = 0;

        let traceFinished = false;
        for (let step = 0; step < maxSteps; step++) {
          // smoothGradient otherwise ignores missing neighbours. Do not let a
          // truncated stencil masquerade as a measured end of the descent.
          const offsets = [[0,0],[1,0],[-1,0],[0,1],[0,-1],
            [Math.SQRT1_2,Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2],
            [-Math.SQRT1_2,Math.SQRT1_2],[-Math.SQRT1_2,-Math.SQRT1_2]];
          if (!offsets.every(([dy,dx]) => Number.isFinite(getElevationFast(curLat + dy*stepDelta, curLng + dx*stepDelta)))) {
            coverage.incompleteTraces++; traceFinished = true; break;
          }
          const sg = smoothGradient(curLat, curLng, stepDelta);
          if (!sg) { traceFinished = true; break; }

          const a = analyzeFast(curLat, curLng, stepDelta);
          if (!a || !Number.isFinite(a.slope)) { coverage.incompleteTraces++; traceFinished = true; break; }

          if (a.slope >= slopeThreshold) {
            steepVert += Math.max(0, prevElev - a.elevation);
            prevElev = Math.min(prevElev, a.elevation);
            totalAspectSin += Math.sin(a.aspect * DEG2RAD);
            totalAspectCos += Math.cos(a.aspect * DEG2RAD);
            steepCount++;
            flatStreak = 0;
          } else {
            flatStreak += stepMeters;
            if (flatStreak > zoneFlatTolerance) { traceFinished = true; break; } // measured flat runout
          }

          // Step downhill
          curLat += (sg.dyNorm * stepMeters) / METERS_PER_DEG_LAT;
          curLng += (sg.dxNorm * stepMeters) / metersPerDegLng(curLat);
        }

        if (!traceFinished) coverage.limitedTraces++;

        if (steepVert >= (options.minVerticalDrop ?? minVerticalDrop) * 0.33) { // at least a third of min vert in steep terrain
          const avgAspect = (Math.atan2(totalAspectSin / steepCount, totalAspectCos / steepCount) * RAD2DEG + 360) % 360;
          results.push({
            lat, lng, elevation: elev,
            sustainedVert: steepVert,
            aspect: avgAspect,
            isNorth: isNorthFacing(avgAspect),
          });
        }
      }
    }

    coverage.complete = coverage.missingElevationSamples === 0 && coverage.missingSlopeSamples === 0
      && coverage.incompleteTraces === 0 && coverage.limitedTraces === 0;
    return { samples: results, coverage };
  }

  // Retention and preference are separate. Width remains the existing screen;
  // these zones are terrain search extents, never cadastral plots.
  function screenMissionZones(zones, coverage) {
    const retained = zones.filter(z => z.maxVert >= 150 && z.width >= 200)
      .map(z => ({ ...z, preferredVertical: z.maxVert >= 250 }))
      .sort((a,b) => b.maxVert-a.maxVert || b.pointCount-a.pointCount);
    const incomplete = coverage?.complete !== true;
    return { zones: retained, status: incomplete ? 'data_review' : retained.length ? 'complete' : 'rejected',
      reason: incomplete ? 'Elevation coverage or bounded descent analysis is incomplete; retain for data review.'
        : retained.length ? null : 'No sampled candidate passed 150m vertical / 200m span; 250m is preferred.' };
  }

  // Cluster adjacent heatmap points into zones
  function clusterZones(heatPoints, clusterDistMeters) {
    clusterDistMeters = clusterDistMeters || 600;
    const clusters = [];
    const used = new Set();

    // Sort by sustained vert descending so we seed clusters from best points
    const sorted = [...heatPoints].sort((a, b) => b.sustainedVert - a.sustainedVert);

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      const seed = sorted[i];
      const cluster = [seed];
      used.add(i);

      // BFS: find all nearby points
      const queue = [seed];
      while (queue.length > 0) {
        const current = queue.shift();
        for (let j = 0; j < sorted.length; j++) {
          if (used.has(j)) continue;
          const candidate = sorted[j];
          const dlat = (current.lat - candidate.lat) * METERS_PER_DEG_LAT;
          const dlng = (current.lng - candidate.lng) * metersPerDegLng(current.lat);
          const dist = Math.sqrt(dlat * dlat + dlng * dlng);
          if (dist <= clusterDistMeters) {
            cluster.push(candidate);
            used.add(j);
            queue.push(candidate);
          }
        }
      }

      if (cluster.length >= 2) { // need at least 2 points to form a zone
        // Compute zone stats
        const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
        const avgLng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
        const maxVert = Math.max(...cluster.map(p => p.sustainedVert));
        const avgVert = cluster.reduce((s, p) => s + p.sustainedVert, 0) / cluster.length;
        const maxElev = Math.max(...cluster.map(p => p.elevation));
        const minElev = Math.min(...cluster.map(p => p.elevation));

        // Zone width: max distance between any two points
        let maxWidth = 0;
        for (let a = 0; a < cluster.length; a++) {
          for (let b = a + 1; b < cluster.length; b++) {
            const dl = (cluster[a].lat - cluster[b].lat) * METERS_PER_DEG_LAT;
            const dn = (cluster[a].lng - cluster[b].lng) * metersPerDegLng(cluster[a].lat);
            maxWidth = Math.max(maxWidth, Math.sqrt(dl * dl + dn * dn));
          }
        }

        // Dominant aspect
        let sinSum = 0, cosSum = 0;
        for (const p of cluster) {
          sinSum += Math.sin(p.aspect * DEG2RAD);
          cosSum += Math.cos(p.aspect * DEG2RAD);
        }
        const dominantAspect = (Math.atan2(sinSum / cluster.length, cosSum / cluster.length) * RAD2DEG + 360) % 360;
        const northPct = cluster.filter(p => p.isNorth).length / cluster.length;

        clusters.push({
          id: 'zone-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          points: cluster,
          centroidLat: avgLat,
          centroidLng: avgLng,
          maxVert,
          avgVert: Math.round(avgVert),
          maxElev,
          minElev,
          width: Math.round(maxWidth),
          aspect: dominantAspect,
          aspectDir: aspectDir(dominantAspect),
          northPct,
          pointCount: cluster.length,
          name: '',
          nameOverride: null,
          forestStatus: 'unknown',
          roadDistance: null,
          score: 0,
          checked: false,
        });
      }
    }

    return clusters;
  }

  function scoreZone(zone) {
    // Vertical: more sustained vert = better (35 pts max)
    const vertScore = Math.min(35, Math.max(0, (zone.maxVert - 150) / 300 * 35));
    // Width: wider zones = more skiable area (25 pts max)
    const widthScore = Math.min(25, Math.max(0, (zone.width - 200) / 800 * 25));
    // NO north-facing bias — all aspects valid in Hokkaido
    // Point density (proxy for consistent steep terrain)
    const densityScore = Math.min(20, zone.pointCount / 3);
    // Road proximity
    let roadScore = 0;
    if (zone.roadDistance !== null) {
      if (zone.roadDistance < 500) roadScore = 10;
      else if (zone.roadDistance < 1000) roadScore = 7;
      else if (zone.roadDistance < 2000) roadScore = 4;
      else if (zone.roadDistance < 5000) roadScore = 2;
    }
    // Elevation range (higher start = more snow)
    const elevScore = Math.min(10, Math.max(0, (zone.maxElev - 600) / 400 * 10));

    return Math.min(100, Math.round(vertScore + widthScore + densityScore + roadScore + elevScore));
  }

  function generateZoneName(zone, existingNames) {
    if (zone.nameOverride) return zone.nameOverride;

    let nearest = LANDMARKS[0], nearestDist = Infinity;
    for (const lm of LANDMARKS) {
      const d = Math.sqrt((zone.centroidLat - lm.lat) ** 2 + (zone.centroidLng - lm.lng) ** 2);
      if (d < nearestDist) { nearest = lm; nearestDist = d; }
    }

    const dlat = zone.centroidLat - nearest.lat;
    const dlng = zone.centroidLng - nearest.lng;
    const bearing = (Math.atan2(dlng, dlat) * RAD2DEG + 360) % 360;
    const dirNames = ['North', 'NE', 'East', 'SE', 'South', 'SW', 'West', 'NW'];
    const dir = dirNames[Math.round(bearing / 45) % 8];

    let baseName = `${nearest.name} ${dir} Zone`;
    let count = 1, name = baseName;
    while (existingNames && existingNames.has(name)) { count++; name = `${baseName} ${count}`; }
    return name;
  }

  // ===== PUBLIC API =====
  // ===== SLOPE TILE COMPUTATION (for heatmap overlay) =====
  // Computes slope angle (degrees) for every pixel in a 256x256 DEM tile.
  // Needs the tile itself + its 8 neighbors for edge pixels.
  // Returns { slopes: Float32Array(65536) } where NaN = no data.
  async function computeSlopeTile(zoom, tileX, tileY) {
    // Fetch center tile + 4 cardinal neighbors (edges need adjacent tile data)
    await Promise.all([
      fetchAndParseTile(zoom, tileX, tileY),
      fetchAndParseTile(zoom, tileX - 1, tileY),
      fetchAndParseTile(zoom, tileX + 1, tileY),
      fetchAndParseTile(zoom, tileX, tileY - 1),
      fetchAndParseTile(zoom, tileX, tileY + 1),
    ]);

    const center = parsedCache[`${zoom}/${tileX}/${tileY}`];
    if (!center) return null;

    const left   = parsedCache[`${zoom}/${tileX - 1}/${tileY}`];
    const right  = parsedCache[`${zoom}/${tileX + 1}/${tileY}`];
    const top    = parsedCache[`${zoom}/${tileX}/${tileY - 1}`];
    const bottom = parsedCache[`${zoom}/${tileX}/${tileY + 1}`];

    // Compute the lat at the center of this tile for meter conversion
    const n = Math.pow(2, zoom);
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 0.5) / n)));
    const tileLat = latRad * RAD2DEG;

    // Each pixel spans this many meters (approximate)
    const tileLatSpan = 360 / n; // degrees of latitude per tile... no
    // Actually: tile covers a range of lat. At zoom 14, each tile is ~256 pixels
    // and covers about 0.022° of latitude. So each pixel is about 0.022/256 degrees.
    const latTop = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * RAD2DEG;
    const latBot = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 1) / n))) * RAD2DEG;
    const lngLeft = tileX / n * 360 - 180;
    const lngRight = (tileX + 1) / n * 360 - 180;

    const pixelLatDeg = (latTop - latBot) / 256;
    const pixelLngDeg = (lngRight - lngLeft) / 256;
    const pixelLatM = pixelLatDeg * METERS_PER_DEG_LAT;
    const pixelLngM = pixelLngDeg * metersPerDegLng(tileLat);

    const slopes = new Float32Array(256 * 256);
    slopes.fill(NaN);

    // Helper: get elevation from any of the 5 tiles
    function getEl(row, col) {
      // row/col can be -1 to 256 (extending into neighbors)
      if (row >= 0 && row < 256 && col >= 0 && col < 256) {
        return center[row * 256 + col];
      }
      if (col < 0 && left) return left[row * 256 + (256 + col)];
      if (col >= 256 && right) return right[row * 256 + (col - 256)];
      if (row < 0 && top) return top[(256 + row) * 256 + col];
      if (row >= 256 && bottom) return bottom[(row - 256) * 256 + col];
      return NaN;
    }

    for (let r = 0; r < 256; r++) {
      for (let c = 0; c < 256; c++) {
        const elC = center[r * 256 + c];
        if (isNaN(elC)) continue;

        const elN = getEl(r - 1, c);
        const elS = getEl(r + 1, c);
        const elE = getEl(r, c + 1);
        const elW = getEl(r, c - 1);

        if (isNaN(elN) || isNaN(elS) || isNaN(elE) || isNaN(elW)) continue;

        const dzdx = (elE - elW) / (2 * pixelLngM);
        const dzdy = (elN - elS) / (2 * pixelLatM);
        slopes[r * 256 + c] = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * RAD2DEG;
      }
    }

    return { slopes, tileX, tileY, zoom };
  }

  // Expose tile coordinate helpers for the GridLayer
  function tileLatLngBounds(zoom, tileX, tileY) {
    const n = Math.pow(2, zoom);
    const latTop = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * RAD2DEG;
    const latBot = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 1) / n))) * RAD2DEG;
    const lngLeft = tileX / n * 360 - 180;
    const lngRight = (tileX + 1) / n * 360 - 180;
    return { latTop, latBot, lngLeft, lngRight };
  }

  return {
    setRegion,
    getRegion,
    getElevation,
    getElevationFast,
    prefetchTiles,
    analyzeFast,
    smoothGradient,
    aspectDir,
    isNorthFacing,
    computeSlopeTile,
    fetchAndParseTile,
    tileLatLngBounds,
    traceRun,
    autoFindRuns,
    findRidgelines,
    fetchRoads,
    computeRoadDistances,
    distanceToNearestRoad,
    fetchProtectedAreas,
    isInProtectedArea,
    generateName,
    scoreRun,
    setMinVert,
    getMinVert,
    latLngToTile,
    traceCatRoute,
    setZoneSensitivity,
    getZoneSensitivity,
    scanZones,
    screenMissionZones,
    clusterZones,
    scoreZone,
    generateZoneName,
    saveRuns,
    loadRuns,
    exportGeoJSON,
    // Expose cache for debugging
    get parsedCache() { return parsedCache; },
    get cachedRoads() { return cachedRoads; },
  };

})();

