import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SHAPE_KINDS, defaultShape, pathFor, roundedRect, roundedRectPhysical, shapeOf, textRegion } from "../src/client/shape.js";
import { transformShapeGroup } from "../src/client/shapegroup.js";

describe("Writer's declarative vector shape geometry",()=>{
  test("all ten presets exist and have finite geometry",()=>{
    assert.equal(SHAPE_KINDS.length,10);
    for(const kind of SHAPE_KINDS){
      const shape=defaultShape(kind);
      assert.equal(shape.kind,kind);
      assert.equal(shape.version,1);
      assert.ok(shape.width_mm>0&&shape.height_mm>0);
      if(kind!=="rectangle"&&kind!=="ellipse")assert.match(pathFor(kind),/^M.*[LZ]/);
      assert.equal(shape.opacity,1);
    }
  });
  test("rounding uses a closed path with independent corner parameters",()=>{
    const result=roundedRect([0,12,12,0]);
    assert.ok(result.startsWith("M0 0 "));
    assert.ok(result.endsWith("Z"));
    assert.ok(result.includes("Q"));
  });
  test("irregular shapes declare conservative nonempty native text regions",()=>{
    for(const kind of SHAPE_KINDS){
      const region=textRegion(kind);
      if(kind==="line"){assert.equal(region.w,0);continue;}
      assert.ok(region.w>0&&region.h>0,kind);
      assert.ok(region.x>=0&&region.y>=0,kind);
      assert.ok(region.x+region.w<=1,kind);
      assert.ok(region.y+region.h<=1,kind);
    }
  });
  test("shape extension retains independent fill, outline and object opacity",()=>{
    const shape=defaultShape("rectangle");
    shape.fill.opacity=0;
    shape.outline.opacity=1;
    shape.opacity=.5;
    assert.equal(shape.fill.opacity,0);
    assert.equal(shape.outline.opacity,1);
    assert.equal(shape.opacity,.5);
    const block={id:"b1",type:"paragraph" as const,text:"",
      extensions:{"slai.writer.shape":shape}};
    assert.equal(shapeOf(block)?.kind,"rectangle");
  });
  test("non-shape text blocks never render as a shape",()=>{
    assert.equal(shapeOf({id:"b1",type:"paragraph",text:"hello",
      extensions:{"slai.writer.shape":defaultShape("rectangle")}}),null);
  });
});

describe("group geometry",()=>{
  test("rotation preserves member dimensions and identities",()=>{
    const left=defaultShape("rectangle"),right=defaultShape("star");
    left.layout={mode:"floating",anchor:"page",x_mm:0,y_mm:0,wrap:"none",layer:"content"};
    right.layout={mode:"floating",anchor:"page",x_mm:80,y_mm:0,wrap:"none",layer:"content"};
    const transformed=transformShapeGroup([{id:"l",shape:left},{id:"r",shape:right}],{scale:1,rotation_deg:90});
    assert.deepEqual(transformed.map(x=>x.id),["l","r"]);
    assert.equal(transformed[0]?.shape.width_mm,left.width_mm);
    assert.equal(transformed[0]?.shape.rotation_deg,90);
    assert.equal(transformed[1]?.shape.rotation_deg,90);
    assert.notEqual(transformed[0]?.shape.layout?.y_mm,transformed[1]?.shape.layout?.y_mm);
  });
  test("scaling repositions members, rescales radii and preserves source",()=>{
    const x=defaultShape("rectangle"),y=defaultShape("ellipse");
    x.layout={mode:"floating",anchor:"page",x_mm:0,y_mm:0};
    y.layout={mode:"floating",anchor:"page",x_mm:90,y_mm:0};
    x.corners_mm=[2,2,2,2];
    const originalWidth=x.width_mm;
    const result=transformShapeGroup([{id:"x",shape:x},{id:"y",shape:y}],{scale:1.2,rotation_deg:0});
    assert.equal(result[0]?.shape.width_mm,originalWidth*1.2);
    assert.equal(result[0]?.shape.corners_mm[0],2.4);
    assert.equal(x.width_mm,originalWidth);
    assert.throws(()=>transformShapeGroup([{id:"x",shape:x}],{scale:100,rotation_deg:0}));
  });
});

describe("physical vector path fidelity",()=>{
  test("rounded corners use independent X/Y normalized dimensions",()=>{
    const path=roundedRectPhysical([10,10,10,10],200,50);
    assert.ok(path.includes("M5 0"),path);
    assert.ok(path.includes("100 20"),path);
    assert.equal(roundedRectPhysical([0,0,0,0],200,50).includes("M0 0"),true);
  });
});
