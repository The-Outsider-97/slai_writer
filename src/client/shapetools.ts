/** Pointer editing for shape objects; commits through the same operation queue as pictures.
 * Inline objects move by block order, including between pages. Geometry edits are one
 * server operation per completed pointer gesture, never one per pointer frame. */
import type { Editor } from "./editor.js";
import * as A from "./actions.js";
import { shapeOf, type ShapeData } from "./shape.js";
import { h } from "./kit.js";
import { MM_PX } from "./textops.js";

export class ShapeTools {
  private id:string|null=null;
  private overlay:HTMLElement|null=null;
  private readonly off:Array<()=>void>=[];
  constructor(private readonly ed:Editor,private readonly edit:(id:string)=>void){
    this.off.push(ed.events.on(e=>{
      if(e.type==="block-selected"){this.id=e.id;this.refresh();}
      if(e.type==="patch"||e.type==="layout")this.refresh();
    }));
    ed.page.onPlaced(()=>this.refresh());
    const key=(e:KeyboardEvent):void=>{
      const b=this.id?ed.model.block(this.id):undefined;
      const shape=shapeOf(b);
      if(!shape||ed.readOnly||!this.id)return;
      if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key) && !e.ctrlKey && !e.metaKey){
        // Inline shapes cannot be nudged independently of their paragraph anchor.
        return;
      }
    };
    ed.host.addEventListener("keydown",key);
    this.off.push(()=>ed.host.removeEventListener("keydown",key));
  }
  destroy():void{this.off.forEach(x=>x());this.overlay?.remove();}
  refresh():void{
    const b=this.id?this.ed.model.block(this.id):undefined;
    const shape=shapeOf(b);
    const target=this.id?this.ed.els.get(this.id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!shape||!target||!target.isConnected||this.ed.readOnly){this.overlay?.remove();this.overlay=null;return;}
    if(!this.overlay)this.build();
    const r=this.ed.page.rectOf(target),o=this.overlay as HTMLElement;
    o.style.left=`${r.left}px`;o.style.top=`${r.top}px`;o.style.width=`${r.width}px`;o.style.height=`${r.height}px`;
    o.style.setProperty("--s",String(1/this.ed.page.zoom));
  }
  private build():void{
    const root=h("div",{class:"imgsel shape-selection",attrs:{role:"group","aria-label":"Vector shape editing handles"}});
    const surface=h("div",{class:"imgsel-move",attrs:{title:"Drag shape to another position or page; double click for Shape Format"}});
    surface.addEventListener("pointerdown",e=>this.move(e,surface));
    surface.addEventListener("dblclick",()=>{if(this.id)this.edit(this.id);});
    root.appendChild(surface);
    for(const corner of ["nw","ne","sw","se"] as const){
      const handle=h("div",{class:`ih ${corner}`,attrs:{role:"button",tabindex:"0","aria-label":`Resize shape from ${corner}`}});
      handle.addEventListener("pointerdown",e=>this.resize(e,handle,corner));
      root.appendChild(handle);
    }
    const stem=h("div",{class:"imgsel-stem"});
    const rot=h("div",{class:"ih rot",attrs:{role:"button",tabindex:"0","aria-label":"Rotate shape"}});
    rot.addEventListener("pointerdown",e=>this.rotate(e,rot));
    root.append(stem,rot);
    this.ed.page.overlay.appendChild(root);this.overlay=root;
  }
  private gesture(e:PointerEvent,handle:HTMLElement,move:(e:PointerEvent)=>void,end:(e:PointerEvent,ok:boolean)=>void):void{
    if(e.button!==0)return;
    e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);
    const onMove=(ev:PointerEvent)=>move(ev);
    const finish=(ev:PointerEvent,ok:boolean):void=>{
      handle.removeEventListener("pointermove",onMove);
      handle.removeEventListener("pointerup",up);
      handle.removeEventListener("pointercancel",cancel);
      end(ev,ok);
    };
    const up=(ev:PointerEvent)=>finish(ev,true),cancel=(ev:PointerEvent)=>finish(ev,false);
    handle.addEventListener("pointermove",onMove);handle.addEventListener("pointerup",up);handle.addEventListener("pointercancel",cancel);
  }
  private async commit(shape:ShapeData,label:string):Promise<void>{
    if(!this.id)return;
    try{await this.ed.op({op:"shape_set",block:this.id,shape,label});}
    catch(e){this.ed.failed(e);}
  }
  private resize(e:PointerEvent,handle:HTMLElement,corner:"nw"|"ne"|"sw"|"se"):void{
    const original=shapeOf(this.id?this.ed.model.block(this.id):undefined);
    const node=this.id?this.ed.els.get(this.id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!original||!node)return;
    const sx=e.clientX,sy=e.clientY,z=this.ed.page.zoom;
    let w=original.width_mm,h=original.height_mm;
    this.gesture(e,handle,ev=>{
      const signX=corner.endsWith("e")?1:-1,signY=corner.startsWith("s")?1:-1;
      w=Math.max(2,Math.min(1000,original.width_mm+signX*(ev.clientX-sx)/z/MM_PX));
      h=Math.max(2,Math.min(1000,original.height_mm+signY*(ev.clientY-sy)/z/MM_PX));
      if(ev.shiftKey){const ratio=original.width_mm/original.height_mm;h=w/ratio;}
      node.style.width=`${w}mm`;node.style.height=`${h}mm`;
      this.refresh();
    },(_ev,ok)=>{
      node.style.width=`${original.width_mm}mm`;node.style.height=`${original.height_mm}mm`;
      if(ok&&(w!==original.width_mm||h!==original.height_mm)){
        const corners=original.corners_mm.map(x=>Math.min(x,w/2,h/2));
        void this.commit({...original,width_mm:w,height_mm:h,corners_mm:corners},"resize shape");
      }else this.refresh();
    });
  }
  private rotate(e:PointerEvent,handle:HTMLElement):void{
    const original=shapeOf(this.id?this.ed.model.block(this.id):undefined);
    const node=this.id?this.ed.els.get(this.id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!original||!node)return;
    const r=node.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    const start=Math.atan2(e.clientY-cy,e.clientX-cx);
    let angle=original.rotation_deg;
    this.gesture(e,handle,ev=>{
      const delta=(Math.atan2(ev.clientY-cy,ev.clientX-cx)-start)*180/Math.PI;
      angle=original.rotation_deg+delta;
      if(ev.shiftKey)angle=Math.round(angle/15)*15;
      node.style.transform=`rotate(${angle}deg)`;
      this.refresh();
    },(_ev,ok)=>{
      node.style.transform=`rotate(${original.rotation_deg}deg)`;
      if(ok&&angle!==original.rotation_deg)void this.commit({...original,rotation_deg:((angle+180)%360+360)%360-180},"rotate shape");
      else this.refresh();
    });
  }
  private move(e:PointerEvent,handle:HTMLElement):void{
    const id=this.id,node=id?this.ed.els.get(id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!id||!node)return;
    const sx=e.clientX,sy=e.clientY,z=this.ed.page.zoom;
    let target:{id:string;before:boolean}|null=null;
    let moved=false;
    const clear=()=>this.ed.host.querySelectorAll(".drop-before,.drop-after").forEach(n=>n.classList.remove("drop-before","drop-after"));
    this.gesture(e,handle,ev=>{
      const dx=ev.clientX-sx,dy=ev.clientY-sy;
      if(Math.hypot(dx,dy)<4)return;
      moved=true;
      node.style.translate=`${dx/z}px ${dy/z}px`;
      clear();
      const hit=document.elementsFromPoint(ev.clientX,ev.clientY).find((n):n is HTMLElement=>
        n instanceof HTMLElement&&n.classList.contains("blk")&&n.dataset["id"]!==id&&!n.hasAttribute("data-floating"));
      target=null;
      if(hit){
        const r=hit.getBoundingClientRect(),before=ev.clientY<r.top+r.height/2;
        hit.classList.add(before?"drop-before":"drop-after");
        target={id:hit.dataset["id"] as string,before};
      }
    },(_ev,ok)=>{
      clear();node.style.translate="";
      if(ok&&moved&&target){
        const dest=target as {id:string;before:boolean};
        const at=this.ed.model.order.indexOf(dest.id);
        const after=dest.before?(at>0?this.ed.model.order[at-1]??null:null):dest.id;
        void A.moveBlocksTo(this.ed,[id],after);
      }else this.refresh();
    });
  }
}
