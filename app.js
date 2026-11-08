(() => {
  const $ = (id) => document.getElementById(id);
  const config = window.BCSO_CONFIG || {};
  let db, divisions = [], trainings = [], calendar, activeFilter = "";
  const colors = ["#477ce6","#23956b","#8a63c7","#d28b35","#c65d75","#268eaa","#75839a"];
  const colorFor = (id) => colors[Math.max(0, divisions.findIndex(d => d.id === id)) % colors.length];
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dateFmt = (d, opts={}) => new Date(d).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit",...opts});
  const msg = (id, text, good=false) => { $(id).textContent=text; $(id).className="form-message"+(good?" success":""); };
  const pageNames = {dashboard:"Dashboard",calendar:"Training Calendar",schedule:"Schedule Training",history:"Training History"};

  async function init() {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY || config.SUPABASE_URL.includes("YOUR-PROJECT")) {
      alert("Setup required: copy config.js.example to config.js and add your Supabase Project URL and Publishable key.");
      return;
    }
    db = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    $("quickSchedule").addEventListener("click", () => navigate("schedule"));
    $("cancelEdit").addEventListener("click", clearTrainingForm);
    $("trainingForm").addEventListener("submit", saveTraining);
    $("historyDivision").addEventListener("change", renderHistory);
    $("closeModal").addEventListener("click", closeModal);
    $("eventModal").addEventListener("click", e => { if(e.target === $("eventModal")) closeModal(); });
    document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click",()=>navigate(b.dataset.page)));
    document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.goto)));
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
    populateDivisionSelects(); renderDashboard(); renderHistory(); renderCalendar();
  }
  function populateDivisionSelects(){
    const opts=divisions.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join("");
    $("division").innerHTML=opts || '<option value="">No divisions available</option>';
    $("historyDivision").innerHTML='<option value="">All divisions</option>'+opts;
  }
  function navigate(page){
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
    $("modalActions").innerHTML = t.status === "scheduled"
      ? '<button class="button danger" id="cancelScheduledTraining">Cancel this training</button>'
      : '';
    const cancelButton = $("cancelScheduledTraining");
    if (cancelButton) cancelButton.addEventListener("click", () => cancelScheduledTraining(t));
    $("eventModal").classList.remove("hidden");
  }
  function closeModal(){$("eventModal").classList.add("hidden")}
  async function cancelScheduledTraining(training){
    const code = prompt("Enter the cancellation code that was provided when this training was scheduled:");
    if (code === null) return;
    if (!code.trim()) { alert("A cancellation code is required."); return; }
    const reason = prompt("Optional cancellation reason:") || "Cancelled by scheduler";
    const button = $("cancelScheduledTraining");
    if (button) { button.disabled = true; button.textContent = "Cancelling..."; }
    const { data, error } = await db.rpc("cancel_training_with_code", {
      target_training_id: training.id,
      supplied_code: code.trim(),
      cancellation_reason: reason.trim().slice(0, 500)
    });
    if (error || !data) {
      alert(error?.message || "Unable to cancel this training. Check the cancellation code.");
      if (button) { button.disabled = false; button.textContent = "Cancel this training"; }
      return;
    }
    closeModal();
    alert("Training cancelled successfully.");
    await refreshData();
  }
  function clearTrainingForm(){
    $("trainingForm").reset();$("scheduleHeading").textContent="Schedule a training";$("saveTraining").textContent="Save training";msg("trainingMessage","");
  }
  async function saveTraining(e){
    e.preventDefault();
    const starts=new Date($("startsAt").value), ends=new Date($("endsAt").value);
    if(!(starts<ends)){msg("trainingMessage","The end time must be later than the start time.");return}
    if(starts<new Date()){msg("trainingMessage","Choose a future start time.");return}
    const payload={title:$("title").value.trim(),division_id:$("division").value,instructor:$("instructor").value.trim(),description:$("description").value.trim(),starts_at:starts.toISOString(),ends_at:ends.toISOString(),location:$("location").value.trim()||null,capacity:$("capacity").value?Number($("capacity").value):null};
    msg("trainingMessage","Checking schedule and saving...");
    const result=await db.rpc("create_training_with_cancel_code", {
      training_title: payload.title,
      target_division_id: payload.division_id,
      training_instructor: payload.instructor,
      training_description: payload.description || null,
      training_starts_at: payload.starts_at,
      training_ends_at: payload.ends_at,
      training_location: payload.location,
      training_capacity: payload.capacity
    });
    if(result.error){
      const text=result.error.message.toLowerCase().includes("training_conflict")||result.error.message.toLowerCase().includes("overlap")
        ?"This time overlaps another scheduled division training. Choose another time or ask command staff for an approved override."
        :result.error.message;
      msg("trainingMessage",text);return;
    }
    const created = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!created?.cancellation_code) { msg("trainingMessage","Training was saved, but the cancellation code could not be displayed. Contact command staff before closing this page."); return; }
    alert(`Training saved successfully!\n\nCancellation code: ${created.cancellation_code}\n\nSave this code. It is required to cancel this training later. It will not be shown again.`);
    clearTrainingForm();await refreshData();navigate("calendar");
  }
  init();
})();
