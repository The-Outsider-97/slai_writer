/** Shape insertion and editing use Writer's existing operation queue, dialog and block selection. */
import { h, labelled, openDialog, toast } from "./kit.js";
import { errorText } from "./net.js";
import { checkbox, selectField } from "./widgets.js";
import { diffText } from "./textops.js";
import { beginShapePlacement } from "./shape_placement.js";
import { transformShapeGroup } from "./shapegroup.js";
import { shapeNumberInput, readShapeNumber } from "./shape_format.js";
import type { Span } from "./types.js";
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { SHAPE_KEY, SHAPE_KINDS, shapeOf, pathFor, roundedRect, type ShapeData, type ShapeKind, type Shadow } from "./shape.js";

const number = (value:number,min:number,max:number,step=1):HTMLInputElement =>
  shapeNumberInput("Numeric shape property",value,min,max,step,step<1?2:2);
const color=(value:string):HTMLInputElement=>h("input",{type:"color",value});
const row=(name:string,node:HTMLElement):HTMLElement=>labelled(name,node);
const percent=(value:number):HTMLInputElement=>number(Math.round(value*100),0,100);
/** Shift unaffected rich-text runs across edits; split runs when replacing text. */
export function rebaseShapeSpans(spans:Span[],start:number,end:number,insertSize:number):Span[]{
  const diff=insertSize-(end-start),next:Span[]=[];
  for(const span of spans){
    if(span.end<=start){next.push({...span});continue;}
    if(span.start>=end){next.push({...span,start:span.start+diff,end:span.end+diff});continue;}
    if(span.start<start)next.push({...span,end:start});
    if(span.end>end)next.push({...span,start:start+insertSize,end:span.end+diff});
  }
  return next.filter(s=>s.start<s.end);
}
const shadowDefault=():Shadow=>({enabled:true,color:"#555555",opacity:.55,offset_x_mm:3,offset_y_mm:3,blur_mm:2,spread_mm:0});

export async function insertShape(ctx:DocCtx):Promise<void> {
  if(ctx.ed.readOnly)return;
  const grid=h("div",{class:"shape-gallery",attrs:{role:"group","aria-label":"Choose a vector shape"}});
  const handle=openDialog<true>({title:"Insert Shape",body:grid,cancelLabel:"Cancel"});
  for(const kind of SHAPE_KINDS){
    const btn=h("button",{type:"button",class:"shape-gallery-item",
      attrs:{"aria-label":`Insert ${kind}`}});
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 100 100");svg.setAttribute("width","38");svg.setAttribute("height","38");
    svg.setAttribute("aria-hidden","true");
    const preview=document.createElementNS("http://www.w3.org/2000/svg",kind==="ellipse"?"ellipse":"path");
    if(kind==="ellipse"){preview.setAttribute("cx","50");preview.setAttribute("cy","50");preview.setAttribute("rx","47");preview.setAttribute("ry","47");}
    else preview.setAttribute("d",kind==="rectangle"?roundedRect([0,0,0,0]):pathFor(kind));
    preview.setAttribute("fill",kind==="line"?"none":"#e3c54a");
    preview.setAttribute("stroke","#202020");preview.setAttribute("stroke-width","4");
    svg.appendChild(preview);
    btn.append(svg,h("span",{text:kind.charAt(0).toUpperCase()+kind.slice(1)}));
    btn.addEventListener("click",()=>{handle.close();beginShapePlacement(ctx,kind);});
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
  let lastText=text.value;
  let spans:Span[]=(s.text.spans??[]).map(x=>({...x}));
  text.addEventListener("input",()=>{
    const diff=diffText(lastText,text.value,text.selectionStart);
    if(diff)spans=rebaseShapeSpans(spans,diff.start,diff.end,diff.insert.length);
    lastText=text.value;
  });
  const addRun=(props:Partial<Span>):void=>{
    const start=text.selectionStart,end=text.selectionEnd;
    if(end<=start){toast("Select the characters to format first.",{kind:"info"});text.focus();return;}
    spans.push({type:"format",start,end,...props});
    if(spans.length>300)spans=spans.slice(-300);
    text.focus();text.setSelectionRange(start,end);
  };
  const formatSelected=h("div",{class:"actions"},
    ...([["Bold","bold"],["Italic","italic"],["Underline","underline"],
      ["Strikethrough","strike"],["Superscript","superscript"],["Subscript","subscript"]] as const).map(([label,key])=>{
      const button=h("button",{type:"button",text:label,attrs:{"aria-label":`${label} selected shape text`}});
      button.addEventListener("mousedown",e=>e.preventDefault());
      button.addEventListener("click",()=>addRun({[key]:true}));
      return button;
    }));
  const formatColor=color("#222222"),formatSize=number(s.text.font_size_pt,5,144,.5);
  const highlightColor=color("#ffff00");
  const highlightSelected=h("button",{type:"button",text:"Highlight selection"});
  highlightSelected.addEventListener("mousedown",e=>e.preventDefault());
  highlightSelected.addEventListener("click",()=>addRun({background:highlightColor.value}));
  const letter=number(0,-10,100,.1),word=number(0,-10,100,.1);
  const applySpacing=h("button",{type:"button",text:"Apply tracking"});
  applySpacing.addEventListener("mousedown",e=>e.preventDefault());
  applySpacing.addEventListener("click",()=>{
    try{addRun({letter_spacing_pt:readShapeNumber(letter,-10,100),
      word_spacing_pt:readShapeNumber(word,-10,100)});}catch(error){toast(errorText(error),{kind:"error"});}
  });
  const colorSelected=h("button",{type:"button",text:"Color selection"});
  colorSelected.addEventListener("mousedown",e=>e.preventDefault());
  colorSelected.addEventListener("click",()=>addRun({color:formatColor.value}));
  const sizeSelected=h("button",{type:"button",text:"Size selection"});
  sizeSelected.addEventListener("mousedown",e=>e.preventDefault());
  sizeSelected.addEventListener("click",()=>addRun({font_size_pt:Number(formatSize.value)}));
  const clearRuns=h("button",{type:"button",text:"Clear selected formatting"});
  clearRuns.addEventListener("click",()=>{const a=text.selectionStart,b=text.selectionEnd;
    spans=spans.flatMap(run=>a<b&&run.start<b&&run.end>a?
      [{...run,end:a},{...run,start:b}].filter(x=>x.start<x.end):[run]);});
  const fit=selectField("Text fitting",[["keep","Keep text size; warn if overflow"],["shrink","Shrink display text to fit"]],s.text.fit??"keep");
  const layout=selectField("Positioning",[["inline","Inline with text"],["floating","Floating relative to page content"]],
    s.layout?.mode??"inline");
  const posX=number(s.layout?.x_mm??0,-5000,5000,.5),posY=number(s.layout?.y_mm??0,-5000,5000,.5);
  const layer=selectField("Object layer",[["content","Content"],["behind_text","Behind text"],["in_front_of_text","In front of text"]],s.layout?.layer??"in_front_of_text");
  const zIndex=number(s.z_index??0,-1000,1000,1);
  const wrap=selectField("Text wrapping",[["none","No wrap / overlay"],["top_bottom","Above and below (flow-aware)"]],
    s.layout?.wrap==="top_bottom"?"top_bottom":"none");
  const syncWrap=():void=>{
    if(wrap.select.value!=="none")layer.select.value="content";
    layer.select.disabled=wrap.select.value!=="none";
  };
  wrap.select.addEventListener("change",syncWrap);syncWrap();
  const floatingControls=h("div",{class:"stack"},row("Horizontal position (mm)",posX),
    row("Vertical position (mm)",posY),wrap.root,layer.root,row("Stacking order",zIndex));
  const updateFloat=():void=>{floatingControls.hidden=layout.select.value!=="floating";};
  layout.select.addEventListener("change",updateFloat);updateFloat();
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
  const selected=():Array<{id:string;shape:ShapeData}>=>[...ctx.ed.selectedShapes].flatMap(key=>{
    const value=shapeOf(ctx.ed.model.block(key));return value?[{id:key,shape:value}]:[];
  });
  const operation=(label:string,work:()=>Promise<void>):HTMLButtonElement=>{
    const button=h("button",{type:"button",text:label});
    button.addEventListener("click",()=>{void work().catch(error=>toast(errorText(error),{kind:"error"}));});
    return button;
  };
  const duplicate=operation("Duplicate",async()=>{
    const duplicate=structuredClone(shapeOf(ctx.ed.model.block(id))??s);
    delete duplicate.group_id;
    if(duplicate.layout?.mode==="floating"){
      duplicate.layout.x_mm=(duplicate.layout.x_mm??0)+5;
      duplicate.layout.y_mm=(duplicate.layout.y_mm??0)+5;
    }
    const created=await A.insertBlock(ctx.ed,{type:"paragraph",text:"",extensions:{[SHAPE_KEY]:duplicate}},id);
    if(created)A.selectBlock(ctx.ed,created);
  });
  const group=operation("Group selected",async()=>{
    const items=selected();if(items.length<2){toast("Shift-click at least two shapes first.",{kind:"info"});return;}
    const modes=new Set(items.map(item=>item.shape.layout?.mode??"inline"));
    if(modes.size!==1){toast("Group shapes with the same positioning mode.",{kind:"info"});return;}
    const groupId=ctx.ed.newId();
    await ctx.ed.op({op:"batch",ops:items.map(item=>({op:"shape_set",block:item.id,
      shape:{...item.shape,group_id:groupId}})),label:"group shapes"});
  });
  const ungroup=operation("Ungroup",async()=>{
    const seed=shapeOf(ctx.ed.model.block(id));
    const items=seed?.group_id?ctx.ed.model.list().flatMap(block=>{
      const value=shapeOf(block);return value?.group_id===seed.group_id?[{id:block.id,shape:value}]:[];
    }):selected();
    if(!items.length)return;
    await ctx.ed.op({op:"batch",ops:items.map(item=>({op:"shape_set",block:item.id,
      shape:{...item.shape,group_id:null}})),label:"ungroup shapes"});
  });
  const moveLayer=(step:number):HTMLButtonElement=>operation(step>0?"Bring forward":"Send backward",async()=>{
    const items=selected().length?selected():[{id,shape:shapeOf(ctx.ed.model.block(id))??s}];
    await ctx.ed.op({op:"batch",ops:items.map(item=>({op:"shape_set",block:item.id,
      shape:{...item.shape,z_index:Math.max(-1000,Math.min(1000,(item.shape.z_index??0)+step))}})),label:"arrange shapes"});
  });
  const arrange=h("div",{class:"actions"},duplicate,group,ungroup,moveLayer(1),moveLayer(-1));
  const groupTransform=(label:string,scale:number,rotation_deg:number):HTMLButtonElement=>
    operation(label,async()=>{
      const seed=shapeOf(ctx.ed.model.block(id));
      const items=seed?.group_id?ctx.ed.model.list().flatMap(block=>{
        const value=shapeOf(block);return value?.group_id===seed.group_id?[{id:block.id,shape:value}]:[];
      }):selected();
      if(items.length<2){toast("Select or group at least two shapes first.",{kind:"info"});return;}
      const pages=new Set(items.map(item=>ctx.ed.els.get(item.id)?.closest(".sheet")));
      if(pages.size>1){toast("Rotate or scale group members on the same page only.",{kind:"info"});return;}
      try{
        const result=transformShapeGroup(items.flatMap(item=>item.shape?[{id:item.id,shape:item.shape}]:[]),{scale,rotation_deg});
        await ctx.ed.op({op:"batch",ops:result.map(item=>({op:"shape_set",block:item.id,shape:item.shape})),
          label:"transform shape group"});
      }catch(error){toast(errorText(error),{kind:"error"});}
    });
  const groupActions=h("div",{class:"actions"},
    groupTransform("Rotate group 90°",1,90),
    groupTransform("Scale group 110%",1.1,0),
    groupTransform("Scale group 90%",.9,0));


  const panes: Array<[string, HTMLElement]> = [
    ["Geometry",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Geometry properties"}},
      h("h3",{text:"Shape geometry"}),kind.root,
      h("div",{class:"grid-2"},row("Width (mm)",width),row("Height (mm)",height)),row("Rotation (degrees)",rotation),
      h("h3",{text:"Rectangle corners"}),...cornerInputs.map((v,i)=>row(["Top left","Top right","Bottom right","Bottom left"][i]??"Corner",v)))],
    ["Fill & Outline",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Fill and outline properties"}},
      h("h3",{text:"Fill"}),fillEnabled.root,row("Fill color",fillColor),row("Fill opacity %",fillOpacity),
      h("h3",{text:"Outline"}),borderEnabled.root,row("Outline color",borderColor),row("Width (pt)",borderWidth),
      borderStyle.root,row("Outline opacity %",borderOpacity),row("Overall opacity %",opacity))],
    ["Text",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Shape text properties"}},
      h("h3",{text:"Shape text"}),row("Content",text),row("Text color",textColor),row("Font size (pt)",textSize),
      textBold.root,textItalic.root,textAlign.root,row("Text padding (mm)",padding),fit.root,
      h("p",{class:"muted",text:"Select a range of text to format only those characters."}),
      formatSelected,h("div",{class:"actions"},formatColor,colorSelected,highlightColor,highlightSelected,
        formatSize,sizeSelected,letter,word,applySpacing,clearRuns))],
    ["Effects",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Effects and shadows"}},
      h("h3",{text:"Independent shadow layers"}),shadowList,add)],
    ["Position",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Position and wrapping"}},
      h("h3",{text:"Position and wrapping"}),layout.root,floatingControls,
      h("p",{class:"muted",text:"For square and contour wrapping, use only verified modes; top/bottom uses block flow."}))],
    ["Arrange",h("section",{class:"shape-properties-pane stack",attrs:{"aria-label":"Arrangement and grouping"}},
      h("h3",{text:"Arrangement"}),arrange,
      h("p",{class:"muted",text:"Shift-click other shapes to select a group. Compound transforms require floating shapes on one page."}),
      groupActions)]
  ];
  const tablist=h("div",{class:"shape-properties-tabs",attrs:{role:"tablist","aria-label":"Shape property categories"}});
  const view=h("div",{class:"shape-properties-content"});
  const tabs:HTMLButtonElement[]=[];
  const showPane=(n:number):void=>{
    panes.forEach(([name,node],i)=>{
      node.hidden=i!==n;
      tabs[i]?.setAttribute("aria-selected",String(i===n));
      tabs[i]?.setAttribute("tabindex",i===n?"0":"-1");
      void name;
    });
    view.scrollTop=0;
  };
  for(const [name,node] of panes){
    const i=tabs.length;
    const tab=h("button",{type:"button",class:"shape-properties-tab",text:name,
      attrs:{role:"tab",tabindex:i===0?"0":"-1","aria-selected":i===0?"true":"false"}});
    tab.addEventListener("click",()=>showPane(i));
    tab.addEventListener("keydown",e=>{
      if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft")return;
      e.preventDefault();
      const next=(i+(e.key==="ArrowRight"?1:-1)+panes.length)%panes.length;
      showPane(next);tabs[next]?.focus();
    });
    tablist.append(tab);tabs.push(tab);view.append(node);
  }
  showPane(0);
  const body=h("div",{class:"shape-format-form shape-format-tabbed"},tablist,view);
  // Corners have meaning for rectangular geometry only.
  const updateCorners=():void=>{
    const visible=kind.select.value==="rectangle";
    cornerInputs.forEach(input=>{input.disabled=!visible;});
  };
  kind.select.addEventListener("change",updateCorners);updateCorners();
  const dialog=openDialog<true>({title:"Shape Format",body,
    actions:[{label:"Apply changes",kind:"primary",run:async()=>{
      try {
      s.kind=kind.select.value as ShapeKind;
      s.width_mm=readShapeNumber(width,2,1000);s.height_mm=readShapeNumber(height,2,1000);
      s.rotation_deg=readShapeNumber(rotation,-360,360);
      s.fill={enabled:fillEnabled.input.checked,color:fillColor.value,opacity:readShapeNumber(fillOpacity,0,100)/100};
      s.outline={enabled:borderEnabled.input.checked,color:borderColor.value,opacity:readShapeNumber(borderOpacity,0,100)/100,
        width_pt:readShapeNumber(borderWidth,.1,72),style:borderStyle.select.value as ShapeData["outline"]["style"]};
      s.opacity=readShapeNumber(opacity,0,100)/100;
      s.corners_mm=s.kind==="rectangle"?cornerInputs.map(x=>readShapeNumber(x,0,500)):[0,0,0,0];
      s.text={content:text.value,color:textColor.value,font_size_pt:readShapeNumber(textSize,5,144),
        bold:textBold.input.checked,italic:textItalic.input.checked,align:textAlign.select.value as ShapeData["text"]["align"],
        padding_mm:readShapeNumber(padding,0,50),spans,fit:fit.select.value as "keep"|"shrink"};
      s.shadows=shadows;
      s.z_index=Math.round(readShapeNumber(zIndex,-1000,1000));
      if(layout.select.value==="inline")s.layout={mode:"inline"};
      else{
        const anchor=ctx.ed.model.order.find(x=>x!==id)??null;
        s.layout={mode:"floating",anchor:anchor?"block":"page",
          ...(anchor?{target:anchor}:{}),x_mm:readShapeNumber(posX,-5000,5000),y_mm:readShapeNumber(posY,-5000,5000),
          wrap:wrap.select.value as "none"|"top_bottom",
          layer:wrap.select.value!=="none"?"content":layer.select.value as "content"|"behind_text"|"in_front_of_text"};
      }
      await ctx.ed.op({op:"shape_set",block:id,shape:s,label:"format shape"});return true;
      }catch(e){toast(errorText(e),{kind:"error"});return undefined;}
    }}]});
  await dialog.result;
}
