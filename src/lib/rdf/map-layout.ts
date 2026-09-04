/**
 * WHICH NODES GO ON THE MAP, AND WHERE — one rule, to be shared by the 2D and 3D renderers.
 *
 * Matt, 2026-09-04: "We need to plan a map layout, gps coordinates places nodes."
 *
 * This is the deterministic half of that feature: coordinates in, layout positions out, no
 * rendering and no network. It is written first and on its own because the hard parts of a map
 * layout are not the drawing — they are deciding what a coordinate IS, what to do with the 93% of
 * nodes that have none, and refusing to invent a position for them.
 *
 * THE PRECEDENT THIS FOLLOWS IS THE TIMELINE, AND IT WAS LEARNED THE EXPENSIVE WAY. Both renderers
 * used to fall back to a statement's INGESTION time for any undated node and place it as though
 * that were an event — 165 of 177 nodes in starter-everyday stacked at import time, with the real
 * dates crushed into a sliver. The fix (timeline-layout.ts) was a labelled UNDATED LANE: a node
 * without a date is not placed on the axis at all.
 *
 * A map has the identical trap and a worse failure mode. A node with no coordinates defaulted to
 * (0, 0) lands at NULL ISLAND — a real point in the Gulf of Guinea — and reads as a location the
 * graph is asserting. So: `unplaced` is a first-class result here, never a position.
 *
 * DIRECT VS INHERITED PLACEMENT IS ALSO NOT COSMETIC. An Event linked to a Place by
 * kpred:location can reasonably be drawn at that Place, and that is most of what makes a map
 * useful — but it is an INFERENCE, and the renderer must be able to draw it differently from a
 * coordinate the source actually stated. `origin` carries which one it was, so a hollow marker for
 * inherited and a solid one for stated stays available rather than needing a second pass.
 *
 * WEB MERCATOR, chosen for one reason: it is what map tiles use, so if a basemap is ever added the
 * node positions already agree with it. Its area distortion near the poles is irrelevant at the
 * extents a personal graph covers, and `fitToExtent` normalizes to the data's own bounding box
 * anyway. Latitude is clamped to ±85.05112878 because the projection is undefined at the poles.
 */
import type { Statement } from './types';
import { isLit, isIRI } from './types';

const KPRED = 'urn:kbase:predicate/';

/** Predicates whose literal value may carry a coordinate pair. */
const COORDINATE_PREDICATES = [`${KPRED}coordinates`, `${KPRED}geo`, `${KPRED}latlong`, `${KPRED}lat-long`];
/** Predicates carrying one half of a pair, for graphs that split them. */
const LAT_PREDICATES = [`${KPRED}latitude`, `${KPRED}lat`];
const LON_PREDICATES = [`${KPRED}longitude`, `${KPRED}lon`, `${KPRED}lng`, `${KPRED}long`];
/**
 * Predicates that link a thing to a place it is at — the inheritance edge.
 *
 * `nests-at` and `habitat` are here because of what the turtle starter graph showed: with only the
 * generic location words, 6 of 39 nodes placed (15%) and the map was six dots with every species
 * missing. The relation a domain actually uses is rarely called "location" — it is `nests-at`,
 * `filmed-in`, `headquartered-in`. This list will always be incomplete, which is an argument for
 * making it configurable later, not for guessing at arbitrary predicates now.
 */
const LOCATION_PREDICATES = [
  `${KPRED}location`,
  `${KPRED}located-in`,
  `${KPRED}place`,
  `${KPRED}venue`,
  `${KPRED}address-of`,
  `${KPRED}nests-at`,
  `${KPRED}habitat`,
  `${KPRED}found-at`,
  `${KPRED}headquartered-in`,
  `${KPRED}based-in`,
];

/** Web Mercator is undefined at the poles; this is the standard cutoff. */
export const MERCATOR_MAX_LAT = 85.05112878;

export interface LatLon {
  lat: number;
  lon: number;
}

export type PlacementOrigin = 'stated' | 'inherited';

export interface PlacedNode extends LatLon {
  /** Entity IRI. */
  iri: string;
  origin: PlacementOrigin;
  /** For an inherited placement, the Place it was taken from. Absent when stated. */
  via?: string;
}

/**
 * Parse a coordinate literal.
 *
 * Accepts the format the shipped graphs actually use — `"37.7716, -119.0715"` in
 * static/knowledge.ttl and starter-everyday.ttl — plus the common variants people paste from
 * mapping tools: whitespace or semicolon separated, a leading `geo:` scheme, and parentheses.
 *
 * It does NOT accept degrees-minutes-seconds. That is a real format and deliberately unhandled:
 * guessing at `40°26'46"N` risks silently transposing a sign or a hemisphere, and a wrong
 * coordinate is worse than a missing one because it looks like knowledge.
 */
export function parseLatLon(value: string): LatLon | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .replace(/^geo:/i, '')
    .replace(/[()[\]]/g, '')
    .trim();
  // A DMS string contains a degree sign or a hemisphere letter — refuse rather than half-parse it.
  if (/[°'"]|[NSEW]\s*$|^\s*[NSEW]/i.test(cleaned)) return null;

  const parts = cleaned.split(/[,;\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;

  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Out-of-range values are a parse failure, not something to clamp: a "latitude" of 200 means the
  // string was not a coordinate, and clamping it to 85 would place a node somewhere plausible.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Coordinates stated directly on each entity. */
export function statedCoordinates(statements: readonly Statement[]): Map<string, LatLon> {
  const out = new Map<string, LatLon>();
  const halves = new Map<string, { lat?: number; lon?: number }>();

  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (!isLit(st.o)) continue;
    const p = st.p.value;
    const subject = st.s.value;

    if (COORDINATE_PREDICATES.includes(p)) {
      const parsed = parseLatLon(st.o.value);
      if (parsed) out.set(subject, parsed);
      continue;
    }
    if (LAT_PREDICATES.includes(p) || LON_PREDICATES.includes(p)) {
      const n = Number(String(st.o.value).trim());
      if (!Number.isFinite(n)) continue;
      const entry = halves.get(subject) ?? {};
      if (LAT_PREDICATES.includes(p)) entry.lat = n;
      else entry.lon = n;
      halves.set(subject, entry);
    }
  }

  for (const [subject, { lat, lon }] of halves) {
    // Both halves or neither. A node with only a latitude is on a line, not at a point, and
    // choosing a longitude for it would be inventing the half that is missing.
    if (lat === undefined || lon === undefined) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (!out.has(subject)) out.set(subject, { lat, lon });
  }

  return out;
}

/**
 * Place every entity that can be placed — stated coordinates first, then one hop through a
 * location edge to a Place that has them.
 *
 * ONE HOP, NOT TRANSITIVE. A chain (event -> venue -> city -> country) would place the event at
 * the centroid of a country, which is a point nobody chose and no source stated. One hop keeps the
 * inference to something a reader can verify by following a single edge.
 */
export function placeNodes(statements: readonly Statement[]): Map<string, PlacedNode> {
  const stated = statedCoordinates(statements);
  const placed = new Map<string, PlacedNode>();

  for (const [iri, ll] of stated) placed.set(iri, { iri, ...ll, origin: 'stated' });

  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (!LOCATION_PREDICATES.includes(st.p.value)) continue;
    if (!isIRI(st.o)) continue;
    const subject = st.s.value;
    if (placed.has(subject)) continue; // a stated coordinate always wins over an inferred one
    const target = stated.get(st.o.value);
    if (!target) continue;
    placed.set(subject, { iri: subject, ...target, origin: 'inherited', via: st.o.value });
  }

  return placed;
}

export interface MapExtent {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Bounding box of what was placed. Null when nothing was — there is no map to draw. */
export function mapExtent(placed: ReadonlyMap<string, PlacedNode>): MapExtent | null {
  if (placed.size === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const n of placed.values()) {
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Web Mercator y, normalized to the same units as longitude so aspect ratio is preserved. */
export function mercatorY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180) / Math.PI;
}

export interface MapAnchor {
  x: number;
  y: number;
  origin: PlacementOrigin;
}

export interface MapLayout {
  /** Entities with a position, in world units centred on 0. */
  anchors: Map<string, MapAnchor>;
  /** Entities the graph holds no location for. They are NOT given a position. */
  unplaced: string[];
  extent: MapExtent | null;
  /** How many anchors came from an inference rather than a stated coordinate. */
  inheritedCount: number;
}

export interface MapLayoutOptions {
  /** Half-width of the layout area in world units. */
  spread?: number;
  /** Every entity in the view, so the unplaced list is complete rather than only what was seen. */
  allEntities?: readonly string[];
}

/**
 * Project placed nodes into layout space, fitted to their own extent.
 *
 * A SINGLE POINT, OR A ROW OF POINTS, IS NOT A DEGENERATE CASE TO DIVIDE BY. One node, or several
 * sharing a latitude, gives a zero-height extent; scaling by it yields Infinity and every node
 * lands at NaN, which in a force simulation is unrecoverable. Zero spans collapse to the centre.
 */
export function buildMapLayout(
  statements: readonly Statement[],
  opts: MapLayoutOptions = {},
): MapLayout {
  const spread = opts.spread ?? 20;
  const placed = placeNodes(statements);
  const extent = mapExtent(placed);

  const anchors = new Map<string, MapAnchor>();
  if (extent) {
    const yMin = mercatorY(extent.minLat);
    const yMax = mercatorY(extent.maxLat);
    const lonSpan = extent.maxLon - extent.minLon;
    const ySpan = yMax - yMin;
    // One scale for both axes, so the map keeps its shape instead of being stretched to fill.
    const span = Math.max(lonSpan, ySpan);
    const scale = span > 0 ? (spread * 2) / span : 0;
    const lonMid = (extent.minLon + extent.maxLon) / 2;
    const yMid = (yMin + yMax) / 2;

    for (const n of placed.values()) {
      anchors.set(n.iri, {
        x: (n.lon - lonMid) * scale,
        y: (mercatorY(n.lat) - yMid) * scale,
        origin: n.origin,
      });
    }
  }

  const universe = opts.allEntities ?? entityUniverse(statements);
  const unplaced = universe.filter((iri) => !anchors.has(iri));

  let inheritedCount = 0;
  for (const a of anchors.values()) if (a.origin === 'inherited') inheritedCount++;

  return { anchors, unplaced, extent, inheritedCount };
}

/** Every non-literal entity mentioned as a subject or object. */
function entityUniverse(statements: readonly Statement[]): string[] {
  const seen = new Set<string>();
  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (isIRI(st.s)) seen.add(st.s.value);
    if (isIRI(st.o)) seen.add(st.o.value);
  }
  return [...seen];
}

/**
 * What to tell the user before they switch to this layout.
 *
 * A map that silently shows 6 of 177 nodes reads as an empty or broken map. Saying so up front is
 * the same honesty the timeline's undated lane provides visually — and it is the difference
 * between "this graph has little location data" and "this feature does not work".
 */
export function mapCoverageSummary(layout: MapLayout): string {
  const placedCount = layout.anchors.size;
  const total = placedCount + layout.unplaced.length;
  if (total === 0) return 'nothing to place';
  if (placedCount === 0) return `no location data — 0 of ${total} nodes can be mapped`;
  const pct = Math.round((placedCount / total) * 100);
  const inherited = layout.inheritedCount > 0 ? `, ${layout.inheritedCount} via a linked place` : '';
  return `${placedCount} of ${total} nodes placed (${pct}%)${inherited}`;
}
