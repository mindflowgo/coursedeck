import"./Bzak7iHL.js";import"./CGrUknPo.js";import{f}from"./35wfyFQ6.js";import{c as m,a as p}from"./DEDcuDiT.js";import{I as $,s as g}from"./Bj2aoOD6.js";import{l as h,s as S}from"./Z8TBJUrC.js";import{p as C}from"./DZlyMDKm.js";function P(t,s){const o=h(s,["children","$$slots","$$events","$$legacy"]);/**
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
 */const n=[["rect",{width:"20",height:"8",x:"2",y:"2",rx:"2",ry:"2"}],["rect",{width:"20",height:"8",x:"2",y:"14",rx:"2",ry:"2"}],["line",{x1:"6",x2:"6.01",y1:"6",y2:"6"}],["line",{x1:"6",x2:"6.01",y1:"18",y2:"18"}]];$(t,S({name:"server"},()=>o,{get iconNode(){return n},children:(e,i)=>{var r=m(),a=f(r);g(a,s,"default",{}),p(e,r)},$$slots:{default:!0}}))}const l="app_resume_last_position";function R(){if(typeof localStorage>"u")return!0;const t=localStorage.getItem(l);return t===null?!0:t==="true"}function T(t){typeof localStorage>"u"||localStorage.setItem(l,String(t))}function N(t){if(!t||t.length===0)return null;const s=t.filter(o=>o.type==="position"&&!!o.file);return s.length===0?null:s.sort((o,n)=>{const e=o.date?new Date(o.date).getTime():0;return(n.date?new Date(n.date).getTime():0)-e})[0]}function _(t,s){if(!s)return null;const o=s.toLowerCase().trim(),n=t.find(r=>r.id.toLowerCase()===o);if(n)return n;const e=o.split(".");if(e.length===2&&!Number.isNaN(Number(e[0]))&&!Number.isNaN(Number(e[1]))){const r=`${e[0].padStart(2,"0")}.${e[1].padStart(2,"0")}`,a=`${Number(e[0])}.${Number(e[1])}`,c=t.find(d=>{const u=d.id.toLowerCase();return u===r||u===a});if(c)return c}const i=t.find(r=>r.code&&(r.code.toLowerCase()===o||r.code.toLowerCase().endsWith(`_${o}`)));return i||null}function A(t,s,o){const n=N(s);if(!n)return null;const e=C(n.file);if(!e)return null;const i=(t||"").toLowerCase();if(e.isCourseScope)return{isCourseScope:!0,lessonId:"course",tab:e.tab,verticalPosition:n.verticalPosition||0,href:`/courses/${i}/course/${e.tab}`};const r=_(o,e.lessonId);if(!r)return null;const a=e.tab!=="lesson"?`/${e.tab}`:"";return{isCourseScope:!1,lessonId:r.id,tab:e.tab,verticalPosition:n.verticalPosition||0,href:`/courses/${i}/${encodeURIComponent(r.id)}${a}`}}export{P as S,R as g,A as r,T as s};
