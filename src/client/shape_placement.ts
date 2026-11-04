/** Insert Shape tool: Escape cancels, click places, drag specifies dimensions.
 * All measurements are page-local millimetres and commit once via block_insert. */
import * as A from "./actions.js";
import { announce, h, toast } from "./kit.js";
import { errorText } from "./net.js";
import type { DocCtx } from "./docctx.js";
import { SHAPE_KEY, defaultShape, type ShapeKind } from "./shape.js";
import { MM_PX } from "./textops.js";

export function beginShapePlacement(ctx:DocCtx,kind:ShapeKind):void{
  if(ctx.ed.readOnly)return;
  const host=ctx.ed.page.host;
  const originalCursor=host.style.cursor;
  host.style.cursor="crosshair";
  let ghost:HTMLElement|null=null;
  let current:{body:HTMLElement;startX:number;startY:number;nowX:number;nowY:number;
    sheet:HTMLElement;pointerId:number}|null=null;
  const finish=():void=>{
    host.style.cursor=originalCursor;
    ghost?.remove();ghost=null;current=null;
    host.removeEventListener("pointerdown",onDown,true);
    host.removeEventListener("pointermove",onMove,true);
    host.removeEventListener("pointerup",onUp,true);
    host.removeEventListener("pointercancel",onCancel,true);
    document.removeEventListener("keydown",onKey,true);
  };
  const mmAt=(body:HTMLElement,event:PointerEvent):{x:number;y:number}=>{
    const r=body.getBoundingClientRect();
    return {x:(event.clientX-r.left)/ctx.ed.page.zoom/MM_PX,
      y:(event.clientY-r.top)/ctx.ed.page.zoom/MM_PX};
  };
  const onKey=(event:KeyboardEvent):void=>{
    if(event.key==="Escape"){
      event.preventDefault();event.stopPropagation();
      finish();announce("Shape insertion cancelled");
    }
  };
  const onDown=(event:PointerEvent):void=>{
    if(event.button!==0)return;
    const target=event.target;
    const body=target instanceof Element?target.closest<HTMLElement>(".sheet .body"):null;
    if(!body)return;
    const sheet=body.closest<HTMLElement>(".sheet");if(!sheet)return;
    event.preventDefault();event.stopImmediatePropagation();
    const {x,y}=mmAt(body,event);
    current={body,sheet,startX:x,startY:y,nowX:x,nowY:y,pointerId:event.pointerId};
    ghost=h("div",{class:"shape-insert-preview",attrs:{"aria-hidden":"true"}});
    ghost.style.left=`${x}mm`;ghost.style.top=`${y}mm`;
    body.appendChild(ghost);
    host.setPointerCapture(event.pointerId);
  };
  const onMove=(event:PointerEvent):void=>{
    if(!current||event.pointerId!==current.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const {x,y}=mmAt(current.body,event);
    current.nowX=x;current.nowY=y;
    const dx=x-current.startX,dy=y-current.startY;
    if(ghost){
      ghost.style.left=`${Math.min(x,current.startX)}mm`;
      ghost.style.top=`${Math.min(y,current.startY)}mm`;
      ghost.style.width=`${Math.max(2,Math.abs(dx))}mm`;
      ghost.style.height=`${Math.max(2,Math.abs(dy))}mm`;
    }
  };
  const onCancel=(event:PointerEvent):void=>{
    if(current&&event.pointerId===current.pointerId){event.preventDefault();finish();}
  };
  const onUp=(event:PointerEvent):void=>{
    if(!current||event.pointerId!==current.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const state=current;
    const drag=Math.hypot((state.nowX-state.startX)*MM_PX,(state.nowY-state.startY)*MM_PX)*ctx.ed.page.zoom;
    const shape=defaultShape(kind);
    if(drag>5){
      shape.width_mm=Math.max(2,Math.min(1000,Math.abs(state.nowX-state.startX)));
      shape.height_mm=Math.max(2,Math.min(1000,Math.abs(state.nowY-state.startY)));
    }
    const posX=Math.max(0,drag>5?Math.min(state.startX,state.nowX):state.startX);
    const posY=Math.max(0,drag>5?Math.min(state.startY,state.nowY):state.startY);
    const anchor=state.sheet.querySelector<HTMLElement>(".blk[data-id]:not([data-floating])");
    const fallback=ctx.ed.model.order[ctx.ed.model.order.length-1]??null;
    const target=anchor?.dataset["id"]??fallback;
    shape.layout={mode:"floating",anchor:target?"block":"page",
      ...(target?{target}:{}),
      x_mm:Math.min(5000,posX),y_mm:Math.min(5000,posY),
      wrap:"none",layer:"in_front_of_text"};
    finish();
    void A.insertBlock(ctx.ed,{type:"paragraph",text:"",
      extensions:{[SHAPE_KEY]:shape}},target)
      .then(id=>{if(id){A.selectBlock(ctx.ed,id);announce(`${kind} inserted`);}})
      .catch(error=>toast(errorText(error),{kind:"error"}));
  };
  host.addEventListener("pointerdown",onDown,true);
  host.addEventListener("pointermove",onMove,true);
  host.addEventListener("pointerup",onUp,true);
  host.addEventListener("pointercancel",onCancel,true);
  document.addEventListener("keydown",onKey,true);
  toast(`Click to place a ${kind}, drag to set its size, or press Escape to cancel.`,{kind:"info"});
}
