"""Render a SYNTHETIC room walkthrough video for the scan:room trial (F58.9.6, F58.9.11).

Not a capture of anywhere real: a made-up 5 x 4 x 2.6 m living room (plank floor, plastered walls,
window, rug, sofa, shelves of books, a table with objects, framed pictures), every texture generated
here from a seed. Filmed by a camera that walks a slow ellipse while turning, so each surface is
seen from several places. Nothing in it comes from a person, a place or third-party media.

  blender -b -P scripts/content/scan-synthetic-room.py -- <frames-dir> [frames=300] [seed=7] [samples=40] [width=1600]
  ffmpeg -framerate 30 -i <frames-dir>/f_%04d.png -c:v libx264 -crf 14 -pix_fmt yuv420p room.mp4

Cycles with the OpenImageDenoise denoiser (so the frames carry no per-frame sampling noise that
structure-from-motion would mistake for texture). Set CYCLES_DEVICE=CUDA/OPTIX/CPU to choose;
CUDA_VISIBLE_DEVICES picks the GPU. Textures carry detail at several scales on purpose:
structure-from-motion needs something to match, and a splat of a flat colour has nothing to learn.
"""
import sys, math, random, os, json, hashlib
from pathlib import Path
import numpy as np
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
frames = int(argv[1]) if len(argv) > 1 else 300
seed = int(argv[2]) if len(argv) > 2 else 7
samples = int(argv[3]) if len(argv) > 3 else 40
width = int(argv[4]) if len(argv) > 4 else 1600
height = width * 9 // 16
rnd = random.Random(seed)
nrng = np.random.default_rng(seed)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.cycles.seed = seed
scene.cycles.denoiser = 'OPENIMAGEDENOISE'
scene.cycles.max_bounces = 4
dev = os.environ.get('CYCLES_DEVICE', 'CUDA')
prefs = bpy.context.preferences.addons['cycles'].preferences
if dev != 'CPU':
    prefs.compute_device_type = dev
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == dev
    scene.cycles.device = 'GPU'
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'Standard'

# ── textures: numpy arrays → Blender images ────────────────────────────────────────────────────

def smooth_noise(n, cells):
    """Value noise: a coarse random grid bilinearly upsampled to n x n, in [0, 1]."""
    g = nrng.random((cells + 1, cells + 1))
    xs = np.linspace(0, cells, n, endpoint=False)
    i = xs.astype(int); f = xs - i
    f = f * f * (3 - 2 * f)
    a = g[i][:, i] * (1 - f)[None, :] + g[i][:, i + 1] * f[None, :]
    b = g[i + 1][:, i] * (1 - f)[None, :] + g[i + 1][:, i + 1] * f[None, :]
    return a * (1 - f)[:, None] + b * f[:, None]

def fractal(n, base=4, octaves=6):
    t = np.zeros((n, n)); amp = 1.0; tot = 0.0
    for o in range(octaves):
        t += amp * smooth_noise(n, base * 2 ** o); tot += amp; amp *= 0.55
    return t / tot

def to_image(name, arr):
    n = arr.shape[0]
    rgba = np.ones((n, n, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(arr, 0, 1)
    img = bpy.data.images.new(name, n, n)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img

def tex_planks(n=2048):
    out_ = np.zeros((n, n, 3))
    planks = 8
    h = n // planks
    grain = fractal(n, 3, 5)
    fine = nrng.random((n, n))
    for p in range(planks):
        tone = np.array([0.50, 0.33, 0.18]) * rnd.uniform(0.75, 1.25)
        sl = slice(p * h, (p + 1) * h)
        yy = np.arange(n)[None, :]
        streak = 0.5 + 0.5 * np.sin(yy * rnd.uniform(0.04, 0.09) + grain[sl] * 14)
        v = 0.65 + 0.25 * streak + 0.2 * (grain[sl] - 0.5) + 0.08 * (fine[sl] - 0.5)
        out_[sl] = tone[None, None, :] * v[..., None]
        out_[p * h:p * h + 3] *= 0.35                       # seam between planks
        for _ in range(3):                                   # end joints
            x = rnd.randrange(n)
            out_[sl, x:x + 3] *= 0.4
        for _ in range(rnd.randrange(0, 3)):                 # knots
            cx, cy, r = rnd.randrange(n), rnd.randrange(p * h + 10, (p + 1) * h - 10), rnd.randrange(8, 22)
            Y, X = np.ogrid[:n, :n]
            m = (X - cx) ** 2 + ((Y - cy) * 1.6) ** 2 < r * r
            ring = 0.6 + 0.4 * np.sin(np.sqrt((X - cx) ** 2 + (Y - cy) ** 2) * 0.7)
            out_[m] *= ring[m][:, None] * 0.7
    return to_image('planks', out_)

def tex_plaster(name, tint, n=1024):
    f = fractal(n, 6, 6)
    fine = nrng.random((n, n)) - 0.5
    v = 0.82 + 0.45 * (f - 0.5) + 0.14 * fine
    arr = np.array(tint)[None, None, :] * v[..., None]
    # a few scuffs and a stain, so there is something to track on a "white" wall
    Y, X = np.ogrid[:n, :n]
    for _ in range(10):
        cx, cy, r = rnd.randrange(n), rnd.randrange(n), rnd.randrange(8, 40)
        m = ((X - cx) ** 2 + (Y - cy) ** 2) < r * r
        arr[m] *= rnd.uniform(0.8, 0.94)
    return to_image(name, arr)

def tex_wallpaper(n=1024):
    Y, X = np.mgrid[:n, :n] / n
    stripes = 0.5 + 0.5 * np.sin(X * 2 * math.pi * 24)
    base = np.array([0.55, 0.70, 0.64])[None, None, :] * (0.75 + 0.25 * stripes)[..., None]
    cell = 1 / 6
    u = (X % cell) / cell - 0.5; v = (Y % cell) / cell - 0.5
    motif = (u * u + v * v < 0.05) | ((np.abs(u) + np.abs(v)) < 0.18) & (np.abs(u) < 0.03)
    base[motif] = [0.93, 0.88, 0.70]
    base *= (0.88 + 0.12 * fractal(n, 6, 5) * 2 + 0.1 * (nrng.random((n, n)) - 0.5))[..., None]
    return to_image('wallpaper', base)

def tex_view(n=512):
    """What is outside the window: sky, clouds and a tree line."""
    Y = np.mgrid[:n, :n][0] / n
    sky = np.array([0.45, 0.68, 0.95])[None, None, :] * (1 - 0.3 * Y)[..., None] + 0.25 * fractal(n, 4, 5)[..., None]
    trees = fractal(n, 14, 5) * 0.6 + 0.5 * (Y - 0.55) > 0.35
    sky[trees] = np.array([0.12, 0.35, 0.14])[None, :] * (0.6 + 0.8 * fractal(n, 30, 3)[trees])[:, None]
    return to_image('view', sky)

def tex_rug(n=1024):
    Y, X = np.mgrid[:n, :n] / n
    a = 0.5 + 0.5 * np.sin(X * 60) * np.sin(Y * 60)
    d = np.maximum(np.abs(X - 0.5), np.abs(Y - 0.5))
    border = (np.sin(d * 70) > 0).astype(float)
    base = np.array([0.55, 0.12, 0.10]) * (0.6 + 0.4 * a)[..., None]
    alt = np.array([0.90, 0.78, 0.45]) * (0.7 + 0.3 * border)[..., None]
    arr = np.where((d > 0.38)[..., None], alt, base)
    diamond = (np.abs(X - 0.5) + np.abs(Y - 0.5)) % 0.12 < 0.03
    arr[diamond & (d < 0.36)] = [0.15, 0.25, 0.45]
    arr *= (0.9 + 0.2 * nrng.random((n, n)))[..., None]
    return to_image('rug', arr)

def tex_fabric(name, rgb, n=512):
    weave = 0.5 + 0.5 * np.sin(np.arange(n)[None, :] * 1.7) * np.sin(np.arange(n)[:, None] * 1.7)
    f = fractal(n, 5, 5)
    v = 0.7 + 0.2 * weave + 0.25 * (f - 0.5)
    return to_image(name, np.array(rgb)[None, None, :] * v[..., None])

def tex_books(n=1024):
    """Rows of book spines: coloured bands with title-like stripes."""
    arr = np.zeros((n, n, 3))
    x = 0
    while x < n:
        w = rnd.randrange(14, 46)
        col = np.array([rnd.random() * 0.8 + 0.1, rnd.random() * 0.8 + 0.1, rnd.random() * 0.8 + 0.1])
        arr[:, x:x + w] = col
        for _ in range(3):
            y = rnd.randrange(30, n - 60); hh = rnd.randrange(4, 22)
            arr[y:y + hh, x + 2:x + w - 2] = np.array([0.95, 0.9, 0.7]) if rnd.random() < 0.6 else col * 0.4
        arr[:, x:x + 1] *= 0.3
        x += w
    arr *= (0.9 + 0.2 * nrng.random((n, n)))[..., None]
    return to_image('books', arr)

def tex_painting(name, n=768):
    """Abstract picture: smooth colour fields with a few hard shapes."""
    c1 = np.array([rnd.random(), rnd.random(), rnd.random()])
    c2 = np.array([rnd.random(), rnd.random(), rnd.random()])
    f = fractal(n, 3, 5)
    arr = c1[None, None, :] * (1 - f[..., None]) + c2[None, None, :] * f[..., None]
    Y, X = np.ogrid[:n, :n]
    for _ in range(9):
        cx, cy, r = rnd.randrange(n), rnd.randrange(n), rnd.randrange(30, 170)
        col = np.array([rnd.random(), rnd.random(), rnd.random()])
        m = ((X - cx) ** 2 + (Y - cy) ** 2 < r * r) if rnd.random() < 0.5 else ((abs(X - cx) < r) & (abs(Y - cy) < r * 0.6))
        arr[m] = col * (0.8 + 0.2 * f[m][:, None])
    return to_image(name, arr)

def tex_speckle(name, rgb, n=512):
    f = fractal(n, 8, 5)
    v = 0.8 + 0.3 * (f - 0.5) + 0.12 * (nrng.random((n, n)) - 0.5)
    return to_image(name, np.array(rgb)[None, None, :] * v[..., None])

# ── scene helpers ──────────────────────────────────────────────────────────────────────────────

def material(name, image, rough=0.7, tile=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = rough
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mapn = nt.nodes.new('ShaderNodeMapping')
    mapn.inputs['Scale'].default_value = (tile, tile, tile)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.interpolation = 'Cubic'
    nt.links.new(coord.outputs['UV'], mapn.inputs['Vector'])
    nt.links.new(mapn.outputs['Vector'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return m

def box(name, loc, size, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    o.data.materials.append(mat)
    # cube UVs cover each face 0..1; fine for tiled textures
    return o

def quad(name, loc, rot, size, mat):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    o.data.materials.append(mat)
    return o

def cyl(name, loc, r, h, mat):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, vertices=24)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat)
    return o

def sphere(name, loc, r, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=24, ring_count=16)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat)
    return o

# ── the room: 5 (x) by 4 (y) by 2.6 (z) metres, floor centred on the origin ─────────────────────
W, D, H = 5.0, 4.0, 2.6
m_planks = material('planks', tex_planks(), 0.45, 1.0)
m_wall_a = material('wallA', tex_plaster('plasterA', (0.92, 0.88, 0.80)), 0.9)
m_wall_b = material('wallB', tex_wallpaper(), 0.9)
m_ceil = material('ceiling', tex_plaster('plasterC', (0.97, 0.97, 0.95)), 0.95)
m_rug = material('rug', tex_rug(), 0.95)
m_sofa = material('sofa', tex_fabric('sofa', (0.20, 0.34, 0.52)), 0.85)
m_cushion = material('cushion', tex_fabric('cushion', (0.85, 0.55, 0.15)), 0.85)
m_books = material('books', tex_books(), 0.6)
m_wood = material('darkwood', tex_speckle('darkwood', (0.30, 0.18, 0.10)), 0.5)
m_white = material('white', tex_speckle('white', (0.95, 0.95, 0.92)), 0.6)
m_green = material('plant', tex_speckle('plant', (0.15, 0.45, 0.18)), 0.7)
m_clay = material('clay', tex_speckle('clay', (0.75, 0.38, 0.25)), 0.8)
m_frame = material('frame', tex_speckle('frame', (0.12, 0.10, 0.09)), 0.4)

quad('floor', (0, 0, 0), (0, 0, 0), (W, D, 1), m_planks)
quad('ceiling', (0, 0, H), (math.pi, 0, 0), (W, D, 1), m_ceil)
quad('wallE', (W / 2, 0, H / 2), (0, -math.pi / 2, 0), (H, D, 1), m_wall_a)
quad('wallW', (-W / 2, 0, H / 2), (0, math.pi / 2, 0), (H, D, 1), m_wall_a)
quad('wallN', (0, D / 2, H / 2), (math.pi / 2, 0, math.pi), (W, H, 1), m_wall_b)
quad('wallS', (0, -D / 2, H / 2), (math.pi / 2, 0, 0), (W, H, 1), m_wall_a)
for sx, sy, sz in ((W, 0.03, 0.12),):                      # baseboards
    box('bb_n', (0, D / 2 - 0.015, 0.06), (sx, sy, sz), m_white)
    box('bb_s', (0, -D / 2 + 0.015, 0.06), (sx, sy, sz), m_white)
box('bb_e', (W / 2 - 0.015, 0, 0.06), (0.03, D, 0.12), m_white)
box('bb_w', (-W / 2 + 0.015, 0, 0.06), (0.03, D, 0.12), m_white)

# window on the north wall (a bright pane with a frame and a sill)
quad('pane', (-0.6, D / 2 - 0.02, 1.5), (math.pi / 2, 0, math.pi), (1.5, 1.2, 1), bpy.data.materials.new('pane'))
pane = bpy.data.objects['pane']
pm = pane.data.materials[0]
pm.use_nodes = True
for n_ in list(pm.node_tree.nodes):
    pm.node_tree.nodes.remove(n_)
em = pm.node_tree.nodes.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 1.1
tv = pm.node_tree.nodes.new('ShaderNodeTexImage'); tv.image = tex_view()
pm.node_tree.links.new(tv.outputs['Color'], em.inputs['Color'])
outn = pm.node_tree.nodes.new('ShaderNodeOutputMaterial')
pm.node_tree.links.new(em.outputs[0], outn.inputs[0])
for nm, loc, sz in (('fw_t', (-0.6, D / 2 - 0.04, 2.12), (1.62, 0.08, 0.06)), ('fw_b', (-0.6, D / 2 - 0.05, 0.88), (1.7, 0.14, 0.05)),
                    ('fw_l', (-1.37, D / 2 - 0.04, 1.5), (0.06, 0.08, 1.2)), ('fw_r', (0.17, D / 2 - 0.04, 1.5), (0.06, 0.08, 1.2)),
                    ('fw_m', (-0.6, D / 2 - 0.04, 1.5), (0.04, 0.08, 1.2))):
    box(nm, loc, sz, m_white)

# a door frame on the east wall
box('door', (W / 2 - 0.03, 1.2, 1.0), (0.05, 0.9, 2.0), m_wood)
box('door_knob', (W / 2 - 0.09, 0.9, 1.0), (0.06, 0.06, 0.06), m_frame)

# rug and a low table with things on it
quad('rug', (0.1, -0.2, 0.004), (0, 0, 0.1), (2.6, 1.9, 1), m_rug)
box('table', (0.1, -0.2, 0.22), (1.0, 0.6, 0.04), m_wood)
for i, (dx, dy) in enumerate(((-0.45, -0.25), (0.45, -0.25), (-0.45, 0.25), (0.45, 0.25))):
    box(f'tleg{i}', (0.1 + dx, -0.2 + dy, 0.1), (0.05, 0.05, 0.2), m_wood)
cyl('vase', (0.35, -0.25, 0.4), 0.07, 0.30, m_clay)
sphere('vase_top', (0.35, -0.25, 0.58), 0.07, m_clay)
box('book_a', (-0.15, -0.15, 0.26), (0.30, 0.22, 0.04), m_books)
box('book_b', (-0.13, -0.14, 0.30), (0.26, 0.2, 0.035), m_frame)
cyl('bowl', (-0.2, -0.38, 0.27), 0.12, 0.05, m_white)
for i in range(4):
    sphere(f'fruit{i}', (-0.2 + rnd.uniform(-0.05, 0.05), -0.38 + rnd.uniform(-0.05, 0.05), 0.32 + 0.02 * i), 0.04, m_cushion if i % 2 else m_green)

# sofa against the south wall, with cushions
box('sofa_base', (0.0, -D / 2 + 0.5, 0.25), (2.1, 0.9, 0.5), m_sofa)
box('sofa_back', (0.0, -D / 2 + 0.12, 0.62), (2.1, 0.22, 0.75), m_sofa)
box('sofa_arm_l', (-1.0, -D / 2 + 0.5, 0.45), (0.2, 0.9, 0.9), m_sofa)
box('sofa_arm_r', (1.0, -D / 2 + 0.5, 0.45), (0.2, 0.9, 0.9), m_sofa)
for i, x in enumerate((-0.55, 0.45)):
    box(f'cush{i}', (x, -D / 2 + 0.42, 0.6), (0.4, 0.14, 0.4), m_cushion, (0.3, 0, rnd.uniform(-0.3, 0.3)))

# bookshelf on the west wall: frame plus rows of books
sh_x = -W / 2 + 0.18
box('shelf_back', (sh_x - 0.1, 0.4, 1.05), (0.03, 1.6, 2.1), m_wood)
box('shelf_l', (sh_x, -0.4, 1.05), (0.34, 0.04, 2.1), m_wood)
box('shelf_r', (sh_x, 1.2, 1.05), (0.34, 0.04, 2.1), m_wood)
for lvl in range(6):
    z = 0.05 + lvl * 0.4
    box(f'board{lvl}', (sh_x, 0.4, z), (0.34, 1.6, 0.03), m_wood)
    if lvl < 5:
        x_ = -0.35
        while x_ < 1.15:
            w = rnd.uniform(0.03, 0.07)
            h = rnd.uniform(0.2, 0.34)
            box(f'bk{lvl}_{x_:.2f}', (sh_x + 0.02, x_ + w / 2, z + 0.015 + h / 2), (0.24, w, h), m_books)
            x_ += w + 0.003
# potted plant in the corner
cyl('pot', (2.0, 1.5, 0.2), 0.2, 0.4, m_clay)
for i in range(9):
    a = i * 0.7
    sphere(f'leaf{i}', (2.0 + 0.18 * math.cos(a), 1.5 + 0.18 * math.sin(a), 0.6 + 0.12 * (i % 4)), 0.13, m_green)

# pictures
for i, (loc, rot, sz) in enumerate((((1.4, D / 2 - 0.03, 1.5), (math.pi / 2, 0, math.pi), (0.9, 0.65, 1)),
                                    ((W / 2 - 0.03, -0.5, 1.5), (0, -math.pi / 2, 0), (0.6, 0.8, 1)),
                                    ((-1.0, -D / 2 + 0.03, 1.6), (math.pi / 2, 0, 0), (1.0, 0.7, 1)),
                                    ((1.3, -D / 2 + 0.03, 1.7), (math.pi / 2, 0, 0), (0.5, 0.5, 1)))):
    quad(f'pic{i}', loc, rot, sz, material(f'pic{i}', tex_painting(f'pic{i}'), 0.5))

# ── light ───────────────────────────────────────────────────────────────────────────────────────
world = bpy.data.worlds.new('w'); scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.75, 0.82, 0.95, 1)
def area(name, loc, size, energy, rot=(0, 0, 0)):
    ld = bpy.data.lights.new(name, 'AREA'); ld.energy = energy; ld.size = size
    lo = bpy.data.objects.new(name, ld); lo.location = loc; lo.rotation_euler = rot
    scene.collection.objects.link(lo)
area('ceil_light', (0, 0, H - 0.05), 2.5, 120)
area('window_light', (-0.6, D / 2 - 0.3, 1.5), 1.4, 90, (math.pi / 2, 0, math.pi))
area('fill', (1.2, -1.0, 2.2), 1.5, 35)

# ── camera path: a slow ellipse with the gaze sweeping around, so every surface gets parallax ───
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 22
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
scene.frame_start, scene.frame_end = 1, frames
for f in range(frames):
    t = f / frames
    a = 2 * math.pi * t
    cam.location = (1.3 * math.cos(a), 0.85 * math.sin(a) - 0.1, 1.45 + 0.08 * math.sin(3 * a))
    yaw = 2 * math.pi * t * 2.0 + 0.3                  # two full turns: every wall seen from several places
    cam.rotation_euler = (math.radians(96 + 6 * math.sin(2 * a)), 0, yaw)
    cam.keyframe_insert('location', frame=f + 1)
    cam.keyframe_insert('rotation_euler', frame=f + 1)

scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = out.rstrip('/') + '/f_'
only = os.environ.get('FRAME_ONLY')
if os.environ.get('ROOM_BENCHMARK') == '1':
    # Known poses isolate splat training from COLMAP pose errors. Every eighth view is
    # held out, spanning both turns; Brush reads this separate test split directly.
    if only or frames < 32:
        raise ValueError('ROOM_BENCHMARK needs the full animation and at least 32 frames')
    Path(out).mkdir(parents=True, exist_ok=True)
    splits = {'train': [], 'test': []}
    for f in range(frames):
        scene.frame_set(f + 1)
        splits['test' if f % 8 == 0 else 'train'].append({
            'file_path': 'f_%04d.png' % (f + 1),
            'transform_matrix': [list(row) for row in cam.matrix_world],
        })
    for split, views in splits.items():
        (Path(out) / ('transforms_%s.json' % split)).write_text(json.dumps({
            'camera_angle_x': cam_data.angle_x, 'w': width, 'h': height, 'frames': views,
        }, indent=2) + '\n')
    (Path(out) / 'benchmark.json').write_text(json.dumps({
        'schema': 1, 'scene': 'reckons-synthetic-room', 'synthetic': True,
        'generatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'blender': bpy.app.version_string, 'seed': seed, 'frames': frames,
        'samples': samples, 'width': width, 'height': height, 'evalEvery': 8,
        'cameraConvention': 'Blender camera-to-world, right-handed, +Y up, -Z forward',
    }, indent=2) + '\n')
if only:                                               # a single still, to look at before committing to a render
    scene.frame_set(int(only))
    scene.render.filepath = out.rstrip('/') + '/still_%04d.png' % int(only)
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
