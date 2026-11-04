import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultShape, SHAPE_KINDS } from "../src/client/shape.js";
import { polygonForShape, contourAtY, intersectIntervals, textBand, layoutContourText } from "../src/client/shape_contour.js";

describe("Shape contour geometry",()=>{
  test("registry returns real closed boundaries (except line)",()=>{
    for(const kind of SHAPE_KINDS){
      const p=polygonForShape(kind,80,70);
      if(kind==="line"){assert.deepEqual(p,[]);continue;}
      assert.ok(p.length>=3,kind);
      assert.ok(p.every(x=>Number.isFinite(x.x)&&Number.isFinite(x.y)),kind);
      assert.ok(p.every(x=>x.x>=-1e-6&&x.x<=80+1e-6),kind);
      assert.ok(p.every(x=>x.y>=-1e-6&&x.y<=70+1e-6),kind);
    }
  });
  test("ellipse has less usable width near its poles",()=>{
    const s=defaultShape("ellipse");
    const middle=textBand(s,16,5);
    const top=textBand(s,2,5);
    assert.ok(middle.length>0);
    assert.ok(top.length>0);
    assert.ok(middle[0]!.end-middle[0]!.start>top[0]!.end-top[0]!.start);
  });
  test("rectangle radii constrain corners but retain middle width",()=>{
    const shape=defaultShape("rectangle");
    shape.corners_mm=[12,12,12,12];
    const top=textBand(shape,1,2),center=textBand(shape,16,2);
    assert.ok(top.length&&center.length);
    assert.ok(center[0]!.end-center[0]!.start>top[0]!.end-top[0]!.start);
  });
  test("intersection respects concave disconnected interior intervals",()=>{
    assert.deepEqual(intersectIntervals(
      [{start:0,end:4},{start:6,end:10}],
      [{start:2,end:8}]),[{start:2,end:4},{start:6,end:8}]);
    const plus=polygonForShape("plus",100,100);
    const at=contourAtY(plus,50);
    assert.ok(at.length>0&&at[0]!.end>=90);
  });
  test("long text flows across multiple bands preserving UTF-16 offsets",()=>{
    const s=defaultShape("pentagon");s.height_mm=100;s.width_mm=100;
    s.text.content="Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(5);
    const measure=(token:string)=>token.length*1.2;
    const result=layoutContourText(s,measure);
    assert.ok(result.lines.length>=3);
    let end=0;
    for(const line of result.lines){
      assert.equal(line.start,end);
      assert.ok(line.end>=line.start);
      assert.ok(line.width>0);
      const bands=textBand(s,line.y,s.text.font_size_pt*25.4/72*1.3);
      assert.ok(bands.some(b=>line.x>=b.start-1e-4&&line.x+line.width<=b.end+1e-4));
      end=line.end;
    }
    assert.equal(result.nextOffset,end);
  });
  test("too much text reports overflow without throwing or mutating content",()=>{
    const s=defaultShape("triangle");s.width_mm=30;s.height_mm=25;
    s.text.content="A ".repeat(1800);
    const before=s.text.content;
    const result=layoutContourText(s,token=>token.length*2);
    assert.equal(result.overflow,true);
    assert.ok(result.nextOffset<before.length);
    assert.equal(s.text.content,before);
  });
});
