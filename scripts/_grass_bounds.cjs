const fs = require("fs");
const REF_LAT = 37.975521, REF_LON = 23.733642;
const M_LAT = 111320, M_LON = M_LAT * Math.cos(REF_LAT * Math.PI / 180);
const w = (data) => (data.grass || []).map(g => (g.nodes||[]).map(n => [ +(((n.lon - REF_LON) * M_LON)).toFixed(1), +((-(n.lat - REF_LAT) * M_LAT)).toFixed(1) ])).filter(p => p.length >= 3);
const j = JSON.parse(fs.readFileSync("public/map_data.json", "utf8"));
const polys = w(j);
console.log("polys:", polys.length);
let area = 0;
polys.forEach((p, i) => {
  let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9; let a=0;
  for (let k=0,j2=p.length-1;k<p.length;j2=k++){ a += (p[j2][0]*p[k][1] - p[k][0]*p[j2][1]); }
  a = Math.abs(a/2); area += a;
  for (const [x,z] of p){ mnx=Math.min(mnx,x); mxx=Math.max(mxx,x); mnz=Math.min(mnz,z); mxz=Math.max(mxz,z); }
  const cx=(mnx+mxx)/2, cz=(mnz+mxz)/2;
  console.log(`[${i}] area=${a.toFixed(0)}m2 bbox x[${mnx},${mxx}] z[${mnz},${mxz}] centre=(${cx.toFixed(0)},${cz.toFixed(0)}) dist=${Math.hypot(cx,cz).toFixed(0)}m`);
});
console.log("total area:", area.toFixed(0));
console.log("nearest grass to origin(0,0):", Math.min(...polys.map(p => Math.min(...p.map(([x,z]) => Math.hypot(x,z))))).toFixed(1));
