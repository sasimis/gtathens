const fs=require('fs');
const d=JSON.parse(fs.readFileSync('public/map_data.json','utf8'));
const REF_LAT=37.975521, REF_LON=23.733642, M_LAT=111320, M_LON=111320*Math.cos(REF_LAT*Math.PI/180);
const g=d.grass||[];
console.log('grass polys:',g.length);
let all=[];
for(const p of g){
  const xs=p.nodes.map(n=>(n.lon-REF_LON)*M_LON), zs=p.nodes.map(n=>(n.lat-REF_LAT)*-M_LAT);
  const area=Math.abs(xs.reduce((a,x,i)=>{const j=(i+1)%xs.length;return a+(xs[i]*zs[j]-xs[j]*zs[i])},0))/2;
  const bbox=[Math.min(...xs).toFixed(1),Math.max(...xs).toFixed(1),Math.min(...zs).toFixed(1),Math.max(...zs).toFixed(1)];
  const cx=xs.reduce((a,b)=>a+b,0)/xs.length, cz=zs.reduce((a,b)=>a+b,0)/zs.length;
  console.log(' poly',p.nodes.length,'pts area',area.toFixed(0),'center',cx.toFixed(1),cz.toFixed(1),'bbox',bbox.join(','));
  all.push([cx,cz]);
}
console.log('nearest to origin:', all.map(([x,z])=>Math.hypot(x,z).toFixed(0)).join(' '));
