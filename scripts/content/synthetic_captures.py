"""Blender side of F58.9.19.6 (kb:fusion-synthetic-captures). Run by synthetic-captures.ts:

  blender --background --factory-startup --python synthetic_captures.py -- <spec.json>

Builds ONE textured object on a textured checkerboard board, renders one capture (a folder of frames) along the camera
path given in the spec, and writes the TRUE pose of every frame, read back from Blender's own camera matrix, to
<outDir>/poses.json. Conventions written: R = world-to-camera rotation in the COLMAP/OpenCV frame (x right, y down,
z forward), centre = camera centre in world coordinates, fPx = focal length in pixels.
"""
import bpy, json, sys, math, random, os
from mathutils import Vector, Matrix

spec = json.load(open(sys.argv[sys.argv.index('--') + 1]))
W, H = spec['width'], spec['height']

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = spec['samples']
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality = 92
scene.view_settings.view_transform = 'Standard'

def textured_material(name, seed, scale, hue):
    """Rich colour texture: noise-warped Voronoi cells over fine noise. COLMAP needs texture to register."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type != 'OUTPUT_MATERIAL' and n.type != 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.85
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mapping = nt.nodes.new('ShaderNodeMapping')
    mapping.inputs['Location'].default_value = (seed * 3.1, seed * 1.7, seed * 2.3)
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    nt.links.new(coord.outputs['Object'], mapping.inputs['Vector'])
    vor = nt.nodes.new('ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = 3.0
    nt.links.new(mapping.outputs['Vector'], vor.inputs['Vector'])
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 14.0
    noise.inputs['Detail'].default_value = 12.0
    noise.inputs['Roughness'].default_value = 0.7
    nt.links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'LINEAR'
    ramp.color_ramp.elements[0].color = (0.05 + hue[0] * .1, 0.04 + hue[1] * .1, 0.06 + hue[2] * .1, 1)
    ramp.color_ramp.elements[1].color = (0.2 + hue[0], 0.2 + hue[1], 0.2 + hue[2], 1)
    e = ramp.color_ramp.elements.new(0.5); e.color = (hue[2], hue[0], 0.3, 1)
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
    nt.links.new(vor.outputs['Color'], mix.inputs['Color1'])
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], mix.inputs['Color2'])
    nt.links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    return m

def board_material():
    """Checkerboard (Matt films on one) carrying coarse and fine noise so squares are not interchangeable (a first run with 8x8 repeating squares and little noise registered badly)."""
    m = bpy.data.materials.new('board')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.9
    coord = nt.nodes.new('ShaderNodeTexCoord')
    chk = nt.nodes.new('ShaderNodeTexChecker')
    chk.inputs['Scale'].default_value = 3.0
    chk.inputs['Color1'].default_value = (0.85, 0.85, 0.8, 1)
    chk.inputs['Color2'].default_value = (0.12, 0.12, 0.14, 1)
    nt.links.new(coord.outputs['Object'], chk.inputs['Vector'])
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 9.0
    noise.inputs['Detail'].default_value = 12.0
    nt.links.new(coord.outputs['Object'], noise.inputs['Vector'])
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'OVERLAY'; mix.inputs['Fac'].default_value = 0.85
    nt.links.new(chk.outputs['Color'], mix.inputs['Color1'])
    nt.links.new(noise.outputs['Color'], mix.inputs['Color2'])
    nt.links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    return m

# ── the object: identical in every capture (built from the run seed, never the capture)
obj_seed = spec['objectSeed']
rnd = random.Random(obj_seed)
mat = textured_material('obj', obj_seed % 97 / 10.0, 1.4, (rnd.random(), rnd.random(), rnd.random()))
parts = []
if spec.get('mesh'):
    p = spec['mesh']; ext = os.path.splitext(p)[1].lower()
    if ext in ('.glb', '.gltf'): bpy.ops.import_scene.gltf(filepath=p)
    elif ext == '.obj': bpy.ops.wm.obj_import(filepath=p)
    elif ext == '.stl': bpy.ops.wm.stl_import(filepath=p)
    elif ext == '.ply': bpy.ops.wm.ply_import(filepath=p)
    else: raise SystemExit('unsupported mesh ' + p)
    parts = [o for o in bpy.context.selected_objects if o.type == 'MESH']
else:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5)); a = bpy.context.object; a.scale = (1.1, 0.8, 1.0); a.rotation_euler[2] = rnd.uniform(0, 1)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.55, location=(0.1, 0.0, 1.35), segments=48, ring_count=24); b = bpy.context.object
    bpy.ops.mesh.primitive_cone_add(radius1=0.45, depth=0.9, location=(0.85, 0.35, 0.45)); c = bpy.context.object
    bpy.ops.mesh.primitive_torus_add(major_radius=0.5, minor_radius=0.16, location=(-0.85, -0.3, 0.2)); d = bpy.context.object
    parts = [a, b, c, d]
for o in parts:
    o.data.materials.clear(); o.data.materials.append(mat)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth() if o.type == 'MESH' else None
# bounding box of the whole object, for centring and for the "share of the object's size" error measure
pts = [o.matrix_world @ Vector(v) for o in parts for v in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
size = (hi - lo).length
target = (lo + hi) / 2
# board under the object
bpy.ops.mesh.primitive_plane_add(size=10.0, location=(target.x, target.y, lo.z - 0.002))
board = bpy.context.object
board.data.materials.append(board_material())

# ── light (per capture)
L = spec['light']
bpy.ops.object.light_add(type='SUN', location=(0, 0, 5))
sun = bpy.context.object
sun.rotation_euler = (math.radians(L['elevationDeg'] * -1 + 90), 0, math.radians(L['azimuthDeg']))
sun.data.energy = L['sun']; sun.data.color = tuple(L['color']); sun.data.angle = math.radians(5)
world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.55, 0.65, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = L['ambient']

# ── camera path
cam_data = bpy.data.cameras.new('cam'); cam_data.lens = spec['focalMm']; cam_data.sensor_width = 36.0; cam_data.sensor_fit = 'HORIZONTAL'
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam); scene.camera = cam
fpx = spec['focalMm'] * W / 36.0
flip = Matrix(((1, 0, 0), (0, -1, 0), (0, 0, -1)))
os.makedirs(spec['outDir'], exist_ok=True)
poses = []
for i, f in enumerate(spec['frames']):
    cam.location = target + Vector(f['position'])  # path positions and look-at points are relative to the object's centre
    look = target + Vector(f['lookAt'])
    direction = look - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    name = 'frame_%04d.jpg' % (i + 1)
    scene.render.filepath = os.path.join(spec['outDir'], name)
    bpy.ops.render.render(write_still=True)
    M = cam.matrix_world
    R_w2c = flip @ M.to_3x3().transposed()
    poses.append({'file': name, 'R': [list(r) for r in R_w2c], 'centre': list(M.translation)})
json.dump({'name': spec['name'], 'width': W, 'height': H, 'focalMm': spec['focalMm'], 'fPx': fpx, 'objectSize': size,
           'objectCentre': list(target), 'frames': poses}, open(os.path.join(spec['outDir'], 'poses.json'), 'w'), indent=1)
