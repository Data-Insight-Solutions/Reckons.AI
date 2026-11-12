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
# MULTI-SCAN (F58.9.19): <workdir>/captures.json = {"matcher": "exhaustive"|"sequential-loop", "vocabTree": path|null}.
# Frames are named <capture>__<n>.jpg; each capture gets its OWN camera (different videos can differ in zoom and focus),
# and matching runs across captures so every capture lands in one coordinate frame.
multi_file = work / 'captures.json'
multi = json.loads(multi_file.read_text()) if multi_file.exists() else None
if multi is None:
    pycolmap.extract_features(str(db), str(images), camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader,
                              extraction_options=extraction)
else:
    groups = {}
    for f in sorted(p.name for p in images.iterdir() if p.suffix.lower() in ('.jpg', '.jpeg', '.png')):
        groups.setdefault(f.split('__')[0], []).append(f)
    for name, files in groups.items():
        pycolmap.extract_features(str(db), str(images), image_names=files, camera_mode=pycolmap.CameraMode.SINGLE,
                                  reader_options=reader, extraction_options=extraction)
t1 = time.time()
if multi is not None and multi['matcher'] == 'exhaustive':
    pycolmap.match_exhaustive(str(db))
else:
    match = pycolmap.SequentialPairingOptions()
    match.overlap = 10
    match.loop_detection = multi is not None
    if multi is not None:
        match.loop_detection_num_images = 50
        match.vocab_tree_path = multi['vocabTree']
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
if multi is not None:
    # Every sub-model's registered image names, so the caller can see which capture did not join; the largest is written for training.
    (work / 'models.json').write_text(json.dumps({'models': [sorted(im.name for im in r.images.values() if im.has_pose) for r in maps.values()]}))
if idx != 0:  # brush reads sparse/0
    (sparse / '0').mkdir(exist_ok=True)
    rec.write(str(sparse / '0'))
print(json.dumps({
    'registered': rec.num_reg_images(), 'models': len(maps), 'points': rec.num_points3D(),
    'version': pycolmap.__version__, 'featuresS': round(t1 - t0, 1), 'matchingS': round(t2 - t1, 1), 'mappingS': round(t3 - t2, 1),
}))
