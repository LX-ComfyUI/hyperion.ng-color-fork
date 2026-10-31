// Built-in test pictures of the media library, drawn in the browser (TV page full screen, control page
// for the thumbnail and as the reference of the picture measurement). Same code on both sides, so the
// reference is exactly what the TV shows.
//   TestImages.LIST = [{ id, name }]   TestImages.draw(ctx, id, width, height)
(function (global) {
  "use strict";

  const LIST = [
    { id: "builtin:colorchecker", name: "Farbtafel (24 Felder)" },
    { id: "builtin:bars", name: "Farbbalken 100 %" },
    { id: "builtin:bars75", name: "Farbbalken 75 %" },
    { id: "builtin:edges", name: "Ränder: jede Seite eine Farbe" },
    { id: "builtin:grayramp", name: "Grauverlauf und Graustufen" },
    { id: "builtin:rgbramp", name: "Verläufe Rot, Grün, Blau, Weiß" },
    { id: "builtin:hue", name: "Farbkreis mit Sättigung" },
  ];

  // X-Rite ColorChecker Classic, sRGB (D65), the usual published values
  const CHECKER = [
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
    [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
  ];
  const BARS = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  function draw(ctx, id, w, h) {
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    switch (id) {
      case "builtin:colorchecker": {
        // 6 x 4 fields on a dark gray frame, like the real chart
        ctx.fillStyle = "rgb(30,30,30)";
        ctx.fillRect(0, 0, w, h);
        const gap = Math.round(Math.min(w, h) * 0.02);
        const cw = (w - gap * 7) / 6, ch = (h - gap * 5) / 4;
        CHECKER.forEach((c, i) => {
          ctx.fillStyle = rgb(c);
          ctx.fillRect(Math.round(gap + (i % 6) * (cw + gap)), Math.round(gap + Math.floor(i / 6) * (ch + gap)), Math.round(cw), Math.round(ch));
        });
        break;
      }
      case "builtin:bars":
      case "builtin:bars75": {
        const k = id === "builtin:bars75" ? 191 / 255 : 1;
        const bw = w / BARS.length;
        BARS.forEach((c, i) => {
          ctx.fillStyle = rgb(c.map((v) => Math.round(v * k)));
          ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), h);
        });
        break;
      }
      case "builtin:edges": {
        // a band along each edge in its own color, mid gray inside: shows whether every side of the
        // LED frame takes its own side of the picture
        const b = Math.round(Math.min(w, h) * 0.18);
        ctx.fillStyle = "rgb(128,128,128)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgb(255,0,0)"; ctx.fillRect(0, 0, w, b);
        ctx.fillStyle = "rgb(0,0,255)"; ctx.fillRect(0, h - b, w, b);
        ctx.fillStyle = "rgb(0,255,0)"; ctx.fillRect(w - b, b, b, h - 2 * b);
        ctx.fillStyle = "rgb(255,255,0)"; ctx.fillRect(0, b, b, h - 2 * b);
        break;
      }
      case "builtin:grayramp": {
        // top: continuous ramp 0..255, bottom: 16 steps
        const half = Math.round(h / 2);
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, "#000");
        g.addColorStop(1, "#fff");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, half);
        const sw = w / 16;
        for (let i = 0; i < 16; i++) {
          const v = Math.round((i * 255) / 15);
          ctx.fillStyle = rgb([v, v, v]);
          ctx.fillRect(Math.round(i * sw), half, Math.ceil(sw), h - half);
        }
        break;
      }
      case "builtin:rgbramp": {
        const rows = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
        const rh = h / rows.length;
        rows.forEach((c, i) => {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          g.addColorStop(0, "#000");
          g.addColorStop(1, rgb(c));
          ctx.fillStyle = g;
          ctx.fillRect(0, Math.round(i * rh), w, Math.ceil(rh));
        });
        break;
      }
      case "builtin:hue": {
        // hue from left to right, full saturation at the top, white at the bottom
        const g = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        const v = ctx.createLinearGradient(0, 0, 0, h);
        v.addColorStop(0, "rgba(255,255,255,0)");
        v.addColorStop(1, "rgba(255,255,255,1)");
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, w, h);
        break;
      }
    }
    ctx.restore();
  }

  global.TestImages = { LIST, draw };
})(typeof window !== "undefined" ? window : globalThis);
