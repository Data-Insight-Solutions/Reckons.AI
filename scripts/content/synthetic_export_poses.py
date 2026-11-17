"""Print the registered cameras of a COLMAP model as JSON, for synthetic-captures.ts (F58.9.19.6).

  python synthetic_export_poses.py <sparse/0 dir>
Each camera: name, R (world-to-camera 3x3, COLMAP/OpenCV convention) and centre (camera centre in COLMAP's world).
"""
import json, sys
import pycolmap

rec = pycolmap.Reconstruction(sys.argv[1])
out = []
for im in rec.images.values():
    if not im.has_pose:
        continue
    cfw = im.cam_from_world() if callable(im.cam_from_world) else im.cam_from_world
    out.append({'name': im.name, 'R': cfw.rotation.matrix().tolist(), 'centre': [float(x) for x in im.projection_center()]})
print(json.dumps({'cameras': out}))
