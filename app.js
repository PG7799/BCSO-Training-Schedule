(() => {
  const $ = (id) => document.getElementById(id);
  const config = window.BCSO_CONFIG || {};
  let db, divisions = [], trainings = [], overlapRequests = [], calendar, activeFilter = "", isTrainingCommand = false;
  const colors = ["#477ce6","#23956b","#8a63c7","#d28b35","#c65d75","#268eaa","#75839a"];
  const colorFor = (id) => colors[Math.max(0, divisions.findIndex(d => d.id === id)) % colors.length];
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dateFmt = (d, opts={}) => new Date(d).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit",...opts});
  const msg = (id, text, good=false) => { $(id).textContent=text; $(id).className="form-message"+(good?" success":""); };
  const pageNames = {dashboard:"Dashboard",calendar:"Training Calendar",schedule:"Schedule Training",history:"Training History",overlapRequests:"Overlap Requests"};

  async function init() {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY || config.SUPABASE_URL.includes("YOUR-PROJECT")) {
      alert("Setup required: copy config.js.example to config.js and add your Supabase Project URL and Publishable key.");
      return;
    }
    db = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    $("quickSchedule").addEventListener("click", () => navigate("schedule"));
    $("cancelEdit").addEventListener("click", clearTrainingForm);
    $("trainingForm").addEventListener("submit", saveTraining);
    $("overlapStatusFilter").addEventListener("change", renderOverlapQueue);
    $("refreshOverlapRequests").addEventListener("click", refreshOverlapRequests);
    $("commandAccessButton").addEventListener("click", openCommandAuth);
    $("closeCommandAuth").addEventListener("click", closeCommandAuth);
    $("commandAuthModal").addEventListener("click", e => { if(e.target === $("commandAuthModal")) closeCommandAuth(); });
    $("commandAuthForm").addEventListener("submit", commandSignIn);
    $("commandSignOut").addEventListener("click", commandSignOut);
    $("historyDivision").addEventListener("change", renderHistory);
    $("closeModal").addEventListener("click", closeModal);
    $("eventModal").addEventListener("click", e => { if(e.target === $("eventModal")) closeModal(); });
    document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click",()=>navigate(b.dataset.page)));
    document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.goto)));
    await checkCommandSession();
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
    if(isTrainingCommand) await refreshOverlapRequests();
  }
  function populateDivisionSelects(){
    const opts=divisions.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join("");
    $("division").innerHTML=opts || '<option value="">No divisions available</option>';
    $("historyDivision").innerHTML='<option value="">All divisions</option>'+opts;
  }
  function navigate(page){
    if(page==="overlapRequests" && !isTrainingCommand) page="dashboard";
    document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
    $(page+"Page").classList.remove("hidden");
    document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    $("pageTitle").textContent=pageNames[page];
    if(page==="calendar"&&calendar) setTimeout(()=>calendar.updateSize(),30);
    if(page==="overlapRequests") refreshOverlapRequests();
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
  function overlapsRequest(training,request){
    return training.status==="scheduled"
      && new Date(training.starts_at)<new Date(request.ends_at)
      && new Date(training.ends_at)>new Date(request.starts_at);
  }
  async function refreshOverlapRequests(){
    if(!isTrainingCommand)return;
    $("overlapRequestsList").innerHTML='<div class="empty-state">Loading requests...</div>';
    const {data,error}=await db.from("training_overlap_requests")
      .select("*, divisions(name)")
      .order("created_at",{ascending:false});
    if(error){
      $("overlapQueueSummary").innerHTML="";
      $("overlapRequestsList").innerHTML=empty("Unable to load the command queue: "+error.message);
      return;
    }
    overlapRequests=data||[];
    const pending=overlapRequests.filter(r=>r.status==="pending").length;
    $("overlapPendingCount").textContent=String(pending);
    renderOverlapQueue();
  }
  function renderOverlapQueue(){
    if(!isTrainingCommand)return;
    const filter=$("overlapStatusFilter").value||"pending";
    const pending=overlapRequests.filter(r=>r.status==="pending").length;
    const approved=overlapRequests.filter(r=>r.status==="approved").length;
    const denied=overlapRequests.filter(r=>r.status==="denied").length;
    $("overlapQueueSummary").innerHTML=
      '<div class="queue-stat"><strong>'+pending+'</strong>Awaiting review</div>'+
      '<div class="queue-stat"><strong>'+approved+'</strong>Approved</div>'+
      '<div class="queue-stat"><strong>'+denied+'</strong>Denied</div>';
    const rows=overlapRequests.filter(r=>filter==="all"||r.status===filter);
    if(!rows.length){
      $("overlapRequestsList").innerHTML=empty(filter==="pending"?"There are no overlap requests awaiting review.":"No requests match this filter.");
      return;
    }
    $("overlapRequestsList").innerHTML=rows.map(request=>{
      const division=request.divisions?.name||divisions.find(d=>d.id===request.division_id)?.name||"Division";
      const conflicts=trainings.filter(t=>overlapsRequest(t,request));
      const status=request.status||"pending";
      const conflictMarkup=conflicts.length
        ? conflicts.map(t=>{
            const name=t.divisions?.name||divisions.find(d=>d.id===t.division_id)?.name||"Division";
            return '<div class="request-conflict"><strong>'+esc(t.title)+'</strong> — '+esc(name)+'<br>'+
              'Instructor: '+esc(t.instructor||"Not listed")+' · '+esc(dateFmt(t.starts_at,{weekday:"short",year:"numeric"}))+
              ' to '+esc(dateFmt(t.ends_at))+'<br>Location: '+esc(t.location||"Not specified")+
              (t.conflict_override?' · Previously approved overlap':'')+'</div>';
          }).join("")
        : '<div class="request-conflict">No currently scheduled trainings overlap this request. If approved now, it will be added without an overlap exception.</div>';
      const review=request.reviewed_at
        ? '<div class="request-review-meta">Reviewed '+esc(dateFmt(request.reviewed_at,{year:"numeric"}))+' by '+esc(request.reviewed_by_label||"Training Command")+
          (request.approved_training_id?' · Training record '+esc(request.approved_training_id):'')+'</div>'
        : '';
      const note=request.review_note?'<div class="request-review-note"><strong>Command note:</strong> '+esc(request.review_note)+'</div>':'';
      const actions=status==="pending"
        ? '<div class="request-actions"><button class="button danger" data-deny-request="'+esc(request.id)+'">Deny request</button><button class="button primary" data-approve-request="'+esc(request.id)+'">Approve &amp; schedule</button></div>'
        : '';
      return '<article class="overlap-request-card">'+
        '<div class="overlap-request-head"><div><span class="tag">'+esc(division)+'</span><h3>'+esc(request.title)+'</h3><p>Submitted '+esc(dateFmt(request.created_at,{weekday:"short",year:"numeric"}))+'</p></div><span class="request-status '+esc(status)+'">'+esc(status)+'</span></div>'+
        '<div class="request-detail-grid">'+
          requestDetail("Submitted by",request.requester_name||"Not provided")+
          requestDetail("Instructor",request.instructor)+
          requestDetail("Division",division)+
          requestDetail("Start",dateFmt(request.starts_at,{weekday:"long",year:"numeric"}))+
          requestDetail("End",dateFmt(request.ends_at,{weekday:"long",year:"numeric"}))+
          requestDetail("Location",request.location||"Not specified")+
          requestDetail("Maximum participants",request.capacity||"No limit")+
          requestDetail("Request submitted",dateFmt(request.created_at,{year:"numeric"}))+
          requestDetail("Request status",status.toUpperCase())+
        '</div>'+
        '<div class="request-full-description"><strong>Full training description / objectives</strong><br>'+esc(request.description||"No description was provided.")+'</div>'+
        '<div class="request-conflicts"><h4>Current scheduling conflicts ('+conflicts.length+')</h4>'+conflictMarkup+'</div>'+
        review+note+
        '<div class="request-id">Request reference: '+esc(request.id)+'</div>'+
        actions+
      '</article>';
    }).join("");
    $("overlapRequestsList").querySelectorAll("[data-approve-request]").forEach(button=>{
      button.addEventListener("click",()=>approveOverlapRequest(button.dataset.approveRequest,button));
    });
    $("overlapRequestsList").querySelectorAll("[data-deny-request]").forEach(button=>{
      button.addEventListener("click",()=>denyOverlapRequest(button.dataset.denyRequest,button));
    });
  }
  function requestDetail(label,value){
    return '<div class="request-detail"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';
  }
  async function approveOverlapRequest(id,button){
    const request=overlapRequests.find(r=>r.id===id);
    if(!request||request.status!=="pending")return;
    const division=request.divisions?.name||divisions.find(d=>d.id===request.division_id)?.name||"Division";
    const warning="Approve and schedule this training?\n\n"+request.title+"\n"+division+"\n"+dateFmt(request.starts_at,{weekday:"long",year:"numeric"})+" to "+dateFmt(request.ends_at)+"\n\nThe system will recheck all conflicts before scheduling.";
    if(!confirm(warning))return;
    button.disabled=true;button.textContent="Approving...";
    const {data,error}=await db.rpc("approve_training_overlap_request",{p_request_id:id});
    if(error){
      alert("Could not approve this request: "+error.message);
      button.disabled=false;button.textContent="Approve & schedule";
      return;
    }
    const result=Array.isArray(data)?data[0]:data;
    alert(result?.conflict_overridden
      ?"Request approved and scheduled. The overlap exception has been recorded."
      :"Request approved and scheduled. The conflicting session is no longer active, so no overlap exception was needed.");
    await refreshData();
    await refreshOverlapRequests();
  }
  async function denyOverlapRequest(id,button){
    const request=overlapRequests.find(r=>r.id===id);
    if(!request||request.status!=="pending")return;
    const reason=prompt("Optional reason for denying this request. This note will be visible in the command review history:");
    if(reason===null)return;
    button.disabled=true;button.textContent="Denying...";
    const {error}=await db.rpc("deny_training_overlap_request",{
      p_request_id:id,
      p_review_note:reason.trim()||null
    });
    if(error){
      alert("Could not deny this request: "+error.message);
      button.disabled=false;button.textContent="Deny request";
      return;
    }
    alert("Overlap request denied. It was not added to the training calendar.");
    await refreshOverlapRequests();
  }
  function showEvent(id){
    const t=trainings.find(x=>x.id===id); if(!t)return;
    $("modalDivision").textContent=t.divisions?.name||"Division";
    $("modalTitle").textContent=t.title;
    $("modalWhen").textContent=`${dateFmt(t.starts_at,{weekday:"long",year:"numeric"})} – ${dateFmt(t.ends_at)}`;
    $("modalDescription").textContent=t.description||"No additional description provided.";
    const detailRows=[["Instructor",t.instructor],["Location",t.location||"Not specified"],["Capacity",t.capacity||"No limit"],["Status",t.status]];
    if(t.conflict_override) detailRows.push(["Scheduling exception","Approved by Training Command"]);
    $("modalDetails").innerHTML=detailRows.map(([k,v])=>`<div class="detail-cell"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("");
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
    $("requesterName").value="";
  }
  function openCommandAuth(){ $("commandAuthModal").classList.remove("hidden"); msg("commandAuthMessage", isTrainingCommand ? "You are signed in with Training Command access." : ""); }
  function closeCommandAuth(){ $("commandAuthModal").classList.add("hidden"); }
  async function checkCommandSession(){
    const {data:{session}}=await db.auth.getSession();
    if(!session){setCommandState(false);return;}
    const {data,error}=await db.rpc("is_training_command");
    if(error || data!==true){ await db.auth.signOut(); setCommandState(false); return; }
    setCommandState(true);
  }
  function setCommandState(active){
    isTrainingCommand=active;
    $("commandBadge").classList.toggle("hidden",!active);
    $("overlapRequestsNav").classList.toggle("hidden",!active);
    if(!active){ overlapRequests=[]; $("overlapPendingCount").textContent="0"; if(!$("overlapRequestsPage").classList.contains("hidden")) navigate("dashboard"); }
    else refreshOverlapRequests();
    $("commandAccessButton").textContent=active?"Command signed in":"Command access";
    $("commandSignOut").classList.toggle("hidden",!active);
    $("commandSignIn").classList.toggle("hidden",active);
    $("commandEmail").disabled=active; $("commandPassword").disabled=active;
    if(!active) $("commandAuthForm").reset();
  }
  async function commandSignIn(e){
    e.preventDefault(); msg("commandAuthMessage","Verifying Training Command access...");
    const {error}=await db.auth.signInWithPassword({email:$("commandEmail").value.trim(),password:$("commandPassword").value});
    if(error){msg("commandAuthMessage",error.message);return;}
    const {data, error:roleError}=await db.rpc("is_training_command");
    if(roleError || data!==true){ await db.auth.signOut(); setCommandState(false); msg("commandAuthMessage","This account is not authorized for Training Command overrides."); return; }
    setCommandState(true); msg("commandAuthMessage","Training Command access verified.",true);
    setTimeout(closeCommandAuth,700);
  }
  async function commandSignOut(){ await db.auth.signOut(); setCommandState(false); msg("commandAuthMessage","Signed out.",true); }
  function getTrainingPayload(){
    const starts=new Date($("startsAt").value), ends=new Date($("endsAt").value);
    if(!(starts<ends)){msg("trainingMessage","The end time must be later than the start time.");return null;}
    if(starts<new Date()){msg("trainingMessage","Choose a future start time.");return null;}
    return {title:$("title").value.trim(),division_id:$("division").value,instructor:$("instructor").value.trim(),requester_name:$("requesterName").value.trim()||null,description:$("description").value.trim(),starts_at:starts.toISOString(),ends_at:ends.toISOString(),location:$("location").value.trim()||null,capacity:$("capacity").value?Number($("capacity").value):null};
  }
  async function submitTraining(){
    const payload=getTrainingPayload();
    if(!payload)return;
    msg("trainingMessage","Checking the department schedule...");
    $("saveTraining").disabled=true;
    try{
      const args={
        training_title:payload.title,
        target_division_id:payload.division_id,
        training_instructor:payload.instructor,
        training_description:payload.description||null,
        training_starts_at:payload.starts_at,
        training_ends_at:payload.ends_at,
        training_location:payload.location,
        training_capacity:payload.capacity
      };
      const result=await db.rpc("create_training_with_cancel_code",args);
      if(result.error){
        const message=String(result.error.message||"");
        const conflict=message.toLowerCase().includes("training_conflict")||message.toLowerCase().includes("overlap");
        if(!conflict){msg("trainingMessage",message);return;}
        msg("trainingMessage","A scheduling conflict was found. Sending the full request to Training Command...");
        const requestResult=await db.rpc("submit_training_overlap_request",{
          p_training_title:payload.title,
          p_target_division_id:payload.division_id,
          p_training_instructor:payload.instructor,
          p_training_description:payload.description||null,
          p_training_starts_at:payload.starts_at,
          p_training_ends_at:payload.ends_at,
          p_training_location:payload.location,
          p_training_capacity:payload.capacity,
          p_requester_name:payload.requester_name
        });
        if(requestResult.error){
          msg("trainingMessage","An overlap was found, but the request could not be submitted: "+requestResult.error.message);
          return;
        }
        const request=Array.isArray(requestResult.data)?requestResult.data[0]:requestResult.data;
        if(!request?.request_id||!request?.cancellation_code){
          msg("trainingMessage","The request may have been created, but its receipt could not be displayed. Contact Training Command and provide the title and requested time.");
          return;
        }
        alert("Overlap request submitted to Training Command. It is not scheduled unless Command approves it.\n\nRequest reference: "+request.request_id+"\nCancellation code: "+request.cancellation_code+"\n\nSave this code privately. It will be needed if the session is approved and later cancelled.");
        clearTrainingForm();
        if(isTrainingCommand){await refreshOverlapRequests();navigate("overlapRequests");}
        else navigate("calendar");
        return;
      }
      const created=Array.isArray(result.data)?result.data[0]:result.data;
      if(!created?.cancellation_code){
        msg("trainingMessage","Training was saved, but the cancellation code could not be displayed. Contact Training Command before closing this page.");
        return;
      }
      alert("Training scheduled successfully!\n\nCancellation code: "+created.cancellation_code+"\n\nSave this code. It is required to cancel this training later. It will not be shown again.");
      clearTrainingForm();
      await refreshData();
      navigate("calendar");
    }catch(error){
      msg("trainingMessage","Unable to submit the training: "+(error?.message||String(error)));
    }finally{
      $("saveTraining").disabled=false;
    }
  }
  async function saveTraining(e){e.preventDefault();await submitTraining();}
  init();
})();
