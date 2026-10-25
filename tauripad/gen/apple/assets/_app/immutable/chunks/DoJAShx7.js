import"./Bzak7iHL.js";import"./CGrUknPo.js";import{f as u}from"./35wfyFQ6.js";import{c as d,a as f}from"./DEDcuDiT.js";import{I as m,s as p}from"./C1vhOTwt.js";import{l as $,s as g}from"./Z8TBJUrC.js";import{p as S}from"./DZlyMDKm.js";function L(t,s){const r=$(s,["children","$$slots","$$events","$$legacy"]);/**
 * @license lucide-svelte v0.475.0 - ISC
 *
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 */const n=[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["polyline",{points:"7 10 12 15 17 10"}],["line",{x1:"12",x2:"12",y1:"15",y2:"3"}]];m(t,g({name:"download"},()=>r,{get iconNode(){return n},children:(e,i)=>{var o=d(),a=u(o);p(a,s,"default",{}),f(e,o)},$$slots:{default:!0}}))}function R(t,s){const r=$(s,["children","$$slots","$$events","$$legacy"]);/**
 * @license lucide-svelte v0.475.0 - ISC
 *
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 */const n=[["rect",{width:"20",height:"8",x:"2",y:"2",rx:"2",ry:"2"}],["rect",{width:"20",height:"8",x:"2",y:"14",rx:"2",ry:"2"}],["line",{x1:"6",x2:"6.01",y1:"6",y2:"6"}],["line",{x1:"6",x2:"6.01",y1:"18",y2:"18"}]];m(t,g({name:"server"},()=>r,{get iconNode(){return n},children:(e,i)=>{var o=d(),a=u(o);p(a,s,"default",{}),f(e,o)},$$slots:{default:!0}}))}const h="app_resume_last_position";function D(){if(typeof localStorage>"u")return!0;const t=localStorage.getItem(h);return t===null?!0:t==="true"}function T(t){typeof localStorage>"u"||localStorage.setItem(h,String(t))}function v(t){if(!t||t.length===0)return null;const s=t.filter(r=>r.type==="position"&&!!r.file);return s.length===0?null:s.sort((r,n)=>{const e=r.date?new Date(r.date).getTime():0;return(n.date?new Date(n.date).getTime():0)-e})[0]}function N(t,s){if(!s)return null;const r=s.toLowerCase().trim(),n=t.find(o=>o.id.toLowerCase()===r);if(n)return n;const e=r.split(".");if(e.length===2&&!Number.isNaN(Number(e[0]))&&!Number.isNaN(Number(e[1]))){const o=`${e[0].padStart(2,"0")}.${e[1].padStart(2,"0")}`,a=`${Number(e[0])}.${Number(e[1])}`,c=t.find(y=>{const l=y.id.toLowerCase();return l===o||l===a});if(c)return c}const i=t.find(o=>o.code&&(o.code.toLowerCase()===r||o.code.toLowerCase().endsWith(`_${r}`)));return i||null}function A(t,s,r){const n=v(s);if(!n)return null;const e=S(n.file);if(!e)return null;const i=(t||"").toLowerCase();if(e.isCourseScope)return{isCourseScope:!0,lessonId:"course",tab:e.tab,verticalPosition:n.verticalPosition||0,href:`/courses/${i}/course/${e.tab}`};const o=N(r,e.lessonId);if(!o)return null;const a=e.tab!=="lesson"?`/${e.tab}`:"";return{isCourseScope:!1,lessonId:o.id,tab:e.tab,verticalPosition:n.verticalPosition||0,href:`/courses/${i}/${encodeURIComponent(o.id)}${a}`}}export{L as D,R as S,D as g,A as r,T as s};
