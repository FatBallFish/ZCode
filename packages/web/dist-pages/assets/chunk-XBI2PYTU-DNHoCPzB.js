import{a as e,i as t,o as n,t as r}from"./chunk-WKBPLHUA-BcPr1l0T.js";async function i(t){let{parts:r,binaryAssets:i}=e(await n(t));return{parts:r,binaryAssets:i}}async function a(e){return t(r(e))}function o(e=l){return{parts:new Map([[`[Content_Types].xml`,{name:`[Content_Types].xml`,content:u}],[`_rels/.rels`,{name:`_rels/.rels`,content:d}],[`word/document.xml`,{name:`word/document.xml`,content:e}],[`word/_rels/document.xml.rels`,{name:`word/_rels/document.xml.rels`,content:f}]]),binaryAssets:new Map}}function s(e,t){return e.parts.get(t)}function c(e,t){let n=new Map(e.parts);return n.set(t.name,t),{parts:n,binaryAssets:new Map(e.binaryAssets)}}var l=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t/></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`,u=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,d=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,f=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;export{c as a,i,s as n,a as r,o as t};