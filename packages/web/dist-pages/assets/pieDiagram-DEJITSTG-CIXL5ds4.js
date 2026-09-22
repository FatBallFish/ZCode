import{i as e,r as t}from"./src-DO1LVmGi.js";import{B as n,C as r,V as i,W as a,_ as o,a as s,b as c,c as l,d as u,v as d}from"./chunk-ICPOFSXX-1miUA7VT.js";import{n as f}from"./ordinal-Bh0DWTsf.js";import{t as p}from"./arc-TglPkFLK.js";import{t as m}from"./pie-DjQKOKmg.js";import{f as h,r as g}from"./chunk-5PVQY5BW-D0qUIuiM.js";import{t as _}from"./chunk-426QAEUC-Bh_UdTer.js";import{t as v}from"./chunk-4BX2VUAB-xf5IjgGt.js";import{t as y}from"./mermaid-parser.core-D7-UYflM.js";var b=u.pie,x={sections:new Map,showData:!1,config:b},S=x.sections,C=x.showData,w=structuredClone(b),T={getConfig:t(()=>structuredClone(w),`getConfig`),clear:t(()=>{S=new Map,C=x.showData,s()},`clear`),setDiagramTitle:a,getDiagramTitle:r,setAccTitle:i,getAccTitle:d,setAccDescription:n,getAccDescription:o,addSection:t(({label:t,value:n})=>{if(n<0)throw Error(`"${t}" has invalid value: ${n}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);S.has(t)||(S.set(t,n),e.debug(`added new section: ${t}, with value: ${n}`))},`addSection`),getSections:t(()=>S,`getSections`),setShowData:t(e=>{C=e},`setShowData`),getShowData:t(()=>C,`getShowData`)},E=t((e,t)=>{v(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),D={parse:t(async t=>{let n=await y(`pie`,t);e.debug(n),E(n,T)},`parse`)},O=t(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),k=t(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return m().value(e=>e.value).sort(null)(n)},`createPieArcs`),A={parser:D,db:T,renderer:{draw:t((t,n,r,i)=>{e.debug(`rendering pie chart
`+t);let a=i.db,o=c(),s=g(a.getConfig(),o.pie),u=_(n),d=u.append(`g`);d.attr(`transform`,`translate(225,225)`);let{themeVariables:m}=o,[v]=h(m.pieOuterStrokeWidth);v??=2;let y=s.textPosition,b=p().innerRadius(0).outerRadius(185),x=p().innerRadius(185*y).outerRadius(185*y);d.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+v/2).attr(`class`,`pieOuterCircle`);let S=a.getSections(),C=k(S),w=[m.pie1,m.pie2,m.pie3,m.pie4,m.pie5,m.pie6,m.pie7,m.pie8,m.pie9,m.pie10,m.pie11,m.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=f(w).domain([...S.keys()]);d.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,b).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),d.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+x.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=d.append(`text`).text(a.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),A=[...S.entries()].map(([e,t])=>({label:e,value:t})),j=d.selectAll(`.legend`).data(A).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*A.length/2;return`translate(216,`+(t*22-n)+`)`});j.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),j.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>a.getShowData()?`${e.label} [${e.value}]`:e.label);let M=512+Math.max(...j.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),N=O.node()?.getBoundingClientRect().width??0,P=450/2-N/2,F=450/2+N/2,I=Math.min(0,P),L=Math.max(M,F)-I;u.attr(`viewBox`,`${I} 0 ${L} 450`),l(u,450,L,s.useMaxWidth)},`draw`)},styles:O};export{A as diagram};