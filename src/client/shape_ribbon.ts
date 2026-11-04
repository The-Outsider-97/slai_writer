/** Contextual Shape Format workspace.
 *
 * Uses the SAME shape_set / batch operations and shape data used by the full
 * properties dialog. Every user gesture commits at most one undoable operation.
 * Panels are contextual and compact, instead of a kilometre-wide ribbon.
 */
import { h, toast } from "./kit.js";
import { errorText } from "./net.js";
import type { DocCtx } from "./docctx.js";
import * as A from "./actions.js";
import { SHAPE_KEY, SHAPE_KINDS, shapeOf, pathFor, roundedRect, type ShapeData, type ShapeKind } from "./shape.js";
import { changeShapeKind, normalizeShapeCorners, resizeShape, shadowPreset,
  shapeNumberInput, readShapeNumber } from "./shape_format.js";
import { transformShapeGroup } from "./shapegroup.js";

type Pair = { id:string; shape:ShapeData };
type Panel = "shape"|"geometry"|"fill"|"outline"|"corners"|"text"|"effects"|"position"|"arrange"|"group";
const SHAPE_LABELS:Record<Panel,string>={
  shape:"Shapes",geometry:"Geometry",fill:"Fill",outline:"Outline",corners:"Corners",
  text:"Shape Text",effects:"Effects",position:"Position",arrange:"Arrange",group:"Group"
};
const ns="http://www.w3.org/2000/svg";
const button=(label:string,run:()=>void):HTMLButtonElement=>{
  const b=h("button",{type:"button",class:"shape-command",text:label,attrs:{"aria-label":label}});
  b.addEventListener("click",run);return b;
};
const label=(name:string,node:HTMLElement):HTMLElement=>
  h("label",{class:"shape-ribbon-field"},h("span",{text:name}),node);
const section=(...items:HTMLElement[]):HTMLElement=>h("div",{class:"shape-ribbon-row"},...items);
const selectionField=(values:ReadonlyArray<readonly [string,string]>,active:string,description:string):HTMLSelectElement=>{
  const s=h("select",{attrs:{"aria-label":description}});
  for(const [value,text] of values){const option=h("option",{value,text});s.append(option);}
  s.value=active;return s;
};
const check=(title:string,initial:boolean):HTMLInputElement=>{
  const input=h("input",{type:"checkbox",checked:initial,attrs:{"aria-label":title}});return input;
};
const color=(name:string,v:string):HTMLInputElement=>h("input",{type:"color",value:v,attrs:{"aria-label":name}});
const numeric=(name:string,v:number,min:number,max:number,step:number,digits=2):HTMLInputElement=>
  shapeNumberInput(name,v,min,max,step,digits);

export function buildShapeWorkspace(ctx:DocCtx):{el:HTMLElement;update():void} {
  const {ed}=ctx;
  const root=h("div",{class:"shape-workspace",attrs:{"aria-label":"Shape Format controls"}});
  const nav=h("div",{class:"shape-workspace-nav",attrs:{role:"tablist","aria-label":"Shape editing categories"}});
  const surface=h("div",{class:"shape-workspace-surface",
    attrs:{role:"tabpanel","aria-label":"Shape editing properties",tabindex:"0"}});
  const panelButtons=new Map<Panel,HTMLButtonElement>();
  let active:Panel="geometry";
  let currentId:string|null=null;
  let activeShadowIndex=0;
  let sync:()=>void=()=>{};
  const selected=():Pair|null=>{
    const id=ed.selectedBlock;
    const shape=shapeOf(id?ed.model.block(id):undefined);
    return id&&shape?{id,shape}:null;
  };
  const members=():Pair[]=>{
    const current=selected();
    if(!current)return[];
    const ids=new Set<string>(ed.selectedShapes.size?[...ed.selectedShapes]:[current.id]);
    if(current.shape.group_id)for(const item of ed.model.list()){
      const shape=shapeOf(item);
      if(shape?.group_id===current.shape.group_id)ids.add(item.id);
    }
    return [...ids].flatMap(id=>{const shape=shapeOf(ed.model.block(id));return shape?[{id,shape}]:[];});
  };
  const run=(promise:Promise<unknown>):void=>{void promise.catch(error=>toast(errorText(error),{kind:"error"}));};
  // Serialize edits per workspace, re-reading current model state after each
  // operation. Otherwise two rapid controls can clone the same stale object
  // and silently overwrite one another's changes.
  let pending:Promise<void>=Promise.resolve();
  const enqueue=(task:()=>Promise<unknown>):void=>{
    const next=pending.then(task).then(()=>{});
    pending=next.catch(()=>{});
    run(next);
  };
  const change=(modifier:(s:ShapeData)=>void,caption:string):void=>{
    const id=selected()?.id;if(!id||ed.readOnly)return;
    enqueue(async()=>{
      const source=shapeOf(ed.model.block(id));if(!source)throw Error("Selected shape no longer exists");
      const next=structuredClone(source);
      modifier(next);
      await ed.op({op:"shape_set",block:id,shape:next,label:caption});
    });
  };
  const changeMany=(fn:(entry:Pair)=>ShapeData,caption:string):void=>{
    const ids=members().map(item=>item.id);if(!ids.length||ed.readOnly)return;
    enqueue(async()=>{
      const ops=ids.map(id=>{
        const shape=shapeOf(ed.model.block(id));
        if(!shape)throw Error("A selected shape no longer exists");
        return {op:"shape_set",block:id,shape:fn({id,shape})};
      });
      await ed.op({op:"batch",ops,label:caption});
    });
  };
  const inputChange=(node:HTMLInputElement,min:number,max:number,fn:(n:number)=>void):void=>{
    node.addEventListener("change",()=>{
      try{fn(readShapeNumber(node,min,max));}
      catch(error){toast(errorText(error),{kind:"error"});sync();}
    });
  };
  const bind=(node:HTMLInputElement,mutate:(s:ShapeData)=>void,desc:string):void=>
    node.addEventListener("change",()=>change(mutate,desc));
  const detail=():void=>{
    const item=selected();if(!item)return;
    // Use the already-loaded Shape Format dialog, with the same shape_set backend.
    void import("./shape_ui.js").then(m=>m.editShape(ctx,item.id));
  };
  const enable=(kind:"fill"|"outline",enabled:boolean):void=>change(s=>{s[kind].enabled=enabled;},kind+" visibility");
  const addNumber=(title:string,value:number,min:number,max:number,step:number,
    modify:(s:ShapeData,n:number)=>void,digits=2):HTMLElement=>{
    const node=numeric(title,value,min,max,step,digits);
    inputChange(node,min,max,n=>change(s=>modify(s,n),title));
    return label(title,node);
  };
  const textGroup=(key:"bold"|"italic",labelText:string):HTMLElement=>{
    const item=selected()!;
    const input=check(labelText,item.shape.text[key]);
    bind(input,s=>{s.text[key]=input.checked;},labelText);
    return label(labelText,input);
  };
  const areaFor=(key:Panel):HTMLElement=>{
    const data=selected();if(!data)return h("div",{text:"Select a vector shape to edit."});
    const s=data.shape,group=h("div",{class:"shape-ribbon-card"});
    const row=(...items:HTMLElement[]):void=>{group.appendChild(section(...items));};
    const add=(text:string,operation:()=>void):HTMLButtonElement=>button(text,operation);
    const field=(title:string,v:number,min:number,max:number,step:number,fn:(next:ShapeData,n:number)=>void,digits=2):HTMLElement=>
      addNumber(title,v,min,max,step,fn,digits);
    if(key==="shape"){
      const picker=selectionField(SHAPE_KINDS.map(x=>[x,x[0]!.toUpperCase()+x.slice(1)] as const),s.kind,"Shape preset");
      picker.addEventListener("change",()=>change(sh=>Object.assign(sh,changeShapeKind(sh,picker.value as ShapeKind)),"change shape preset"));
      const gallery=h("div",{class:"shape-ribbon-gallery"});
      for(const kind of SHAPE_KINDS){
        const b=h("button",{type:"button",class:"shape-gallery-small",attrs:{"aria-label":`Change to ${kind}`,title:kind}});
        const svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 100 100");
        svg.setAttribute("aria-hidden","true");
        const p=document.createElementNS(ns,kind==="ellipse"?"ellipse":"path");
        if(kind==="ellipse")for(const [name,val]of Object.entries({cx:50,cy:50,rx:45,ry:45}))p.setAttribute(name,String(val));
        else p.setAttribute("d",kind==="rectangle"?roundedRect([0,0,0,0]):pathFor(kind));
        p.setAttribute("fill",kind==="line"?"none":"#e1bf38");p.setAttribute("stroke","#303030");p.setAttribute("stroke-width","4");
        svg.appendChild(p);b.append(svg);
        b.setAttribute("aria-pressed",String(s.kind===kind));
        b.addEventListener("click",()=>change(sh=>Object.assign(sh,changeShapeKind(sh,kind)),"change shape preset"));
        gallery.append(b);
      }
      row(label("Change shape",picker),gallery,add("Duplicate",()=>{
        const fresh=structuredClone(s);delete fresh.group_id;
        if(fresh.layout?.mode==="floating"){
          fresh.layout.x_mm=Math.min(5000,(fresh.layout.x_mm??0)+5);
          fresh.layout.y_mm=Math.min(5000,(fresh.layout.y_mm??0)+5);
        }
        run(A.insertBlock(ed,{type:"paragraph",text:"",extensions:{[SHAPE_KEY]:fresh}},data.id)
          .then(id=>{if(id)A.selectBlock(ed,id);}));
      }),add("Reset appearance",()=>change(sh=>{
        sh.fill={enabled:true,color:"#f1d24b",opacity:1};
        sh.outline={enabled:true,color:"#202020",opacity:1,width_pt:1.5,style:"solid"};
        sh.shadows=[];sh.opacity=1;sh.rotation_deg=0;
      },"reset appearance")));
    }else if(key==="geometry"){
      let locked=false;const lock=check("Lock aspect ratio",locked);
      lock.addEventListener("change",()=>{locked=lock.checked;});
      row(field("Width (mm)",s.width_mm,2,1000,.5,(shape,n)=>Object.assign(shape,resizeShape(shape,n,shape.height_mm,locked))),
        field("Height (mm)",s.height_mm,2,1000,.5,(shape,n)=>Object.assign(shape,resizeShape(shape,locked?shape.width_mm*n/shape.height_mm:shape.width_mm,n,false))),
        label("Lock ratio",lock),
        field("Rotation (°)",s.rotation_deg,-360,360,1,(shape,n)=>{shape.rotation_deg=n;}),
        add("Flip horizontal",()=>change(shape=>{shape.flip_horizontal=!shape.flip_horizontal;},"flip shape horizontally")),
        add("Flip vertical",()=>change(shape=>{shape.flip_vertical=!shape.flip_vertical;},"flip shape vertically")),
        add("Reset rotation",()=>change(shape=>{shape.rotation_deg=0;},"reset rotation")));
    }else if(key==="fill"){
      const enabled=check("Fill enabled",s.fill.enabled),ink=color("Fill color",s.fill.color);
      const pct=numeric("Fill opacity %",s.fill.opacity*100,0,100,1,0);
      bind(enabled,sh=>{sh.fill.enabled=enabled.checked;},"fill visibility");
      bind(ink,sh=>{sh.fill.color=ink.value;sh.fill.enabled=true;},"fill color");
      inputChange(pct,0,100,n=>change(sh=>{sh.fill.opacity=n/100;},"fill opacity"));
      row(label("Enabled",enabled),label("Color",ink),label("Opacity %",pct),
        add("No Fill",()=>enable("fill",false)),add("Solid Fill",()=>enable("fill",true)));
    }else if(key==="outline"){
      const enabled=check("Outline enabled",s.outline.enabled),ink=color("Outline color",s.outline.color);
      const alpha=numeric("Outline opacity %",s.outline.opacity*100,0,100,1,0);
      const style=selectionField([["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"]],s.outline.style,"Outline style");
      bind(enabled,sh=>{sh.outline.enabled=enabled.checked;},"outline visibility");
      bind(ink,sh=>{sh.outline.color=ink.value;sh.outline.enabled=true;},"outline color");
      inputChange(alpha,0,100,n=>change(sh=>{sh.outline.opacity=n/100;},"outline opacity"));
      style.addEventListener("change",()=>change(sh=>{sh.outline.style=style.value as ShapeData["outline"]["style"];},"outline style"));
      row(label("Enabled",enabled),label("Color",ink),
        field("Width (pt)",s.outline.width_pt,.1,72,.5,(shape,n)=>{shape.outline.width_pt=n;}),
        label("Style",style),label("Opacity %",alpha),add("No Outline",()=>enable("outline",false)));
    }else if(key==="corners"){
      if(s.kind!=="rectangle")return h("div",{class:"shape-ribbon-note",text:"Independent corner radii apply to rectangles only."});
      const radius=Math.max(...s.corners_mm);
      row(field("All corners (mm)",radius,0,Math.min(s.width_mm,s.height_mm)/2,.5,(sh,n)=>{sh.corners_mm=[n,n,n,n];}),
        ...["Top left","Top right","Bottom right","Bottom left"].map((name,i)=>
          field(name,s.corners_mm[i]??0,0,Math.min(s.width_mm,s.height_mm)/2,.5,(sh,n)=>{
            const corners=[...sh.corners_mm];corners[i]=n;
            sh.corners_mm=normalizeShapeCorners(corners,sh.width_mm,sh.height_mm);
          })),
        add("Reset corners",()=>change(sh=>{sh.corners_mm=[0,0,0,0];},"reset corners")));
    }else if(key==="text"){
      const title=h("input",{type:"text",value:s.text.content,maxLength:4000,
        attrs:{"aria-label":"Shape text",placeholder:"Text inside the shape"}});
      title.addEventListener("change",()=>change(sh=>{sh.text.content=title.value;
        sh.text.spans=[];},"edit shape text"));
      const size=field("Font size (pt)",s.text.font_size_pt,5,144,.5,(sh,n)=>{sh.text.font_size_pt=n;});
      const ink=color("Shape text color",s.text.color);
      bind(ink,sh=>{sh.text.color=ink.value;},"shape text color");
      const align=selectionField([["left","Left"],["center","Center"],["right","Right"]],s.text.align,"Shape text alignment");
      align.addEventListener("change",()=>change(sh=>{sh.text.align=align.value as ShapeData["text"]["align"];},"shape text alignment"));
      const fit=selectionField([["keep","Keep size"],["shrink","Shrink to fit"]],s.text.fit??"keep","Text fitting");
      fit.addEventListener("change",()=>change(sh=>{sh.text.fit=fit.value as "keep"|"shrink";},"shape text fitting"));
      row(label("Content",title),size,textGroup("bold","Bold"),textGroup("italic","Italic"),
        label("Text color",ink),label("Align",align),label("Fit",fit),
        field("Padding (mm)",s.text.padding_mm,0,Math.min(s.width_mm,s.height_mm)/4,.5,
          (sh,n)=>{sh.text.padding_mm=n;}),
        add("Edit selected runs…",detail));
    }else if(key==="effects"){
      row(field("Overall opacity %",s.opacity*100,0,100,1,(sh,n)=>{sh.opacity=n/100;},0),
        ...(["soft","hard","bottom","glow"] as const).map(preset=>add(preset.charAt(0).toUpperCase()+preset.slice(1)+" shadow",()=>{
          change(sh=>{if(sh.shadows.length>=8)throw Error("Maximum of eight shadow layers");
            sh.shadows.push(shadowPreset(preset));},"add shadow");
        })),
        add("Remove last shadow",()=>change(sh=>{sh.shadows.pop();},"remove shadow")),
        add("Advanced shadows…",detail));
      const alpha=check("Shadows enabled",s.shadows.some(x=>x.enabled));
      bind(alpha,sh=>{sh.shadows=sh.shadows.map(x=>({...x,enabled:alpha.checked}));},"toggle shadows");
      row(label("Enable shadows",alpha),add("Clear shadows",()=>change(sh=>{sh.shadows=[];},"clear shadows")));
      if(s.shadows.length){
        activeShadowIndex=Math.max(0,Math.min(s.shadows.length-1,activeShadowIndex));
        const pick=selectionField(s.shadows.map((_,i)=>[String(i),`Shadow ${i+1}`] as const),
          String(activeShadowIndex),"Choose shadow layer");
        pick.addEventListener("change",()=>{activeShadowIndex=Number(pick.value);show("effects");});
        const index=activeShadowIndex;
        const sh=s.shadows[index]!;
        const enabled=check("Shadow visible",sh.enabled),ink=color("Shadow color",sh.color);
        const applyShadow=(modify:(value:ShapeData["shadows"][number])=>void,name:string):void=>
          change(data=>{if(data.shadows[index])modify(data.shadows[index]!);},name);
        enabled.addEventListener("change",()=>applyShadow(value=>{value.enabled=enabled.checked;},"shadow visibility"));
        ink.addEventListener("change",()=>applyShadow(value=>{value.color=ink.value;},"shadow color"));
        row(label("Layer",pick),label("Enabled",enabled),label("Color",ink),
          field("Opacity %",sh.opacity*100,0,100,1,(_s,n)=>{_s.shadows[index]!.opacity=n/100;},0),
          field("X offset (mm)",sh.offset_x_mm,-100,100,.5,(_s,n)=>{_s.shadows[index]!.offset_x_mm=n;}),
          field("Y offset (mm)",sh.offset_y_mm,-100,100,.5,(_s,n)=>{_s.shadows[index]!.offset_y_mm=n;}),
          field("Blur (mm)",sh.blur_mm,0,30,.5,(_s,n)=>{_s.shadows[index]!.blur_mm=n;}),
          field("Spread (mm)",sh.spread_mm,-20,30,.5,(_s,n)=>{_s.shadows[index]!.spread_mm=n;}),
          add("Move up",()=>change(_s=>{
            if(activeShadowIndex>0)[_s.shadows[index-1],_s.shadows[index]]=
              [_s.shadows[index]!,_s.shadows[index-1]!];
            activeShadowIndex=Math.max(0,activeShadowIndex-1);
          },"reorder shadow layers")),
          add("Move down",()=>change(_s=>{
            if(activeShadowIndex+1<_s.shadows.length)[_s.shadows[index+1],_s.shadows[index]]=
              [_s.shadows[index]!,_s.shadows[index+1]!];
            activeShadowIndex=Math.min(_s.shadows.length-1,activeShadowIndex+1);
          },"reorder shadow layers")));
      }
    }else if(key==="position"){
      const mode=selectionField([["inline","Inline with text"],["floating","Floating"]],s.layout?.mode??"inline","Shape positioning");
      const anchor=selectionField([["block","Paragraph anchor"],["page","Page anchor"]],s.layout?.anchor??"block","Anchor type");
      const layers=selectionField([["content","Content"],["behind_text","Behind text"],["in_front_of_text","In front of text"]],
        s.layout?.layer??"content","Shape layer");
      const wrap=selectionField([["none","No wrapping"],["top_bottom","Top and bottom"]],s.layout?.wrap??"none","Text wrapping");
      const placement=(sh:ShapeData):void=>{
        if(mode.value==="inline"){sh.layout={mode:"inline"};return;}
        const target=ed.model.order.find(id=>id!==data.id);
        const anchorKind=anchor.value==="page"||!target?"page":"block";
        const selectedWrap=anchorKind==="page"?"none":wrap.value as "none"|"top_bottom";
        sh.layout={mode:"floating",anchor:anchorKind,...(anchorKind==="block"?{target}:{}),
          x_mm:sh.layout?.x_mm??0,y_mm:sh.layout?.y_mm??0,wrap:selectedWrap,
          layer:selectedWrap==="none"?(layers.value as "content"|"behind_text"|"in_front_of_text"):"content"};
      };
      for(const combo of [mode,anchor,layers,wrap])combo.addEventListener("change",()=>change(placement,"shape placement"));
      row(label("Position",mode),label("Anchor",anchor),label("Wrap",wrap),label("Layer",layers),
        field("X (mm)",s.layout?.x_mm??0,-5000,5000,.5,(sh,n)=>{placement(sh);if(sh.layout?.mode==="floating")sh.layout.x_mm=n;}),
        field("Y (mm)",s.layout?.y_mm??0,-5000,5000,.5,(sh,n)=>{placement(sh);if(sh.layout?.mode==="floating")sh.layout.y_mm=n;}));
    }else if(key==="arrange"){
      const moveZ=(step:number,absolute=false):void=>changeMany(({shape})=>({...shape,z_index:Math.max(-1000,Math.min(1000,absolute?step:(shape.z_index??0)+step))}),"arrange shapes");
      const align=(axis:"x"|"y",where:"start"|"mid"|"end"):void=>{
        const items=members();
        if(items.length<2){toast("Select multiple floating shapes first.",{kind:"info"});return;}
        if(items.some(item=>item.shape.layout?.mode!=="floating")){
          toast("Alignment requires floating shapes.",{kind:"info"});return;
        }
        const positions=items.map(({shape})=>{
          const at=axis==="x"?shape.layout!.x_mm??0:shape.layout!.y_mm??0;
          const size=axis==="x"?shape.width_mm:shape.height_mm;
          return where==="start"?at:where==="end"?at+size:at+size/2;
        });
        const target=where==="start"?Math.min(...positions):where==="end"?Math.max(...positions):
          positions.reduce((a,b)=>a+b,0)/positions.length;
        changeMany(({shape})=>{
          const old=structuredClone(shape);
          const size=axis==="x"?old.width_mm:old.height_mm;
          const dest=target-(where==="start"?0:where==="end"?size:size/2);
          if(old.layout?.mode==="floating")old.layout[axis==="x"?"x_mm":"y_mm"]=Math.max(-5000,Math.min(5000,dest));
          return old;
        },"align shapes");
      };
      const distribute=(axis:"x"|"y"):void=>{
        const items=members();
        if(items.length<3||items.some(x=>x.shape.layout?.mode!=="floating")){
          toast("Select at least three floating shapes to distribute.",{kind:"info"});return;
        }
        const sorted=items.map(x=>({id:x.id,pos:axis==="x"?x.shape.layout!.x_mm??0:x.shape.layout!.y_mm??0})).sort((a,b)=>a.pos-b.pos);
        const start=sorted[0]!.pos,end=sorted[sorted.length-1]!.pos;
        const targets=new Map(sorted.map((x,i)=>[x.id,start+(end-start)*i/(sorted.length-1)]));
        changeMany(entry=>{
          const sh=structuredClone(entry.shape);
          if(sh.layout?.mode==="floating")sh.layout[axis==="x"?"x_mm":"y_mm"]=targets.get(entry.id)!;
          return sh;
        },"distribute shapes");
      };
      row(add("Forward",()=>moveZ(1)),add("Backward",()=>moveZ(-1)),add("Front",()=>moveZ(1000,true)),
        add("Back",()=>moveZ(-1000,true)),
        add("Align left",()=>align("x","start")),add("Align center",()=>align("x","mid")),add("Align right",()=>align("x","end")),
        add("Align top",()=>align("y","start")),add("Align middle",()=>align("y","mid")),add("Align bottom",()=>align("y","end")),
        add("Distribute ↔",()=>distribute("x")),add("Distribute ↕",()=>distribute("y")));
    }else if(key==="group"){
      const groups=members();
      row(add("Group selected",()=>{
        if(groups.length<2){toast("Shift-click two or more shapes.",{kind:"info"});return;}
        const id=ed.newId();
        changeMany(({shape})=>({...shape,group_id:id}),"group shapes");
      }),add("Ungroup",()=>changeMany(({shape})=>({...shape,group_id:null}),"ungroup shapes")),
      ...([["Rotate +90°",1,90],["Scale +10%",1.1,0],["Scale −10%",.9,0]] as const).map(([name,scale,rotation_deg])=>
        add(name,()=>{
          const parts=members();
          if(parts.length<2){toast("Select a group of floating shapes first.",{kind:"info"});return;}
          const pages=new Set(parts.map(item=>ed.els.get(item.id)?.closest(".sheet")));
          if(pages.size!==1){toast("Group transformations require the same page.",{kind:"info"});return;}
          try{
            const next=transformShapeGroup(parts,{scale,rotation_deg});
            run(ed.op({op:"batch",ops:next.map(item=>({op:"shape_set",block:item.id,shape:item.shape})),label:"transform shape group"}));
          }catch(error){toast(errorText(error),{kind:"error"});}
        })));
    }
    return group;
  };
  const show=(key:Panel):void=>{
    active=key;
    for(const [name,b]of panelButtons){
      b.setAttribute("aria-selected",String(name===key));
      b.setAttribute("tabindex",name===key?"0":"-1");
    }
    surface.replaceChildren(areaFor(key));
    sync=():void=>{
      const activeNode=document.activeElement;
      if(activeNode instanceof HTMLInputElement||activeNode instanceof HTMLSelectElement)return;
      surface.replaceChildren(areaFor(active));
    };
  };
  for(const key of Object.keys(SHAPE_LABELS) as Panel[]){
    const b=button(SHAPE_LABELS[key],()=>show(key));
    b.className="shape-category";b.setAttribute("role","tab");b.setAttribute("aria-selected","false");
    nav.append(b);panelButtons.set(key,b);
  }
  nav.addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const keys=[...panelButtons.keys()];
    const index=keys.indexOf(active);
    const next=event.key==="Home"?0:event.key==="End"?keys.length-1:
      (index+(event.key==="ArrowRight"?1:-1)+keys.length)%keys.length;
    const target=keys[next];
    if(target&&!panelButtons.get(target)?.disabled){
      event.preventDefault();show(target);panelButtons.get(target)?.focus();
    }
  });
  const more=button("Full properties…",detail);more.className="shape-full-properties";
  nav.append(more);
  root.append(nav,surface);
  const update=():void=>{
    const next=selected();
    if(!next){root.hidden=true;currentId=null;return;}
    root.hidden=false;
    if(next.id!==currentId){currentId=next.id;show("geometry");}
    else sync();
    const corners=panelButtons.get("corners");if(corners)corners.disabled=next.shape.kind!=="rectangle";
    const group=panelButtons.get("group");if(group)group.disabled=ed.readOnly;
    for(const b of panelButtons.values())if(b!==corners&&b!==group)b.disabled=ed.readOnly;
  };
  update();
  return {el:root,update};
}
