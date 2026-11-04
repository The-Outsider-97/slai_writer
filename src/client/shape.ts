/** Declarative Writer vector geometry. No untrusted SVG or HTML is ever interpreted. */
import type { Block, Span } from "./types.js";
import { segments } from "./textops.js";

export const SHAPE_KEY = "slai.writer.shape";
export const SHAPE_KINDS = ["rectangle","ellipse","line","triangle","diamond","pentagon","hexagon","star","arrow","plus"] as const;
export type ShapeKind = typeof SHAPE_KINDS[number];
export interface Paint { enabled:boolean; color:string; opacity:number }
export interface Outline extends Paint { width_pt:number; style:"solid"|"dashed"|"dotted" }
export interface Shadow { enabled:boolean; color:string; opacity:number; offset_x_mm:number; offset_y_mm:number; blur_mm:number; spread_mm:number }
export interface ShapeText {
  content:string; color:string; font_size_pt:number; bold:boolean; italic:boolean;
  align:"left"|"center"|"right"; padding_mm:number; spans?:Span[]; fit?:"keep"|"shrink";
}
export interface ShapeLayout {
  mode:"inline"|"floating"; anchor?:"block"|"page"; target?:string;
  x_mm?:number; y_mm?:number; wrap?:"none"|"square"|"top_bottom";
  layer?:"content"|"behind_text"|"in_front_of_text";
}
export interface ShapeData {
  version:1; kind:ShapeKind; width_mm:number; height_mm:number; rotation_deg:number;
  fill:Paint; outline:Outline; opacity:number; corners_mm:number[];
  text:ShapeText; shadows:Shadow[]; layout?:ShapeLayout; z_index?:number; group_id?:string|null;
}
export function shapeOf(block:Block|undefined):ShapeData|null {
  if(block?.type!=="paragraph"||block.text!=="")return null;
  const value=block.extensions?.[SHAPE_KEY] as ShapeData|undefined;
  return value?.version===1&&SHAPE_KINDS.includes(value.kind)?value:null;
}
export function defaultShape(kind:ShapeKind):ShapeData {
  return {version:1,kind,width_mm:60,height_mm:40,rotation_deg:0,opacity:1,
    fill:{enabled:true,color:"#f1d24b",opacity:1},
    outline:{enabled:true,color:"#202020",opacity:1,width_pt:1.5,style:"solid"},
    corners_mm:[0,0,0,0],
    text:{content:"",color:"#171717",font_size_pt:12,bold:false,italic:false,
      align:"center",padding_mm:2,spans:[],fit:"keep"},
    shadows:[],layout:{mode:"inline"},z_index:0};
}
const ns="http://www.w3.org/2000/svg";
let seq=0;
function el(tag:string,attrs:Record<string,string|number>={}):SVGElement{
  const node=document.createElementNS(ns,tag);
  for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));
  return node;
}
function polygon(points:Array<[number,number]>):string{
  return points.map(([x,y],i)=>`${i?"L":"M"}${x.toFixed(5)} ${y.toFixed(5)}`).join(" ")+" Z";
}
function regular(n:number,rx:number,ry:number,turn=-Math.PI/2):string{
  return polygon(Array.from({length:n},(_,i)=>[50+rx*Math.cos(turn+i*2*Math.PI/n),50+ry*Math.sin(turn+i*2*Math.PI/n)]));
}
export function pathFor(kind:ShapeKind):string{
  switch(kind){
    case "triangle":return polygon([[50,0],[100,100],[0,100]]);
    case "diamond":return polygon([[50,0],[100,50],[50,100],[0,50]]);
    case "pentagon":return regular(5,50,50);
    case "hexagon":return regular(6,50,50);
    case "star":return polygon(Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5,r=i%2?22:50;return[50+r*Math.cos(a),50+r*Math.sin(a)];}));
    case "arrow":return polygon([[0,30],[62,30],[62,5],[100,50],[62,95],[62,70],[0,70]]);
    case "plus":return polygon([[35,0],[65,0],[65,35],[100,35],[100,65],[65,65],[65,100],[35,100],[35,65],[0,65],[0,35],[35,35]]);
    case "line":return "M0 50 L100 50";
    default:return "";
  }
}
export function roundedRect(corners:number[]):string{
  const [a,b,c,d]=corners.map(v=>Math.max(0,Math.min(50,v))) as [number,number,number,number];
  return `M${a} 0 H${100-b} Q100 0 100 ${b} V${100-c} Q100 100 ${100-c} 100 H${d} Q0 100 0 ${100-d} V${a} Q0 0 ${a} 0 Z`;
}
/** Conservative axis-aligned text containment region within each silhouette. */
export function textRegion(kind:ShapeKind,corners:number[]=[0,0,0,0]):{x:number;y:number;w:number;h:number}{
  const regions:Record<ShapeKind,[number,number,number,number]>={
    rectangle:[.05,.07,.9,.86],ellipse:[.18,.18,.64,.64],
    line:[0,0,0,0],triangle:[.35,.48,.3,.44],diamond:[.28,.28,.44,.44],
    pentagon:[.24,.34,.52,.5],hexagon:[.2,.18,.6,.64],
    star:[.33,.37,.34,.27],arrow:[.1,.36,.48,.28],plus:[.09,.37,.82,.26]
  };
  const [x,y,w,h]=regions[kind];
  if(kind!=="rectangle"||!corners.length)return {x,y,w,h};
  const radius=Math.max(...corners,0);
  const inset=Math.min(.2,radius/100);
  return {x:Math.max(x,inset),y:Math.max(y,inset),w:Math.min(w,1-2*inset),h:Math.min(h,1-2*inset)};
}
function primitive(shape:ShapeData):SVGElement {
  if(shape.kind==="ellipse")return el("ellipse",{cx:50,cy:50,rx:50,ry:50});
  if(shape.kind==="rectangle")return el("path",{d:roundedRect(shape.corners_mm.map(v=>v*100/Math.min(shape.width_mm,shape.height_mm)))});
  return el("path",{d:pathFor(shape.kind)});
}
function paintRuns(shape:ShapeData):HTMLElement{
  const text=document.createElement("div");text.className="writer-shape-text";
  const region=textRegion(shape.kind,shape.corners_mm.map(v=>v*100/Math.min(shape.width_mm,shape.height_mm)));
  text.style.left=`${region.x*100}%`;text.style.top=`${region.y*100}%`;
  text.style.width=`${region.w*100}%`;text.style.height=`${region.h*100}%`;
  text.style.color=shape.text.color;text.style.fontSize=`${shape.text.font_size_pt}pt`;
  text.style.fontWeight=shape.text.bold?"700":"400";text.style.fontStyle=shape.text.italic?"italic":"normal";
  text.style.textAlign=shape.text.align;text.style.padding=`${shape.text.padding_mm}mm`;
  const inner=document.createElement("div");inner.className="writer-shape-text-runs";
  for(const seg of segments({text:shape.text.content,spans:shape.text.spans??[]})){
    const part=document.createElement("span");part.textContent=seg.text;
    if(seg.flags.bold)part.style.fontWeight="700";
    if(seg.flags.italic)part.style.fontStyle="italic";
    if(seg.flags.underline)part.style.textDecoration="underline";
    if(seg.color)part.style.color=seg.color;
    if(seg.font_family)part.style.fontFamily=seg.font_family;
    if(seg.font_size_pt)part.style.fontSize=`${seg.font_size_pt}pt`;
    inner.appendChild(part);
  }
  text.appendChild(inner);
  return text;
}
export function paintShape(shape:ShapeData):HTMLElement {
  const host=document.createElement("div");host.className="writer-shape";
  host.style.width=`${shape.width_mm}mm`;host.style.height=`${shape.height_mm}mm`;
  host.style.transform=`rotate(${shape.rotation_deg}deg)`;
  host.style.opacity=String(shape.opacity);
  host.style.zIndex=String(shape.z_index??0);
  host.setAttribute("role","img");host.setAttribute("aria-label",shape.text.content?`${shape.kind}: ${shape.text.content}`:`${shape.kind} shape`);
  const svg=el("svg",{viewBox:"0 0 100 100",width:"100%",height:"100%",preserveAspectRatio:"none","aria-hidden":"true"});
  svg.style.overflow="visible";
  const defs=el("defs");svg.appendChild(defs);
  const group=el("g");const unitStroke=100*25.4/(shape.width_mm*72);
  [...shape.shadows].reverse().forEach((shadow,i)=>{
    if(!shadow.enabled)return;
    const node=primitive(shape);
    const index=seq++;
    if(shadow.blur_mm>0){
      const filter=el("filter",{id:`wr-shadow-${index}`,x:"-100%",y:"-100%",width:"300%",height:"300%"});
      filter.appendChild(el("feGaussianBlur",{stdDeviation:shadow.blur_mm*100/shape.width_mm}));
      defs.appendChild(filter);node.setAttribute("filter",`url(#wr-shadow-${index})`);
    }
    node.setAttribute("fill",shadow.color);node.setAttribute("fill-opacity",String(shadow.opacity));
    node.setAttribute("stroke",shadow.color);node.setAttribute("stroke-opacity",String(shadow.opacity));
    node.setAttribute("stroke-width",String(Math.max(0,shadow.spread_mm)*200/shape.width_mm));
    node.setAttribute("transform",`translate(${shadow.offset_x_mm*100/shape.width_mm} ${shadow.offset_y_mm*100/shape.height_mm})`);
    group.appendChild(node);void i;
  });
  const body=primitive(shape);
  body.setAttribute("fill",shape.kind==="line"||!shape.fill.enabled?"none":shape.fill.color);
  body.setAttribute("fill-opacity",String(shape.fill.opacity));
  body.setAttribute("stroke",shape.outline.enabled?shape.outline.color:"none");
  body.setAttribute("stroke-opacity",String(shape.outline.opacity));
  body.setAttribute("stroke-width",String(shape.outline.width_pt*unitStroke));
  body.setAttribute("vector-effect","non-scaling-stroke");
  if(shape.outline.style!=="solid")body.setAttribute("stroke-dasharray",shape.outline.style==="dotted"?"1 3":"5 3");
  group.appendChild(body);svg.appendChild(group);host.appendChild(svg);
  if(shape.text.content&&shape.kind!=="line"){
    const t=paintRuns(shape);host.appendChild(t);
    // Width and height are measured after placement. In keep mode preserve the
    // text size and display an overflow cue; shrink never mutates stored sizes.
    window.requestAnimationFrame(()=>{
      if(!t.isConnected)return;
      const inner=t.firstElementChild as HTMLElement|null;
      if(!inner)return;
      if(shape.text.fit==="shrink"){
        let scale=1;
        for(let pass=0;pass<22&&scale>.38&&(inner.scrollHeight>t.clientHeight||inner.scrollWidth>t.clientWidth);pass++){
          scale*=.94;inner.style.fontSize=`${shape.text.font_size_pt*scale}pt`;
          inner.querySelectorAll<HTMLElement>("span").forEach((s,i)=>{
            const seg=segments({text:shape.text.content,spans:shape.text.spans??[]})[i];
            if(seg?.font_size_pt)s.style.fontSize=`${seg.font_size_pt*scale}pt`;
          });
        }
      }
      if(inner.scrollHeight>t.clientHeight+1||inner.scrollWidth>t.clientWidth+1){
        host.setAttribute("data-text-overflow","true");
        host.title="Text does not fit in this shape. Open Shape Format to increase the shape or use Shrink text.";
      }
    });
  }
  return host;
}
