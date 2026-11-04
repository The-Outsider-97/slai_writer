/** Reusable exact affine transforms for grouped floating Writer shapes.
 *  Geometry stays local; a single document batch commits all transformed members.
 *  Coordinates are document millimetres, never viewport pixels. */
import type { ShapeData } from "./shape.js";

export interface GroupMember { id:string; shape:ShapeData }
export interface GroupTransform { scale:number; rotation_deg:number }
export function transformShapeGroup(items:readonly GroupMember[],transform:GroupTransform):GroupMember[] {
  if(!items.length)throw new Error("Select at least one shape.");
  const {scale,rotation_deg:angle}=transform;
  if(!Number.isFinite(scale)||scale<=0||scale>10||!Number.isFinite(angle)||Math.abs(angle)>360)
    throw new Error("Group transform is outside the supported range.");
  if(items.some(x=>x.shape.layout?.mode!=="floating"))
    throw new Error("A group transform requires floating shapes.");
  const boxes=items.map(({shape})=>{
    const x=shape.layout?.x_mm??0,y=shape.layout?.y_mm??0;
    const w=shape.width_mm,h=shape.height_mm;
    const cx=x+w/2,cy=y+h/2;
    const a=(shape.rotation_deg*Math.PI)/180,co=Math.cos(a),si=Math.sin(a);
    const corners=([[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]] as const).map(([dx,dy])=>
      ({x:cx+dx*co-dy*si,y:cy+dx*si+dy*co}));
    return corners;
  }).flat();
  const minX=Math.min(...boxes.map(x=>x.x)),maxX=Math.max(...boxes.map(x=>x.x));
  const minY=Math.min(...boxes.map(x=>x.y)),maxY=Math.max(...boxes.map(x=>x.y));
  const groupX=(minX+maxX)/2,groupY=(minY+maxY)/2;
  const phi=angle*Math.PI/180,co=Math.cos(phi),si=Math.sin(phi);
  return items.map(({id,shape})=>{
    const layout=shape.layout;
    const oldX=layout?.x_mm??0,oldY=layout?.y_mm??0;
    const cx=oldX+shape.width_mm/2,cy=oldY+shape.height_mm/2;
    const dx=(cx-groupX)*scale,dy=(cy-groupY)*scale;
    const ncx=groupX+dx*co-dy*si,ncy=groupY+dx*si+dy*co;
    const w=shape.width_mm*scale,h=shape.height_mm*scale;
    const nx=ncx-w/2,ny=ncy-h/2;
    if(w<2||h<2||w>1000||h>1000||Math.abs(nx)>5000||Math.abs(ny)>5000)
      throw new Error("The transformed group would exceed document geometry limits.");
    const radii=shape.corners_mm.map(v=>Math.min(v*scale,w/2,h/2));
    const text={...shape.text,padding_mm:Math.min(shape.text.padding_mm*scale,w/4,h/4)};
    const next:ShapeData={
      ...shape,width_mm:w,height_mm:h,corners_mm:radii,text,
      rotation_deg:((shape.rotation_deg+angle+180)%360+360)%360-180,
      layout:{...layout,mode:"floating",x_mm:nx,y_mm:ny},
    };
    return {id,shape:next};
  });
}
