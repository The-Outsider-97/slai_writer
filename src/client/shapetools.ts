/** Pointer editing for shape objects; commits through the same operation queue as pictures.
 * Inline objects move by block order, including between pages. Geometry edits are one
 * server operation per completed pointer gesture, never one per pointer frame. */
import type { Editor } from "./editor.js";
import * as A from "./actions.js";
import { shapeOf, type ShapeData } from "./shape.js";
import { openShapeTextEditor } from "./shape_text_edit.js";
import { TEXTBOX_MIN_MM, isLocked, isPinned, neededHeightMm, textBoxOf } from "./textbox.js";
import { openTextBoxEditor, isEditingTextBox } from "./textbox_edit.js";
import { transformShapeGroup } from "./shapegroup.js";
import { h } from "./kit.js";
import { MM_PX } from "./textops.js";

export class ShapeTools {
  private id:string|null=null;
  private overlay:HTMLElement|null=null;
  private readonly off:Array<()=>void>=[];
  constructor(private readonly ed:Editor,_edit:(id:string)=>void){
    this.off.push(ed.events.on(e=>{
      if(e.type==="block-selected"){this.id=e.id;this.refresh();}
      if(e.type==="patch"||e.type==="layout")this.refresh();
      if(e.type==="patch"&&e.local)this.autoFit(Object.keys(e.patch.blocks));
    }));
    ed.page.onPlaced(()=>this.refresh());
    const key=(e:KeyboardEvent):void=>{
      const b=this.id?ed.model.block(this.id):undefined;
      const shape=shapeOf(b);
      if(!shape||ed.readOnly||!this.id)return;
      if(isLocked(shape)||isPinned(shape)||isEditingTextBox(this.id))return;   // a pinned or locked box does not move; text keys belong to the text
      if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key) && !e.ctrlKey && !e.metaKey && shape.layout?.mode==="floating"){
        e.preventDefault();e.stopImmediatePropagation();
        const move=e.shiftKey?5:.5;
        const deltaX=e.key==="ArrowLeft"?-move:e.key==="ArrowRight"?move:0;
        const deltaY=e.key==="ArrowUp"?-move:e.key==="ArrowDown"?move:0;
        const group=this.groupMembers();
        if(group.length>1){
          const ops=group.map(({id,shape:s})=>({op:"shape_set",block:id,shape:{...s,
            layout:{...s.layout,x_mm:Math.max(-5000,Math.min(5000,(s.layout?.x_mm??0)+deltaX)),
              y_mm:Math.max(-5000,Math.min(5000,(s.layout?.y_mm??0)+deltaY))}}}));
          void ed.op({op:"batch",ops,label:"nudge shape group"}).catch(err=>ed.failed(err));
        }else{
          const placement={...shape.layout,
            x_mm:Math.max(-5000,Math.min(5000,(shape.layout.x_mm??0)+deltaX)),
            y_mm:Math.max(-5000,Math.min(5000,(shape.layout.y_mm??0)+deltaY))};
          void ed.op({op:"shape_set",block:this.id,shape:{...shape,layout:placement},label:"nudge shape"})
            .catch(err=>ed.failed(err));
        }
      }
    };
    ed.host.addEventListener("keydown",key);
    this.off.push(()=>ed.host.removeEventListener("keydown",key));
  }
  /** A text box with Auto-expand grows when a change (a bigger font, more text, a narrower box) leaves its text taller than the box. */
  private readonly fitting=new Set<string>();
  private autoFit(ids:string[]):void{
    if(this.ed.readOnly||!ids.length)return;
    window.requestAnimationFrame(()=>{
      for(const id of ids){
        const shape=shapeOf(this.ed.model.block(id));const box=textBoxOf(shape);
        if(!shape||!box?.auto_expand||box.locked||isEditingTextBox(id))continue;
        const host=this.ed.els.get(id)?.querySelector<HTMLElement>(".writer-shape");
        const need=host?neededHeightMm(host):null;
        if(need===null||need<=shape.height_mm+0.3)continue;
        const key=`${id}:${shape.height_mm}`;
        if(this.fitting.has(key))continue;
        this.fitting.add(key);
        void this.ed.op({op:"shape_set",block:id,shape:{...shape,height_mm:Math.min(1000,Math.ceil(need*10)/10)},label:"fit text box"})
          .catch(()=>{}).finally(()=>this.fitting.delete(key));
      }
    });
  }
  destroy():void{this.off.forEach(x=>x());this.overlay?.remove();}
  /** Compound selection uses one visual bounding box, not an unrelated handle
   * around each member. Only shapes in the same page coordinate system may
   * be transformed as one affine object. */
  private groupMembers():Array<{id:string;shape:ShapeData;node:HTMLElement}>{
    const id=this.id;
    const shape=shapeOf(id?this.ed.model.block(id):undefined);
    if(!id||!shape)return[];
    const ids=shape.group_id?
      this.ed.model.list().filter(block=>shapeOf(block)?.group_id===shape.group_id).map(b=>b.id):
      this.ed.selectedShapes.size>1?[...this.ed.selectedShapes]:[id];
    const all=ids.flatMap(current=>{
      const item=shapeOf(this.ed.model.block(current));
      const node=this.ed.els.get(current)?.querySelector<HTMLElement>(".writer-shape");
      return item&&node&&node.isConnected&&item.layout?.mode==="floating"?[{id:current,shape:item,node}]:[];
    });
    if(all.length!==ids.length||all.length<2)return[];
    const pages=new Set(all.map(entry=>entry.node.closest(".sheet")));
    return pages.size===1?all:[];
  }
  refresh():void{
    const b=this.id?this.ed.model.block(this.id):undefined;
    const shape=shapeOf(b);
    const target=this.id?this.ed.els.get(this.id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!shape||!target||!target.isConnected||this.ed.readOnly){this.overlay?.remove();this.overlay=null;return;}
    if(!this.overlay)this.build();
    const members=this.groupMembers();
    const bounds=(members.length?members.map(entry=>this.ed.page.rectOf(entry.node)):[this.ed.page.rectOf(target)]);
    const left=Math.min(...bounds.map(r=>r.left)),top=Math.min(...bounds.map(r=>r.top));
    const right=Math.max(...bounds.map(r=>r.left+r.width)),bottom=Math.max(...bounds.map(r=>r.top+r.height));
    const o=this.overlay as HTMLElement;
    o.style.left=`${left}px`;o.style.top=`${top}px`;
    o.style.width=`${right-left}px`;o.style.height=`${bottom-top}px`;
    o.dataset["group"]=String(members.length>1);
    const box=textBoxOf(shape);
    o.dataset["textbox"]=String(Boolean(box));o.dataset["pinned"]=String(Boolean(box?.pinned));o.dataset["locked"]=String(Boolean(box?.locked));
    o.dataset["editing"]=String(isEditingTextBox(this.id??undefined));
    o.setAttribute("aria-label",members.length>1?`Transform group of ${members.length} vector shapes`:"Vector shape editing handles");
    o.style.setProperty("--s",String(1/this.ed.page.zoom));
  }
  private build():void{
    const root=h("div",{class:"imgsel shape-selection",attrs:{role:"group","aria-label":"Vector shape editing handles"}});
    // The handles live outside the document, so pressing one would leave the focus on the page body and Ctrl+Z, Delete and the arrow keys would stop reaching the editor.
    root.addEventListener("pointerdown",()=>{if(!isEditingTextBox())this.ed.host.focus({preventScroll:true});},true);
    const surface=h("div",{class:"imgsel-move",attrs:{title:"Drag shape to move; double click to edit its text"}});
    surface.addEventListener("pointerdown",e=>this.move(e,surface));
    surface.addEventListener("dblclick",()=>{if(this.id)openShapeTextEditor(this.ed,this.id);});
    root.appendChild(surface);
    for(const corner of ["nw","ne","sw","se"] as const){
      const handle=h("div",{class:`ih ${corner}`,attrs:{role:"button",tabindex:"0","aria-label":`Resize shape from ${corner}`}});
      handle.addEventListener("pointerdown",e=>this.resize(e,handle,corner));
      root.appendChild(handle);
    }
    // Text-box chrome (shown only for text boxes): a four-arrow move handle at the top-left corner and four border strips that also move the box.
    const grab=h("div",{class:"tb-move",attrs:{role:"button",tabindex:"0","aria-label":"Move text box",title:"Drag to move the text box"}});
    grab.append(document.createElementNS("http://www.w3.org/2000/svg","svg"));
    const arrows=grab.firstElementChild as SVGElement;
    arrows.setAttribute("viewBox","0 0 24 24");arrows.setAttribute("aria-hidden","true");
    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M12 2l3.2 3.6h-2.2v5.4h5.4V8.8L22 12l-3.6 3.2v-2.2H13v5.4h2.2L12 22l-3.2-3.6H11V13H5.6v2.2L2 12l3.6-3.2V11H11V5.6H8.8z");
    path.setAttribute("fill","currentColor");arrows.appendChild(path);
    grab.addEventListener("pointerdown",e=>this.move(e,grab));
    root.appendChild(grab);
    for(const side of ["n","e","s","w"] as const){
      const edge=h("div",{class:`tb-edge ${side}`,attrs:{"aria-hidden":"true",title:"Drag the border to move; click the text to edit it"}});
      edge.addEventListener("pointerdown",e=>this.move(e,edge));
      edge.addEventListener("dblclick",()=>{if(this.id)openTextBoxEditor(this.ed,this.id);});
      root.appendChild(edge);
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
  /** Live-paint the current affine proposal by changing DOM styles only.
   * On release, the entire group is committed once as a batch operation;
   * on cancel, every style is restored without modifying the document. */
  private transformGroupGesture(e:PointerEvent,handle:HTMLElement,mode:"resize"|"rotate",
    corner:"nw"|"ne"|"sw"|"se"="se"):boolean{
    const members=this.groupMembers();
    if(members.length<2||!this.overlay)return false;
    const original=members.map(({id,shape})=>({id,shape}));
    const originals=new Map(members.map(({id,node})=>[id,node.getAttribute("style")??""]));
    const bounds=this.overlay.getBoundingClientRect();
    const cx=bounds.left+bounds.width/2,cy=bounds.top+bounds.height/2;
    const startAngle=Math.atan2(e.clientY-cy,e.clientX-cx);
    const sx=e.clientX,sy=e.clientY;
    let proposed=original,modified=false;
    const restore=():void=>{
      for(const entry of members)entry.node.style.cssText=originals.get(entry.id)??"";
      this.refresh();
    };
    const preview=(result:typeof original):void=>{
      for(const item of result){
        const node=members.find(x=>x.id===item.id)?.node;
        if(!node)continue;
        node.style.left=`${item.shape.layout?.x_mm??0}mm`;
        node.style.top=`${item.shape.layout?.y_mm??0}mm`;
        node.style.width=`${item.shape.width_mm}mm`;
        node.style.height=`${item.shape.height_mm}mm`;
        node.style.transform=`rotate(${item.shape.rotation_deg}deg)`;
      }
    };
    this.gesture(e,handle,ev=>{
      const dx=ev.clientX-sx,dy=ev.clientY-sy;
      let scale=1,rotation_deg=0;
      if(mode==="resize"){
        const signX=corner.endsWith("e")?1:-1,signY=corner.startsWith("s")?1:-1;
        const factorX=1+signX*dx/Math.max(20,bounds.width);
        const factorY=1+signY*dy/Math.max(20,bounds.height);
        scale=Math.max(.1,Math.min(10,Math.abs(dx)>Math.abs(dy)?factorX:factorY));
      }else{
        rotation_deg=(Math.atan2(ev.clientY-cy,ev.clientX-cx)-startAngle)*180/Math.PI;
        if(ev.shiftKey)rotation_deg=Math.round(rotation_deg/15)*15;
      }
      try{
        proposed=transformShapeGroup(original,{scale,rotation_deg});
        preview(proposed);modified=true;
      }catch(_error){
        // An invalid preview is not persisted. Existing geometry stays safe.
        proposed=original;preview(original);modified=false;
      }
    },(_event,ok)=>{
      restore();
      if(!ok||!modified)return;
      const ops=proposed.map(item=>({op:"shape_set",block:item.id,shape:item.shape}));
      void this.ed.op({op:"batch",ops,label:mode==="resize"?"resize shape group":"rotate shape group"})
        .catch(err=>this.ed.failed(err));
    });
    return true;
  }

  private resize(e:PointerEvent,handle:HTMLElement,corner:"nw"|"ne"|"sw"|"se"):void{
    if(this.transformGroupGesture(e,handle,"resize",corner))return;
    const original=shapeOf(this.id?this.ed.model.block(this.id):undefined);
    const node=this.id?this.ed.els.get(this.id)?.querySelector<HTMLElement>(".writer-shape"):null;
    if(!original||!node)return;
    const sx=e.clientX,sy=e.clientY,z=this.ed.page.zoom;
    let w=original.width_mm,h=original.height_mm;
    const box=textBoxOf(original);
    if(box){
      // Text box: any corner resizes continuously (the text reflows as it is HTML), a west or north corner keeps the opposite
      // corner still, nothing goes below the minimum size, and an auto-expanding box never ends up shorter than its text.
      if(box.locked)return;
      const floating=original.layout?.mode==="floating";
      const ox=original.layout?.x_mm??0,oy=original.layout?.y_mm??0;
      const west=corner.endsWith("w"),north=corner.startsWith("n");
      const was={width:node.style.width,height:node.style.height,left:node.style.left,top:node.style.top};
      let x=ox,y=oy;
      const clamp=(v:number,lo:number):number=>Math.max(lo,Math.min(1000,v));
      this.gesture(e,handle,ev=>{
        const dx=(ev.clientX-sx)/z/MM_PX,dy=(ev.clientY-sy)/z/MM_PX;
        w=clamp(original.width_mm+(west?-dx:dx),TEXTBOX_MIN_MM.width);
        h=clamp(original.height_mm+(north?-dy:dy),TEXTBOX_MIN_MM.height);
        x=floating&&west?ox+(original.width_mm-w):ox;
        y=floating&&north?oy+(original.height_mm-h):oy;
        node.style.width=`${w}mm`;node.style.height=`${h}mm`;
        if(floating&&original.layout?.wrap!=="top_bottom"){node.style.left=`${x}mm`;node.style.top=`${y}mm`;}
        node.dataset["resizing"]=`${w.toFixed(1)} × ${h.toFixed(1)} mm`;
        this.refresh();
      },(_ev,ok)=>{
        delete node.dataset["resizing"];
        let finalH=h;
        if(ok&&box.auto_expand){const need=neededHeightMm(node);if(need!==null&&need>finalH)finalH=Math.min(1000,Math.ceil(need*10)/10);}
        node.style.width=was.width;node.style.height=was.height;node.style.left=was.left;node.style.top=was.top;
        if(ok&&(w!==original.width_mm||finalH!==original.height_mm||x!==ox||y!==oy)){
          const round=(v:number):number=>Math.round(v*10)/10;
          const next:ShapeData={...original,width_mm:round(w),height_mm:round(finalH),
            corners_mm:original.corners_mm.map(c=>Math.min(c,w/2,finalH/2)),
            text:{...original.text,padding_mm:Math.min(original.text.padding_mm,w/4,finalH/4)}};
          if(floating&&original.layout)next.layout={...original.layout,x_mm:round(x),y_mm:round(y)};
          void this.commit(next,"resize text box");
        }else this.refresh();
      });
      return;
    }
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
        const text={...original.text,padding_mm:Math.min(original.text.padding_mm,w/4,h/4)};
        void this.commit({...original,width_mm:w,height_mm:h,corners_mm:corners,text},"resize shape");
      }else this.refresh();
    });
  }
  private rotate(e:PointerEvent,handle:HTMLElement):void{
    if(this.transformGroupGesture(e,handle,"rotate"))return;
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
    const shape=shapeOf(id?this.ed.model.block(id):undefined);
    if(!id||!node||!shape)return;
    if(isLocked(shape)||isPinned(shape))return;
    const compound=this.groupMembers().map(x=>x.id);
    const cohort=compound.length>1?compound:shape.group_id?this.ed.model.list().filter(block=>
      shapeOf(block)?.group_id===shape.group_id).map(block=>block.id):[id];
    const movingIds=new Set(cohort);
    const sx=e.clientX,sy=e.clientY,z=this.ed.page.zoom;
    const startRect=node.getBoundingClientRect();
    const holdX=sx-startRect.left,holdY=sy-startRect.top;
    const scroller=this.ed.page.scroller;
    let lastX=sx,lastY=sy,auto=0;
    let target:{id:string;before:boolean}|null=null;
    let destination:HTMLElement|null=null,moved=false;
    const clear=()=>this.ed.host.querySelectorAll(".drop-before,.drop-after").forEach(n=>n.classList.remove("drop-before","drop-after"));
    const locate=(x:number,y:number):void=>{
      clear();
      const elements=document.elementsFromPoint(x,y);
      const sheet=elements.find((n):n is HTMLElement=>n instanceof HTMLElement&&n.classList.contains("sheet"))
        ??this.ed.page.sheets.find(s=>{
          const r=s.el.getBoundingClientRect();return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
        })?.el??null;
      destination=sheet?.querySelector<HTMLElement>(".body")??null;
      let hit=elements.find((n):n is HTMLElement=>n instanceof HTMLElement&&n.classList.contains("blk")
        &&!movingIds.has(n.dataset["id"]??"")&&!n.hasAttribute("data-floating"));
      if(!hit&&destination){
        const rows=[...destination.querySelectorAll<HTMLElement>(".blk[data-id]:not([data-floating])")]
          .filter(n=>!movingIds.has(n.dataset["id"]??""));
        hit=rows.find(n=>y<n.getBoundingClientRect().top+n.getBoundingClientRect().height/2)
          ??rows[rows.length-1];
      }
      target=null;
      if(hit){
        const r=hit.getBoundingClientRect();
        // A floating box takes no room in the flow, so "before the first block of a page" would leave it at the end of the previous page: drop it after that block instead.
        const firstOnLaterPage=hit.parentElement?.querySelector(".blk[data-id]:not([data-floating])")===hit&&this.ed.page.sheets.findIndex(sh=>sh.el.contains(hit))>0;
        const before=y<r.top+r.height/2&&!firstOnLaterPage;
        hit.classList.add(before?"drop-before":"drop-after");
        target={id:hit.dataset["id"] as string,before};
      }
    };
    const scroll=():void=>{
      if(!auto)return;
      const box=scroller.getBoundingClientRect();
      const edge=42;
      const delta=lastY<box.top+edge?-15:lastY>box.bottom-edge?15:0;
      if(delta){scroller.scrollTop+=delta;locate(lastX,lastY);}
      auto=window.requestAnimationFrame(scroll);
    };
    auto=window.requestAnimationFrame(scroll);
    this.gesture(e,handle,ev=>{
      lastX=ev.clientX;lastY=ev.clientY;
      const dx=lastX-sx,dy=lastY-sy;
      if(Math.hypot(dx,dy)<4)return;
      moved=true;
      node.style.translate=`${dx/z}px ${dy/z}px`;
      locate(lastX,lastY);
      this.refresh();
    },(_ev,ok)=>{
      window.cancelAnimationFrame(auto);clear();node.style.translate="";
      if(!ok||!moved){this.refresh();return;}
      const endTarget=target,endBody=destination;
      if(shape.layout?.mode==="floating"&&endBody){
        const rect=endBody.getBoundingClientRect();
        const x=Math.max(-5000,Math.min(5000,(lastX-holdX-rect.left)/z/MM_PX));
        const y=Math.max(-5000,Math.min(5000,(lastY-holdY-rect.top)/z/MM_PX));
        const newX=Math.round(x*2)/2,newY=Math.round(y*2)/2;
        const deltaX=newX-(shape.layout.x_mm??0),deltaY=newY-(shape.layout.y_mm??0);
        const ops:Array<Record<string,unknown>>=[];
        if(endTarget){
          const at=this.ed.model.order.indexOf(endTarget.id);
          const after=endTarget.before?(at>0?this.ed.model.order[at-1]??null:null):endTarget.id;
          ops.push({op:"move",blocks:cohort,after});
        }
        for(const member of cohort){
          const old=shapeOf(this.ed.model.block(member));if(!old||old.layout?.mode!=="floating")continue;
          const layout={...old.layout,
            x_mm:Math.max(-5000,Math.min(5000,(old.layout.x_mm??0)+deltaX)),
            y_mm:Math.max(-5000,Math.min(5000,(old.layout.y_mm??0)+deltaY))};
          if(endTarget){layout.anchor="block";layout.target=endTarget.id;}
          ops.push({op:"shape_set",block:member,shape:{...old,layout}});
        }
        if(ops.length)void this.ed.op({op:"batch",ops,label:"move shapes across pages"}).catch(err=>this.ed.failed(err));
      }else if(endTarget){
        const at=this.ed.model.order.indexOf(endTarget.id);
        const after=endTarget.before?(at>0?this.ed.model.order[at-1]??null:null):endTarget.id;
        void A.moveBlocksTo(this.ed,cohort,after);
      }else this.refresh();
    });
  }
}
