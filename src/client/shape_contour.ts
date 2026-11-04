/** Deterministic contour-aware text bands for the ten built-in vector presets.
 *
 * Pure functions with no DOM, no SVG parsing of untrusted document text.
 * Geometry is in shape-local millimetres, independent of zoom and CSS pixels.
 * For each line height the allowable interval is the intersection of five
 * cross-sections, ensuring containment through concave/curved narrow areas.
 */
import { pathFor, type ShapeKind, type ShapeData } from "./shape.js";

export type Point={x:number;y:number};
export type Interval={start:number;end:number};
export type ShapeLine={start:number;end:number;x:number;y:number;width:number};
export type LayoutResult={lines:ShapeLine[];overflow:boolean;nextOffset:number};

export function polygonForShape(kind:ShapeKind,w:number,h:number,corners:readonly number[]=[0,0,0,0]):Point[] {
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)return[];
  if(kind==="line")return[];
  if(kind==="ellipse")return Array.from({length:96},(_,i)=>{
    const t=2*Math.PI*i/96;
    return {x:w*(.5+.5*Math.cos(t)),y:h*(.5+.5*Math.sin(t))};
  });
  if(kind==="rectangle"){
    const radius=(corners.length===4?corners:[0,0,0,0]).map(r=>Math.max(0,Math.min(w/2,h/2,r)));
    const centers:[[number,number,number,number],[number,number,number,number],
      [number,number,number,number],[number,number,number,number]]=[
      [w-radius[1]!,radius[1]!, -Math.PI/2,0],
      [w-radius[2]!,h-radius[2]!,0,Math.PI/2],
      [radius[3]!,h-radius[3]!,Math.PI/2,Math.PI],
      [radius[0]!,radius[0]!,Math.PI,3*Math.PI/2]
    ];
    return centers.flatMap(([cx,cy,from,to],index)=>{
      const r=radius[[1,2,3,0][index]!]!;
      return Array.from({length:16},(_,i)=>{
        const t=from+(to-from)*i/15;
        return {x:cx+r*Math.cos(t),y:cy+r*Math.sin(t)};
      });
    });
  }
  const raw=pathFor(kind);
  const matches=[...raw.matchAll(/([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
  return matches.map(match=>({x:Number(match[2])*w/100,y:Number(match[3])*h/100}));
}
export function contourAtY(polygon:readonly Point[],y:number):Interval[]{
  if(polygon.length<3||!Number.isFinite(y))return[];
  const xs:number[]=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!;
    if((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y)){
      const x=a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y);
      if(Number.isFinite(x))xs.push(x);
    }
  }
  xs.sort((a,b)=>a-b);
  const regions:Interval[]=[];
  for(let i=0;i+1<xs.length;i+=2){
    if(xs[i+1]!-xs[i]!>1e-7)regions.push({start:xs[i]!,end:xs[i+1]!});
  }
  return regions;
}
export function intersectIntervals(a:readonly Interval[],b:readonly Interval[]):Interval[]{
  const out:Interval[]=[];
  for(const left of a)for(const right of b){
    const start=Math.max(left.start,right.start),end=Math.min(left.end,right.end);
    if(end-start>1e-6)out.push({start,end});
  }
  return out.sort((x,y)=>x.start-y.start);
}
export function textBand(shape:ShapeData,top:number,height:number):Interval[]{
  const w=shape.width_mm,h=shape.height_mm;
  if(height<=0||top<0||top+height>h)return[];
  const poly=polygonForShape(shape.kind,w,h,shape.corners_mm);
  if(!poly.length)return[];
  const padding=shape.text.padding_mm+
    (shape.outline.enabled?shape.outline.width_pt*25.4/72/2:0);
  // Inset on each side conservatively; fill holes are never fabricated.
  const samples=[.02,.25,.5,.75,.98];
  let bands:Interval[]=[{start:0,end:w}];
  for(const factor of samples){
    const cross=contourAtY(poly,top+height*factor).map(region=>({
      start:Math.max(0,region.start+padding),end:Math.min(w,region.end-padding)
    })).filter(region=>region.end-region.start>1e-6);
    bands=intersectIntervals(bands,cross);
    if(!bands.length)break;
  }
  return bands;
}
function nextGrapheme(input:string,start:number):string{
  if(start>=input.length)return "";
  const cp=input.codePointAt(start)!;
  let end=start+(cp>0xffff?2:1);
  // Combining marks and variation selectors remain attached to their base.
  while(end<input.length){
    const c=input.codePointAt(end)!;
    const piece=String.fromCodePoint(c);
    if(!/\p{Mark}|\uFE0F/u.test(piece))break;
    end+=c>0xffff?2:1;
  }
  return input.slice(start,end);
}
/** Layout preserves the original UTF-16 range per line, for rich span mapping.
 * The caller supplies glyph measurement in mm at the current font scale.
 */
export function layoutContourText(shape:ShapeData,measure:(piece:string,offset:number,scale:number)=>number,
    scale=1):LayoutResult {
  const content=shape.text.content;
  if(!content)return {lines:[],overflow:false,nextOffset:0};
  const fs=shape.text.font_size_pt*25.4/72*scale;
  const lineH=Math.max(1.2,fs*1.30);
  const max=shape.height_mm-shape.text.padding_mm;
  let y=shape.text.padding_mm,offset=0,iterations=0,oversizedGlyph=false;
  const lines:ShapeLine[]=[];
  while(offset<content.length&&y+lineH<=max+1e-7&&iterations++<500){
    const options=textBand(shape,y,lineH);
    const band=options.sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0];
    if(!band||band.end-band.start<1){y+=lineH/3;continue;}
    const cap=band.end-band.start;
    let j=offset,used=0,lastSpace=-1;
    while(j<content.length){
      const piece=nextGrapheme(content,j);
      if(piece==="\n"){j+=piece.length;break;}
      const advance=measure(piece,j,scale);
      if(!Number.isFinite(advance)||advance<0)throw Error("Invalid glyph measure");
      if(used+advance>cap+1e-7){
        if(lastSpace>offset)j=lastSpace;
        else if(j===offset){j+=piece.length;oversizedGlyph=true;} // Never loop forever on an oversized glyph.
        break;
      }
      used+=advance;j+=piece.length;
      if(/\s/u.test(piece))lastSpace=j;
    }
    let right=j;
    if(right>offset&&content[right-1]==="\n")right--;
    lines.push({start:offset,end:right,x:band.start,y,width:cap});
    offset=j;
    y+=lineH;
  }
  return {lines,overflow:oversizedGlyph||offset<content.length,nextOffset:offset};
}
export function shapeContourClip(shape:ShapeData):string {
  const points=polygonForShape(shape.kind,shape.width_mm,shape.height_mm,shape.corners_mm);
  if(!points.length)return "none";
  return "polygon("+points.map(p=>`${(p.x/shape.width_mm*100).toFixed(4)}% ${(p.y/shape.height_mm*100).toFixed(4)}%`).join(",")+")";
}
