/** Regression coverage for precision, invalid input and shape geometry contracts. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultShape } from "../src/client/shape.js";
import { showShapeNumber, parseShapeNumber, resizeShape, normalizeShapeCorners,
  changeShapeKind, shadowPreset } from "../src/client/shape_format.js";

describe("Shape numeric display does not mutate document precision",()=>{
  test("large decimals use short UI strings",()=>{
    const original=48.83661048689139;
    assert.equal(showShapeNumber(original), "48.84");
    assert.equal(original,48.83661048689139);
    assert.equal(showShapeNumber(-0.06492272022910583),"\u22120.06".replace("−","-"));
    assert.equal(showShapeNumber(-0.00000002),"0");
  });
  test("accept Dutch decimal commas and English dots, not ambiguous groups",()=>{
    assert.equal(parseShapeNumber("48,84",2,1000),48.84);
    assert.equal(parseShapeNumber("48.84",2,1000),48.84);
    assert.equal(parseShapeNumber("1,25",0,2),1.25);
    assert.equal(parseShapeNumber("1.234,56",0,10000),null);
    assert.equal(parseShapeNumber("1,234.56",0,10000),null);
    assert.equal(parseShapeNumber("NaN",0,10000),null);
    assert.equal(parseShapeNumber("Infinity",0,10000),null);
    assert.equal(parseShapeNumber("1e309",0,10000),null);
    assert.equal(parseShapeNumber("  ",0,10000),null);
    assert.equal(parseShapeNumber("-1",0,10000),null);
    assert.equal(parseShapeNumber("0",0,10000),0);
  });
});
describe("Shared shape property functions",()=>{
  test("resize preserves existing precision and constrains corner radii",()=>{
    const s=defaultShape("rectangle");
    s.corners_mm=[15,15,15,15];s.text.padding_mm=2;
    const result=resizeShape(s,10,10);
    assert.equal(result.width_mm,10);
    assert.equal(result.height_mm,10);
    assert.ok(result.corners_mm.every(x=>x<=5));
    assert.ok(result.text.padding_mm<=2.5);
    assert.equal(s.width_mm,60);
    assert.deepEqual(s.corners_mm,[15,15,15,15]);
  });
  test("ratio-locked resizing and kind changes preserve user styling",()=>{
    const shape=defaultShape("rectangle");
    shape.width_mm=90;shape.height_mm=30;
    shape.fill.color="#00ff00";shape.shadows=[shadowPreset("soft")];
    const locked=resizeShape(shape,180,30,true);
    assert.equal(locked.width_mm,180);
    assert.equal(locked.height_mm,60);
    const hexagon=changeShapeKind(locked,"hexagon");
    assert.deepEqual(hexagon.corners_mm,[0,0,0,0]);
    assert.equal(hexagon.fill.color,"#00ff00");
    assert.equal(hexagon.shadows.length,1);
  });
  test("normalization guarantees pairwise non-overlap",()=>{
    const c=normalizeShapeCorners([900,80,70,800],100,50);
    assert.ok(c.every(x=>x>=0&&x<=25));
    assert.ok(c[0]!+c[1]!<=100);
    assert.ok(c[2]!+c[3]!<=100);
    assert.ok(c[0]!+c[3]!<=50);
    assert.ok(c[1]!+c[2]!<=50);
  });
  test("shadow gallery creates independent data copies",()=>{
    const a=shadowPreset("soft"),b=shadowPreset("soft");
    a.opacity=0;
    assert.ok(b.opacity>0);
    assert.equal(shadowPreset("hard").blur_mm,0);
  });
});
