# Renders the app icon with Cycles. Run headless:
#   blender -b -P scripts/icon/render.py -- <out_dir> [samples]
# Writes icon-full.png (full-bleed square, for maskable and apple-touch icons) and icon-tile.png
# (rounded tile on transparency, for "any" icons and favicons), both 1024px.
import math
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = argv[0] if argv else "."
SAMPLES = int(argv[1]) if len(argv) > 1 else 256

# The app's heat tint (anodised titanium), as on the wordmark and the "you're live" border.
HEAT = [(0.0, "#e2b25a"), (0.33, "#c8668f"), (0.66, "#8a6cf2"), (1.0, "#e2b25a")]


def srgb(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    c = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, alpha)


def principled(nt):
    return next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type == backend for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            break
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 1024
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    return scene


def brushed(name, base, rough, rings=420.0, bump_strength=0.18):
    # Circular brushing, like a machined knob: concentric micro-grooves in the bump, and the
    # default tangent (around local Z) stretches highlights into arcs.
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = principled(nt)
    bsdf.inputs["Base Color"].default_value = srgb(base)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Anisotropic"].default_value = 1.0
    coord = nt.nodes.new("ShaderNodeTexCoord")
    radius = nt.nodes.new("ShaderNodeVectorMath")
    radius.operation = "LENGTH"
    scale = nt.nodes.new("ShaderNodeMath")
    scale.operation = "MULTIPLY"
    scale.inputs[1].default_value = rings
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "1D"
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 8.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = bump_strength
    spread = nt.nodes.new("ShaderNodeMapRange")
    spread.inputs["To Min"].default_value = rough - 0.1
    spread.inputs["To Max"].default_value = rough + 0.1
    nt.links.new(coord.outputs["Object"], radius.inputs[0])
    nt.links.new(radius.outputs["Value"], scale.inputs[0])
    nt.links.new(scale.outputs["Value"], noise.inputs["W"])
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(noise.outputs["Fac"], spread.inputs["Value"])
    nt.links.new(spread.outputs["Result"], bsdf.inputs["Roughness"])
    return mat


def solid(name, color, metallic, rough):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = principled(mat.node_tree)
    bsdf.inputs["Base Color"].default_value = srgb(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = rough
    return mat


def heat_metal():
    # Hue sweeps around the ring.
    mat = bpy.data.materials.new("Heat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = principled(nt)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 0.22
    bsdf.inputs["Emission Strength"].default_value = 0.35
    coord = nt.nodes.new("ShaderNodeTexCoord")
    rot = nt.nodes.new("ShaderNodeMapping")
    rot.inputs["Rotation"].default_value = (0, 0, math.radians(-120))
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "RADIAL"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = HEAT[0][0], srgb(HEAT[0][1])
    els[1].position, els[1].color = HEAT[-1][0], srgb(HEAT[-1][1])
    for pos, col in HEAT[1:-1]:
        els.new(pos).color = srgb(col)
    nt.links.new(coord.outputs["Object"], rot.inputs["Vector"])
    nt.links.new(rot.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Emission Color"])
    return mat


def finish(obj, mat, bevel_width=0.0, segments=6):
    obj.data.materials.append(mat)
    if bevel_width:
        m = obj.modifiers.new("Bevel", "BEVEL")
        m.width = bevel_width
        m.segments = segments
        m.limit_method = "ANGLE"
    for poly in obj.data.polygons:
        poly.use_smooth = True


def rounded_slab(scene, name, size, radius, depth):
    half = size / 2
    verts = []
    if radius <= 0:
        verts = [(-half, -half, 0), (half, -half, 0), (half, half, 0), (-half, half, 0)]
    else:
        for cx, cy, start in ((half, half, 0), (-half, half, 90), (-half, -half, 180), (half, -half, 270)):
            ox, oy = cx - math.copysign(radius, cx), cy - math.copysign(radius, cy)
            for i in range(17):
                a = math.radians(start + 90 * i / 16)
                verts.append((ox + radius * math.cos(a), oy + radius * math.sin(a), 0))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [list(range(len(verts)))])
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location.z = -depth
    solidify = obj.modifiers.new("Solidify", "SOLIDIFY")
    solidify.thickness = depth
    solidify.offset = 1.0
    return obj


def area(scene, name, loc, rot, energy, size, color="#ffffff"):
    light = bpy.data.lights.new(name, "AREA")
    light.energy = energy
    light.size = size
    light.color = srgb(color)[:3]
    obj = bpy.data.objects.new(name, light)
    obj.location = loc
    obj.rotation_euler = [math.radians(a) for a in rot]
    scene.collection.objects.link(obj)


def build(tile):
    scene = reset()
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = srgb("#3a3f46")
    bg.inputs["Strength"].default_value = 0.5

    # Plate: full-bleed square, or a tile with rounded corners.
    plate = rounded_slab(scene, "Plate", 1.72 if tile else 2.3, 0.36 if tile else 0.0, 0.16)
    finish(plate, brushed("Steel", "#8e959d", 0.3), 0.035)

    # Dark well, heat ring around it, chrome play button on top.
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=0.56, depth=0.04, location=(0, 0, 0.01))
    finish(bpy.context.active_object, solid("Well", "#15171b", 0.6, 0.45), 0.012, 4)

    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.6, minor_radius=0.055, major_segments=160, minor_segments=32, location=(0, 0, 0.03)
    )
    finish(bpy.context.active_object, heat_metal())

    r = 0.33
    verts = [(r * math.cos(math.radians(a)) + 0.05, r * math.sin(math.radians(a)), 0) for a in (0, 120, 240)]
    mesh = bpy.data.meshes.new("Play")
    mesh.from_pydata(verts, [], [(0, 1, 2)])
    play = bpy.data.objects.new("Play", mesh)
    scene.collection.objects.link(play)
    play.location.z = 0.03
    solidify = play.modifiers.new("Solidify", "SOLIDIFY")
    solidify.thickness = 0.07
    solidify.offset = 1.0
    finish(play, brushed("Chrome", "#d9dde2", 0.12, 900.0, 0.05), 0.03, 8)

    area(scene, "Key", (-2.2, 2.0, 2.4), (-38, -42, 0), 520, 1.6)
    area(scene, "Rim", (2.4, -1.6, 1.4), (58, 52, 0), 220, 1.0, "#cfd9ff")
    area(scene, "Top", (0, 0, 4), (0, 0, 0), 25, 2.0)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.0
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.location = (0, 0, 5)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.film_transparent = tile
    return scene


for tile, name in ((False, "icon-full.png"), (True, "icon-tile.png")):
    scene = build(tile)
    scene.render.filepath = f"{OUT}/{name}"
    bpy.ops.render.render(write_still=True)
