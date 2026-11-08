(() => {
  const $ = (id) => document.getElementById(id);
  const config = window.BCSO_CONFIG || {};
  let db, session, profile, divisions = [], trainings = [], calendar, activeFilter = "";
  const colors = ["#477ce6","#23956b","#8a63c7","#d28b35","#c65d75","#268eaa","#75839a"];
  const colorFor = (id) => colors[Math.max(0, divisions.findIndex(d => d.id === id)) % colors.length];
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dateFmt = (d, opts={}) => new Date(d).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit",...opts});
  const isAdmin = () => profile?.role === "admin";
  const msg = (id, text, good=false) => { $(id).textContent=text; $(id).className="form-message"+(good?" success":""); };
  const canManage = (t) => isAdmin() || t.created_by === session.user.id || t.can_manage === true;
  const pageNames = {dashboard:"Dashboard",calendar:"Training Calendar",schedule:"Schedule Training",history:"Training History",management:"Division Management"};

  async function init() {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY || config.SUPABASE_URL.includes("YOUR-PROJECT")) {
      $("authMessage").textContent = "Setup required: copy config.js.example to config.js and add your Supabase project URL and anon/publishable key.";
      $("authSubmit").disabled = true; return;
    }
    db = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    const {data:{session:s}} = await db.auth.getSession();
    session=s;
    db.auth.onAuthStateChange((_event, s) => { session=s; if(s) loadApp(); else showLogin(); });
    if(session) await loadApp();
    $("authForm").addEventListener("submit", authSubmit);
    $("showSignup").addEventListener("click", signup);
    $("signOut").addEventListener("click", () => db.auth.signOut());
    $("quickSchedule").addEventListener("click", () => navigate("schedule"));
    $("cancelEdit").addEventListener("click", clearTrainingForm);
    $("trainingForm").addEventListener("submit", saveTraining);
    $("divisionForm").addEventListener("submit", addDivision);
    $("memberForm").addEventListener("submit", grantMember);
    $("historyDivision").addEventListener("change", renderHistory);
    $("closeModal").addEventListener("click", closeModal);
    $("eventModal").addEventListener("click", e => { if(e.target === $("eventModal")) closeModal(); });
    document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click",()=>navigate(b.dataset.page)));
    document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.goto)));
  }
  async function authSubmit(e) {
    e.preventDefault(); msg("authMessage","Signing in...");
    const {error} = await db.auth.signInWithPassword({email:$("email").value.trim(),password:$("password").value});
    msg("authMessage", error?.message || "", !error);
  }
  async function signup() {
    const email=$("email").value.trim(), password=$("password").value;
    if(!email || password.length<6){msg("authMessage","Enter an email and a password of at least 6 characters.");return;}
    msg("authMessage","Creating account...");
    const {error}=await db.auth.signUp({email,password,options:{emailRedirectTo:location.href}});
    msg("authMessage",error?.message || "Account created. Check your email if email confirmation is enabled, then sign in.",!error);
  }
  function showLogin(){ $("loginView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
  async function loadApp() {
    if(!session) return showLogin();
    $("loginView").classList.add("hidden"); $("appView").classList.remove("hidden");
    const {data:p,error:pe}=await db.from("profiles").select("*").eq("id",session.user.id).single();
    if(pe){alert("Could not load your profile: "+pe.message);return;}
    profile=p;
    $("userName").textContent=p.full_name || session.user.email;
    $("userRole").textContent=p.role==="admin"?"System Administrator":"Department Personnel";
    $("userInitials").textContent=(p.full_name||session.user.email).split(/[ @]/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
    document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hidden",!isAdmin()));
    await refreshData();
    navigate("dashboard");
  }
  async function refreshData() {
    const [d,t]=await Promise.all([
      db.from("divisions").select("*").eq("is_active",true).order("name"),
      db.from("trainings").select("*, divisions(name)").order("starts_at")
    ]);
    if(d.error || t.error){alert("Unable to load schedule data: "+(d.error||t.error).message);return;}
    divisions=d.data||[]; trainings=t.data||[];
    await loadManagePermissions();
    populateDivisionSelects(); renderDashboard(); renderHistory(); renderCalendar();
  }
  async function loadManagePermissions(){
    if(!session) return;
    const {data}=await db.from("division_members").select("division_id,access_level").eq("user_id",session.user.id);
    const allowed=new Set((data||[]).filter(x=>["commander","co_commander"].includes(x.access_level)).map(x=>x.division_id));
    trainings=trainings.map(t=>({...t,can_manage:allowed.has(t.division_id)}));
  }
  function populateDivisionSelects(){
    const opts=divisions.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join("");
    $("division").innerHTML=opts || '<option value="">No divisions available</option>';
    $("memberDivision").innerHTML=opts;
    $("historyDivision").innerHTML='<option value="">All divisions</option>'+opts;
  }
  function navigate(page){
    if(page==="management"&&!isAdmin()) page="dashboard";
    document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
    $(page+"Page").classList.remove("hidden");
    document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    $("pageTitle").textContent=pageNames[page];
    if(page==="calendar"&&calendar) setTimeout(()=>calendar.updateSize(),30);
  }
  function renderDashboard(){
    const now=new Date(), month=now.getMonth(), year=now.getFullYear();
    const active=trainings.filter(t=>t.status==="scheduled"&&new Date(t.ends_at)>=now);
    $("statUpcoming").textContent=active.length;
    $("statMonth").textContent=trainings.filter(t=>{const d=new Date(t.starts_at);return d.getMonth()===month&&d.getFullYear()===year}).length;
    $("statCompleted").textContent=trainings.filter(t=>t.status==="completed").length;
    $("statDivisions").textContent=divisions.length;
    $("todayLabel").textContent=now.toLocaleDateString([], {weekday:"long",month:"long",day:"numeric",year:"numeric"});
    $("upcomingList").innerHTML=active.sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at)).slice(0,6).map(trainingCard).join("") || empty("No upcoming trainings are scheduled.");
    bindTrainingCards();
  }
  function trainingCard(t){
    const div=t.divisions?.name || divisions.find(d=>d.id===t.division_id)?.name || "Division";
    return `<article class="training-item" data-id="${t.id}"><div class="event-stripe" style="background:${colorFor(t.division_id)}"></div><div><span class="tag">${esc(div)}</span><h3>${esc(t.title)}</h3><p>${esc(t.instructor)} · ${esc(t.location||"Location not specified")}</p></div><div class="event-time">${dateFmt(t.starts_at)}<br><span class="muted">to ${new Date(t.ends_at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span></div></article>`;
  }
  function empty(s){return `<div class="empty-state">${esc(s)}</div>`}
  function bindTrainingCards(){document.querySelectorAll(".training-item[data-id]").forEach(el=>el.addEventListener("click",()=>showEvent(el.dataset.id)));}
  function renderCalendar(){
    if(!window.FullCalendar) return;
    const filters=$("divisionFilters");
    filters.innerHTML=`<button class="filter-chip ${activeFilter===""?"active":""}" data-filter="">All divisions</button>`+divisions.map(d=>`<button class="filter-chip ${activeFilter===d.id?"active":""}" data-filter="${d.id}">${esc(d.name)}</button>`).join("");
    filters.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{activeFilter=b.dataset.filter;renderCalendar()}));
    const events=trainings.filter(t=>t.status==="scheduled"&&(!activeFilter||t.division_id===activeFilter)).map(t=>({id:t.id,title:t.title,start:t.starts_at,end:t.ends_at,backgroundColor:colorFor(t.division_id),borderColor:colorFor(t.division_id),extendedProps:{training:t}}));
    if(!calendar){
      calendar=new FullCalendar.Calendar($("calendar"),{initialView:"dayGridMonth",height:"auto",headerToolbar:{left:"prev,next today",center:"title",right:"dayGridMonth,timeGridWeek,listMonth"},events,eventClick:info=>showEvent(info.event.id),nowIndicator:true,displayEventTime:true});
      calendar.render();
    } else {calendar.removeAllEvents();events.forEach(e=>calendar.addEvent(e));}
  }
  function renderHistory(){
    const div=$("historyDivision")?.value||"";
    const rows=trainings.filter(t=>["completed","cancelled"].includes(t.status)&&(!div||t.division_id===div)).sort((a,b)=>new Date(b.starts_at)-new Date(a.starts_at));
    $("historyList").innerHTML=rows.map(t=>`<article class="training-item" data-id="${t.id}"><div class="event-stripe" style="background:${t.status==="completed"?"#23956b":"#9aa4b3"}"></div><div><span class="tag">${esc(t.divisions?.name||"Division")} · ${esc(t.status)}</span><h3>${esc(t.title)}</h3><p>${esc(t.instructor)} · ${dateFmt(t.starts_at)}</p></div><div class="event-time">${t.status==="completed"?"Completed":"Cancelled"}</div></article>`).join("")||empty("No completed or cancelled trainings found.");
    bindTrainingCards();
  }
  function showEvent(id){
    const t=trainings.find(x=>x.id===id); if(!t)return;
    $("modalDivision").textContent=t.divisions?.name||"Division";
    $("modalTitle").textContent=t.title;
    $("modalWhen").textContent=`${dateFmt(t.starts_at,{weekday:"long",year:"numeric"})} – ${dateFmt(t.ends_at)}`;
    $("modalDescription").textContent=t.description||"No additional description provided.";
    $("modalDetails").innerHTML=[["Instructor",t.instructor],["Location",t.location||"Not specified"],["Capacity",t.capacity||"No limit"],["Status",t.status]].map(([k,v])=>`<div class="detail-cell"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("");
    const actions=$("modalActions"); actions.innerHTML="";
    if(canManage(t)&&t.status==="scheduled"){
      const edit=document.createElement("button");edit.className="button secondary";edit.textContent="Edit";edit.onclick=()=>{closeModal();fillTrainingForm(t);navigate("schedule")};actions.append(edit);
      const cancel=document.createElement("button");cancel.className="button danger";cancel.textContent="Cancel training";cancel.onclick=()=>changeStatus(t,"cancelled");actions.append(cancel);
      if(isAdmin()){const complete=document.createElement("button");complete.className="button primary";complete.textContent="Mark completed";complete.onclick=()=>changeStatus(t,"completed");actions.append(complete)}
    }
    $("eventModal").classList.remove("hidden");
  }
  function closeModal(){$("eventModal").classList.add("hidden")}
  async function changeStatus(t,status){
    if(!confirm(`Mark "${t.title}" as ${status}?`))return;
    const {error}=await db.from("trainings").update({status}).eq("id",t.id);
    if(error){alert(error.message);return}
    closeModal();await refreshData();
  }
  function fillTrainingForm(t){
    $("trainingId").value=t.id;$("title").value=t.title;$("division").value=t.division_id;$("instructor").value=t.instructor;$("description").value=t.description||"";
    $("startsAt").value=new Date(t.starts_at).toISOString().slice(0,16);$("endsAt").value=new Date(t.ends_at).toISOString().slice(0,16);
    $("location").value=t.location||"";$("capacity").value=t.capacity||"";$("scheduleHeading").textContent="Edit training";$("saveTraining").textContent="Update training";
  }
  function clearTrainingForm(){
    $("trainingForm").reset();$("trainingId").value="";$("scheduleHeading").textContent="Schedule a training";$("saveTraining").textContent="Save training";msg("trainingMessage","");
  }
  async function saveTraining(e){
    e.preventDefault();
    const id=$("trainingId").value, starts=new Date($("startsAt").value), ends=new Date($("endsAt").value);
    if(!(starts<ends)){msg("trainingMessage","The end time must be later than the start time.");return}
    if(starts<new Date()&&!id){msg("trainingMessage","Choose a future start time.");return}
    const payload={title:$("title").value.trim(),division_id:$("division").value,instructor:$("instructor").value.trim(),description:$("description").value.trim(),starts_at:starts.toISOString(),ends_at:ends.toISOString(),location:$("location").value.trim()||null,capacity:$("capacity").value?Number($("capacity").value):null};
    msg("trainingMessage","Checking schedule and saving...");
    let result;
    if(id) result=await db.from("trainings").update(payload).eq("id",id);
    else result=await db.from("trainings").insert(payload);
    if(result.error){
      const text=result.error.message.toLowerCase().includes("training_conflict")||result.error.message.toLowerCase().includes("overlap")
        ?"This time overlaps another scheduled division training. Choose another time or ask command staff for an approved override."
        :result.error.message;
      msg("trainingMessage",text);return;
    }
    msg("trainingMessage","Training saved successfully.",true);clearTrainingForm();await refreshData();navigate("calendar");
  }
  async function addDivision(e){
    e.preventDefault();const {error}=await db.from("divisions").insert({name:$("divisionName").value.trim(),description:$("divisionDescription").value.trim()||null});
    msg("divisionMessage",error?.message||"Division added.",!error);if(!error){$("divisionForm").reset();await refreshData();renderManagement();}
  }
  async function grantMember(e){
    e.preventDefault();msg("memberMessage","Looking up account...");
    const email=$("memberEmail").value.trim().toLowerCase();
    // Profiles are searchable by administrators through the restricted admin-only RPC.
    const {data,error}=await db.rpc("admin_grant_division_access",{target_email:email,target_division:$("memberDivision").value,target_access:$("memberRole").value});
    msg("memberMessage",error?.message||data||"Access granted.",!error);if(!error)$("memberForm").reset();
  }
  function renderManagement(){
    $("divisionList").innerHTML=divisions.map(d=>`<div class="division-row"><strong>${esc(d.name)}</strong><small>${esc(d.description||"No description")}</small></div>`).join("")||empty("No divisions have been created.");
  }
  const originalNavigate=navigate;
  navigate=function(page){originalNavigate(page);if(page==="management")renderManagement()};
  init();
})();