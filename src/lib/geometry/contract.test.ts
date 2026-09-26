import { afterEach, beforeEach, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { getTableByName } from "@/lib/metadata/tables";
import { inspectTable } from "@/lib/table-service";
import { beginRefresh, endRefresh, refreshUnit } from "@/lib/ingest/fence";
import { lit } from "@/lib/ingest/sql";
import * as resource from "@/app/api/tables/[name]/geometry/route";
import { POST as preview } from "@/app/api/tables/[name]/geometry/preview/route";
import { GET as projections } from "@/app/api/geometry/projections/route";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";
let dir: string;
beforeEach(async()=>{dir=await setupGeometryTest();});
afterEach(async()=>{await cleanupGeometryTest(dir);});
function context(name:string) {return {params:Promise.resolve({name})};}
function req(method:string,body?:unknown,query="") {return new Request(`http://dezfil.test/api/tables/test/geometry${query}`,{method,...(body!==undefined?{body:JSON.stringify(body),headers:{"content-type":"application/json"}}:{})});}
const operations=[
  ["/api/tables/{name}/geometry","get","inspect_table_geometry","GeometryInspection"],
  ["/api/tables/{name}/geometry/preview","post","preview_table_geometry","GeometryPreview"],
  ["/api/tables/{name}/geometry","put","set_table_geometry","GeometryMutation"],
  ["/api/tables/{name}/geometry","delete","clear_table_geometry","GeometryMutation"],
  ["/api/geometry/projections","get","list_geometry_projections","GeometryProjections"],
] as const;
it.each(operations)("%s %s is documented with its body/reply and derived tool",(path,method,toolName,response)=>{
  const doc=buildOpenApiDocument();
  const operation=(doc.paths as Record<string,Record<string,unknown>>)[path]?.[method] as Record<string,unknown>;
  expect(operation).toMatchObject({"x-tool":toolName,responses:{"200":{content:{"application/json":{schema:{$ref:`#/components/schemas/${response}`}}}}}});
  const tool=buildTools().find(t=>t.name===toolName)!;
  expect(tool).toBeDefined(); expect(tool.path).toBe(path); expect(tool.method).toBe(method);
  expect(tool.confirm).toBe(method==="delete");
  if(method==="put"||method==="post") {
    expect(tool.bodyKeys).toEqual(["expectedRevision","choice"]);
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["name","expectedRevision","choice"]));
    expect(tool.inputSchema.properties.choice).toMatchObject({type:"object",required:["format","columns"],additionalProperties:false});
  }
  if(method==="delete") {expect(tool.queryParams).toEqual(["expectedRevision"]);expect(tool.inputSchema.required).toContain("expectedRevision");}
});
it("manual record additions and error details are published without widening candidate enums",()=>{
  const schemas=buildOpenApiDocument().components.schemas;
  expect(schemas.GeometryRecord.properties.signal.enum).toContain("manual");
  expect(schemas.GeometryRecord.properties.rule.enum).toContain("manual");
  expect(schemas.GeometryCandidate.properties.signal.enum).toEqual(["name","content"]);
  expect(schemas.Table.properties.geometryRecord.description).toContain("manual");
  expect(schemas.Table.properties.geometryRecord.description).not.toContain("absent for legacy and non-CSV");
  expect(schemas.Error.properties.error.properties).toHaveProperty("issues");
  for(const code of ["geometry_not_supported","geometry_choice_invalid","geometry_in_flight"]) expect(buildOpenApiDocument()["x-error-codes"]).toHaveProperty(code);
});
it("all five actual handlers return the documented envelopes and tools forward body/query unchanged",async()=>{
  const table=await stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y");
  const inspectionResponse=await resource.GET(req("GET"),context(table.name)); expect(inspectionResponse.status).toBe(200);
  const inspected=await inspectionResponse.json();
  expect(Object.keys(inspected).sort()).toEqual(["tableId","revision","columns","geometryColumn","geometryRecord","currentChoice","mode","candidates"].sort());
  const names=["preview_table_geometry","set_table_geometry","clear_table_geometry","list_geometry_projections"];
  let revision=inspected.revision;
  for(const name of names) {
    const tool=buildTools().find(t=>t.name===name)!;
    const choice={format:"pair",columns:["y","x"],epsg:4326};
    const forwarded:typeof fetch=async(input,init)=>{
      const request=new Request(String(input),init),url=new URL(request.url);
      if(name==="list_geometry_projections") return projections(request);
      if(name==="clear_table_geometry") { expect(url.searchParams.get("expectedRevision")).toBe(revision);return resource.DELETE(request,context(table.name)); }
      expect(await request.clone().json()).toEqual({expectedRevision:revision,choice});
      return name==="preview_table_geometry" ? preview(request,context(table.name)) : resource.PUT(request,context(table.name));
    };
    const args=name==="list_geometry_projections" ? {epsg:"EPSG:31467"} : name==="clear_table_geometry" ? {name:table.name,expectedRevision:revision} : {name:table.name,expectedRevision:revision,choice};
    const result=await executeTool(tool,args,"http://dezfil.test",forwarded);
    expect(result.status).toBe(200); expect(result.ok).toBe(true);
    const body=result.body as Record<string,unknown>;
    if(name==="preview_table_geometry") expect(body).toMatchObject({canApply:true,extent:[40,30,40,30],sample:{rows:[{index:0,status:"readable"}],features:{type:"FeatureCollection",features:[{id:0,geometry:{type:"Point",coordinates:[40,30]}}]}}});
    if(name==="set_table_geometry"||name==="clear_table_geometry") {
      expect(Object.keys(body).sort()).toEqual(["table","revision","currentChoice","mode","extent"].sort()); revision=String(body.revision);
      expect(body.table).toMatchObject({id:table.id,projectIds:[]}); expect(body.table).not.toHaveProperty("geometryState");
    }
    if(name==="list_geometry_projections") expect(body.resolved).toEqual({epsg:31467,name:"EPSG:31467",unit:null});
  }
  expect((await inspectTable(table.name)).geometryColumn).toBeNull();
});
it.each([
  ["wkt","POINT (10 20)"], ["wkt","SRID=3857;POINT (1113194.9079327357 0)"],
  ["wkb","010100000000000000000024400000000000003440"],
  ["wkb","0101000020110F00009F476EE86AFC30410000000000000000"],
  ["wkb","002000000100000F114130FC6AE86E479F0000000000000000"],
  ["geojson",'{"type":"Point","coordinates":[10,20]}'], ["h3","8928308280fffff"],
])("actual handlers preview and apply %s %s",async(format,value)=>{
  const t=await stored(`SELECT ${lit(value)} payload`),choice={format,columns:["payload"]},body={expectedRevision:geometryRevision(t),choice};
  const p=await preview(req("POST",body),context(t.name)); expect(p.status).toBe(200);
  const previewed=await p.json();expect(previewed.canApply).toBe(true);
  const applied=await resource.PUT(req("PUT",body),context(t.name));expect(applied.status).toBe(200);
  const result=await applied.json();expect(result.extent).toEqual(previewed.extent);
  expect((await inspectTable(t.name)).geometryType).toBe(format==="h3"?"POLYGON":"POINT");
  expect(previewed.sample.features.features[0].geometry).toMatchObject(format==="h3"?{type:"Polygon"}:{type:"Point",coordinates:value.includes("3857")||value.includes("110F")||value.includes("0F11")?[10,0]:[10,20]});
});
it.each([
  ["operation",{kind:"sql"}], ["operation",{recipeId:"workflow"}], ["postgis",{}], ["osm",{}], ["overture",{}], ["sketch",{}],
] as const)("every geometry handler refuses excluded source %s %j without mutation",async(source,sourceParams)=>{
  const t=await stored("SELECT 'POINT (10 20)' payload",{source,sourceParams});
  const body={expectedRevision:geometryRevision(t),choice:{format:"wkt",columns:["payload"]}};
  for(const response of [await resource.GET(req("GET"),context(t.name)),await preview(req("POST",body),context(t.name)),await resource.PUT(req("PUT",body),context(t.name)),await resource.DELETE(req("DELETE",undefined,`?expectedRevision=${geometryRevision(t)}`),context(t.name))]) {
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:"geometry_not_supported",message:expect.stringContaining("file uploads and URL imports")}});
  }
  expect(getTableByName(t.name)).toEqual(t);
});
it("invalid bodies, unavailable columns, projection issues and contention have stable statuses",async()=>{
  const t=await stored("SELECT 'POINT (500000 5800000)' payload");
  const good={expectedRevision:geometryRevision(t),choice:{format:"wkt",columns:["payload"]}};
  for(const body of [null,[],{}, {...good,extra:1}, {...good,expectedRevision:4}, {...good,choice:{...good.choice,extra:true}}, {...good,choice:{format:"pair",columns:["payload","payload"]}}, {...good,choice:{format:"geojson",columns:["payload"],epsg:4326}}]) {
    expect((await resource.PUT(req("PUT",body),context(t.name))).status).toBe(400);
  }
  const malformed=new Request("http://dezfil.test",{method:"PUT",body:"{"});expect((await resource.PUT(malformed,context(t.name))).status).toBe(400);
  const absent=await resource.PUT(req("PUT",{...good,choice:{format:"wkt",columns:["missing\"; DROP TABLE data_tables;--"]}}),context(t.name));
  expect(absent.status).toBe(400);expect(await absent.json()).toMatchObject({error:{code:"column_unavailable"}});
  expect((await resource.DELETE(req("DELETE"),context(t.name))).status).toBe(400);
  expect((await preview(req("POST",good),context(t.name))).status).toBe(200);
  const invalid=await resource.PUT(req("PUT",good),context(t.name));expect(invalid.status).toBe(422);expect(await invalid.json()).toMatchObject({error:{code:"geometry_choice_invalid",issues:[{code:"projection_required"}]}});
  expect((await resource.PUT(req("PUT",{...good,expectedRevision:"stale"}),context(t.name))).status).toBe(409);
  expect((await resource.GET(req("GET"),context("unknown"))).status).toBe(404);
  beginRefresh(refreshUnit(t),t.name);
  try {const response=await resource.PUT(req("PUT",good),context(t.name));expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:"geometry_in_flight"}});} finally {endRefresh(refreshUnit(t));}
  expect(getTableByName(t.name)).toEqual(t);
  expect((await projections(req("GET",undefined,"?epsg=999999999"))).status).toBe(422);
  expect((await projections(req("GET",undefined,"?epsg=not-code"))).status).toBe(400);
});
it("response schemas require every preview/mutation fact and bound corresponding rows",()=>{
  const s=buildOpenApiDocument().components.schemas;
  expect(s.GeometryInspection.required).toEqual(["tableId","revision","columns","geometryColumn","geometryRecord","currentChoice","mode","candidates"]);
  expect(s.GeometryPreview.required).toEqual(["tableId","revision","choice","canApply","issues","rowCount","unreadableCount","geometryType","extent","degreeCompatible","sample"]);
  expect(s.GeometryMutation.required).toEqual(["table","revision","currentChoice","mode","extent"]);
  expect(s.GeometryPreview.properties.sample).toMatchObject({properties:{rows:{maxItems:50},features:{properties:{features:{maxItems:50}}}}});
});

it("field round: published preview figures name the first 50 rows and keep Apply authoritative", () => {
  const doc = buildOpenApiDocument();
  const description = doc.paths["/api/tables/{name}/geometry/preview"].post.description;
  expect(description).toContain("first 50 rows");
  expect(description).toContain("sampled");
  expect(description).toContain("Apply");
  expect(description).not.toContain("describe the full input");
  expect(doc.components.schemas.GeometryPreview.properties.rowCount).toMatchObject({ description: expect.stringContaining("50") });
  expect(doc.components.schemas.GeometryPreview.properties.extent).toMatchObject({ description: expect.stringContaining("sample") });
});
