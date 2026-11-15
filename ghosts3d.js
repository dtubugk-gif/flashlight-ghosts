// Flashlight Ghosts: the ghosts in 3D.
// The models were made in Blender (art/blender). They are drawn by three.js into an offscreen WebGL
// canvas that the game composites into its 2D canvas between the room and the embers, using the
// game's own camera (so the 3D ghosts sit exactly where the 2D game logic says they are).
// The flashlight is a real spotlight on the cloth. Burning chars the cloth from the hem up, and a
// burned ghost dissolves into glowing embers. All of that, the ghostly rim glow and the cloth
// flutter are done in the shaders below.
import * as THREE from 'three';
import { GLTFLoader } from './lib/loaders/GLTFLoader.js';

// Per ghost type: model file, how it looks in the game, how its cloth moves.
// breath: how much the body swells and sinks; reach: how far the arms stretch toward you up close
const LOOK = {
  sheet:  { file: 'models/sheet.glb',  tint: [1.0, 0.98, 0.95], glow: [0.20, 0.22, 0.27], flutter: 1.0, rough: 0.88, breath: 0.03, reach: 1.0 },
  wisp:   { file: 'models/wisp.glb',   tint: [0.84, 0.93, 1.06], glow: [0.30, 0.42, 0.58], flutter: 1.6, rough: 0.9, breath: 0.04, reach: 0.4 },
  wraith: { file: 'models/wraith.glb', tint: [0.4, 0.38, 0.42], glow: [0.05, 0.05, 0.07], flutter: 0.75, rough: 0.95, breath: 0.022, reach: 0.6 },
  gent:   { file: 'models/gent.glb',   tint: [1.0, 1.0, 1.0],    glow: [0.20, 0.20, 0.22], flutter: 0.55, rough: 0.6, breath: 0.035, reach: 0.7 },
  imp:    { file: 'models/imp.glb',    tint: [1.0, 1.0, 1.0],    glow: [0.05, 0.02, 0.02], flutter: 1.2, rough: 0.75, breath: 0.018, reach: 1.0 },
};
const NOFLUTTER = new Set(['M_Bone', 'M_Hat', 'M_Band']);
const NOGLOW = new Set(['M_Hat', 'M_Band']);
const FACE = { sheet: 0.22, wisp: 0.3, wraith: 0.36, gent: -0.04, imp: 0.33 };   // the face, above the model's centre (x height)

const NOISE = /* glsl */`
uniform float uTime, uFlutter, uTop, uHeight, uBurn, uChar, uDying, uOpacity, uEyes, uBreath, uWrithe, uReach, uHalfW, uAppear, uEyeFlare;
uniform vec3 uGlow;
varying vec3 vObj;
varying float vH;
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float gFbm(vec3 p) { return 0.55 * gNoise(p) + 0.3 * gNoise(p * 2.13 + 7.1) + 0.15 * gNoise(p * 4.37 + 3.3); }
`;
const VERT = /* glsl */`
#include <begin_vertex>
vObj = position;
vH = clamp((uTop - position.y) / uHeight, 0.0, 1.0);
{
  float fl = uFlutter * vH * vH * uHeight;
  float k = 6.2832 / uHeight;
  transformed.x += sin(uTime * 2.1 + position.y * k * 1.1 + position.z * k * 0.8) * 0.030 * fl;
  transformed.z += cos(uTime * 1.7 + position.y * k * 0.9 + position.x * k * 0.7) * 0.026 * fl;
  transformed.y += sin(uTime * 2.6 + position.x * k * 1.4) * 0.010 * fl;
  // breathing: the body slowly swells and sinks
  float gBr = 1.0 + uBreath * sin(uTime * 1.25) * (0.6 + 0.4 * vH);
  transformed.x *= gBr; transformed.z *= gBr;
  // writhing in the light: the cloth twists around the body, most at the hem
  float gTw = uWrithe * (0.2 + vH) * sin(uTime * 11.0 + position.y * k * 0.7) * 0.12;
  float gC = cos(gTw), gS = sin(gTw);
  transformed.xz = mat2(gC, -gS, gS, gC) * transformed.xz;
  // reaching: the arms (the outer parts of the upper body) stretch toward the player
  float gSide = smoothstep(0.35, 0.95, abs(position.x) / uHalfW) * (1.0 - smoothstep(0.5, 0.95, vH));
  transformed.z += uReach * gSide * uHeight * (0.16 + 0.04 * sin(uTime * 2.3 + sign(position.x) * 1.7));
  transformed.y += uReach * gSide * uHeight * 0.05;
}
`;
// shared by the colour pass and the depth pre-pass: the burn-away dissolve
const DISSOLVE = /* glsl */`
float gN = gFbm(vObj * (9.0 / uHeight));
float gDis = gN * 0.72 + (1.0 - vH) * 0.28;          // the hem goes first, the head last
float gThr = uDying * 1.12;
if (uDying > 0.0 && gDis < gThr) discard;
float gDisEdge = uDying > 0.0 ? 1.0 - smoothstep(0.0, 0.07, gDis - gThr) : 0.0;
// materialising: the head forms first, then the body pours down out of the dark
float gApp = gN * 0.6 + vH * 0.4;
if (uAppear < 1.0 && gApp > uAppear * 1.15) discard;
float gAppEdge = uAppear < 1.0 ? 1.0 - smoothstep(0.0, 0.08, uAppear * 1.15 - gApp) : 0.0;
`;

function patchColor(mat, U, isEyes) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + NOISE).replace('#include <begin_vertex>', VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <map_fragment>', `#include <map_fragment>
${DISSOLVE}
// charring climbs from the hem as the ghost takes damage (uChar 0..1); its edge glows while lit (uBurn)
float gChar = uChar > 0.001 ? smoothstep(1.06 - uChar * 0.8, 1.14 - uChar * 0.8, vH + (gN - 0.5) * 0.5) : 0.0;
float gEmber = gChar * (1.0 - gChar) * 4.0;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.16, 0.12, 0.1), gChar * 0.9);
diffuseColor.a *= ${isEyes ? 'uEyes' : 'uOpacity'};`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${isEyes ? 'totalEmissiveRadiance *= uEyeFlare;' : ''}
{
  vec3 gV = normalize(vViewPosition);
  float gRim = pow(1.0 - abs(dot(normal, gV)), 2.2);
  totalEmissiveRadiance += uGlow * (0.35 + gRim * 1.6);
  float gFlick = 0.7 + 0.3 * gNoise(vObj * 30.0 + uTime * 6.0);
  totalEmissiveRadiance += vec3(1.0, 0.42, 0.12) * (gEmber * uBurn * 2.8 * gFlick + gDisEdge * 5.0 * gFlick);
  totalEmissiveRadiance += vec3(0.55, 0.75, 1.0) * gAppEdge * 2.2 * gFlick;
}`);
  };
  mat.customProgramCacheKey = () => 'ghost-color-' + (isEyes ? 'e' : 'b');
}
function depthMaterial(U, side) {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, side });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + NOISE).replace('#include <begin_vertex>', VERT);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + DISSOLVE);
  };
  m.customProgramCacheKey = () => 'ghost-depth';
  return m;
}

export async function createGhost3D() {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  camera.matrixAutoUpdate = false;
  scene.add(camera);
  const hemi = new THREE.HemisphereLight(0x8a96b8, 0x2a2018, 0.55);
  scene.add(hemi);
  const candle = new THREE.PointLight(0xffb060, 0, 0, 1.4);   // the haunted house's candles (warm fill)
  scene.add(candle);
  const torch = new THREE.SpotLight(0xffdcae, 0, 0, 0.5, 0.55, 1.15);
  torch.position.set(0, 0, 0);
  scene.add(torch, torch.target);
  const flash = new THREE.PointLight(0xfff1dc, 0, 0, 1.0);    // the jump-scare flash
  scene.add(flash);

  // ---------- load all five models
  const loader = new GLTFLoader();
  const proto = {};
  await Promise.all(Object.entries(LOOK).map(async ([type, look]) => {
    const gltf = await loader.loadAsync(look.file);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // measure the body (the biggest mesh) for flutter, centring and scale
    let body = null, best = -1;
    root.traverse(o => { if (o.isMesh) { o.geometry.computeBoundingBox(); const s = o.geometry.boundingBox.getSize(new THREE.Vector3()); const v = s.x * s.y * s.z; if (v > best) { best = v; body = o; } } });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    body.geometry.computeBoundingBox();
    const bb = body.geometry.boundingBox;
    proto[type] = { root, look, height: size.y, center, top: bb.max.y, bodyH: bb.max.y - bb.min.y, halfW: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) };
  }));

  // ---------- instances (pooled per type, so shaders and materials are made once)
  const pool = {}; for (const t in LOOK) pool[t] = [];
  const live = new Map();
  function makeInstance(type) {
    const P = proto[type], L = P.look;
    const U = {
      uTime: { value: 0 }, uFlutter: { value: L.flutter }, uTop: { value: P.top }, uHeight: { value: P.bodyH },
      uBurn: { value: 0 }, uChar: { value: 0 }, uDying: { value: 0 }, uOpacity: { value: 1 }, uEyes: { value: 1 }, uGlow: { value: new THREE.Vector3(...L.glow) },
      uBreath: { value: L.breath }, uWrithe: { value: 0 }, uReach: { value: 0 }, uHalfW: { value: P.halfW }, uAppear: { value: 1 }, uEyeFlare: { value: 1 },
    };
    const Ufix = { ...U, uFlutter: { value: 0 }, uWrithe: { value: 0 }, uReach: { value: 0 }, uBreath: { value: 0 } };   // hands, hats: rigid
    const Uhat = { ...Ufix, uGlow: { value: new THREE.Vector3(0, 0, 0) } };   // the hat stays black
    const holder = new THREE.Group(); holder.matrixAutoUpdate = false;
    const model = P.root.clone(true);
    model.position.sub(P.center);
    holder.add(model);
    const parts = { hands: [], hat: [] };
    const extra = [];
    model.traverse(o => {
      if (o.name.startsWith('Hand_')) parts.hands.push({ o, rx: o.rotation.x, rz: o.rotation.z });
      if (!o.isMesh) return;
      const src = o.material, name = src.name || '';
      const isEyes = name === 'M_Eyes' && !!src.emissive && src.emissive.getHex() !== 0, isVoid = name === 'M_Void';   // glowing eyes (imp, wraith)
      const uni = NOGLOW.has(name) ? Uhat : NOFLUTTER.has(name) ? Ufix : U;
      let mat;
      if (isVoid) {
        mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true });
        mat.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, uni); sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + NOISE).replace('#include <begin_vertex>', VERT); sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + NOISE).replace('#include <map_fragment>', '#include <map_fragment>\n' + DISSOLVE + '\ndiffuseColor.a *= max(uOpacity, uEyes * 0.85);'); };
        mat.customProgramCacheKey = () => 'ghost-void';
      } else {
        mat = new THREE.MeshStandardMaterial({
          map: src.map || null, normalMap: src.normalMap || null, roughnessMap: src.roughnessMap || null,
          color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1), roughness: src.roughnessMap ? 1 : (src.roughness ?? L.rough),
          metalness: 0, side: THREE.DoubleSide, transparent: true,
          emissive: isEyes ? new THREE.Color(1.0, 0.42, 0.12) : new THREE.Color(0, 0, 0),
          emissiveIntensity: isEyes ? 1.7 : 0,
        });
        if (!isEyes && name === 'M_Body') mat.color.multiply(new THREE.Color(...L.tint));
        if (isEyes) mat.color.setRGB(0.12, 0.05, 0.02);   // embers: the colour comes from the glow
        if (mat.normalMap) mat.normalScale.set(1, 1);
        patchColor(mat, uni, isEyes);
        if (name === 'M_Hat' || name === 'M_Band') parts.hat.push(o);
      }
      o.material = mat;
      o.frustumCulled = false;
      // depth pre-pass twin: only the front-most layer of the ghost gets blended (clean see-through cloth)
      const d = new THREE.Mesh(o.geometry, depthMaterial(uni, THREE.DoubleSide));
      d.frustumCulled = false;
      extra.push([o, d]);
    });
    for (const [o, d] of extra) { o.parent.add(d); d.position.copy(o.position); d.quaternion.copy(o.quaternion); d.scale.copy(o.scale); o.userData.depth = d; }
    // the hat sits on top and is lifted when the gentleman tips it
    let hatPivot = null;
    if (parts.hat.length) {
      const hb = new THREE.Box3(); parts.hat.forEach(m => hb.expandByObject(m));
      hatPivot = new THREE.Group(); const c = hb.getCenter(new THREE.Vector3()); c.y = hb.min.y; c.x = hb.min.x; // tip from the brim's edge
      model.add(hatPivot); hatPivot.position.copy(c);
      for (const m of parts.hat) { const dd = m.userData.depth; hatPivot.attach(m); if (dd) hatPivot.attach(dd); }
    }
    return { type, holder, model, U, Ufix, parts, hatPivot, meshes: extra };
  }
  function acquire(type) { const i = pool[type].pop() || makeInstance(type); scene.add(i.holder); return i; }
  function release(inst) { scene.remove(inst.holder); pool[inst.type].push(inst); }

  const m4 = new THREE.Matrix4(), mR = new THREE.Matrix4(), mS = new THREE.Matrix4();
  const vX = new THREE.Vector3(), vY = new THREE.Vector3(0, 0, 1), vZ = new THREE.Vector3(), vP = new THREE.Vector3();
  function place(inst, pos, size, opts) {
    const P = proto[inst.type];
    vZ.set(-pos[0], -pos[1], 0); if (vZ.lengthSq() < 1e-6) vZ.set(0, -1, 0); vZ.normalize();   // model front faces the player
    vX.crossVectors(vY, vZ).normalize();
    m4.makeBasis(vX, vY, vZ);
    mR.makeRotationFromEuler(new THREE.Euler(opts.tilt || 0, opts.yaw || 0, opts.roll || 0, 'YXZ'));
    const k = size / P.height;
    mS.makeScale(k, k, k);
    m4.multiply(mR).multiply(mS);
    m4.setPosition(vP.set(pos[0], pos[1], pos[2]));
    inst.holder.matrix.copy(m4);
    inst.holder.matrixWorldNeedsUpdate = true;
  }
  function setOrder(inst, rank) {
    for (const [o, d] of inst.meshes) { d.renderOrder = 10 + rank * 2; o.renderOrder = 11 + rank * 2; }
  }

  let W = 1, H = 1, scareInst = null;
  const api = {
    canvas,
    resize(w, h, dpr) { W = w; H = h; renderer.setPixelRatio(Math.min(dpr, 1.75)); renderer.setSize(w, h, false); },
    /** Draw the ghosts. ghosts: game ghosts sorted far to near. Returns true if anything was drawn. */
    draw(st) {
      const { cam, F, beam, ghosts, haunted, scare } = st;
      // camera = the game's camera: basis R, U, -F at the origin, same focal length in pixels
      m4.makeBasis(vX.set(...cam.R), new THREE.Vector3(...cam.U), vZ.set(-cam.F[0], -cam.F[1], -cam.F[2]));
      camera.matrix.copy(m4); camera.matrixWorldNeedsUpdate = true; camera.updateMatrixWorld(true);
      camera.fov = 2 * Math.atan(H / 2 / F) * 180 / Math.PI; camera.aspect = W / H; camera.updateProjectionMatrix();
      // the flashlight: from the phone, toward the beam's centre on screen
      const dx = (beam.BX - W / 2) / F, dy = -(beam.BY - H / 2) / F;
      torch.target.position.set(cam.F[0] + cam.R[0] * dx + cam.U[0] * dy, cam.F[1] + cam.R[1] * dx + cam.U[1] * dy, cam.F[2] + cam.R[2] * dx + cam.U[2] * dy).multiplyScalar(4);
      torch.target.updateMatrixWorld();
      torch.angle = Math.min(1.2, Math.atan(beam.BEAM * 1.25 / F));
      torch.intensity = beam.I * 60;
      candle.intensity = haunted ? 2.2 : 0.6; candle.position.set(-cam.F[0] * 1.5 - 1.2, -cam.F[1] * 1.5 + 0.6, -0.4);
      hemi.intensity = haunted ? 0.55 : 0.45;
      flash.intensity = 0;

      // the jump scare: only the ghost that got you, rushing into the lens
      if (scare) {
        if (scareInst && scareInst.type !== scare.type) { release(scareInst); scareInst = null; }
        if (!scareInst) scareInst = acquire(scare.type);
        for (const inst of live.values()) inst.holder.visible = false;
        scareInst.holder.visible = true;
        const u = Math.min(1, scare.t / 0.34), e = u * u * (3 - 2 * u), dist = 2.4 - e * 1.75;
        const face = FACE[scare.type] ?? 0.2;   // keep its face in the middle of the screen
        const p = [0, 1, 2].map(i => cam.F[i] * dist - cam.U[i] * face);
        place(scareInst, p, 1.0, { tilt: 0.12, yaw: 0, roll: Math.sin(scare.t * 30) * 0.05 });
        for (const U of [scareInst.U, scareInst.Ufix]) { U.uTime.value = Math.floor(scare.t * 3 * 12) / 12; U.uBurn.value = 0; U.uChar.value = 0; U.uDying.value = 0; U.uOpacity.value = Math.min(1, 0.6 + u); U.uEyes.value = 1; U.uAppear.value = 1; U.uEyeFlare.value = 2.5; }
        scareInst.U.uReach.value = proto[scare.type].look.reach * (0.6 + 0.4 * e); scareInst.U.uWrithe.value = 0.35;
        flash.position.set(cam.F[0] * 0.2 - cam.U[0] * 0.2, cam.F[1] * 0.2 - cam.U[1] * 0.2, cam.F[2] * 0.2 - cam.U[2] * 0.2);
        flash.intensity = 0.8 + 2.2 * e;
        setOrder(scareInst, 0);
        renderer.render(scene, camera);
        for (const inst of live.values()) inst.holder.visible = true;
        return true;
      }
      if (scareInst) { release(scareInst); scareInst = null; }

      const seen = new Set();
      let rank = 0;
      for (const g of ghosts) {
        if (!proto[g.type]) continue;
        let inst = live.get(g);
        if (!inst) { inst = acquire(g.type); live.set(g, inst); }
        seen.add(g);
        const d = g.dying >= 0 ? g.dying : -1;
        const size = g.T.size * 1.06 * (d > 0 ? 1 + d * 0.12 : 1);
        const pos = [g.pos[0], g.pos[1], g.pos[2] + (d > 0 ? d * g.T.size * 0.3 : Math.sin(g.t * 1.4 + g.seed * 9) * 0.03 * g.T.size)];
        const jit = g.burn * 0.02 * g.T.size;
        if (jit) { pos[0] += (Math.random() - .5) * jit; pos[1] += (Math.random() - .5) * jit; pos[2] += (Math.random() - .5) * jit; }
        const tw = g.twitch;   // a sudden jerk, held for a few frames, like a bad film splice
        if (tw) { pos[0] += cam.R[0] * tw.dx * g.T.size; pos[1] += cam.R[1] * tw.dx * g.T.size; pos[2] += tw.dz * g.T.size; }
        place(inst, pos, size, {
          yaw: Math.sin(g.t * 0.7 + g.seed * 6) * 0.22 + (g.dodge ? g.dodge.yaw : 0) + (tw ? tw.yaw : 0),
          tilt: -g.burn * 0.16 + Math.sin(g.t * 1.1 + g.seed) * 0.04 + (g.lunge || 0) * 0.28 + (tw ? tw.tilt : 0),   // recoils from the light, leans in to lunge
          roll: Math.sin(g.t * 0.9 + g.seed * 3) * 0.06 + (g.dodge ? g.dodge.roll : 0) + (g.stare || 0) + (tw ? tw.roll : 0),   // a slow, curious head tilt while it stares
        });
        const flut = proto[g.type].look.flutter * (1 + g.burn * 1.5);
        // up close and unlit it moves in stop-motion: the time steps instead of flowing
        const tq = g.stutter ? Math.floor(g.t * 9) / 9 : g.t;
        const L = proto[g.type].look;
        inst.U.uWrithe.value = d >= 0 ? 0.8 : g.burn;
        inst.U.uReach.value = L.reach * (g.reach || 0);
        for (const U of [inst.U, inst.Ufix]) {
          U.uTime.value = tq;
          U.uAppear.value = d >= 0 ? 1 : Math.min(1, g.fade * 1.05);
          U.uEyeFlare.value = 1 + g.burn * 1.6 + (g.reach || 0) * (0.6 + 0.6 * Math.sin(g.t * 9));
          U.uBurn.value = d >= 0 ? 1 : g.burn;
          U.uChar.value = d >= 0 ? 1 : Math.max(0, Math.min(1, 1 - g.hp / g.T.hp));
          U.uDying.value = d >= 0 ? Math.min(1, d / 1.0) : 0;
          U.uOpacity.value = g.alpha3;
          U.uEyes.value = Math.min(1, g.fade) * (d >= 0 ? Math.max(0, 1 - d * 1.6) : 1);
        }
        inst.U.uFlutter.value = flut;
        // the wraith's hands grasp, the gentleman tips his hat
        for (const h of inst.parts.hands) h.o.rotation.x = h.rx + Math.sin(tq * 1.6 + h.rz * 9) * 0.16 - (g.reach || 0) * 0.55 + g.burn * Math.sin(tq * 20) * 0.2;
        if (inst.hatPivot) inst.hatPivot.rotation.z = (g.hatTip || 0) * 0.45;
        setOrder(inst, rank++);
      }
      for (const [g, inst] of live) if (!seen.has(g)) { release(inst); live.delete(g); }
      if (!rank) return false;
      renderer.render(scene, camera);
      return true;
    },
    /** drop every instance (new game / menu) */
    clear() { for (const [g, inst] of live) release(inst); live.clear(); },
    info() { return { live: live.size, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs.length }; },
  };
  return api;
}

createGhost3D().then(api => {
  window.G3D = api;
  if (window.FGOn3D) window.FGOn3D(api);
}).catch(err => { console.warn('3D ghosts unavailable, using the 2D ones:', err && err.message || err); window.G3DFailed = true; });
