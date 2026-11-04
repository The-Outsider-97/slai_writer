import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rebaseTextSpans } from "../src/client/shape_text_edit.js";
import { diffText } from "../src/client/textops.js";
import type { Span } from "../src/client/types.js";

describe("Direct shape text edit spans",()=>{
  test("insert before run shifts its range",()=>{
    const old:Span[]=[{type:"format",start:4,end:9,bold:true}];
    assert.deepEqual(rebaseTextSpans(old,0,0,2),[
      {type:"format",start:6,end:11,bold:true}]);
    assert.deepEqual(old,[{type:"format",start:4,end:9,bold:true}]);
  });
  test("deleting across formatting splits remaining runs",()=>{
    const original:Span[]=[{type:"format",start:1,end:10,color:"#112233"}];
    const next=rebaseTextSpans(original,4,7,0);
    assert.deepEqual(next,[
      {type:"format",start:1,end:4,color:"#112233"},
      {type:"format",start:4,end:7,color:"#112233"}]);
  });
  test("UTF-16 text edits preserve surrogate-aligned span positions",()=>{
    const old="Alpha 😀 Bold";
    const now="Alpha 😀! Bold";
    const change=diffText(old,now,9);
    assert.ok(change);
    const offset=old.indexOf("Bold");
    const next=rebaseTextSpans([{type:"format",start:offset,end:old.length,bold:true}],
      change!.start,change!.end,change!.insert.length);
    assert.equal(next[0]?.start,now.indexOf("Bold"));
    assert.equal(next[0]?.end,now.length);
  });
});
