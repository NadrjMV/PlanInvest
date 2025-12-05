import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

console.log("LifePlan v3.2 (Firebase Fix) Iniciando...");

// --- CONFIGURAÇÃO FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyAZilONHJurs2w8M-sIMm5Xrahzr654KwY",
  authDomain: "planinvest-12f20.firebaseapp.com",
  projectId: "planinvest-12f20",
  storageBucket: "planinvest-12f20.firebasestorage.app",
  messagingSenderId: "1073823664394",
  appId: "1:1073823664394:web:740b4b69c7ad40b09612f3",
  measurementId: "G-YGHGXQY05J"
};

// CORREÇÃO AQUI: Verificamos se a chave NÃO é o placeholder genérico.
// Como sua chave é real, isso agora vai dar TRUE.
const isConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";
let app, auth, db;

if (isConfigured) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    console.log("Firebase conectado com sucesso!");
  } catch (e) {
    console.error("Erro crítico ao iniciar Firebase:", e);
  }
} else {
  console.warn("ALERTA: Firebase não detectado. Rodando em modo local.");
}

// --- ESTADO & CONSTANTES ---
const selectors = (id) => document.getElementById(id);
const formatCurrency = (val) => val.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const LOCAL_SESSION_KEY = "lp_session_user";

let state = {
  profile: { income: 0, expenses: 0, mainGoalName: "", mainGoalTarget: 0 },
  institutions: [],
  goals: [],
  entries: [],
  user: { name: "Planner", email: "" }
};

let currentUser = null;
let authMode = "login";

// --- CORE FUNCTIONS ---

async function saveState() {
  if (isConfigured && currentUser?.uid) {
    try {
      await setDoc(doc(db, "users", currentUser.uid), state, { merge: true });
      console.log("Estado salvo no Firestore.");
    } catch (e) {
      console.error("Erro ao salvar no Firestore (fallback local):", e);
      localStorage.setItem(`lp_data_${currentUser?.email}`, JSON.stringify(state));
    }
  } else {
    localStorage.setItem(`lp_data_${currentUser?.email || 'guest'}`, JSON.stringify(state));
  }
}

async function loadState(user) {
  // 1. Carregamento Otimista (Cache Local)
  const local = localStorage.getItem(`lp_data_${user.email}`);
  if (local) state = JSON.parse(local);

  if (isConfigured && user.uid) {
    try {
      // 2. Busca na nuvem
      const docRef = doc(db, "users", user.uid);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        state = { ...state, ...data };
        
        // Prioridade de nomes: Banco > Auth > State > Padrão
        const dbName = data.user?.name;
        const authName = user.displayName;
        const finalName = dbName || authName || state.user?.name || "Planner";
        state.user = { uid: user.uid, email: user.email, name: finalName };
      }
    } catch (e) {
      console.warn("Modo Offline ativo ou erro de rede:", e);
    }
  } else {
    // Fallback puro
    state.user = { uid: user.uid, email: user.email, name: state.user?.name || user.name || "Planner" };
  }
}

// --- RENDERIZAÇÃO ---

function renderDonut(id, data) {
  const el = selectors(id);
  if(!el) return;
  const total = Object.values(data).reduce((a,b) => a+b, 0);
  if (!total) { el.style.background = "#334155"; return; }
  
  const colors = ["#6366f1", "#06b6d4", "#d946ef", "#22c55e", "#f59e0b"];
  let gradString = "";
  let accum = 0;
  Object.values(data).forEach((val, i) => {
    const pct = (val / total) * 100;
    const color = colors[i % colors.length];
    gradString += `${color} ${accum}% ${accum + pct}%, `;
    accum += pct;
  });
  el.style.background = `conic-gradient(${gradString.slice(0,-2)})`;
}

function renderSparkline(entries) {
  const container = selectors("sparkline");
  if (!container) return;
  if (!entries || entries.length < 2) { container.innerHTML = ""; return; }
  
  const sorted = [...entries].sort((a, b) => new Date(a.date) - new Date(b.date));
  let acc = 0;
  const data = sorted.map(e => { acc += Number(e.amount); return acc; });
  
  const width = container.clientWidth || 300;
  const height = container.clientHeight || 60;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:100%"><defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#06b6d4" stop-opacity="0.5"/><stop offset="100%" stop-color="#06b6d4" stop-opacity="0"/></linearGradient></defs><path d="M0,${height} ${points} L${width},${height} Z" fill="url(#grad)"/><polyline points="${points}" fill="none" stroke="#06b6d4" stroke-width="2"/></svg>`;
}

function renderLists(entries, goals, goalsProgress) {
  const goalsEl = selectors("goalsList");
  const recentEl = selectors("recentEntries");
  const goalsFull = selectors("goalsFullList");
  const entriesEl = selectors("entriesList");
  if (!goalsEl) return;

  const createGoalHTML = (g) => {
    const current = goalsProgress.get(g.id) || 0;
    const pct = Math.min(100, Math.round((current / g.target) * 100));
    return `<div class="list-item"><div class="item-left"><div class="item-icon" style="color: ${pct >= 100 ? '#22c55e' : '#fff'}"><i class="ph ${pct >= 100 ? 'ph-check-circle' : 'ph-target'}"></i></div><div class="item-info"><h4>${g.name}</h4><div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div></div></div><div class="item-value">${pct}%</div></div>`;
  };

  const goalsHtml = goals.slice(0, 3).map(createGoalHTML).join("") || "<p class='text-muted small'>Sem metas ativas.</p>";
  goalsEl.innerHTML = goalsHtml;
  if(goalsFull) goalsFull.innerHTML = goals.map(createGoalHTML).join("");

  const sortedEntries = [...entries].sort((a,b) => new Date(b.date) - new Date(a.date));
  const createEntryHTML = (e) => {
    const inst = state.institutions.find(i => i.id === e.institutionId);
    return `<div class="list-item"><div class="item-left"><div class="item-icon"><i class="ph ph-arrow-down-left" style="color: #22c55e"></i></div><div class="item-info"><h4>${e.description || "Aporte"}</h4><p>${inst?.name || "Caixa"} • ${new Date(e.date).toLocaleDateString('pt-BR')}</p></div></div><div class="item-value">${formatCurrency(Number(e.amount))}</div></div>`;
  };
  recentEl.innerHTML = sortedEntries.slice(0, 5).map(createEntryHTML).join("") || "<p class='text-muted small'>Sem lançamentos.</p>";
  if(entriesEl) entriesEl.innerHTML = sortedEntries.map(createEntryHTML).join("");
}

function renderInstitutions() {
  const list = selectors("institutionsList");
  if(!list) return;
  const totals = {};
  state.entries.forEach(e => totals[e.institutionId] = (totals[e.institutionId] || 0) + Number(e.amount));
  list.innerHTML = state.institutions.map(inst => `<div class="list-item"><div class="item-left"><div class="item-icon"><i class="ph ph-bank"></i></div><div class="item-info"><h4>${inst.name}</h4><p>${inst.type}</p></div></div><div class="item-value">${formatCurrency(totals[inst.id] || 0)}</div></div>`).join("");
}

function hydrateProfile() {
  const form = selectors("profileForm");
  if(!form) return;
  if(form.userName) form.userName.value = state.user?.name || "";
  form.income.value = state.profile.income || "";
  form.expenses.value = state.profile.expenses || "";
  form.mainGoalName.value = state.profile.mainGoalName || "";
  form.mainGoalTarget.value = state.profile.mainGoalTarget || "";
  form.mainGoalDeadline.value = state.profile.mainGoalDeadline || "";
}

function renderApp() {
  const entries = state.entries || [];
  const total = entries.reduce((acc, e) => acc + Number(e.amount), 0);
  
  const byClass = {};
  const byInst = {};
  const goalProgress = new Map();
  
  entries.forEach(e => {
    const val = Number(e.amount);
    byClass[e.assetClass] = (byClass[e.assetClass] || 0) + val;
    byInst[e.institutionId] = (byInst[e.institutionId] || 0) + val;
    if(e.goalId) goalProgress.set(e.goalId, (goalProgress.get(e.goalId) || 0) + val);
  });

  if(selectors("totalBalance")) selectors("totalBalance").textContent = formatCurrency(total);
  const displayName = state.user?.name?.split(" ")[0] || "Planner";
  if(selectors("userGreeting")) selectors("userGreeting").textContent = displayName;
  if(selectors("headerAvatar")) selectors("headerAvatar").textContent = displayName.charAt(0).toUpperCase();

  renderSparkline(entries);
  renderDonut("classPie", byClass);
  renderDonut("institutionPie", byInst);
  renderLists(entries, state.goals || [], goalProgress);
  renderInstitutions();
  hydrateProfile();

  const instSelect = selectors("entryInstitution");
  const goalSelect = selectors("entryGoal");
  const bindSelect = selectors("primaryGoalSelect");
  
  if (instSelect) instSelect.innerHTML = state.institutions.map(i => `<option value="${i.id}">${i.name}</option>`).join("");
  const goalOpts = state.goals.map(g => `<option value="${g.id}">${g.name}</option>`).join("");
  if (goalSelect) goalSelect.innerHTML = `<option value="">Apenas guardar (Sem meta)</option>` + goalOpts;
  if (bindSelect) bindSelect.innerHTML = `<option value="">Selecionar...</option>` + goalOpts;
  
  saveState();
  checkOnboarding();
}

// --- ONBOARDING LOGIC ---
function checkOnboarding() {
  if (state.profile.income === 0) {
    selectors("onboardingModal").classList.remove("hidden");
  } else {
    selectors("onboardingModal").classList.add("hidden");
  }
}

function setupOnboarding() {
  const btnStep1 = selectors("btnStep1");
  const btnFinish = selectors("btnFinishOnboarding");

  if(btnStep1) {
    btnStep1.addEventListener("click", () => {
      const name = selectors("obGoalName").value;
      const target = selectors("obGoalTarget").value;
      if(name && target) {
        state.goals.push({ id: crypto.randomUUID(), name, target: Number(target), priority: "alta", due: "" });
        state.profile.mainGoalName = name;
        state.profile.mainGoalTarget = Number(target);
        selectors("step1").classList.remove("active");
        selectors("step2").classList.add("active");
      } else {
        alert("Preencha os campos!");
      }
    });
  }

  if(btnFinish) {
    btnFinish.addEventListener("click", () => {
      const inc = selectors("obIncome").value;
      const exp = selectors("obExpenses").value;
      if(inc && exp) {
        state.profile.income = Number(inc);
        state.profile.expenses = Number(exp);
        saveState();
        renderApp();
        selectors("onboardingModal").classList.add("hidden");
      } else {
        alert("Preencha os valores!");
      }
    });
  }
}

// --- SETUP & LISTENERS ---

function setupNavigation() {
  const buttons = document.querySelectorAll(".nav-item, .nav-fab");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
      if(btn.classList.contains("nav-item")) btn.classList.add("active");
      const target = btn.dataset.section;
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      selectors(target).classList.add("active");
    });
  });
}

function setupForms() {
  const toggle = (btnId, panelId) => {
    const btn = selectors(btnId);
    if(btn) btn.addEventListener("click", () => {
      const panel = selectors(panelId);
      panel.style.display = panel.style.display === "block" ? "none" : "block";
    });
  };
  toggle("toggleInstitutionForm", "institutionFormCard");
  toggle("toggleGoalForm", "goalFormCard");

  const handleForm = (id, callback) => {
    const form = selectors(id);
    if(form) form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      callback(Object.fromEntries(fd));
      if (id !== "profileForm") e.target.reset();
      renderApp();
      if(id === "institutionForm") selectors("institutionFormCard").style.display = "none";
      if(id === "goalForm") selectors("goalFormCard").style.display = "none";
      if(id === "entryForm") document.querySelector('[data-section="dashboard"]').click();
    });
  };

  handleForm("institutionForm", (data) => state.institutions.push({ ...data, id: crypto.randomUUID() }));
  handleForm("goalForm", (data) => state.goals.push({ ...data, id: crypto.randomUUID(), target: Number(data.target) }));
  handleForm("entryForm", (data) => state.entries.push({ ...data, id: crypto.randomUUID(), amount: Number(data.amount) }));
  
  handleForm("profileForm", (data) => {
    state.profile = { 
      income: Number(data.income),
      expenses: Number(data.expenses),
      mainGoalName: data.mainGoalName,
      mainGoalTarget: Number(data.mainGoalTarget),
      mainGoalDeadline: data.mainGoalDeadline
    };
    if(data.userName) {
      state.user.name = data.userName;
      if(isConfigured && auth && auth.currentUser) {
        updateProfile(auth.currentUser, { displayName: data.userName }).catch(err => console.log(err));
      }
    }
    alert("Perfil e nome atualizados!");
  });
}

function setupAuth() {
  const modal = selectors("authModal");
  const form = selectors("authForm");
  const toggleBtn = selectors("toggleAuth");
  const submitBtn = selectors("authSubmit");
  
  if(!modal) return;

  toggleBtn.addEventListener("click", () => {
    authMode = authMode === "login" ? "register" : "login";
    selectors("nameField").classList.toggle("hidden");
    toggleBtn.textContent = authMode === "login" ? "Não tem conta? Crie agora" : "Já tenho conta? Entrar";
    submitBtn.textContent = authMode === "login" ? "Entrar" : "Criar Conta";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "Conectando...";
    submitBtn.classList.add("pulse-opacity");
    submitBtn.disabled = true;

    const data = new FormData(e.target);
    const email = data.get("email");
    const pass = data.get("password");

    // FALLBACK (Se config estiver errada)
    if (!isConfigured) {
      setTimeout(async () => {
        currentUser = { uid: "local-user", email, name: data.get("name") || "Local User" };
        localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(currentUser));
        await loadState(currentUser);
        renderApp();
        modal.style.display = "none";
      }, 300);
      return;
    }

    try {
      let uc;
      if (authMode === "login") uc = await signInWithEmailAndPassword(auth, email, pass);
      else {
        uc = await createUserWithEmailAndPassword(auth, email, pass);
        if (data.get("name")) updateProfile(uc.user, { displayName: data.get("name") });
      }
      currentUser = uc.user;
      localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ uid: currentUser.uid, email: currentUser.email, name: currentUser.displayName }));
      await loadState(currentUser);
      renderApp();
      modal.style.display = "none";
    } catch (err) {
      alert("Erro Auth: " + err.message);
      submitBtn.textContent = originalText;
      submitBtn.classList.remove("pulse-opacity");
      submitBtn.disabled = false;
    }
  });

  selectors("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem(LOCAL_SESSION_KEY);
    if (isConfigured && auth) signOut(auth);
    location.reload();
  });
}

function init() {
  setupNavigation();
  setupForms();
  setupAuth();
  setupOnboarding();
  
  if (isConfigured) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        // --- SUCESSO NO LOGIN AUTOMÁTICO ---
        currentUser = user;
        localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ uid: user.uid, email: user.email, name: user.displayName }));
        await loadState(user);
        renderApp();
        selectors("authModal").style.display = "none";
      } else {
         // Verifica se tem sessão salva localmente antes de mostrar login
         const savedUser = localStorage.getItem(LOCAL_SESSION_KEY);
         if (savedUser && !auth.currentUser) {
            // Dá um tempinho pro Firebase conectar (Cold Start)
            setTimeout(() => {
                if(!auth.currentUser) selectors("authModal").style.display = "grid";
            }, 800);
         } else {
            selectors("authModal").style.display = "grid";
         }
      }
    });
  } else {
    // Modo Offline
    const savedUser = localStorage.getItem(LOCAL_SESSION_KEY);
    if (savedUser) {
      currentUser = JSON.parse(savedUser);
      loadState(currentUser).then(() => {
        renderApp();
        selectors("authModal").style.display = "none";
      });
    } else {
      selectors("authModal").style.display = "grid";
    }
  }
}

init();
