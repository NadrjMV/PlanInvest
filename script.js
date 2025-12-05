import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, addDoc, getDocs, query, orderBy, where, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

console.log("LifePlan v4.2 (Recurrence Fix) Iniciando...");

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

const isConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";
let app, auth, db;

if (isConfigured) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    console.log("Firebase conectado (Subcollections Mode).");
  } catch (e) {
    console.error("Erro init Firebase:", e);
  }
} else {
  console.error("Firebase NÃO configurado corretamente.");
}

// --- ESTADO & HELPERS ---
const selectors = (id) => document.getElementById(id);
const formatCurrency = (val) => val.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const LOCAL_SESSION_KEY = "lp_session_user";

// Estado agora é apenas um cache de leitura
let state = {
  profile: { income: 0, expenses: 0, mainGoalName: "", mainGoalTarget: 0 },
  institutions: [],
  goals: [],
  entries: [],
  subscriptions: [],
  user: { name: "Planner", email: "" },
  ui: { 
    selectedDate: new Date(), // Data atual para filtro
    privacyMode: localStorage.getItem("lp_privacy") === "true" // Lembra da escolha
  }
};

let currentUser = null;
let authMode = "login";

// --- MÁSCARA DE MOEDA (Input Mask & Helpers) ---
// Transforma 1000 em "R$ 10,00" para inputs que esperam digitação
const moneyMask = (value) => {
  if (!value) return "";
  value = value.replace(/\D/g, ""); // Remove tudo que não é número
  value = (Number(value) / 100).toFixed(2) + ""; // Divide por 100 e fixa decimais
  value = value.replace(".", ",");
  value = value.replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1.");
  return `R$ ${value}`;
};

// Transforma float do banco (2500.00) em valor para input (R$ 2.500,00)
// CORREÇÃO APLICADA: Multiplica por 100 antes de mascarar
const formatToInput = (floatVal) => {
  if (!floatVal && floatVal !== 0) return "";
  return moneyMask((floatVal * 100).toFixed(0)); 
};

// Transforma string mascarada (R$ 1.000,00) em Float (1000.00)
const parseMoney = (maskedValue) => {
  if (!maskedValue) return 0;
  return Number(maskedValue.replace(/[^0-9,-]+/g,"").replace(",","."));
};

function setupMoneyInputs() {
  document.querySelectorAll('.money-mask').forEach(input => {
    input.addEventListener('input', (e) => {
      e.target.value = moneyMask(e.target.value);
    });
  });
}

// --- MODAL CUSTOMIZADO (Promise-based) ---
function customConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = selectors("confirmModal");
    const titleEl = selectors("confirmTitle");
    const msgEl = selectors("confirmMessage");
    const btnYes = selectors("btnConfirm");
    const btnNo = selectors("btnCancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.remove("hidden");

    const close = (result) => {
      modal.classList.add("hidden");
      btnYes.replaceWith(btnYes.cloneNode(true)); // Limpa listeners
      btnNo.replaceWith(btnNo.cloneNode(true));
      resolve(result);
    };

    selectors("btnConfirm").addEventListener("click", () => close(true));
    selectors("btnCancel").addEventListener("click", () => close(false));
  });
}

// --- CORE FUNCTIONS (ARQUITETURA NOVA) ---

async function fetchUserData(user) {
  // 1. Fetch Profile
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  
  if (userSnap.exists()) {
    const data = userSnap.data();
    state.profile = data.profile || state.profile;
    state.institutions = data.institutions || [];
    state.user.name = data.name || user.displayName || "Planner";
  } else {
    await setDoc(userRef, { 
      name: user.displayName, 
      email: user.email, 
      profile: state.profile, 
      institutions: [] 
    });
  }

  // 2. Fetch Entries
  const entriesRef = collection(db, "users", user.uid, "entries");
  const qEntries = query(entriesRef, orderBy("date", "desc"));
  const entriesSnap = await getDocs(qEntries);
  state.entries = entriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 3. Fetch Goals
  const goalsRef = collection(db, "users", user.uid, "goals");
  const goalsSnap = await getDocs(goalsRef);
  state.goals = goalsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 4. Fetch Subscriptions
  const subsRef = collection(db, "users", user.uid, "subscriptions");
  const subsSnap = await getDocs(subsRef);
  state.subscriptions = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderApp();
}

// --- LOGIC: RECORRÊNCIA AUTOMÁTICA ---
async function checkRecurringEntries() {
  if (!state.subscriptions.length) return;
  
  const today = new Date();
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();
  const currentDay = today.getDate();
  let addedCount = 0;

  for (const sub of state.subscriptions) {
    // Se o dia do vencimento já passou ou é hoje
    if (currentDay >= Number(sub.day)) {
      // Verifica se já existe lançamento deste fixo neste mês/ano
      // Usamos um ID composto ou flag 'originId'
      const alreadyExists = state.entries.some(e => 
        e.originId === sub.id && 
        new Date(e.date).getMonth() + 1 === currentMonth &&
        new Date(e.date).getFullYear() === currentYear
      );

      if (!alreadyExists) {
        // Cria lançamento automático
        const newEntry = {
          amount: -Math.abs(Number(sub.amount)), // Despesa é negativo visualmente no saldo? Não, no sistema Amount é absoluto, AssetClass define.
          description: `(Fixo) ${sub.name}`,
          date: new Date().toISOString().split('T')[0],
          institutionId: state.institutions[0]?.id || "", // Fallback para a primeira conta
          assetClass: "Despesa",
          originId: sub.id, // Link para evitar duplicação
          isRecurring: true
        };
        
        // Ajuste: Amount deve ser positivo no objeto, lógica de display decide cor
        newEntry.amount = Math.abs(Number(sub.amount));
        
        await addEntry(newEntry);
        addedCount++;
      }
    }
  }

  if (addedCount > 0) {
    showToast(`${addedCount} contas fixas lançadas automaticamente!`);
  }
}

// CRUD Settings (Profile & Institutions)
async function saveSettings() {
  if (!currentUser?.uid) return;
  try {
    const userRef = doc(db, "users", currentUser.uid);
    await updateDoc(userRef, {
      profile: state.profile,
      institutions: state.institutions
    });
  } catch (e) {
    console.error("Save error:", e);
  }
}

// CRUD Entries
async function addEntry(entryData) {
  state.entries.unshift({ ...entryData, id: "temp" });
  renderApp();

  if (currentUser?.uid) {
    try {
      const docRef = await addDoc(collection(db, "users", currentUser.uid, "entries"), entryData);
      state.entries[0].id = docRef.id;
    } catch (e) {
      showToast("Erro ao salvar online", "error");
    }
  }
}

async function removeEntry(id) {
  const confirmed = await customConfirm("Excluir lançamento?", "O valor será removido do seu saldo.");
  if (!confirmed) return;

  state.entries = state.entries.filter(e => e.id !== id);
  renderApp();

  if (currentUser?.uid) {
    try {
      await deleteDoc(doc(db, "users", currentUser.uid, "entries", id));
      showToast("Removido com sucesso");
    } catch (e) {
      showToast("Erro ao remover", "error");
    }
  }
}

// CRUD Goals
async function addGoal(goalData) {
  state.goals.push({ ...goalData, id: "temp" });
  renderApp();
  
  if (currentUser?.uid) {
    const docRef = await addDoc(collection(db, "users", currentUser.uid, "goals"), goalData);
    const idx = state.goals.findIndex(g => g.id === "temp");
    if(idx !== -1) state.goals[idx].id = docRef.id;
  }
}

// CRUD Subscriptions (Novo)
async function addSubscription(subData) {
  state.subscriptions.push({ ...subData, id: "temp" });
  renderApp();

  if (currentUser?.uid) {
    const docRef = await addDoc(collection(db, "users", currentUser.uid, "subscriptions"), subData);
    const idx = state.subscriptions.findIndex(s => s.id === "temp");
    if(idx !== -1) state.subscriptions[idx].id = docRef.id;
  }
}

async function removeSubscription(id) {
    const confirmed = await customConfirm("Cancelar recorrência?", "O sistema parará de lançar esta conta.");
    if (!confirmed) return;

    state.subscriptions = state.subscriptions.filter(s => s.id !== id);
    renderApp();

    if (currentUser?.uid) {
        await deleteDoc(doc(db, "users", currentUser.uid, "subscriptions", id));
        showToast("Recorrência removida");
    }
}


// --- RENDERIZAÇÃO ---
function showToast(msg, type = 'success') {
  const toast = selectors("toast");
  const text = selectors("toastMessage");
  const icon = selectors("toastIcon");
  if(!toast) return;
  
  text.textContent = msg;
  toast.className = `toast show ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  icon.className = type === 'success' ? 'ph ph-check-circle' : 'ph ph-warning-circle';
  
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function renderDonut(id, data) {
  const el = selectors(id);
  if(!el) return;
  const total = Object.values(data).reduce((a,b) => a+b, 0);
  if (!total) { el.style.background = "#334155"; return; }
  
  const colors = ["#6366f1", "#06b6d4", "#d946ef", "#22c55e", "#f59e0b", "#ef4444"];
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
  const data = sorted.map(e => {
      // Ajuste: Despesa subtrai, Receita soma
      if(e.assetClass === "Despesa") acc -= Number(e.amount);
      else acc += Number(e.amount);
      return acc;
  });
  
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

function renderLists(monthlyEntries, allEntries, goals) {
  const goalsEl = selectors("goalsList");
  const goalsFull = selectors("goalsFullList");
  const recentEl = selectors("recentEntries"); // Home (Resumo Global)
  const entriesEl = selectors("entriesList");  // Aba Lançamentos (Mês Selecionado)

  // --- 1. RENDER GOALS ---
  // Calculamos o progresso com BASE EM TUDO (allEntries), pois metas são longo prazo
  const goalsProgress = new Map();
  allEntries.forEach(e => {
      if(e.goalId && e.assetClass !== "Despesa") {
        goalsProgress.set(e.goalId, (goalsProgress.get(e.goalId) || 0) + Number(e.amount));
      }
  });

  if (goalsEl) {
    const createGoalHTML = (g) => {
      const current = goalsProgress.get(g.id) || 0;
      const pct = Math.min(100, Math.round((current / g.target) * 100));
      return `
      <div class="list-item">
        <div class="item-left">
          <div class="item-icon" style="color: ${pct >= 100 ? '#22c55e' : '#fff'}">
            <i class="ph ${pct >= 100 ? 'ph-check-circle' : 'ph-target'}"></i>
          </div>
          <div class="item-info">
            <h4>${g.name}</h4>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${pct}%"></div>
            </div>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <div class="item-value" style="margin-right: 8px;">${pct}%</div>
          <button data-id="${g.id}" class="delete-btn action-del-goal"><i class="ph ph-trash"></i></button>
        </div>
      </div>`;
    };

    const goalsHtml = goals.slice(0, 3).map(createGoalHTML).join("") || "<p class='text-muted small'>Sem metas ativas.</p>";
    goalsEl.innerHTML = goalsHtml;
    if(goalsFull) goalsFull.innerHTML = goals.map(createGoalHTML).join("");
    
    document.querySelectorAll('.action-del-goal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeGoal(btn.dataset.id);
      });
    });
  }

  // --- 2. RENDER ENTRIES (HELPER) ---
  const createEntryHTML = (e) => {
    const inst = state.institutions.find(i => i.id === e.institutionId);
    const isExpense = e.assetClass === "Despesa";
    const color = isExpense ? "#ef4444" : "#22c55e";
    const icon = isExpense ? "ph-arrow-up-right" : "ph-arrow-down-left";
    const desc = e.isRecurring ? `<i class="ph ph-arrows-clockwise"></i> ${e.description}` : (e.description || "Aporte");
    
    // NOTA: Adicionei a classe 'money-value' abaixo para o efeito de blur
    return `
      <div class="list-item">
        <div class="item-left">
          <div class="item-icon">
            <i class="ph ${icon}" style="color: ${color}"></i>
          </div>
          <div class="item-info">
            <h4>${desc}</h4>
            <p>${inst?.name || "Caixa"} • ${new Date(e.date).toLocaleDateString('pt-BR', {timeZone: 'UTC'})}</p>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <div class="item-value money-value" style="color: ${color}">
            ${isExpense ? '-' : ''}${formatCurrency(Number(e.amount))}
          </div>
          <button data-id="${e.id}" class="delete-btn action-delete"><i class="ph ph-trash"></i></button>
        </div>
      </div>`;
  };

  // Lista HOME: Mostra os 5 últimos globais (independente do mês)
  const sortedAll = [...allEntries].sort((a,b) => new Date(b.date) - new Date(a.date));
  if(recentEl) recentEl.innerHTML = sortedAll.slice(0, 5).map(createEntryHTML).join("") || "<p class='text-muted small'>Sem lançamentos.</p>";

  // Lista ABA ENTRIES: Mostra TODOS do MÊS SELECIONADO
  const sortedMonthly = [...monthlyEntries].sort((a,b) => new Date(b.date) - new Date(a.date));
  if(entriesEl) entriesEl.innerHTML = sortedMonthly.map(createEntryHTML).join("") || "<p class='text-muted center-text'>Nenhum lançamento neste mês.</p>";

  // Re-attach listeners
  document.querySelectorAll('.action-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if(id) removeEntry(id);
    });
  });
}

function renderSubscriptions() {
    const list = selectors("subsList");
    if(!list) return;
    
    if(state.subscriptions.length === 0) {
        list.innerHTML = "<p class='text-muted center-text'>Nenhuma conta fixa cadastrada.</p>";
        return;
    }

    list.innerHTML = state.subscriptions.map(sub => `
        <div class="list-item">
            <div class="item-left">
                <div class="item-icon"><i class="ph ph-arrows-clockwise"></i></div>
                <div class="item-info">
                    <h4>${sub.name}</h4>
                    <p>Dia ${sub.day} • ${sub.category}</p>
                </div>
            </div>
            <div style="display:flex; align-items:center;">
                <div class="item-value">${formatCurrency(Number(sub.amount))}</div>
                <button data-id="${sub.id}" class="delete-btn action-del-sub"><i class="ph ph-trash"></i></button>
            </div>
        </div>
    `).join("");

    document.querySelectorAll('.action-del-sub').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeSubscription(btn.dataset.id);
        });
    });
}

function renderInstitutions() {
  const list = selectors("institutionsList");
  if(!list) return;
  const totals = {};
  
  // Calcula totais baseado em Entradas - Saídas
  state.entries.forEach(e => {
      const val = Number(e.amount);
      const isExpense = e.assetClass === "Despesa";
      if(!totals[e.institutionId]) totals[e.institutionId] = 0;
      
      if(isExpense) totals[e.institutionId] -= val;
      else totals[e.institutionId] += val;
  });

  list.innerHTML = state.institutions.map(inst => `<div class="list-item"><div class="item-left"><div class="item-icon"><i class="ph ph-bank"></i></div><div class="item-info"><h4>${inst.name}</h4><p>${inst.type}</p></div></div><div class="item-value">${formatCurrency(totals[inst.id] || 0)}</div></div>`).join("");
}

function hydrateProfile() {
  const form = selectors("profileForm");
  if(!form) return;
  if(form.userName) form.userName.value = state.user?.name || "";
  
  // CORREÇÃO: Usando formatToInput para preencher os valores corretamente
  form.income.value = formatToInput(state.profile.income);
  form.expenses.value = formatToInput(state.profile.expenses);
  form.mainGoalName.value = state.profile.mainGoalName || "";
  form.mainGoalTarget.value = formatToInput(state.profile.mainGoalTarget);
  form.mainGoalDeadline.value = state.profile.mainGoalDeadline || "";
}

// --- FUNÇÕES DE PRIVACIDADE ---
function togglePrivacy() {
  state.ui.privacyMode = !state.ui.privacyMode;
  localStorage.setItem("lp_privacy", state.ui.privacyMode);
  applyPrivacyUI();
}

function applyPrivacyUI() {
  const btn = selectors("togglePrivacy");
  if (state.ui.privacyMode) {
    document.body.classList.add("privacy-active");
    if(btn) btn.innerHTML = '<i class="ph ph-eye-slash"></i>';
  } else {
    document.body.classList.remove("privacy-active");
    if(btn) btn.innerHTML = '<i class="ph ph-eye"></i>';
  }
}

// --- FUNÇÕES DE DATA ---
function updateMonthDisplay() {
  const label = selectors("currentMonthLabel");
  if(label) {
    // Ex: "Dezembro 2025"
    const display = state.ui.selectedDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    label.textContent = display.charAt(0).toUpperCase() + display.slice(1);
  }
}

function changeMonth(delta) {
  state.ui.selectedDate.setMonth(state.ui.selectedDate.getMonth() + delta);
  updateMonthDisplay();
  renderApp(); // Re-renderiza tudo com o novo filtro
}

function renderApp() {
  const allEntries = state.entries || [];
  
  // --- 1. FILTRO DE DATA (CORRIGIDO: COMPARAÇÃO POR TEXTO) ---
  // Gera "2025-12" baseado no selecionado
  const year = state.ui.selectedDate.getFullYear();
  const month = String(state.ui.selectedDate.getMonth() + 1).padStart(2, '0');
  const targetStr = `${year}-${month}`; // Ex: "2025-12"

  // Filtra: "A data do lançamento COMEÇA com 2025-12?"
  const monthlyEntries = allEntries.filter(e => e.date.startsWith(targetStr));

  // --- 2. CÁLCULOS GLOBAIS (SALDO TOTAL REAL) ---
  // Soma TUDO, independente do mês (Patrimônio Acumulado)
  const globalTotal = allEntries.reduce((acc, e) => {
      // Se AssetClass for "Despesa", subtrai. Se não (Receita/Invest), soma.
      if(e.assetClass === "Despesa") return acc - Number(e.amount);
      return acc + Number(e.amount);
  }, 0);

  // --- 3. CÁLCULOS MENSAIS (PARA OS GRÁFICOS) ---
  const byClass = {};
  const byInst = {};
  
  monthlyEntries.forEach(e => {
    const val = Number(e.amount);
    byClass[e.assetClass] = (byClass[e.assetClass] || 0) + val;
    byInst[e.institutionId] = (byInst[e.institutionId] || 0) + val;
  });

  // --- RENDERIZAÇÃO DA UI ---
  if(selectors("totalBalance")) selectors("totalBalance").textContent = formatCurrency(globalTotal);
  
  const displayName = state.user?.name?.split(" ")[0] || "Planner";
  if(selectors("userGreeting")) selectors("userGreeting").textContent = displayName;
  if(selectors("headerAvatar")) selectors("headerAvatar").textContent = displayName.charAt(0).toUpperCase();

  // Gráficos e Listas
  renderSparkline(allEntries); // Sparkline mostra histórico completo
  renderDonut("classPie", byClass);
  renderDonut("institutionPie", byInst);
  
  // Passamos a lista FILTRADA (monthly) para a aba de lançamentos
  // Passamos a lista COMPLETA (all) para o histórico recente da home e cálculo de metas
  renderLists(monthlyEntries, allEntries, state.goals || []);
  
  renderInstitutions();
  renderSubscriptions(); // Apenas lista, sem lógica de desconto
  hydrateProfile();

  // Dropdowns
  const instSelect = selectors("entryInstitution");
  const goalSelect = selectors("entryGoal");
  
  if (instSelect) instSelect.innerHTML = state.institutions.map(i => `<option value="${i.id}">${i.name}</option>`).join("");
  const goalOpts = state.goals.map(g => `<option value="${g.id}">${g.name}</option>`).join("");
  if (goalSelect) goalSelect.innerHTML = `<option value="">Nenhuma</option>` + goalOpts;

  checkOnboarding();
  applyPrivacyUI();
  updateMonthDisplay();
}

function checkOnboarding() {
  if (state.profile.income === 0 && !selectors("onboardingModal").classList.contains("done")) {
    selectors("onboardingModal").classList.remove("hidden");
  } else {
    selectors("onboardingModal").classList.add("hidden");
  }
}

// --- SETUP & LISTENERS ---

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
  toggle("toggleSubForm", "subFormCard"); // Toggle de assinaturas

  const handleForm = (id, callback) => {
    const form = selectors(id);
    if(form) form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd);
      callback(data);
      if (id !== "profileForm") e.target.reset();
      if(id === "institutionForm") selectors("institutionFormCard").style.display = "none";
      if(id === "goalForm") selectors("goalFormCard").style.display = "none";
      if(id === "subForm") selectors("subFormCard").style.display = "none";
      if(id === "entryForm") document.querySelector('[data-section="dashboard"]').click();
    });
  };

  handleForm("institutionForm", (data) => {
    state.institutions.push({ ...data, id: crypto.randomUUID() });
    saveSettings(); 
    renderApp();
    showToast("Carteira adicionada!");
  });

  handleForm("goalForm", (data) => {
    const cleanData = { ...data, target: parseMoney(data.target) };
    addGoal(cleanData);
    showToast("Meta criada!");
  });

  handleForm("subForm", (data) => {
    const cleanData = { ...data, amount: parseMoney(data.amount) };
    addSubscription(cleanData);
    showToast("Recorrência ativada!");
  });

  handleForm("entryForm", (data) => {
    const cleanData = { ...data, amount: parseMoney(data.amount) };
    addEntry(cleanData);
    showToast("Aporte registrado!");
  });
  
  handleForm("profileForm", (data) => {
    state.profile = { 
      income: parseMoney(data.income),
      expenses: parseMoney(data.expenses),
      mainGoalName: data.mainGoalName,
      mainGoalTarget: parseMoney(data.mainGoalTarget),
      mainGoalDeadline: data.mainGoalDeadline
    };
    if(data.userName) {
      state.user.name = data.userName;
      if(isConfigured && auth && auth.currentUser) {
        updateProfile(auth.currentUser, { displayName: data.userName }).catch(err => console.log(err));
      }
    }
    saveSettings();
    renderApp();
    showToast("Perfil atualizado!");
  });
}

function setupOnboarding() {
  const btnStep1 = selectors("btnStep1");
  const btnFinish = selectors("btnFinishOnboarding");

  if(btnStep1) {
    btnStep1.addEventListener("click", () => {
      const name = selectors("obGoalName").value;
      const target = parseMoney(selectors("obGoalTarget").value);
      if(name && target) {
        addGoal({ name, target, priority: "alta", due: "" });
        state.profile.mainGoalName = name;
        state.profile.mainGoalTarget = target;
        selectors("step1").classList.remove("active");
        selectors("step2").classList.add("active");
      } else {
        showToast("Preencha a meta!", "error");
      }
    });
  }

  if(btnFinish) {
    btnFinish.addEventListener("click", () => {
      const inc = parseMoney(selectors("obIncome").value);
      const exp = parseMoney(selectors("obExpenses").value);
      if(inc) {
        state.profile.income = inc;
        state.profile.expenses = exp;
        saveSettings();
        selectors("onboardingModal").classList.add("hidden");
        selectors("onboardingModal").classList.add("done");
        renderApp();
      } else {
        showToast("Informe a renda!", "error");
      }
    });
  }
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
    submitBtn.disabled = true;

    const data = new FormData(e.target);
    const email = data.get("email");
    const pass = data.get("password");

    try {
      let uc;
      if (authMode === "login") uc = await signInWithEmailAndPassword(auth, email, pass);
      else {
        uc = await createUserWithEmailAndPassword(auth, email, pass);
        if (data.get("name")) updateProfile(uc.user, { displayName: data.get("name") });
      }
      modal.style.display = "none";
    } catch (err) {
      showToast("Erro Auth: " + err.message, "error");
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  selectors("logoutBtn").addEventListener("click", () => {
    if (isConfigured && auth) signOut(auth);
    location.reload();
  });
}

// 1. MANTENHA O SEU setupNavigation (Gerencia Telas)
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

  // Clique no Header abre o perfil
  const profileTrigger = selectors("profileTrigger");
  if(profileTrigger) {
    profileTrigger.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      selectors("profile").classList.add("active");
    });
  }
}

// 2. CRIE ESSA NOVA FUNÇÃO (Gerencia Ações de UI: Privacidade e Mês)
function setupUIListeners() {
  // Toggle Privacy (Olhinho)
  const privacyBtn = selectors("togglePrivacy");
  if(privacyBtn) {
    privacyBtn.addEventListener("click", togglePrivacy);
  }

  // Navegação de Meses
  const prevBtn = selectors("prevMonth");
  const nextBtn = selectors("nextMonth");

  if(prevBtn) prevBtn.addEventListener("click", () => changeMonth(-1));
  if(nextBtn) nextBtn.addEventListener("click", () => changeMonth(1));
}

async function removeGoal(id) {
  const confirmed = await customConfirm("Excluir meta?", "Isso não apaga os lançamentos vinculados.");
  if (!confirmed) return;

  // Atualiza Local
  state.goals = state.goals.filter(g => g.id !== id);
  
  // Se a meta principal do perfil for a excluída, limpa o perfil
  if (state.profile.mainGoalName === state.goals.find(g => g.id === id)?.name) {
     state.profile.mainGoalName = "";
     state.profile.mainGoalTarget = 0;
  }
  
  renderApp();

  // Atualiza Firebase
  if (currentUser?.uid) {
    try {
      await deleteDoc(doc(db, "users", currentUser.uid, "goals", id));
      showToast("Meta removida");
    } catch (e) {
      showToast("Erro ao remover", "error");
    }
  }
}

function init() {
  setupNavigation();
  setupUIListeners();
  setupForms();
  setupAuth();
  setupOnboarding();
  setupMoneyInputs();

  if (isConfigured) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        // Carrega dados, mas NÃO roda mais a verificação automática
        await fetchUserData(user); 
        selectors("authModal").style.display = "none";
      } else {
        selectors("authModal").style.display = "grid";
      }
    });
  }
}

init();
