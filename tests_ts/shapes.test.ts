import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SHAPE_KINDS, defaultShape, pathFor, roundedRect, shapeOf, textRegion } from "../src/client/shape.js";

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
