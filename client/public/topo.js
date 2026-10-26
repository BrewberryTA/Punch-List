/* Homebuilder Ops — the topographic ground.

   Draws a seamless contour sheet once at load and hands it to the stylesheet
   as --topo, which body::before uses as a *mask* (the ink colour comes from
   --topo-ink, so one drawing serves light and dark).

   The field is a sum of sines on integer wavenumbers over a 560px period, so
   it is exactly periodic and the tile repeats without a seam. The seed is
   fixed, so every visitor and every reload gets the same land.

   Tuning, all at the top: SEED changes the terrain, LEVELS how many contours,
   RELIEF how sharply the steep ground bunches, OCTAVES the shape of the land
   (weight on the low wavenumbers = broad plateaus; more weight high = rockier).

   If this script never runs, --topo stays the transparent default in
   styles.css and the page simply has no contours — nothing else depends
   on it. */

(function () {
  var L = 560;          // tile size in px, = 8 heavy modules
  var N = 176;          // grid resolution; cell is ~3.2px
  var LEVELS = 34;      // contour count
  var SEED = 31337;     // change this and you get different country
  var RELIEF = 1.55;    // >1 opens the plateaus and bunches the steep faces
  var OCTAVES = [[1, 1.0], [2, 0.62], [3, 0.40], [5, 0.26], [8, 0.15], [13, 0.07]];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  try {
    var rand = mulberry32(SEED);
    var waves = [];
    for (var o = 0; o < OCTAVES.length; o++) {
      var k = OCTAVES[o][0], amp = OCTAVES[o][1];
      for (var c = 0; c < 3; c++) {
        var m = Math.floor(rand() * (2 * k + 1)) - k;
        var n = Math.floor(rand() * (2 * k + 1)) - k;
        if (m === 0 && n === 0) m = k;
        waves.push([m, n, rand() * Math.PI * 2, amp]);
      }
    }

    // sample the field on an (N+1)² lattice that includes the wrap row/column,
    // so contours meet across the tile edge
    var S = N + 1, f = new Float32Array(S * S), min = Infinity, max = -Infinity;
    var TAU = Math.PI * 2;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var px = x * L / N, py = y * L / N, v = 0;
        for (var w = 0; w < waves.length; w++) {
          var W = waves[w];
          v += W[3] * Math.sin(TAU * (W[0] * px + W[1] * py) / L + W[2]);
        }
        f[y * S + x] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    // normalise, then bias so flat ground stays open and steep ground bunches
    var span = max - min || 1;
    for (var i = 0; i < f.length; i++) f[i] = Math.pow((f[i] - min) / span, RELIEF);

    var cv = document.createElement('canvas');
    cv.width = L; cv.height = L;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var cell = L / N;
    // two passes: every 5th contour is an index line, drawn heavier
    for (var pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (var li = 0; li < LEVELS; li++) {
        if ((li % 5 === 0) !== (pass === 1)) continue;
        var t = 0.015 + (li + 0.5) * (0.97 / LEVELS);
        for (var gy = 0; gy < N; gy++) {
          for (var gx = 0; gx < N; gx++) {
            var a = f[gy * S + gx],
                b = f[gy * S + gx + 1],
                cc = f[(gy + 1) * S + gx + 1],
                d = f[(gy + 1) * S + gx];
            var x0 = gx * cell, y0 = gy * cell, pts = [];
            if ((a - t) * (b - t) < 0) pts.push([x0 + cell * (t - a) / (b - a), y0]);
            if ((b - t) * (cc - t) < 0) pts.push([x0 + cell, y0 + cell * (t - b) / (cc - b)]);
            if ((d - t) * (cc - t) < 0) pts.push([x0 + cell * (t - d) / (cc - d), y0 + cell]);
            if ((a - t) * (d - t) < 0) pts.push([x0, y0 + cell * (t - a) / (d - a)]);
            if (pts.length === 2) {
              ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);
            } else if (pts.length === 4) {
              ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);
              ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]);
            }
          }
        }
      }
      ctx.strokeStyle = pass === 1 ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,.6)';
      ctx.lineWidth = pass === 1 ? 1.5 : 0.9;
      ctx.stroke();
    }

    document.documentElement.style.setProperty('--topo', 'url("' + cv.toDataURL() + '")');
  } catch (e) {
    /* no contours; the page is otherwise unaffected */
  }
})();
