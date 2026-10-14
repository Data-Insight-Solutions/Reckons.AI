/**
 * Writes for a space's room: importing a scan (F58.9.7) and the space's background settings
 * (F58.9.8). The reading side is pure and lives in $lib/3d/splat.
 */
import { v4 as uuid } from 'uuid';
import { statements, addStatements, setStatus } from './kb.svelte';
import { importSplatFile, type ImportedSplat } from '$lib/storage/splat-files';
import {
  scanStatements, scanEntityIri, SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, type SplatOrigin,
  backgroundSplatFrom, backgroundSettingsFrom, BG_EXTENT_PREDICATE, placementsFrom, defaultPlacement, adjustPlacement, formatPlacementAt,
  PLACED_AT_PREDICATE, PLACED_SCALE_PREDICATE, PLACED_YAW_PREDICATE, DEFAULT_PLACED_SCALE, type Placement, type PlacementOp,
} from '$lib/3d/splat';
import { roomView } from '$lib/3d/room-view';

/** Replace-one setting on a subject: reject any live value, then write the new one (empty clears). */
export async function setMeta(subject: string, predicate: string, value: string): Promise<void> {
  for (const st of statements()) {
    if (st.s.kind === 'iri' && st.s.value === subject && st.p.value === predicate && st.o.kind === 'literal'
      && st.status !== 'rejected' && st.status !== 'superseded') await setStatus(st.id, 'rejected');
  }
  const v = value.trim();
  if (!v) return;
  const now = Date.now();
  await addStatements([{
    id: uuid(), s: { kind: 'iri', value: subject }, p: { kind: 'iri', value: predicate }, o: { kind: 'literal', value: v },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: now, updatedAt: now,
  }]);
}

/** Check, store and add a chosen file as the space's background. A refused file changes nothing. */
export async function importScan(file: File, origin: SplatOrigin): Promise<ImportedSplat & { entity?: string }> {
  const res = await importSplatFile(file);
  if (!res.ok) return res;
  const entity = scanEntityIri(res.url);
  const label = file.name.replace(/\.(ply|spz|sog)$/i, '');
  const known = statements().some((s) => s.s.kind === 'iri' && s.s.value === entity && s.status !== 'rejected');
  if (!known) await addStatements(scanStatements(res.url, label, origin, uuid));
  await setMeta(SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, res.url);
  // Record the measured size so a surround room can be fitted to the graph (COLMAP scale is arbitrary).
  const extent = Number(res.check.measured.extent);
  await setMeta(SPACE_SUBJECT, BG_EXTENT_PREDICATE, Number.isFinite(extent) && extent > 0 ? String(extent) : '');
  return { ...res, entity };
}

// ── Placement (F58.9.9) ──────────────────────────────────────────────────────

async function writePlacement(iri: string, p: Placement, was?: Placement) {
  await setMeta(iri, PLACED_AT_PREDICATE, formatPlacementAt(p.at));
  if (!was || was.scale !== p.scale) await setMeta(iri, PLACED_SCALE_PREDICATE, String(p.scale));
  if (!was || was.yaw !== p.yaw) await setMeta(iri, PLACED_YAW_PREDICATE, String(p.yaw));
}

/**
 * Put a node's splat in the room: on the floor, half way from the camera toward the graph. Says why
 * when it cannot, instead of silently doing nothing.
 */
export async function placeInRoom(iri: string): Promise<{ ok: boolean; message: string }> {
  const sts = statements();
  const bg = backgroundSettingsFrom(sts);
  if (!backgroundSplatFrom(sts)) return { ok: false, message: 'This space has no room yet. Import a scan first (Graphs tab, space background).' };
  if (bg.mode !== 'surround') return { ok: false, message: 'Switch the background to "surround" to place things in the room (Graphs tab, space background).' };
  if (!roomView.live) return { ok: false, message: 'Open the 3D graph first, so the room has a camera to place things in front of.' };
  const p = defaultPlacement(
    { camera: roomView.camera, target: roomView.target, floor: bg.floor },
    { centre: roomView.centre, scale: bg.scale, yaw: bg.yaw },
    1 / bg.scale, // one world unit of radius, whatever the scan's own scale
  );
  await writePlacement(iri, p);
  return { ok: true, message: bg.floor === null ? "Placed at the room's mid height: run Level the floor to stand it on the floor." : 'Placed on the floor.' };
}

/** One step: move, raise, turn or scale a placed node. No-op for a node that is not placed. */
export async function adjustInRoom(iri: string, op: PlacementOp): Promise<void> {
  const was = placementsFrom(statements()).get(iri);
  if (!was) return;
  await writePlacement(iri, adjustPlacement(was, op), was);
}

/** Return a node to the force layout. */
export async function unplace(iri: string): Promise<void> {
  for (const p of [PLACED_AT_PREDICATE, PLACED_SCALE_PREDICATE, PLACED_YAW_PREDICATE]) await setMeta(iri, p, '');
}
