/** Writer vector shapes: declarative geometry and data-only SVG painting.
 * Geometry is constructed from a fixed registry; no document-supplied SVG or HTML.
 * Coordinates are shape-local millimetres. */
import type { Block } from "./types.js";
export const SHAPE_KEY = "slai.writer.shape";
export const SHAPE_KINDS = ["rectangle","ellipse","line","triangle","diamond","pentagon","hexagon","star","arrow","plus"] as const;
export type ShapeKind = typeof SHAPE_KINDS[number];
export interface Paint { enabled:boolean; color:string; opacity:number }
export interface Outline extends Paint { width_pt:number; style:"solid"|"dashed"|"dotted" }
export interface Shadow { enabled:boolean; color:string; opacity:number; offset_x_mm:number; offset_y_mm:number; blur_mm:number; spread_mm:number }
export interface ShapeText { content:string; color:string; font_size_pt:number; bold:boolean; italic:boolean; align:"left"|"center"|"right"; padding_mm:number }
export interface ShapeData {
  version:1; kind:ShapeKind; width_mm:number; height_mm:number; rotation_deg:number;
  fill:Paint; outline:Outline; opacity:number; corners_mm:number[];
  text:ShapeText; shadows:Shadow[];
}
export function shapeOf(block: Block | undefined):ShapeData|null {
  if (block?.type !== "paragraph" || block.text !== "") return null;
  const value = block.extensions?.[SHAPE_KEY] as ShapeData|undefined;
  return value?.version === 1 && SHAPE_KINDS.includes(value.kind) ? value : null;
}
export function defaultShape(kind:ShapeKind):ShapeData {
  return {version:1,kind,width_mm:60,height_mm:40,rotation_deg:0,opacity:1,
    fill:{enabled:true,color:"#f1d24b",opacity:1},
    outline:{enabled:true,color:"#202020",opacity:1,width_pt:1.5,style:"solid"},
    corners_mm:[0,0,0,0],
    text:{content:"",color:"#171717",font_size_pt:12,bold:false,italic:false,align:"center",padding_mm:2},
    shadows:[]};
}
const ns="http://www.w3.org/2000/svg";
function el(tag:string, attrs:Record<string,string|number>={}):SVGElement {
  const node=document.createElementNS(ns,tag);
  for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
  return node;
}
function polygon(points:Array<[number,number]>):string {
  return points.map(([x,y],i)=>`${i?"L":"M"}${x.toFixed(5)} ${y.toFixed(5)}`).join(" ")+" Z";
}
function regular(n:number,rx:number,ry:number,turn=-Math.PI/2):string {
  return polygon(Array.from({length:n},(_,i)=>[50+rx*Math.cos(turn+i*2*Math.PI/n),50+ry*Math.sin(turn+i*2*Math.PI/n)]));
}
export function pathFor(kind:ShapeKind):string {
  switch(kind){
    case "triangle":return polygon([[50,0],[100,100],[0,100]]);
    case "diamond":return polygon([[50,0],[100,50],[50,100],[0,50]]);
    case "pentagon":return regular(5,50,50);
    case "hexagon":return regular(6,50,50,-Math.PI/2);
    case "star":return polygon(Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5,r=i%2?22:50;return [50+r*Math.cos(a),50+r*Math.sin(a)];}));
    case "arrow":return polygon([[0,30],[62,30],[62,5],[100,50],[62,95],[62,70],[0,70]]);
    case "plus":return polygon([[35,0],[65,0],[65,35],[100,35],[100,65],[65,65],[65,100],[35,100],[35,65],[0,65],[0,35],[35,35]]);
    case "line":return "M0 50 L100 50";
    default:return "";
  }
}
/** Four-corner rounded rectangle in a 100x100 local viewport. */
export function roundedRect(radii:number[]):string {
  const [a,b,c,d]=radii.map(x=>Math.max(0,Math.min(50,x))) as [number,number,number,number];
  return `M${a} 0 H${100-b} Q100 0 100 ${b} V${100-c} Q100 100 ${100-c} 100 H${d} Q0 100 0 ${100-d} V${a} Q0 0 ${a} 0 Z`;
}
export function paintShape(shape:ShapeData):HTMLElement {
  const host=document.createElement("div"); host.className="writer-shape";
  host.style.width=`${shape.width_mm}mm`;host.style.height=`${shape.height_mm}mm`;
  host.style.transform=`rotate(${shape.rotation_deg}deg)`;
  host.style.opacity=String(shape.opacity);
  const svg=el("svg",{viewBox:"0 0 100 100",width:"100%",height:"100%",preserveAspectRatio:"none",role:"img","aria-label":`${shape.kind} shape`});
  svg.style.overflow="visible";
  const defs=el("defs");svg.appendChild(defs);
  const group=el("g");
  const paint=(node:SVGElement,shadow=false):void=>{
    node.setAttribute("fill",shape.kind==="line"||!shape.fill.enabled?"none":shape.fill.color);
    node.setAttribute("fill-opacity",String(shape.fill.opacity));
    node.setAttribute("stroke",shape.outline.enabled?shape.outline.color:"none");
    node.setAttribute("stroke-opacity",String(shape.outline.opacity));
    node.setAttribute("stroke-width",String(shape.outline.width_pt*100/(shape.width_mm*72/25.4)));
    node.setAttribute("vector-effect","non-scaling-stroke");
    if(shape.outline.style!=="solid")node.setAttribute("stroke-dasharray",shape.outline.style==="dotted"?"1 3":"5 3");
    void shadow;
  };
  const primitive=():SVGElement=>{
    if(shape.kind==="ellipse")return el("ellipse",{cx:50,cy:50,rx:50,ry:50});
    if(shape.kind==="rectangle")return el("path",{d:roundedRect(shape.corners_mm.map(x=>x*100/Math.min(shape.width_mm,shape.height_mm)))});
    return el("path",{d:pathFor(shape.kind)});
  };
  // Shadow layers are painted behind the same silhouette, in reverse stack order.
  shape.shadows.slice().reverse().forEach((s,i)=>{
    if(!s.enabled)return;
    const node=primitive();
    const index=shape.shadows.length-1-i;
    if(s.blur_mm>0){
      const id=`blur-${index}`;
      const filter=el("filter",{id,x:"-100%",y:"-100%",width:"300%",height:"300%"});
      filter.appendChild(el("feGaussianBlur",{stdDeviation:s.blur_mm*100/shape.width_mm}));
      defs.appendChild(filter);node.setAttribute("filter",`url(#${id})`);
    }
    node.setAttribute("fill",s.color);node.setAttribute("fill-opacity",String(s.opacity));
    node.setAttribute("stroke",s.color);node.setAttribute("stroke-opacity",String(s.opacity));
    node.setAttribute("stroke-width",String(Math.max(0,s.spread_mm)*200/shape.width_mm));
    node.setAttribute("transform",`translate(${s.offset_x_mm*100/shape.width_mm} ${s.offset_y_mm*100/shape.height_mm})`);
    group.appendChild(node);
  });
  const main=primitive();paint(main);group.appendChild(main);svg.appendChild(group);host.appendChild(svg);
  if(shape.text.content && shape.kind!=="line"){
    const t=document.createElement("div");t.className="writer-shape-text";
    t.textContent=shape.text.content;t.style.color=shape.text.color;
    t.style.fontSize=`${shape.text.font_size_pt}pt`;t.style.fontWeight=shape.text.bold?"700":"400";
    t.style.fontStyle=shape.text.italic?"italic":"normal";t.style.textAlign=shape.text.align;
    t.style.padding=`${shape.text.padding_mm}mm`;
    host.appendChild(t);
  }
  return host;
}
