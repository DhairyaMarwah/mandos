// Build a Lottie disco ball with event photos matted onto its tiles.
// The source ball spins by morphing tiles (rigid Lottie images can't follow that),
// so we FREEZE the tile grid at one frame → static ball, then track-matte a photo
// onto a subset of front-facing tiles. Fills keep shimmering = the "pulse".
const fs = require('fs')

const SRC = './discoball.json'
const OUT = './discoball-photos.json'
const FREEZE = 40           // frame to freeze the tile shapes at
const N_PHOTOS = 34         // how many tiles get a photo

const IMG_IDS = [
  '1470229722913-7c0e2dbbafd3','1514525253161-7a46d19cd819','1516450360452-9312f5e86fc7','1492684223066-81342ee5ff30',
  '1429962714451-bb934ecdc4ec','1533174072545-7a4b6ad7a6c3','1519214605650-76a613ee3245','1514933651103-005eec06c04b',
  '1477959858617-67f85cf4f1df','1502920917128-1aa500764cbd','1545128485-c400e7702796','1566737236500-c8ac43014a67',
  '1524368535928-5b5e00ddc76b','1506157786151-b8491531f063','1519671482749-fd09be7ccebf','1571266028243-d220c6a9b8a3',
]
const IMG_URL = (id) => `https://images.unsplash.com/photo-${id}?w=300&h=300&fit=crop&q=60`

const j = JSON.parse(fs.readFileSync(SRC, 'utf8'))
const pc = j.assets.find((a) => a.layers)

// ── shape at a given frame (nearest keyframe ≤ FREEZE) ──
const shapeAt = (ks, f) => {
  if (ks.a !== 1) return ks.k
  let best = ks.k[0].s[0]
  for (const kf of ks.k) { if (kf.t <= f && kf.s) best = kf.s[0] }
  return best
}

// ── collect every tile with its comp-space frozen shape + bbox ──
const tiles = []
for (const L of pc.layers) {
  const lp = L.ks.p.k, la = L.ks.a.k, ls = L.ks.s.k
  const sx = ls[0] / 100, sy = ls[1] / 100
  for (const grp of L.shapes) {
    if (grp.ty !== 'gr') continue
    const path = grp.it.find((x) => x.ty === 'sh')
    const tr = grp.it.find((x) => x.ty === 'tr')
    if (!path || !tr) continue
    const shp = shapeAt(path.ks, FREEZE)
    const tp = tr.p.k
    // → comp space
    const toComp = (vx, vy) => [ (tp[0] + vx - la[0]) * sx + lp[0], (tp[1] + vy - la[1]) * sy + lp[1] ]
    const v = shp.v.map(([x, y]) => toComp(x, y))
    const iH = shp.i.map(([x, y]) => [x * sx, y * sy])
    const oH = shp.o.map(([x, y]) => [x * sx, y * sy])
    const xs = v.map((p) => p[0]), ys = v.map((p) => p[1])
    const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2
    const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0
    // freeze the source path in place so the ball stops spinning
    path.ks.a = 0
    path.ks.k = { i: shp.i, o: shp.o, v: shp.v, c: shp.c }
    tiles.push({ v, iH, oH, c: shp.c, cx, cy, w, h, area: w * h })
  }
}
console.log('total tiles:', tiles.length)

// ── pick well-placed front tiles: near centre, reasonable size, spread out ──
const CX = 500, CY = 500
const cand = tiles
  .filter((t) => Math.hypot(t.cx - CX, t.cy - CY) < 330 && t.w > 26 && t.h > 26 && t.w < 130 && t.h < 130)
  .sort((a, b) => b.area - a.area)
const chosen = []
for (const t of cand) {
  if (chosen.length >= N_PHOTOS) break
  if (chosen.every((c) => Math.hypot(c.cx - t.cx, c.cy - t.cy) > 46)) chosen.push(t)
}
console.log('photo tiles:', chosen.length)

// ── assets: one image per chosen tile ──
j.assets = j.assets || []
chosen.forEach((t, i) => {
  j.assets.push({ id: `evt_${i}`, w: 300, h: 300, u: '', p: IMG_URL(IMG_IDS[i % IMG_IDS.length]), e: 0 })
})

// ── pulse: staggered opacity so photos breathe with the ball ──
const EASE = { i: { x: [0.6], y: [1] }, o: { x: [0.4], y: [0] } }
const pulseOpacity = (phase) => {
  const lo = 68, hi = 100, per = 30 // frames
  const kf = []
  for (let t = 0; t <= j.op + per; t += per / 2) {
    const up = Math.floor(t / (per / 2)) % 2 === (phase % 2)
    kf.push({ ...EASE, t: Math.round(t), s: [up ? hi : lo] })
  }
  kf[kf.length - 1] = { t: kf[kf.length - 1].t, s: [kf[kf.length - 1].s[0]] }
  return { a: 1, k: kf }
}

// ── build matte + image layer pairs (matte above the image) ──
const T = (a, k) => ({ a, k })
let ind = 5000
const newLayers = []
chosen.forEach((t, i) => {
  const matteInd = ind++, imgInd = ind++
  // matte = the tile shape, white fill, flagged td
  newLayers.push({
    ddd: 0, ind: matteInd, ty: 4, nm: `matte_${i}`, td: 1, sr: 1,
    ks: { o: T(0, 100), r: T(0, 0), p: T(0, [0, 0, 0]), a: T(0, [0, 0, 0]), s: T(0, [100, 100, 100]) },
    ao: 0, shapes: [{ ty: 'gr', it: [
      { ty: 'sh', ks: { a: 0, k: { i: t.iH, o: t.oH, v: t.v, c: t.c } } },
      { ty: 'fl', c: T(0, [1, 1, 1, 1]), o: T(0, 100), r: 1 },
      { ty: 'tr', p: T(0, [0, 0]), a: T(0, [0, 0]), s: T(0, [100, 100]), r: T(0, 0), o: T(0, 100) },
    ] }], ip: 0, op: j.op, st: 0, bm: 0,
  })
  // image, clipped by the matte above, scaled to cover the tile bbox
  const scale = Math.max(t.w / 300, t.h / 300) * 100 * 1.08
  newLayers.push({
    ddd: 0, ind: imgInd, ty: 2, nm: `photo_${i}`, refId: `evt_${i}`, tt: 1, sr: 1,
    ks: { o: pulseOpacity(i), r: T(0, 0), p: T(0, [t.cx, t.cy, 0]), a: T(0, [150, 150, 0]), s: T(0, [scale, scale, 100]) },
    ao: 0, ip: 0, op: j.op, st: 0, bm: 0,
  })
})

// photos render ON TOP of the ball → put the pairs first
j.layers = [...newLayers, ...j.layers]

fs.writeFileSync(OUT, JSON.stringify(j))
console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(2) + 'MB', '| layers', j.layers.length, '| assets', j.assets.length)
