import gsap from 'https://esm.sh/gsap@3.13.0'
import * as THREE from 'https://esm.sh/three@0.171.0'

/* ───────── Shaders ───────── */
const ballVertexShader = /* glsl */ `
  varying vec3 vObjNormal;
  varying vec3 vWorldPosition;
  varying vec3 vBallCenter;

  void main() {
    vObjNormal = normal;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vBallCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const ballFragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uVideoTexture;
  uniform float uTime;
  uniform float uHasVideo;
  uniform float uRows;
  uniform float uFlatten;
  uniform float uZoom;
  uniform float uClarity;
  uniform float uDistortion;
  uniform float uShininess;
  uniform float uSpecular;
  uniform vec3 uKeyLightPos;
  uniform float uKeyStrength;
  uniform vec3 uFillLightPos;
  uniform float uFillStrength;
  uniform vec3 uTopLightPos;
  uniform float uTopStrength;
  uniform float uRim1Strength;
  uniform float uRim1Sharpness;
  uniform vec2 uRim1Pos;
  uniform float uRim2Strength;
  uniform float uRim2Sharpness;
  uniform vec2 uRim2Pos;
  uniform float uLightIntensity;
  uniform float uAmbient;
  uniform float uRotation;
  uniform vec3 uTint;
  uniform float uTintStrength;
  uniform float uVideoAspect;
  uniform sampler2D uAtlasTexture;
  uniform float uHasAtlas;
  uniform float uAtlasGrid;
  uniform float uImageCount;
  uniform float uPhotoRatio;
  uniform float uCycleSpeed;
  uniform vec3 uFadeTint;
  uniform sampler2D uEnvTexture; // metallic mirror reflection (club lighting)
  uniform float uEnvStrength;
  uniform float uEnvPulse; // 0..1 — reflected lights pulse to a beat
  uniform float uShine;    // 0..1 — a bright gleam sweeps across the chrome

  varying vec3 vObjNormal;
  varying vec3 vWorldPosition;
  varying vec3 vBallCenter;

  #define PI 3.14159265359
  #define GAP 0.06

  vec3 rotateY(vec3 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
  }

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 geoN = normalize(vObjNormal);

    // ── Tile grid: un-rotate into ball-local space ──
    // As the ball flattens, blend the grid rotation to 0 so the meridian grid
    // LOCKS to the camera frame — the resting spin angle no longer decides the
    // pattern. (Before this, the flat logo depended on where the spin froze:
    // facing away → empty, sideways → half.) With 16 cols + rot 0, a seam sits
    // dead-centre and the logo's hole pattern lands deterministically.
    float gridRot = mix(uRotation, 0.0, uFlatten);
    vec3 localN = rotateY(geoN, -gridRot);

    float theta = acos(clamp(localN.y, -1.0, 1.0));
    float phi = atan(localN.z, localN.x) + PI;

    float rowIndex = floor(theta / PI * uRows);
    float rowTheta = (rowIndex + 0.5) / uRows * PI;
    float rowRadius = sin(rowTheta);
    // Disco ball: per-row column count (staggered mirrors). Logo globe:
    // one shared meridian grid — flattening aligns the seams across rows so
    // columns run pole-to-pole like the 2D mark. 16 columns exactly (a
    // multiple of 4) so a seam — not a tile — sits on the view axis, letting
    // the logo's centre pair flank it.
    float cols = mix(max(4.0, floor(uRows * 2.0 * rowRadius)), 16.0, uFlatten);
    float colIndex = floor(phi / (2.0 * PI) * cols);
    float colPhi = (colIndex + 0.5) / cols * 2.0 * PI;

    // Gap mask — flattening thickens the gaps and rounds the tile corners so
    // the grid takes on the 2D brand-globe look (fat dark seams, soft tiles).
    float rowFrac = fract(theta / PI * uRows);
    float colFrac = fract(phi / (2.0 * PI) * cols);
    float hardMask = step(GAP, rowFrac) * step(GAP, 1.0 - rowFrac)
                   * step(GAP, colFrac) * step(GAP, 1.0 - colFrac);
    float fGap = mix(GAP, 0.13, uFlatten);
    float fRad = 0.16 * uFlatten;
    // polar rows keep more of their cell → taller tiles top & bottom, like the logo
    float polarTall = abs(cos(rowTheta));
    float fGapRow = fGap * mix(1.0, 0.35, polarTall * uFlatten);
    vec2 tp = abs(vec2(colFrac, rowFrac) - 0.5);
    vec2 th = vec2(0.5 - fGap - fRad, 0.5 - fGapRow - fRad);
    float fd = length(max(tp - th, vec2(0.0))) - fRad;
    float roundMask = 1.0 - smoothstep(-0.015, 0.015, fd);
    float gapMask = mix(hardMask, roundMask, uFlatten);

    // ── Tile normal: local → world (used for specular only) ──
    vec3 localTileN = normalize(vec3(
      sin(rowTheta) * cos(colPhi - PI),
      cos(rowTheta),
      sin(rowTheta) * sin(colPhi - PI)
    ));
    vec3 worldTileN = rotateY(localTileN, gridRot);

    // ── Webcam sampling ──
    vec3 sampleN = mix(worldTileN, geoN, uClarity);

    // Flat mapping (direct normal → UV)
    vec2 flatUv = vec2(
      sampleN.x * 0.5 * uZoom + 0.5,
      sampleN.y * 0.5 * uZoom + 0.5
    );

    // Reflection-based spherical mapping
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 reflDir = reflect(viewDir, sampleN);
    vec2 reflUv = vec2(
      0.5 + atan(reflDir.x, reflDir.z) / PI * uZoom,
      0.5 + asin(clamp(reflDir.y, -1.0, 1.0)) / PI * uZoom
    );

    // distortion: 0 = flat, 1 = full spherical reflection
    vec2 webcamUv = mix(flatUv, reflUv, uDistortion);

    // Correct for webcam aspect ratio (16:9 etc.) — scale x around center
    webcamUv.x = (webcamUv.x - 0.5) / uVideoAspect + 0.5;

    // Per-tile hash — used for mirror variation and photo tile selection
    float tileHash = fract(sin(rowIndex * 127.1 + colIndex * 311.7) * 43758.5453);

    // Beat pulse — shared by the reflection AND the event photos so the whole
    // ball breathes to a club beat (punchy up, soft down).
    float uBeat = pow(0.5 + 0.5 * sin(uTime * 2.6), 1.6);
    float pulseF = mix(1.0, 0.55 + 0.85 * uBeat, uEnvPulse);

    // ── Tile color: video / env-reflection / mosaic / procedural ──
    vec3 baseColor;
    vec3 envEmissive = vec3(0.0); // metallic mirror reflection, added emissively
    if (uHasVideo > 0.5) {
      webcamUv = clamp(webcamUv, 0.0, 1.0);
      baseColor = texture2D(uVideoTexture, webcamUv).rgb;
    } else if (uEnvStrength > 0.01) {
      // Chrome mirror: each tile reflects the club-lighting environment via its
      // own normal, so coloured light pools + white hotspots sweep across the
      // ball as it turns. Dark metal base for the diffuse term; the reflection
      // is added emissively (a mirror isn't dimmed by facing the lights).
      vec2 euv = vec2(fract(reflUv.x), clamp(reflUv.y, 0.0, 1.0));
      vec3 envCol = texture2D(uEnvTexture, euv).rgb;
      baseColor = vec3(0.07 + tileHash * 0.10); // dark chrome
      envEmissive = envCol * (0.55 + tileHash * 0.55) * uEnvStrength * pulseF;
    } else if (uHasAtlas > 0.5) {
      // Mosaic mode: high-contrast black / silver checker mirrors
      float bright = step(0.62, fract(tileHash * 7.31));
      baseColor = mix(vec3(0.04 + tileHash * 0.1), vec3(0.65 + tileHash * 0.35), bright);
    } else {
      // Hash-based per-tile brightness — mimics varied mirror reflectivity
      baseColor = vec3(0.15 + tileHash * 0.25);
    }

    // ── Color tint ──
    float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
    vec3 tintedColor = uTint * luma * 1.6;
    vec3 mirrorColor = mix(baseColor, tintedColor, uTintStrength);

    // ── Lighting ──
    float specPow = mix(16.0, 256.0, uShininess);

    // Key light
    vec3 keyDir = normalize(uKeyLightPos);
    float keyDiff = max(dot(worldTileN, keyDir), 0.0) * 0.5 * uKeyStrength;
    float keySpec = pow(max(dot(reflect(-keyDir, worldTileN), -viewDir), 0.0), specPow) * uKeyStrength;

    // Fill light
    vec3 fillDir = normalize(uFillLightPos);
    float fillDiff = max(dot(worldTileN, fillDir), 0.0) * 0.5 * uFillStrength;
    float fillSpec = pow(max(dot(reflect(-fillDir, worldTileN), -viewDir), 0.0), specPow) * uFillStrength;

    // Top light
    vec3 topDir = normalize(uTopLightPos);
    float topDiff = max(dot(worldTileN, topDir), 0.0) * 0.5 * uTopStrength;
    float topSpec = pow(max(dot(reflect(-topDir, worldTileN), -viewDir), 0.0), specPow) * uTopStrength;

    float diffuse = (keyDiff + fillDiff + topDiff) * uLightIntensity;
    float spec = (keySpec + fillSpec + topSpec) * uLightIntensity;

    // ── Rim lights (Fresnel-based, positioned) ──
    float facing = dot(geoN, -viewDir);
    float baseFresnel = 1.0 - max(0.0, facing);

    // Rim 1
    float rim1Pow = mix(1.5, 5.0, uRim1Sharpness);
    vec3 rim1Dir = normalize(vec3(uRim1Pos.x, uRim1Pos.y, 0.0) + vec3(0.0, 0.0, -1.0));
    float rim1Bias = max(0.0, dot(geoN, -rim1Dir));
    float rim1 = pow(baseFresnel, rim1Pow) * (0.3 + 0.7 * rim1Bias) * uRim1Strength;

    // Rim 2
    float rim2Pow = mix(1.5, 5.0, uRim2Sharpness);
    vec3 rim2Dir = normalize(vec3(uRim2Pos.x, uRim2Pos.y, 0.0) + vec3(0.0, 0.0, -1.0));
    float rim2Bias = max(0.0, dot(geoN, -rim2Dir));
    float rim2 = pow(baseFresnel, rim2Pow) * (0.3 + 0.7 * rim2Bias) * uRim2Strength;

    float rim = rim1 + rim2;

    // Per-tile sparkle shimmer
    float tileId = rowIndex * 50.0 + colIndex;
    float shimmer = sin(uTime * 3.0 + tileId * 1.7) * 0.5 + 0.5;
    shimmer = pow(shimmer, 10.0) * 0.25;

    // ── Combine ──
    vec3 color = mirrorColor * (uAmbient + diffuse);
    color += envEmissive; // metallic mirror reflection sits on top of the metal
    color += spec * vec3(1.0) * mix(1.0, 3.0, uShininess) * uSpecular;
    color += rim * vec3(1.0);
    color += shimmer * vec3(1.0);

    // ── Shine sweep: a soft bright gleam gliding diagonally across the front ──
    if (uShine > 0.001) {
      float sc = geoN.x * 0.55 + geoN.y * 0.83;   // diagonal coordinate
      float phase = sc * 0.5 + 0.5;               // → 0..1
      float move = fract(uTime * 0.3);            // sweeping position
      float d = abs(phase - move);
      d = min(d, 1.0 - d);                        // wrap seamlessly
      float shine = smoothstep(0.07, 0.0, d) * max(dot(geoN, -viewDir), 0.0);
      color += shine * uShine * 1.3 * vec3(1.0);
    }

    // ── Photo mosaic tiles: random event images fading in/out per tile ──
    // In webcam mode the ball is dedicated to the face — skip photo tiles.
    if (uHasAtlas > 0.5 && uHasVideo < 0.5) {
      // Skip the tiny pole rows; hash decides which tiles carry photos
      float isPhoto = step(1.0 - uPhotoRatio, tileHash)
                    * step(1.5, rowIndex)
                    * step(rowIndex, uRows - 2.5);

      if (isPhoto > 0.5) {
        // Local UV inside the tile face (inset by the gap)
        vec2 tileUv = vec2(
          (colFrac - GAP) / (1.0 - 2.0 * GAP),
          1.0 - (rowFrac - GAP) / (1.0 - 2.0 * GAP)
        );
        tileUv = clamp(tileUv, 0.0, 1.0);

        // Staggered per-tile cycle: fade out, brief mirror, next image fades in
        float t = uTime * uCycleSpeed + tileHash * 37.0;
        float slot = floor(t);
        float f = fract(t);
        float env = smoothstep(0.0, 0.3, f) * (1.0 - smoothstep(0.7, 1.0, f));

        // Random image pick per tile per cycle slot
        float tileId2 = rowIndex * 200.0 + colIndex;
        float imgIdx = min(
          floor(hash21(vec2(tileId2, slot)) * uImageCount),
          uImageCount - 1.0
        );
        float ac = mod(imgIdx, uAtlasGrid);
        float ar = uAtlasGrid - 1.0 - floor(imgIdx / uAtlasGrid);

        // Blurry fade: 5-tap blur whose spread shrinks to zero as the
        // image resolves, blended through the fade tint color layer
        float spread = (1.0 - env) * 0.18;
        vec2 cUv = clamp(tileUv, vec2(spread), vec2(1.0 - spread));
        vec2 auv = (vec2(ac, ar) + cUv) / uAtlasGrid;
        float o = spread / uAtlasGrid;
        vec3 photoColor = texture2D(uAtlasTexture, auv).rgb * 0.4;
        photoColor += texture2D(uAtlasTexture, auv + vec2(o, o)).rgb * 0.15;
        photoColor += texture2D(uAtlasTexture, auv + vec2(-o, o)).rgb * 0.15;
        photoColor += texture2D(uAtlasTexture, auv + vec2(o, -o)).rgb * 0.15;
        photoColor += texture2D(uAtlasTexture, auv + vec2(-o, -o)).rgb * 0.15;
        photoColor = mix(uFadeTint * 1.2, photoColor, env);

        // Photos stay readable: lit mostly by how much they face the camera
        float facingCam = max(dot(worldTileN, -viewDir), 0.0);
        vec3 photoLit = photoColor * (0.22 + 0.95 * facingCam)
                      * (0.5 + 0.5 * uLightIntensity);
        photoLit += (spec * uSpecular * 0.3 + rim * 0.25) * vec3(1.0);
        photoLit *= pulseF; // event photos pulse to the beat too

        color = mix(color, photoLit, env);
      }
    }

    // ── Flatten → logo: collapse every tile to a flat white→grey grid,
    // killing all 3D shading so it matches the 2D brand globe before hand-off.
    // Vertical gradient (white top → #adad grey bottom) mirrors the SVG fill.
    float flatFy = clamp(geoN.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 flatColor = mix(vec3(0.68), vec3(1.0), flatFy);
    color = mix(color, flatColor, uFlatten);

    // Sculpt the flat grid toward the logo:
    //  · drop the paper-thin slivers at the LEFT/RIGHT silhouette only —
    //    judged by how the tile's column faces the camera horizontally,
    //    so the tall polar rows survive like in the logo
    //  · punch out a couple of "missing mirror" cells near the centre
    // MUST use worldTileN: the tile grid lives in a rotating frame
    // (localN un-rotates by uRotation), so localTileN spins with the ball —
    // anchoring the cull/holes to it made them land at whatever azimuth the
    // spin froze at (ball empty/half/fine at random). worldTileN is
    // camera-frame: stable no matter where the rotation rests.
    vec2 hN = vec2(worldTileN.x, worldTileN.z);
    float hLen = max(length(hN), 1e-4);
    vec2 hV = vec2(-viewDir.x, -viewDir.z);
    float azFacing = dot(hN / hLen, hV / max(length(hV), 1e-4));
    float keepEdge = smoothstep(0.12, 0.38, azFacing);
    // Empty "missing mirror" cells — the exact holes of the brand globe,
    // measured from its SVG: row2 left-of-centre, row3 both sides at ±1.5,
    // row4 right-of-centre. They pop in as the flatten completes.
    float azT = atan(worldTileN.x, worldTileN.z);
    // view azimuth from the BALL CENTRE (constant across fragments) — the
    // per-fragment direction wobbles up to half a column at this ball size
    vec3 cd = cameraPosition - vBallCenter;
    float azV = atan(cd.x, cd.z);
    float dAz = azT - azV;
    dAz -= 6.2831853 * floor(dAz / 6.2831853 + 0.5);
    float colSnap = floor(dAz / (6.2831853 / cols)) + 0.5;
    float e1 = (1.0 - step(0.25, abs(rowIndex - 2.0))) * (1.0 - step(0.25, abs(colSnap + 0.5)));
    float e2 = (1.0 - step(0.25, abs(rowIndex - 3.0))) * (1.0 - step(0.25, abs(abs(colSnap) - 1.5)));
    float e3 = (1.0 - step(0.25, abs(rowIndex - 4.0))) * (1.0 - step(0.25, abs(colSnap - 0.5)));
    float isEmpty = step(0.85, uFlatten) * min(e1 + e2 + e3, 1.0);
    gapMask *= mix(1.0, keepEdge * (1.0 - isEmpty), uFlatten);

    // gaps darken to the page background when flat, so seams read as bg
    vec3 gapColor = mix(vec3(0.02), vec3(0.051), uFlatten);
    color = mix(gapColor, color, gapMask);

    gl_FragColor = vec4(color, 1.0);
  }
`

/* ───────── Sparkle Texture ───────── */
function createSparkleTexture() {
  const size = 128
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  const cx = size / 2
  const cy = size / 2

  ctx.clearRect(0, 0, size, size)

  const outer = size * 0.48
  const inner = size * 0.015

  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4 - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r)
  }
  ctx.closePath()

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  grad.addColorStop(0.08, 'rgba(255, 255, 255, 0.9)')
  grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.4)')
  grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.1)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fill()

  const cGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 4)
  cGrad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  cGrad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = cGrad
  ctx.beginPath()
  ctx.arc(cx, cy, 4, 0, Math.PI * 2)
  ctx.fill()

  return new THREE.CanvasTexture(c)
}

/* ───────── Reflection Texture ───────── */
function createReflectionTexture() {
  const w = 64
  const h = 64
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')

  ctx.clearRect(0, 0, w, h)

  // Crisp filled rectangle with a thin soft edge
  const pad = 3 // pixels of edge fade
  const imgData = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const dy = Math.min(y, h - 1 - y)
    const fy = Math.min(dy / pad, 1)
    for (let x = 0; x < w; x++) {
      const dx = Math.min(x, w - 1 - x)
      const fx = Math.min(dx / pad, 1)
      const idx = (y * w + x) * 4
      imgData.data[idx] = 255
      imgData.data[idx + 1] = 255
      imgData.data[idx + 2] = 255
      imgData.data[idx + 3] = fx * fy * 255
    }
  }
  ctx.putImageData(imgData, 0, 0)

  return new THREE.CanvasTexture(c)
}

/* ───────── Glow / Flare Textures ───────── */
function createGlowTexture() {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  )
  g.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
  g.addColorStop(0.25, 'rgba(255, 255, 255, 0.45)')
  g.addColorStop(0.6, 'rgba(255, 255, 255, 0.12)')
  g.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(c)
}

// Surrounding halo: soft ring hugging the ball edge + radial light rays.
// Drawn for a sprite 5x the ball radius wide — ball edge sits at 0.2 * size.
function createHaloTexture() {
  const size = 512
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const cx = size / 2
  const cy = size / 2
  const inner = size * 0.2

  // Soft glow ring around the ball silhouette
  const g = ctx.createRadialGradient(cx, cy, inner * 0.9, cx, cy, size * 0.5)
  g.addColorStop(0, 'rgba(255, 255, 255, 0.75)')
  g.addColorStop(0.25, 'rgba(255, 255, 255, 0.26)')
  g.addColorStop(0.6, 'rgba(255, 255, 255, 0.08)')
  g.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  // Radial rays shooting out of the globe
  let seed = 7
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  const rays = 56
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2 + rnd() * 0.1
    const len = inner * 1.15 + rnd() * (size * 0.5 - inner)
    const w = (0.006 + rnd() * 0.014) * size
    const alpha = 0.12 + rnd() * 0.3
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    const rg = ctx.createLinearGradient(inner * 0.95, 0, len, 0)
    rg.addColorStop(0, `rgba(255, 255, 255, ${alpha})`)
    rg.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = rg
    ctx.beginPath()
    ctx.moveTo(inner * 0.95, -w / 2)
    ctx.lineTo(len, -w * 0.12)
    ctx.lineTo(len, w * 0.12)
    ctx.lineTo(inner * 0.95, w / 2)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  return new THREE.CanvasTexture(c)
}

function createFlareTexture() {
  const size = 256
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const cx = size / 2
  const cy = size / 2

  // Light beams radiating from the source
  const beam = (rot, len, thick, alpha) => {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.scale(1, thick)
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len)
    g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`)
    g.addColorStop(0.4, `rgba(255, 255, 255, ${alpha * 0.35})`)
    g.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, len, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  beam(0, size * 0.5, 0.05, 1)
  beam(Math.PI / 2, size * 0.5, 0.05, 1)
  beam(Math.PI / 4, size * 0.36, 0.03, 0.5)
  beam(-Math.PI / 4, size * 0.36, 0.03, 0.5)

  // Bright core
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.3)
  g.addColorStop(0, 'rgba(255, 255, 255, 1)')
  g.addColorStop(0.15, 'rgba(255, 255, 255, 0.85)')
  g.addColorStop(0.5, 'rgba(230, 220, 255, 0.25)')
  g.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  return new THREE.CanvasTexture(c)
}

// A SEAMLESS bloom that truly melts into black. Real light bloom is
// multi-scale — a bright tight core stacked with a wide, very faint halo — so
// the intensity ramps down over a long, low tail with no visible boundary.
// A smooth (zero-slope) radial cutoff guarantees it reaches exactly 0 at the
// rim, so neither the falloff nor the square texture bounds ever show an edge.
function createBloomTexture() {
  const size = 512 // bigger canvas → finer gradient, no banding at the tail
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(size, size)
  const mid = (size - 1) / 2
  const half = size / 2
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - mid) / half
      const dy = (y - mid) / half
      const dd = dx * dx + dy * dy
      const d = Math.sqrt(dd)
      // three gaussians: tight bright core + mid + wide faint halo
      let a = 0.5 * Math.exp(-dd * 16) + 0.32 * Math.exp(-dd * 5.5) + 0.3 * Math.exp(-dd * 2.0)
      a *= 1 - smooth(0.8, 1.0, d) // ease to a true 0 at the rim, zero slope
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(255 * Math.min(1, a))
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

// Club-lighting environment reflected by the chrome tiles. A dark field with
// soft coloured light pools (amber, magenta, teal) + bright white spotlights;
// sampled by each tile's reflection vector so the colours sweep as it spins.
function createEnvTexture() {
  const s = 512
  const c = document.createElement('canvas')
  c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#08080c'
  ctx.fillRect(0, 0, s, s)
  ctx.globalCompositeOperation = 'lighter'
  const blob = (x, y, r, rgb, a) => {
    const g = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s)
    g.addColorStop(0, `rgba(${rgb},${a})`)
    g.addColorStop(1, `rgba(${rgb},0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x * s, y * s, r * s, 0, 7)
    ctx.fill()
  }
  // white ceiling spotlights → the big blown highlights
  blob(0.5, 0.16, 0.24, '255,255,255', 0.95)
  blob(0.74, 0.28, 0.15, '255,255,255', 0.7)
  blob(0.16, 0.24, 0.12, '245,245,255', 0.6)
  // amber / warm cluster
  blob(0.3, 0.52, 0.2, '255,150,50', 0.85)
  blob(0.2, 0.48, 0.1, '255,205,120', 0.9)
  // magenta
  blob(0.4, 0.78, 0.2, '214,74,200', 0.7)
  // teal / blue
  blob(0.82, 0.62, 0.24, '52,150,255', 0.6)
  blob(0.64, 0.86, 0.16, '90,205,220', 0.5)
  ctx.globalCompositeOperation = 'source-over'
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  return t
}

/* ───────── Event Images (mosaic atlas) ───────── */
const DEFAULT_IMAGES = [
  'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=400&h=400&fit=crop&q=60', // concert crowd
  'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=400&h=400&fit=crop&q=60', // stage lights
  'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=400&h=400&fit=crop&q=60', // live gig
  'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=400&h=400&fit=crop&q=60', // sparkler party
  'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=400&h=400&fit=crop&q=60', // concert
  'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=400&h=400&fit=crop&q=60', // party crowd
  'https://images.unsplash.com/photo-1519214605650-76a613ee3245?w=400&h=400&fit=crop&q=60', // cocktails
  'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=400&h=400&fit=crop&q=60', // bar at night
  'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=400&h=400&fit=crop&q=60', // city skyline
  'https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=400&h=400&fit=crop&q=60', // city at night
  'https://images.unsplash.com/photo-1545128485-c400e7702796?w=400&h=400&fit=crop&q=60',    // club dj
  'https://images.unsplash.com/photo-1566737236500-c8ac43014a67?w=400&h=400&fit=crop&q=60', // neon sign
  'https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?w=400&h=400&fit=crop&q=60', // concert hands
  'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400&h=400&fit=crop&q=60', // festival
  'https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?w=400&h=400&fit=crop&q=60', // celebration
  'https://images.unsplash.com/photo-1571266028243-d220c6a9b8a3?w=400&h=400&fit=crop&q=60', // night venue
]

// Neon "event card" placeholder — shown until (or if) the real image loads
function drawEventPlaceholder(ctx, x, y, size, seed) {
  let s = seed
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const palettes = [
    ['#ff2fd6', '#3b0764'], ['#00e5ff', '#1e1b4b'], ['#ff9d00', '#7f1d1d'],
    ['#a855f7', '#0f0026'], ['#22d3ee', '#312e81'], ['#fb7185', '#4c0519'],
  ]
  const [c1, c2] = palettes[Math.floor(rnd() * palettes.length)]
  const g = ctx.createLinearGradient(x, y, x + size, y + size)
  g.addColorStop(0, c1)
  g.addColorStop(1, c2)
  ctx.fillStyle = g
  ctx.fillRect(x, y, size, size)
  // Bokeh dots — reads as out-of-focus nightlife lights
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.08 + rnd() * 0.25})`
    ctx.beginPath()
    ctx.arc(x + rnd() * size, y + rnd() * size, 3 + rnd() * size * 0.12, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawCover(ctx, img, x, y, size) {
  const scale = Math.max(size / img.width, size / img.height)
  const w = img.width * scale
  const h = img.height * scale
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, size, size)
  ctx.clip()
  ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h)
  ctx.restore()
}

/* ───────── Constants ───────── */
const _white = new THREE.Color(1, 1, 1)
const OFF_Y = 10
const CORD_HEIGHT = 12
const CAM_Z = 6
const FOV_RAD = (45 * Math.PI) / 180

/* ───────── Attribute Schema ───────── */
// [jsProperty, htmlAttribute, type, default]
// type: 'f' = float, 'i' = int, 's' = string
const ATTRS = [
  ['speed', 'speed', 'f', 1],
  ['size', 'size', 'f', 200],
  ['segments', 'segments', 'i', 20],
  ['flatten', 'flatten', 'f', 0],
  ['envStrength', 'env-strength', 'f', 0], // metallic mirror reflection (0 = off)
  ['envPulse', 'env-pulse', 'f', 0], // reflected lights pulse to a beat
  ['shine', 'shine', 'f', 0], // gleam sweep across the chrome
  ['zoom', 'zoom', 'f', 1],
  ['clarity', 'clarity', 'f', 1],
  ['distortion', 'distortion', 'f', 1],
  ['shininess', 'shininess', 'f', 0.5],
  ['specular', 'specular', 'f', 1],
  ['keyX', 'key-x', 'f', 2],
  ['keyY', 'key-y', 'f', 3],
  ['keyZ', 'key-z', 'f', 3],
  ['keyStrength', 'key-strength', 'f', 1],
  ['fillX', 'fill-x', 'f', -2],
  ['fillY', 'fill-y', 'f', 1],
  ['fillZ', 'fill-z', 'f', 2],
  ['fillStrength', 'fill-strength', 'f', 0.5],
  ['topX', 'top-x', 'f', 0],
  ['topY', 'top-y', 'f', 4],
  ['topZ', 'top-z', 'f', 1],
  ['topStrength', 'top-strength', 'f', 0.6],
  ['rim1Strength', 'rim1-strength', 'f', 0.6],
  ['rim1Sharpness', 'rim1-sharpness', 'f', 0.5],
  ['rim1X', 'rim1-x', 'f', 0],
  ['rim1Y', 'rim1-y', 'f', 1],
  ['rim2Strength', 'rim2-strength', 'f', 0.4],
  ['rim2Sharpness', 'rim2-sharpness', 'f', 0.5],
  ['rim2X', 'rim2-x', 'f', 0],
  ['rim2Y', 'rim2-y', 'f', -1],
  ['lightIntensity', 'light-intensity', 'f', 1],
  ['ambient', 'ambient', 'f', 0.3],
  ['tint', 'tint', 's', '#1db954'],
  ['tintStrength', 'tint-strength', 'f', 0],
  ['sparkleCount', 'sparkle-count', 'i', 8],
  ['sparkleSize', 'sparkle-size', 'f', 0.5],
  ['sparkleStrength', 'sparkle-strength', 'f', 1],
  ['sparkleSpeed', 'sparkle-speed', 'f', 1],
  ['reflectionCount', 'reflection-count', 'i', 12],
  ['reflectionSize', 'reflection-size', 'f', 0.3],
  ['reflectionStrength', 'reflection-strength', 'f', 0.5],
  ['reflectionSpread', 'reflection-spread', 'f', 1.5],
  ['reflectionTint', 'reflection-tint', 'f', 0],
  ['targetX', 'target-x', 'f', 0],
  ['targetY', 'target-y', 'f', 0],
  ['photoRatio', 'photo-ratio', 'f', 0.56],
  ['cycleSpeed', 'cycle-speed', 'f', 0.26],
  ['glowStrength', 'glow-strength', 'f', 0.38],
  ['glowSize', 'glow-size', 'f', 0.4],
  ['glowColor', 'glow-color', 's', '#bb37bf'],
  // independent glow-layer amounts (multiply the master strength):
  ['glowBloom', 'glow-bloom', 'f', 0], // seamless gaussian haze (0 = off → app unchanged)
  ['glowRays', 'glow-rays', 'f', 1], // spiky radial rays + edge ring
  ['glowFlare', 'glow-flare', 'f', 1], // top/bottom cross starbursts + bottom haze
  ['images', 'images', 's', ''],
]

const BOOL_ATTRS = ['disco', 'show-helpers', 'show-reflections', 'webcam', 'mosaic']

/* ───────── Uniform Schema ───────── */
// [uniformName, type, ...getterProps]
// type: 's' = scalar, 'v2' = Vector2, 'v3' = Vector3
const UNIFORMS = [
  ['uRows', 's', 'segments'],
  ['uFlatten', 's', 'flatten'],
  ['uEnvStrength', 's', 'envStrength'],
  ['uEnvPulse', 's', 'envPulse'],
  ['uShine', 's', 'shine'],
  ['uZoom', 's', 'zoom'],
  ['uClarity', 's', 'clarity'],
  ['uDistortion', 's', 'distortion'],
  ['uShininess', 's', 'shininess'],
  ['uSpecular', 's', 'specular'],
  ['uKeyLightPos', 'v3', 'keyX', 'keyY', 'keyZ'],
  ['uKeyStrength', 's', 'keyStrength'],
  ['uFillLightPos', 'v3', 'fillX', 'fillY', 'fillZ'],
  ['uFillStrength', 's', 'fillStrength'],
  ['uTopLightPos', 'v3', 'topX', 'topY', 'topZ'],
  ['uTopStrength', 's', 'topStrength'],
  ['uRim1Strength', 's', 'rim1Strength'],
  ['uRim1Sharpness', 's', 'rim1Sharpness'],
  ['uRim1Pos', 'v2', 'rim1X', 'rim1Y'],
  ['uRim2Strength', 's', 'rim2Strength'],
  ['uRim2Sharpness', 's', 'rim2Sharpness'],
  ['uRim2Pos', 'v2', 'rim2X', 'rim2Y'],
  ['uLightIntensity', 's', 'lightIntensity'],
  ['uAmbient', 's', 'ambient'],
  ['uTintStrength', 's', 'tintStrength'],
  ['uPhotoRatio', 's', 'photoRatio'],
  ['uCycleSpeed', 's', 'cycleSpeed'],
]

/* ───────── Light Helper Definitions ───────── */
// [instanceKey, color, xProp, yProp, zProp]
const HELPERS = [
  ['_keyHelper', 0xffff00, 'keyX', 'keyY', 'keyZ'],
  ['_fillHelper', 0x00ffff, 'fillX', 'fillY', 'fillZ'],
  ['_topHelper', 0xff00ff, 'topX', 'topY', 'topZ'],
]

/* ───────── Web Component ───────── */
class DiscoBall extends HTMLElement {
  static observedAttributes = [...BOOL_ATTRS, ...ATTRS.map((a) => a[1])]

  // Generate attribute getters from schema
  static {
    for (const [prop, attr, type, def] of ATTRS) {
      Object.defineProperty(this.prototype, prop, {
        get() {
          const v = this.getAttribute(attr)
          if (v === null) return def
          return type === 'i' ? parseInt(v, 10) : type === 'f' ? parseFloat(v) : v
        },
      })
    }
  }

  constructor() {
    super()
    Object.assign(this, {
      _elapsed: 0, _ballRotation: 0, _lastTime: 0,
      _rafId: null, _animating: false, _discoTimeline: null,
      // Dirty flags
      _dirtyUniforms: true, _dirtySize: true, _dirtySparkleCount: true,
      _dirtyReflectionCount: true, _dirtyHelpers: true,
      // Three.js references
      _renderer: null, _scene: null, _camera: null,
      _ballGroup: null, _ball: null, _ballMaterial: null, _cord: null,
      _sparkles: [], _sparkleTexture: null,
      _reflections: [], _reflectionTexture: null,
      _tintColor: new THREE.Color(this.tint),
      // Mosaic atlas + glow layers
      _atlasTexture: null, _glows: [],
      _topFlare: null, _bottomFlare: null, _bottomGlow: null, _halo: null, _bloom: null,
      _glowTexture: null, _flareTexture: null, _haloTexture: null, _bloomTexture: null,
      _envTexture: null,
      _glowStrength: 1, _glowSize: 1, _glowColorObj: new THREE.Color('#bb37bf'),
      _glowBloom: 0, _glowRays: 1, _glowFlare: 1,
      // Webcam
      _videoTexture: null, _webcamStream: null, _webcamReady: false, _video: null,
      // Light helpers
      _helpersInScene: false,
      // Cached layout values
      _cachedVisibleHeight: 2 * Math.tan(FOV_RAD / 2) * CAM_Z, _hostHeight: 0,
      // Cached hot-path values (updated in _applyUniforms)
      _speed: 1, _sparkleSpeed: 1, _sparkleStrength: 1, _sparkleSize: 0.5,
      _sizeVal: 200, _reflectionSize: 0.3, _reflectionStrength: 0.5,
      _reflectionSpread: 1.5, _reflectionTint: 0,
      // Bound handlers
      _onResize: this._resize.bind(this),
      _boundLoop: this._loop.bind(this),
    })
  }

  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>:host{display:block}canvas{display:block;width:100%;height:100%}</style>`
    this._canvas = document.createElement('canvas')
    shadow.appendChild(this._canvas)

    this._initScene()
    this._envTexture = createEnvTexture() // needed by _initBall's uniforms
    this._initBall()
    this._initCord()
    this._sparkleTexture = createSparkleTexture()
    this._initSparkles()
    this._reflectionTexture = createReflectionTexture()
    this._initReflections()
    this._glowTexture = createGlowTexture()
    this._flareTexture = createFlareTexture()
    this._haloTexture = createHaloTexture()
    this._bloomTexture = createBloomTexture()
    this._initGlows()
    if (this.hasAttribute('mosaic')) this._initAtlas()
    this._initLightHelpers()
    this._resize()

    window.addEventListener('resize', this._onResize)

    // If disco attribute is already set, toggle on
    if (this.hasAttribute('disco')) {
      this._toggleDisco(true)
    }

    this._scheduleLoop()
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize)
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    this._stopWebcam(true)
    this._dispose()
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (!this._renderer) return
    if (oldValue === newValue) return

    if (name === 'disco') {
      this._toggleDisco(this.hasAttribute('disco'))
      return
    }

    if (name === 'show-helpers') {
      this._dirtyHelpers = true
      this._scheduleLoop()
      return
    }

    if (name === 'webcam') {
      if (this.hasAttribute('disco')) {
        if (this.hasAttribute('webcam')) {
          this._startWebcam()
        } else {
          this._stopWebcam()
          this._ballMaterial.uniforms.uHasVideo.value = 0
        }
      }
      this._scheduleLoop()
      return
    }

    if (name === 'mosaic') {
      if (this.hasAttribute('mosaic') && !this._atlasTexture) this._initAtlas()
    }

    if (name === 'images') {
      if (this._atlasTexture) {
        this._atlasTexture.dispose()
        this._atlasTexture = null
        this._ballMaterial.uniforms.uAtlasTexture.value = null
      }
      if (this.hasAttribute('mosaic')) this._initAtlas()
    }

    if (name === 'size') {
      this._dirtySize = true
    }

    if (name === 'sparkle-count') {
      this._dirtySparkleCount = true
    }

    if (name === 'target-x' || name === 'target-y') {
      if (this.hasAttribute('disco') && !this._animating) {
        const t = this._targetToWorld()
        this._ballGroup.position.x = t.x
        this._ballGroup.position.y = t.y
      }
      this._scheduleLoop()
    }

    if (
      name === 'show-reflections' ||
      name === 'reflection-count' ||
      name === 'segments'
    ) {
      this._dirtyReflectionCount = true
    }

    this._dirtyUniforms = true
    this._scheduleLoop()
  }

  /* ───────── Scene Setup ───────── */
  _initScene() {
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true,
    })
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this._renderer.setClearColor(0x000000, 0)

    this._scene = new THREE.Scene()

    this._camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this._camera.position.set(0, 0, CAM_Z)
  }

  _initBall() {
    this._ballGroup = new THREE.Group()
    this._ballGroup.position.y = OFF_Y
    this._scene.add(this._ballGroup)

    // Build uniforms from schema + special entries
    const uniforms = {
      uVideoTexture: { value: null },
      uEnvTexture: { value: this._envTexture },
      uTime: { value: 0 },
      uHasVideo: { value: 0 },
      uVideoAspect: { value: 16 / 9 },
      uRotation: { value: 0 },
      uTint: { value: this._tintColor },
      uAtlasTexture: { value: null },
      uHasAtlas: { value: 0 },
      uAtlasGrid: { value: 4 },
      uImageCount: { value: 16 },
      uFadeTint: { value: new THREE.Color('#bb37bf') },
    }
    for (const [name, type, ...props] of UNIFORMS) {
      if (type === 'v3')
        uniforms[name] = {
          value: new THREE.Vector3(...props.map((p) => this[p])),
        }
      else if (type === 'v2')
        uniforms[name] = {
          value: new THREE.Vector2(...props.map((p) => this[p])),
        }
      else uniforms[name] = { value: this[props[0]] }
    }

    const ballGeometry = new THREE.SphereGeometry(1, 64, 64)
    this._ballMaterial = new THREE.ShaderMaterial({
      vertexShader: ballVertexShader,
      fragmentShader: ballFragmentShader,
      uniforms,
    })
    this._ball = new THREE.Mesh(ballGeometry, this._ballMaterial)
    this._ballGroup.add(this._ball)
  }

  _initCord() {
    const cordGeometry = new THREE.CylinderGeometry(
      0.002,
      0.002,
      CORD_HEIGHT,
      4
    )
    const cordMaterial = new THREE.MeshBasicMaterial({ color: 0x333333 })
    this._cord = new THREE.Mesh(cordGeometry, cordMaterial)
    this._ballGroup.add(this._cord)
  }

  _clearSpriteArray(arr, parent) {
    for (let i = 0; i < arr.length; i++) {
      parent.remove(arr[i].sprite)
      arr[i].mat.dispose()
    }
    arr.length = 0
  }

  _initSparkles() {
    this._clearSpriteArray(this._sparkles, this._ballGroup)

    const count = this.sparkleCount
    for (let i = 0; i < count; i++) {
      const theta = Math.acos(1 - Math.random() * 1.4)
      const phi = (Math.random() - 0.5) * Math.PI * 1.4

      const mat = new THREE.SpriteMaterial({
        map: this._sparkleTexture,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      })

      const sprite = new THREE.Sprite(mat)
      sprite.renderOrder = 1

      const sizeVariance = 0.5 + Math.random() * 1.0
      const r = this._pxToWorld(this.size) * 1.06
      sprite.position.set(
        r * Math.sin(theta) * Math.cos(phi),
        r * Math.cos(theta),
        r * Math.sin(theta) * Math.sin(phi)
      )
      sprite.scale.setScalar(this.sparkleSize * sizeVariance)

      this._ballGroup.add(sprite)
      this._sparkles.push({
        sprite,
        mat,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 1.5 + Math.random() * 3,
        sizeVariance,
        theta,
        phi,
      })
    }
  }

  _pickReflectionTiles(count) {
    const rows = this.segments
    // Build list of all tiles with their row/col info
    const allTiles = []
    for (let r = 0; r < rows; r++) {
      const rowTheta = ((r + 0.5) / rows) * Math.PI
      const cols = Math.max(4, Math.floor(rows * 2 * Math.sin(rowTheta)))
      for (let c = 0; c < cols; c++) {
        allTiles.push({ rowIndex: r, colIndex: c, rows, cols })
      }
    }
    // Stride-based sampling for even distribution
    const total = allTiles.length
    const stride = Math.max(1, Math.floor(total / count))
    const tiles = []
    for (let i = 0; i < count && i * stride < total; i++) {
      tiles.push(allTiles[i * stride])
    }
    return tiles
  }

  _initReflections() {
    this._clearSpriteArray(this._reflections, this._scene)

    if (!this.hasAttribute('show-reflections')) return

    const count = this.reflectionCount
    const tiles = this._pickReflectionTiles(count)

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      const mat = new THREE.SpriteMaterial({
        map: this._reflectionTexture,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0,
        color: new THREE.Color(0xffffff),
      })

      const sprite = new THREE.Sprite(mat)
      sprite.renderOrder = 2

      // Tile aspect ratio: width / height at this latitude
      const rowTheta = ((tile.rowIndex + 0.5) / tile.rows) * Math.PI
      const tileHeight = Math.PI / tile.rows
      const tileWidth = ((2 * Math.PI) / tile.cols) * Math.sin(rowTheta)
      const aspect = tileWidth / tileHeight

      this._scene.add(sprite)
      this._reflections.push({ sprite, mat, tile, aspect })
    }
  }

  _updateReflections() {
    if (this._reflections.length === 0) return

    const spread = this._reflectionSpread
    const sizeScale = this._reflectionSize
    const strength = this._reflectionStrength
    const rotation = this._ballRotation

    // Ball world-space radius for sizing reflections to match segments
    const ballWorldSize = this._pxToWorld(this._sizeVal)
    const rows = this._ballMaterial.uniforms.uRows.value

    // Base tile height in world units
    const baseTileH = (Math.PI / rows) * ballWorldSize * sizeScale

    // Key light direction for brightness modulation
    const u = this._ballMaterial.uniforms
    const lx = u.uKeyLightPos.value.x
    const ly = u.uKeyLightPos.value.y
    const lz = u.uKeyLightPos.value.z
    const lLen = Math.sqrt(lx * lx + ly * ly + lz * lz)
    const lightDirX = lx / lLen
    const lightDirY = ly / lLen
    const lightDirZ = lz / lLen

    // Match shader's rotateY(localTileN, uRotation) exactly
    const cosR = Math.cos(rotation)
    const sinR = Math.sin(rotation)

    // Track ball's vertical position so reflections follow the bounce
    const ballY = this._ballGroup.position.y

    for (let i = 0; i < this._reflections.length; i++) {
      const { sprite, mat, tile, aspect } = this._reflections[i]
      const { rowIndex, colIndex, rows, cols } = tile

      // Tile local normal — matches shader: cos(colPhi - PI), sin(colPhi - PI)
      const rowTheta = ((rowIndex + 0.5) / rows) * Math.PI
      const colPhi = ((colIndex + 0.5) / cols) * 2 * Math.PI - Math.PI

      const sinRowTheta = Math.sin(rowTheta)
      const localNx = sinRowTheta * Math.cos(colPhi - Math.PI)
      const localNy = Math.cos(rowTheta)
      const localNz = sinRowTheta * Math.sin(colPhi - Math.PI)

      // Rotate local → world with +rotation (same as shader)
      const nx = localNx * cosR + localNz * sinR
      const ny = localNy
      const nz = -localNx * sinR + localNz * cosR

      // Back hemisphere only — these are the tiles facing the wall behind the ball
      if (nz >= 0) {
        mat.opacity = 0
        continue
      }

      // Project onto wall using sphere normal components
      sprite.position.set(nx * spread, ny * spread + ballY, -spread)
      sprite.scale.set(baseTileH * aspect, baseTileH, 1)

      // -nz: brighter when tile faces the wall more directly (nz is negative here)
      const facingWall = -nz

      // Light modulation
      const facingLight = Math.max(
        0,
        nx * lightDirX + ny * lightDirY + nz * lightDirZ
      )

      mat.opacity = strength * facingWall * (0.3 + 0.7 * facingLight)
    }
  }

  _initLightHelpers() {
    const geo = new THREE.SphereGeometry(0.1, 8, 8)
    for (const [key, color] of HELPERS) {
      this[key] = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }))
    }
  }

  /* ───────── Mosaic Atlas ───────── */
  _initAtlas() {
    const urls = (this.images || '').split(',').map((s) => s.trim()).filter(Boolean)
    const list = urls.length ? urls : DEFAULT_IMAGES
    const grid = Math.ceil(Math.sqrt(list.length))
    const cell = 256

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = grid * cell
    const ctx = canvas.getContext('2d')

    // Neon placeholders first — every cell is valid even before/without network
    for (let i = 0; i < grid * grid; i++) {
      drawEventPlaceholder(
        ctx,
        (i % grid) * cell,
        Math.floor(i / grid) * cell,
        cell,
        i * 7919 + 17
      )
    }

    const tex = new THREE.CanvasTexture(canvas)
    // No mipmaps — atlas is sampled inside a non-uniform branch per tile
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    this._atlasTexture = tex

    const u = this._ballMaterial.uniforms
    u.uAtlasTexture.value = tex
    u.uAtlasGrid.value = grid
    u.uImageCount.value = list.length

    list.forEach((url, i) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (this._atlasTexture !== tex) return
        drawCover(ctx, img, (i % grid) * cell, Math.floor(i / grid) * cell, cell)
        tex.needsUpdate = true
        this._scheduleLoop()
      }
      img.src = url
    })
  }

  /* ───────── Glow Layers (top flare + bottom haze) ───────── */
  _initGlows() {
    const mk = (map, color, opts = {}) => {
      const mat = new THREE.SpriteMaterial({
        map,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: opts.depthTest ?? false,
        opacity: 0,
        color: new THREE.Color(color),
      })
      const sprite = new THREE.Sprite(mat)
      sprite.renderOrder = opts.renderOrder ?? 3
      this._ballGroup.add(sprite)
      this._glows.push({ sprite, mat })
      return sprite
    }
    // Seamless gaussian bloom — a single soft haze around the whole ball
    this._bloom = mk(this._bloomTexture, '#bb37bf', { depthTest: false, renderOrder: 0 })
    // Surrounding halo: ring + rays behind the ball (ball occludes its center)
    this._halo = mk(this._haloTexture, '#bb37bf', { depthTest: true, renderOrder: 0 })
    this._bottomGlow = mk(this._glowTexture, '#bb37bf')
    this._topFlare = mk(this._flareTexture, '#ffffff', { renderOrder: 4 })
    this._bottomFlare = mk(this._flareTexture, '#ffffff', { renderOrder: 4 })
  }

  _updateGlows() {
    if (!this._topFlare || !this._hostHeight) return
    const r = this._pxToWorld(this._sizeVal)
    const gs = this._glowSize
    this._topFlare.position.set(0, r * 1.02, r * 0.2)
    this._topFlare.scale.set(r * 2.4 * gs, r * 2.4 * gs, 1)
    this._bottomFlare.position.set(0, -r * 1.02, r * 0.2)
    this._bottomFlare.scale.set(r * 1.5 * gs, r * 1.5 * gs, 1)
    this._bottomGlow.position.set(0, -r * 1.05, 0)
    this._bottomGlow.scale.set(r * 5 * gs, r * 3.5 * gs, 1)
    // Halo keeps a fixed proportion to the ball — its rays must always
    // clear the silhouette, so glow size does not scale it
    this._halo.position.set(0, 0, -r * 0.4)
    this._halo.scale.set(r * 5, r * 5, 1)
    // Seamless bloom: centred behind the ball, wide and soft, scales with size
    this._bloom.position.set(0, 0, -r * 0.3)
    this._bloom.scale.set(r * 6.5 * gs, r * 6.5 * gs, 1)
  }

  _updateGlowOpacity() {
    if (!this._topFlare) return
    const gs = this._glowStrength
    const rays = this._glowRays
    const flare = this._glowFlare
    const bloom = this._glowBloom
    const e = this._elapsed
    // White light from the north and south poles (cross starbursts)
    this._topFlare.material.opacity = Math.min(1, gs * flare * 2 * (0.8 + 0.2 * Math.sin(e * 2.7)))
    this._bottomFlare.material.opacity = Math.min(1, gs * flare * 2 * (0.55 + 0.15 * Math.sin(e * 2.3 + 0.7)))
    this._bottomGlow.material.opacity = gs * flare * 0.6
    // Purple rays: slow, deep fade in / fade out + a gentle drift
    this._halo.material.opacity = gs * rays * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(e * 0.7)))
    this._halo.material.rotation = e * 0.04
    // Seamless bloom: near-steady, only a whisper of breathing
    this._bloom.material.opacity = gs * bloom * (0.92 + 0.08 * Math.sin(e * 0.5))
  }

  /* ───────── Webcam ───────── */
  _startWebcam() {
    if (!this._video) {
      this._video = Object.assign(document.createElement('video'), {
        autoplay: true,
        loop: true,
        muted: true,
        playsInline: true,
      })
    }

    if (this._webcamReady) {
      this._video.play()
      this._ballMaterial.uniforms.uHasVideo.value = 1.0
      return
    }

    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720 } })
      .then((stream) => {
        this._webcamStream = stream
        this._video.srcObject = stream
        this._video.play()
        this._videoTexture = new THREE.VideoTexture(this._video)
        this._videoTexture.minFilter = THREE.LinearFilter
        this._videoTexture.magFilter = THREE.LinearFilter
        this._ballMaterial.uniforms.uVideoTexture.value = this._videoTexture
        // Wait for actual frame data, then pre-upload texture to GPU before enabling.
        // This avoids both the tint flash (no video data) and a frame skip
        // (synchronous GPU upload of 1280x720 during a render call).
        const onFrame = () => {
          if (this._video.readyState >= this._video.HAVE_CURRENT_DATA) {
            this._renderer.initTexture(this._videoTexture)
            this._ballMaterial.uniforms.uVideoAspect.value =
              this._video.videoWidth / this._video.videoHeight
            this._ballMaterial.uniforms.uHasVideo.value = 1.0
          } else {
            requestAnimationFrame(onFrame)
          }
        }
        requestAnimationFrame(onFrame)
        this._webcamReady = true
      })
      .catch((err) => console.warn('Webcam unavailable:', err))
  }

  _stopWebcam(dispose = false) {
    if (this._video) this._video.pause()
    if (dispose && this._webcamStream) {
      this._webcamStream.getTracks().forEach((t) => t.stop())
      this._webcamStream = null
      this._webcamReady = false
      if (this._videoTexture) {
        this._videoTexture.dispose()
        this._videoTexture = null
      }
    }
  }

  /* ───────── Disco Toggle ───────── */
  _toggleDisco(on) {
    if (this._discoTimeline) {
      this._discoTimeline.kill()
      this._discoTimeline = null
    }

    const hasGsap = typeof gsap !== 'undefined'

    if (on) {
      if (this.hasAttribute('webcam')) this._startWebcam()
      if (hasGsap) {
        this._animating = true
        this._discoTimeline = gsap.timeline({
          onComplete: () => {
            this._animating = false
          },
        })
        const t = this._targetToWorld()
        this._discoTimeline.to(this._ballGroup.position, {
          x: t.x,
          y: t.y,
          ease: 'power2.out(1.2)',
          duration: 0.5,
        })
      } else {
        const t = this._targetToWorld()
        this._ballGroup.position.x = t.x
        this._ballGroup.position.y = t.y
      }
      this._scheduleLoop()
    } else {
      if (hasGsap) {
        this._animating = true
        this._discoTimeline = gsap.timeline({
          onComplete: () => {
            this._animating = false
            if (this.hasAttribute('webcam')) this._stopWebcam()
          },
        })
        this._discoTimeline.to(this._ballGroup.position, {
          y: OFF_Y,
          ease: 'power3.in',
          duration: 0.3,
        })
      } else {
        this._ballGroup.position.y = OFF_Y
        if (this.hasAttribute('webcam')) this._stopWebcam()
      }
    }
  }

  /* ───────── Render Loop ───────── */
  _scheduleLoop() {
    if (this._rafId) return
    this._lastTime = performance.now()
    this._rafId = requestAnimationFrame(this._boundLoop)
  }

  _loop(now) {
    this._rafId = null

    const dt = (now - this._lastTime) / 1000
    this._lastTime = now

    const isDisco = this.hasAttribute('disco')

    // Process dirty flags
    if (this._dirtySparkleCount) {
      this._dirtySparkleCount = false
      this._initSparkles()
    }

    if (this._dirtyReflectionCount) {
      this._dirtyReflectionCount = false
      this._initReflections()
    }

    if (this._dirtySize) {
      this._dirtySize = false
      this._updateBallSize()
    }

    if (this._dirtyHelpers) {
      this._dirtyHelpers = false
      this._updateHelpers()
    }

    if (this._dirtyUniforms) {
      this._dirtyUniforms = false
      this._applyUniforms()
    }

    if (isDisco || this._animating) {
      this._elapsed += dt
      this._ballRotation += dt * this._speed * 1.2

      // Always update time-varying uniforms
      this._ballMaterial.uniforms.uRotation.value = this._ballRotation
      this._ballMaterial.uniforms.uTime.value = this._elapsed

      this._updateSparkles()
      this._updateReflections()
      this._updateGlowOpacity()
    }

    this._renderer.render(this._scene, this._camera)

    // Keep looping while disco is active or animating
    if (isDisco || this._animating) {
      this._rafId = requestAnimationFrame(this._boundLoop)
    }
  }

  _applyUniforms() {
    const u = this._ballMaterial.uniforms

    // Cache values read in the hot loop
    this._speed = this.speed
    this._sparkleSpeed = this.sparkleSpeed
    this._sparkleStrength = this.sparkleStrength
    this._sparkleSize = this.sparkleSize
    this._sizeVal = this.size
    this._reflectionSize = this.reflectionSize
    this._reflectionStrength = this.reflectionStrength
    this._reflectionSpread = this.reflectionSpread
    this._reflectionTint = this.reflectionTint

    this._tintColor.set(this.tint)

    // Glow layers
    this._glowStrength = this.glowStrength
    this._glowSize = this.glowSize
    this._glowBloom = this.glowBloom
    this._glowRays = this.glowRays
    this._glowFlare = this.glowFlare
    this._glowColorObj.set(this.glowColor)
    if (this._topFlare) {
      // Rays, bottom haze and bloom take the glow color as-is — purple, not white
      this._halo.material.color.copy(this._glowColorObj)
      this._bottomGlow.material.color.copy(this._glowColorObj)
      this._bloom.material.color.copy(this._glowColorObj)
      this._updateGlows()
      this._updateGlowOpacity()
    }
    u.uFadeTint.value.set(this.glowColor)

    // Mosaic
    u.uHasAtlas.value =
      this.hasAttribute('mosaic') && this._atlasTexture ? 1 : 0

    // Sync tint to reflection sprites
    const refTint = this._reflectionTint
    for (let i = 0; i < this._reflections.length; i++) {
      const m = this._reflections[i].mat
      if (refTint > 0) {
        m.color.copy(this._tintColor).lerp(_white, 1 - refTint)
      } else {
        m.color.set(0xffffff)
      }
    }

    // Sync uniforms from schema
    for (const [name, type, ...props] of UNIFORMS) {
      if (type === 'v3') u[name].value.set(...props.map((p) => this[p]))
      else if (type === 'v2') u[name].value.set(...props.map((p) => this[p]))
      else u[name].value = this[props[0]]
    }
    u.uTint.value = this._tintColor

    // Update helper positions
    if (this._helpersInScene) {
      for (const [key, , ...props] of HELPERS) {
        this[key].position.set(...props.map((p) => this[p]))
      }
    }
  }

  _updateSparkles() {
    const worldSize = this._pxToWorld(this._sizeVal)
    const elapsed = this._elapsed
    const sparkleSpeed = this._sparkleSpeed
    const sparkleStrength = this._sparkleStrength
    const sparkleSize = this._sparkleSize
    const sparkles = this._sparkles
    for (let i = 0; i < sparkles.length; i++) {
      const s = sparkles[i]
      const v = Math.sin(elapsed * s.twinkleSpeed * sparkleSpeed + s.phase)
      const brightness = v > 0 ? v * v * v * v : 0
      s.mat.opacity = brightness * sparkleStrength
      s.sprite.scale.setScalar(
        sparkleSize * s.sizeVariance * worldSize * (0.7 + brightness * 0.3)
      )
    }
  }

  _updateBallSize() {
    const s = this._pxToWorld(this.size)
    this._ball.scale.setScalar(s)
    this._cord.position.y = s + CORD_HEIGHT / 2
    this._sparkles.forEach((sp) => {
      const r = s * 1.06
      sp.sprite.position.set(
        r * Math.sin(sp.theta) * Math.cos(sp.phi),
        r * Math.cos(sp.theta),
        r * Math.sin(sp.theta) * Math.sin(sp.phi)
      )
      sp.sprite.scale.setScalar(this.sparkleSize * sp.sizeVariance * s)
    })
    this._updateGlows()
  }

  _updateHelpers() {
    const show = this.hasAttribute('show-helpers')
    for (const [key, , ...props] of HELPERS) {
      this._scene[show ? 'add' : 'remove'](this[key])
      if (show) this[key].position.set(...props.map((p) => this[p]))
    }
    this._helpersInScene = show
  }

  _pxToWorld(px) {
    return (px * this._cachedVisibleHeight) / (2 * this._hostHeight)
  }

  // Convert normalized [-1, 1] target coords to world units
  _targetToWorld() {
    const vh = this._cachedVisibleHeight
    const aspect = this._camera ? this._camera.aspect : 1
    return {
      x: (this.targetX * (vh * aspect)) / 2,
      y: (this.targetY * vh) / 2,
    }
  }

  _resize() {
    const rect = this.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    this._hostHeight = rect.height
    this._camera.aspect = rect.width / rect.height
    this._camera.updateProjectionMatrix()
    this._renderer.setSize(rect.width, rect.height, false)
    this._updateBallSize()
    this._scheduleLoop()
  }

  _dispose() {
    if (!this._renderer) return

    this._clearSpriteArray(this._sparkles, this._ballGroup)
    this._clearSpriteArray(this._reflections, this._scene)
    this._clearSpriteArray(this._glows, this._ballGroup)

    if (this._reflectionTexture) this._reflectionTexture.dispose()
    if (this._sparkleTexture) this._sparkleTexture.dispose()
    if (this._glowTexture) this._glowTexture.dispose()
    if (this._flareTexture) this._flareTexture.dispose()
    if (this._haloTexture) this._haloTexture.dispose()
    if (this._atlasTexture) this._atlasTexture.dispose()
    if (this._ball) {
      this._ball.geometry.dispose()
      this._ballMaterial.dispose()
    }
    if (this._cord) {
      this._cord.geometry.dispose()
      this._cord.material.dispose()
    }
    // Helpers share geometry — dispose once
    if (this._keyHelper) this._keyHelper.geometry.dispose()
    for (const [key] of HELPERS) {
      if (this[key]) this[key].material.dispose()
    }

    this._renderer.dispose()
    this._renderer = null
  }
}

customElements.define('disco-ball', DiscoBall)

export { DiscoBall }
