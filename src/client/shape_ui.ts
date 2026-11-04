/** Shape insertion and editing use Writer's existing operation queue, dialog and block selection. */
import { h, labelled, openDialog, toast } from "./kit.js";
import { errorText } from "./net.js";
import { checkbox, selectField } from "./widgets.js";
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { SHAPE_KEY, SHAPE_KINDS, defaultShape, shapeOf, type ShapeData, type ShapeKind, type Shadow } from "./shape.js";

const number = (value:number,min:number,max:number,step=1):HTMLInputElement =>
  h("input",{type:"number",value:String(value),min,max,step,attrs:{inputmode:"decimal"}});
const color=(value:string):HTMLInputElement=>h("input",{type:"color",value});
const row=(name:string,node:HTMLElement):HTMLElement=>labelled(name,node);
const percent=(value:number):HTMLInputElement=>number(Math.round(value*100),0,100);
const shadowDefault=():Shadow=>({enabled:true,color:"#555555",opacity:.55,offset_x_mm:3,offset_y_mm:3,blur_mm:2,spread_mm:0});

export async function insertShape(ctx:DocCtx):Promise<void> {
  if(ctx.ed.readOnly)return;
  const grid=h("div",{class:"shape-gallery",attrs:{role:"group","aria-label":"Choose a vector shape"}});
  const handle=openDialog<true>({title:"Insert Shape",body:grid,cancelLabel:"Cancel"});
  for(const kind of SHAPE_KINDS){
    const btn=h("button",{type:"button",class:"shape-gallery-item",text:kind[0]?.toUpperCase()+kind.slice(1),
      attrs:{"aria-label":`Insert ${kind}`}});
    btn.addEventListener("click",()=>{void (async()=>{
      try {
        const id=await A.insertBlock(ctx.ed,{type:"paragraph",text:"",extensions:{[SHAPE_KEY]:defaultShape(kind)}});
        if(id){handle.close();A.selectBlock(ctx.ed,id);await editShape(ctx,id);}
      }catch(e){toast(errorText(e),{kind:"error"});}
    })();});
    grid.appendChild(btn);
  }
  await handle.result;
}
export async function editShape(ctx:DocCtx,id:string):Promise<void>{
  const old=shapeOf(ctx.ed.model.block(id));
  if(!old||ctx.ed.readOnly)return;
  const s:ShapeData=structuredClone(old);
  const kind=selectField("Shape type",SHAPE_KINDS.map(x=>[x,x]),s.kind);
  const width=number(s.width_mm,2,1000,.5),height=number(s.height_mm,2,1000,.5);
  const rotation=number(s.rotation_deg,-360,360,1);
  const fillEnabled=checkbox("Fill visible",s.fill.enabled),fillColor=color(s.fill.color),fillOpacity=percent(s.fill.opacity);
  const borderEnabled=checkbox("Outline visible",s.outline.enabled),borderColor=color(s.outline.color);
  const borderWidth=number(s.outline.width_pt,.1,72,.5),borderOpacity=percent(s.outline.opacity);
  const borderStyle=selectField("Outline style",[["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"]],s.outline.style);
  const opacity=percent(s.opacity);
  const text=h("textarea",{rows:3,maxLength:4000,value:s.text.content,attrs:{"aria-label":"Text inside shape"}});
  const textColor=color(s.text.color),textSize=number(s.text.font_size_pt,5,144,.5);
  const textBold=checkbox("Bold",s.text.bold),textItalic=checkbox("Italic",s.text.italic);
  const textAlign=selectField("Text alignment",[["left","Left"],["center","Center"],["right","Right"]],s.text.align);
  const padding=number(s.text.padding_mm,0,50,.5);
  const cornerInputs=[0,1,2,3].map(i=>number(s.corners_mm[i]??0,0,500,.5));
  const shadowList=h("div",{class:"shape-shadow-list"});
  const shadows=s.shadows.map(x=>({...x}));
  const rebuild=():void=>{
    shadowList.replaceChildren();
    shadows.forEach((shadow,i)=>{
      const en=checkbox(`Shadow ${i+1} enabled`,shadow.enabled);
      const cc=color(shadow.color),alpha=percent(shadow.opacity);
      const x=number(shadow.offset_x_mm,-100,100,.5),y=number(shadow.offset_y_mm,-100,100,.5);
      const blur=number(shadow.blur_mm,0,30,.5),spread=number(shadow.spread_mm,-20,30,.5);
      const del=h("button",{type:"button",text:"Remove shadow"});
      del.addEventListener("click",()=>{shadows.splice(i,1);rebuild();});
      const up=h("button",{type:"button",text:"Move up",disabled:i===0});
      up.addEventListener("click",()=>{if(i>0){[shadows[i-1],shadows[i]]=[shadows[i] as Shadow,shadows[i-1] as Shadow];rebuild();}});
      const down=h("button",{type:"button",text:"Move down",disabled:i===shadows.length-1});
      down.addEventListener("click",()=>{if(i<shadows.length-1){[shadows[i+1],shadows[i]]=[shadows[i] as Shadow,shadows[i+1] as Shadow];rebuild();}});
      const controls=[cc,alpha,x,y,blur,spread];
      const sync=():void=>{shadow.enabled=en.input.checked;shadow.color=cc.value;shadow.opacity=Number(alpha.value)/100;
        shadow.offset_x_mm=Number(x.value);shadow.offset_y_mm=Number(y.value);shadow.blur_mm=Number(blur.value);shadow.spread_mm=Number(spread.value);};
      en.input.addEventListener("change",sync);controls.forEach(n=>n.addEventListener("change",sync));
      shadowList.appendChild(h("fieldset",{class:"shape-shadow"},h("legend",{text:`Shadow ${i+1}`}),
        en.root,row("Color",cc),row("Opacity %",alpha),row("Offset X (mm)",x),row("Offset Y (mm)",y),
        row("Blur (mm)",blur),row("Spread (mm)",spread),h("div",{class:"actions"},up,down,del)));
    });
  };
  rebuild();
  const add=h("button",{type:"button",text:"+ Add Shadow"});
  add.addEventListener("click",()=>{if(shadows.length<8){shadows.push(shadowDefault());rebuild();}else toast("Eight shadows is the maximum.",{kind:"info"});});
  const body=h("div",{class:"shape-format-form stack"},
    h("h3",{text:"Geometry"}),kind.root,h("div",{class:"grid-2"},row("Width (mm)",width),row("Height (mm)",height)),
    row("Rotation (degrees)",rotation),
    h("h3",{text:"Fill and outline"}),fillEnabled.root,row("Fill color",fillColor),row("Fill opacity %",fillOpacity),
    borderEnabled.root,row("Outline color",borderColor),row("Outline width (pt)",borderWidth),
    borderStyle.root,row("Outline opacity %",borderOpacity),row("Overall opacity %",opacity),
    h("h3",{text:"Corners (rectangles)"}),...cornerInputs.map((v,i)=>row(["Top left","Top right","Bottom right","Bottom left"][i]??"Corner",v)),
    h("h3",{text:"Text"}),row("Content",text),row("Text color",textColor),row("Font size (pt)",textSize),
    textBold.root,textItalic.root,textAlign.root,row("Text padding (mm)",padding),
    h("h3",{text:"Shadow layers"}),shadowList,add);
  const dialog=openDialog<true>({title:"Shape Format",body,
    actions:[{label:"Apply changes",kind:"primary",run:async()=>{
      s.kind=kind.select.value as ShapeKind;
      s.width_mm=Number(width.value);s.height_mm=Number(height.value);s.rotation_deg=Number(rotation.value);
      s.fill={enabled:fillEnabled.input.checked,color:fillColor.value,opacity:Number(fillOpacity.value)/100};
      s.outline={enabled:borderEnabled.input.checked,color:borderColor.value,opacity:Number(borderOpacity.value)/100,
        width_pt:Number(borderWidth.value),style:borderStyle.select.value as ShapeData["outline"]["style"]};
      s.opacity=Number(opacity.value)/100;
      s.corners_mm=s.kind==="rectangle"?cornerInputs.map(x=>Number(x.value)):[0,0,0,0];
      s.text={content:text.value,color:textColor.value,font_size_pt:Number(textSize.value),
        bold:textBold.input.checked,italic:textItalic.input.checked,align:textAlign.select.value as ShapeData["text"]["align"],
        padding_mm:Number(padding.value)};
      s.shadows=shadows;
      try{await ctx.ed.op({op:"shape_set",block:id,shape:s,label:"format shape"});return true;}
      catch(e){toast(errorText(e),{kind:"error"});return undefined;}
    }}]});
  await dialog.result;
}
