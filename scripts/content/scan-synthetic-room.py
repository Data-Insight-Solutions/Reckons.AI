"""Render a SYNTHETIC room walkthrough video for the scan:room trial (F58.9.6).

Not a capture of anywhere real: a 5 x 5 x 2.6 m box with random-blob textured walls and a few
textured boxes, filmed by a camera circling inside while turning. Run with Blender:

  blender -b -P scripts/content/scan-synthetic-room.py -- <frames-dir> [frames] [seed]
  ffmpeg -framerate 30 -i <frames-dir>/f_%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p room.mp4

Workbench engine (no GPU needed). Written so structure-from-motion has something to match:
every surface has high-contrast blobs at several scales, and the camera translates as well as turns.
"""
import sys, math, random
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
frames = int(argv[1]) if len(argv) > 1 else 240
seed = int(argv[2]) if len(argv) > 2 else 7
rnd = random.Random(seed)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x, scene.render.resolution_y = 960, 540
scene.display.shading.light = 'FLAT'
scene.display.shading.color_type = 'TEXTURE'
scene.render.film_transparent = False

def blob_image(name, size=512):
    # sum of random coloured discs at several scales, on a coloured base
    img = bpy.data.images.new(name, size, size)
    px = [0.0] * (size * size * 4)
    base = [rnd.random() * 0.5 + 0.25 for _ in range(3)]
    for i in range(size * size):
        px[i*4:i*4+4] = base + [1.0]
    for scale, n in ((90, 25), (35, 150), (12, 500)):
        for _ in range(n):
            cx, cy, r = rnd.randrange(size), rnd.randrange(size), rnd.randrange(scale // 2, scale)
            col = [rnd.random() for _ in range(3)]
            for y in range(max(0, cy - r), min(size, cy + r)):
                for x in range(max(0, cx - r), min(size, cx + r)):
                    if (x - cx) ** 2 + (y - cy) ** 2 < r * r:
                        k = (y * size + x) * 4
                        px[k:k+3] = col
    img.pixels = px
    return img

def material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = blob_image(name)
    bsdf = nt.nodes['Principled BSDF']
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    m.diffuse_color = (1, 1, 1, 1)
    return m

def quad(name, loc, rot, size, mat):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    o.data.materials.append(mat)
    return o

W, H = 5.0, 2.6
quad('floor', (0, 0, 0), (0, 0, 0), (W, W, 1), material('floor'))
quad('ceil', (0, 0, H), (math.pi, 0, 0), (W, W, 1), material('ceil'))
for i, (loc, rot) in enumerate([((W/2, 0, H/2), (0, math.pi/2, 0)), ((-W/2, 0, H/2), (0, -math.pi/2, 0)),
                                ((0, W/2, H/2), (-math.pi/2, 0, 0)), ((0, -W/2, H/2), (math.pi/2, 0, 0))]):
    quad(f'wall{i}', loc, rot, (H, W, 1) if i < 2 else (W, H, 1), material(f'wall{i}'))
for i in range(5):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(rnd.uniform(-1.8, 1.8), rnd.uniform(-1.8, 1.8), 0.4),
                                    rotation=(0, 0, rnd.uniform(0, 3)))
    c = bpy.context.object
    c.scale = (rnd.uniform(0.4, 0.8), rnd.uniform(0.4, 0.8), rnd.uniform(0.5, 1.0))
    c.location.z = c.scale.z / 2
    c.data.materials.append(material(f'box{i}'))

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 24
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
scene.frame_start, scene.frame_end = 1, frames
for f in range(frames):
    t = f / frames
    a = 2 * math.pi * t
    cam.location = (1.0 * math.cos(a), 1.0 * math.sin(a) * 0.8, 1.4 + 0.1 * math.sin(3 * a))
    yaw = 2 * math.pi * t * 1.5 + 0.3          # turn one and a half times, so every wall is seen from two places
    cam.rotation_euler = (math.radians(86 + 4 * math.sin(2 * a)), 0, yaw)
    cam.keyframe_insert('location', frame=f + 1)
    cam.keyframe_insert('rotation_euler', frame=f + 1)

scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = out.rstrip('/') + '/f_'
bpy.ops.render.render(animation=True)
