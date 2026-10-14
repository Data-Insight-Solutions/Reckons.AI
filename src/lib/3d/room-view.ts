/**
 * Where the 3D graph's camera and room are right now, for "Place in room" (F58.9.9).
 *
 * KnowledgeGraph writes this each frame; a button in the asset viewer reads it once when pressed.
 * It is a plain mutable object, not a store: nothing reacts to it, and writing a few numbers a
 * frame must not wake anything. `live` is false until a 3D graph has drawn a frame.
 */
import type { Vec3 } from './splat';

export const roomView: { camera: Vec3; target: Vec3; centre: Vec3; scale: number; yaw: number; surround: boolean; live: boolean } = {
  camera: [0, 0, 10], target: [0, 0, 0], centre: [0, 0, 0], scale: 1, yaw: 0, surround: false, live: false,
};
