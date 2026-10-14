"""COLMAP pose recovery for scan-room.ts (F58.9.6), via pycolmap in the gen venv.

  python scan_colmap.py <workdir>   expects <workdir>/images/*.jpg; writes <workdir>/sparse/0 and prints one JSON line

Video frames are consecutive, so matching is SEQUENTIAL with loop detection off (no vocabulary-tree
download). One shared camera: a phone video has one lens.
"""
import json, sys, time
from pathlib import Path
import os
import pycolmap

work = Path(sys.argv[1])
images = work / 'images'
db = work / 'database.db'
sparse = work / 'sparse'
if db.exists():
    db.unlink()
sparse.mkdir(exist_ok=True)

t0 = time.time()
reader = pycolmap.ImageReaderOptions()
reader.camera_model = 'SIMPLE_RADIAL'
# BOUNDED MEMORY. COLMAP's defaults (3200 px, one SIFT extractor per core) took 16.7 GB RSS on 300 iPhone
# frames at 1920x1440 with 24 cores and the kernel OOM-killed it, taking the editor with it (2026-10-14).
# Frames are already scaled to <= 1600 px by scan-room.ts; this caps both again in case they are not.
extraction = pycolmap.FeatureExtractionOptions()
extraction.max_image_size = 1600
extraction.num_threads = int(os.environ.get('RECKONS_SCAN_THREADS', min(8, os.cpu_count() or 1)))
pycolmap.extract_features(str(db), str(images), camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader,
                          extraction_options=extraction)
t1 = time.time()
match = pycolmap.SequentialPairingOptions()
match.overlap = 10
match.loop_detection = False
pycolmap.match_sequential(str(db), pairing_options=match)
t2 = time.time()
maps = pycolmap.incremental_mapping(str(db), str(images), str(sparse))
t3 = time.time()
best = None
for i, rec in maps.items():
    if best is None or rec.num_reg_images() > best[1].num_reg_images():
        best = (i, rec)
if best is None:
    print(json.dumps({'registered': 0, 'models': 0, 'points': 0, 'version': pycolmap.__version__}))
    sys.exit(0)
idx, rec = best
if idx != 0:  # brush reads sparse/0
    (sparse / '0').mkdir(exist_ok=True)
    rec.write(str(sparse / '0'))
print(json.dumps({
    'registered': rec.num_reg_images(), 'models': len(maps), 'points': rec.num_points3D(),
    'version': pycolmap.__version__, 'featuresS': round(t1 - t0, 1), 'matchingS': round(t2 - t1, 1), 'mappingS': round(t3 - t2, 1),
}))
