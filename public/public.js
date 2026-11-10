(() => {
"use strict";
const cfg=window.BCSO_CONFIG||{};
const $=id=>document.getElementById(id);
const colors=["#477ce6","#23956b","#8a63c7","#d28b35","#c65d75","#268eaa","#75839a"];
let client,divisions=[],trainings=[],month=new Date(new Date().getFullYear(),new Date().getMonth(),1),filter="all",channel=null;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const color=id=>colors[Math.max(0,divisions.findIndex(d=>d.id===id))%colors.length];
const fmt=(v,opts={})=>new Date(v).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",...opts});
const sameMonth=d=>d.getMonth()===month.getMonth()&&d.getFullYear()===month.getFullYear();
function setConnection(ok,msg){$("connection").textContent=msg;$("connection").parentElement.classList.toggle("offline",!ok);}
async function load(){
  const [d,t]=await Promise.all([client.from("divisions").select("id,name").eq("is_active",true).order("name"),client.from("trainings").select("id,division_id,title,description,instructor,starts_at,ends_at,location,capacity,status,divisions(name)").eq("status","scheduled").order("starts_at")]);
  if(d.error||t.error){setConnection(false,"Unable to load schedule");$("calendar").innerHTML='<div class="empty">Schedule data could not be loaded. The database may not yet allow public read-only access.</div>';$("eventList").innerHTML='<div class="empty">Please contact Training Command.</div>';console.error(d.error||t.error);return;}
  divisions=d.data||[];trainings=t.data||[];render();setConnection(true,"Live schedule connected");$("updated").textContent="Last refreshed "+new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
}
function visible(){const q=$("search").value.trim().toLowerCase();return trainings.filter(t=>sameMonth(new Date(t.starts_at))&&(filter==="all"||t.division_id===filter)&&(!q||[t.title,t.instructor,t.location,t.divisions?.name].join(" ").toLowerCase().includes(q)));}
function render(){
  $("monthLabel").textContent=month.toLocaleDateString([],{month:"long",year:"numeric"});
  $("filters").innerHTML='<button class="filter '+(filter==="all"?"active":"")+'" data-filter="all">All divisions</button>'+divisions.map(d=>'<button class="filter '+(filter===d.id?"active":"")+'" data-filter="'+esc(d.id)+'">'+esc(d.name)+'</button>').join("");
  $("filters").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{filter=b.dataset.filter;render();}));
  const all=visible();$("monthCount").textContent=all.length;$("divisionCount").textContent=new Set(all.map(t=>t.division_id)).size;
  const upcoming=trainings.filter(t=>new Date(t.starts_at)>=new Date()).sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at))[0];
  $("nextSession").textContent=upcoming?fmt(upcoming.starts_at,{month:"short",day:"numeric"}):"None scheduled";
  renderCalendar(all);renderList(all);$("resultLabel").textContent=all.length+" session"+(all.length===1?"":"s");
}
function renderCalendar(events){
  const first=new Date(month.getFullYear(),month.getMonth(),1),start=new Date(first);start.setDate(1-first.getDay());
  const today=new Date();let out="";
  for(let i=0;i<42;i++){const d=new Date(start);d.setDate(start.getDate()+i);const dayEvents=events.filter(t=>{const x=new Date(t.starts_at);return x.getFullYear()===d.getFullYear()&&x.getMonth()===d.getMonth()&&x.getDate()===d.getDate();}).sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
    out+='<div class="day '+(!sameMonth(d)?"outside ":"")+(d.toDateString()===today.toDateString()?"today":"")+'"><div class="day-num">'+d.getDate()+'</div>'+dayEvents.slice(0,3).map(t=>'<button class="day-event" data-event="'+esc(t.id)+'" style="--event-color:'+color(t.division_id)+'" title="'+esc(t.title)+'">'+esc(t.title)+'</button>').join("")+(dayEvents.length>3?'<div class="more">+'+(dayEvents.length-3)+' more</div>':"")+'</div>';
  }
  $("calendar").innerHTML=out;$("calendar").querySelectorAll("[data-event]").forEach(b=>b.addEventListener("click",()=>showDetails(b.dataset.event)));
}
function renderList(events){
  if(!events.length){$("eventList").innerHTML='<div class="empty">No scheduled trainings match this month and filter.</div>';return;}
  $("eventList").innerHTML=events.slice().sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at)).map(t=>{const d=new Date(t.starts_at);return '<article class="event-card" data-event="'+esc(t.id)+'"><div class="datebox"><b>'+d.getDate()+'</b><span>'+d.toLocaleDateString([],{month:"short"})+'</span></div><div><h3>'+esc(t.title)+'</h3><p>'+esc(t.instructor)+' · '+fmt(t.starts_at,{hour:"numeric",minute:"2-digit"})+'–'+new Date(t.ends_at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+'<br>'+esc(t.location||"Location not specified")+'</p></div><span class="division-tag">'+esc(t.divisions?.name||"Division")+'</span></article>';}).join("");
  $("eventList").querySelectorAll("[data-event]").forEach(b=>b.addEventListener("click",()=>showDetails(b.dataset.event)));
}
function showDetails(id){
 const t=trainings.find(x=>x.id===id);if(!t)return;
 $("detailDivision").textContent=t.divisions?.name||"BCSO TRAINING";
 $("detailTitle").textContent=t.title;$("detailWhen").textContent=fmt(t.starts_at,{weekday:"long",year:"numeric"})+" – "+fmt(t.ends_at,{hour:"numeric",minute:"2-digit",timeZoneName:"short"});
 $("detailInfo").innerHTML=[["Instructor",t.instructor],["Location",t.location||"Not specified"],["Division",t.divisions?.name||"Division"],["Maximum participants",t.capacity||"No limit"]].map(([k,v])=>'<div><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>').join("");
 $("detailDescription").textContent=t.description||"No additional description provided.";$("details").classList.remove("hidden");
}
function setupRealtime(){
 channel=client.channel("public-training-schedule")
  .on("postgres_changes",{event:"*",schema:"public",table:"trainings"},()=>load())
  .on("postgres_changes",{event:"*",schema:"public",table:"divisions"},()=>load())
  .subscribe(status=>{if(status==="SUBSCRIBED")setConnection(true,"Live updates enabled");});
}
function init(){
 if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY){setConnection(false,"Schedule configuration missing");$("calendar").innerHTML='<div class="empty">The public schedule is not configured.</div>';return;}
 client=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 $("prev").addEventListener("click",()=>{month.setMonth(month.getMonth()-1);render();});
 $("next").addEventListener("click",()=>{month.setMonth(month.getMonth()+1);render();});
 $("today").addEventListener("click",()=>{month=new Date(new Date().getFullYear(),new Date().getMonth(),1);render();});
 $("refresh").addEventListener("click",load);$("search").addEventListener("input",render);
 $("closeDetails").addEventListener("click",()=>$("details").classList.add("hidden"));
 $("details").addEventListener("click",e=>{if(e.target===$("details"))$("details").classList.add("hidden");});
 load();setupRealtime();window.setInterval(load,60000);
}
document.addEventListener("DOMContentLoaded",init);
})();