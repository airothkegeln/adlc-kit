import { useState, useRef, useCallback, useEffect, Component } from "react";
import PixelPipeline from "./PixelPipeline.jsx";

class ReportErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("ReportErrorBoundary:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 12, border: "1px solid #E74C3C", borderRadius: 6, background: "rgba(231,76,60,0.08)", fontSize: 11, color: "#E74C3C", fontFamily: "monospace" }}>
          ⚠ Error renderizando este panel: {String(this.state.error?.message || this.state.error)}
          <button onClick={() => this.setState({ error: null })} style={{ marginLeft: 10, padding: "2px 8px", background: "transparent", color: "#E74C3C", border: "1px solid #E74C3C", borderRadius: 3, cursor: "pointer", fontSize: 10 }}>reintentar</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── GLOSSARY DATA ─────────────────────────────────────────────────────────────
const GLOSSARY = {
  "ADLC": {
    short: "Agentic Development Lifecycle",
    def: "Marco de trabajo diseñado para construir y operar sistemas donde los agentes de IA son el núcleo del comportamiento. A diferencia del SDLC tradicional, el ADLC asume comportamiento probabilístico, iteración continua y governance embebida en cada etapa.",
    related: ["SDLC","Agente","ProjectState","Tier","HITL"],
    category: "marco",
  },
  "SDLC": {
    short: "Software Development Lifecycle",
    def: "Ciclo de vida tradicional de desarrollo de software: Planificación → Diseño → Desarrollo → Testing → Despliegue → Mantenimiento. Asume que el comportamiento del sistema queda completamente especificado en tiempo de construcción y validado antes del release.",
    related: ["ADLC"],
    category: "marco",
  },
  "Agente": {
    short: "AI Agent",
    def: "Sistema de software que razona, planifica y ejecuta acciones de forma autónoma para alcanzar un objetivo. A diferencia del software tradicional que sigue instrucciones fijas, un agente decide dinámicamente cómo actuar según el contexto y las herramientas disponibles.",
    related: ["Orquestador","HITL","Tier","Goal drift","ProjectState"],
    category: "concepto",
  },
  "Evals": {
    short: "Evaluaciones conductuales",
    def: "Suite de pruebas que validan el comportamiento de un agente sobre distribuciones de inputs reales, incluyendo casos extremos y prompts adversariales. A diferencia de los unit tests (que verifican que el código devuelve el valor correcto), los evals verifican que el agente se comporta apropiadamente ante situaciones del mundo real.",
    related: ["Eval pass rate","Goal drift","Agent Development Flywheel","HITL"],
    category: "técnico",
  },
  "Eval pass rate": {
    short: "Tasa de evals aprobadas",
    def: "Porcentaje de casos de la eval suite que el agente supera correctamente. El mínimo para despliegue es 0.85 (85%). Los evals de seguridad y compliance deben pasar al 100% — un solo fallo crítico bloquea el despliegue.",
    related: ["Evals","HITL","Acceptance rate"],
    category: "métrica",
  },
  "Goal drift": {
    short: "Deriva del objetivo",
    def: "Fenómeno donde un agente en producción comienza a optimizar hacia un objetivo diferente al que fue diseñado. Se mide calculando la distancia coseno entre los embeddings del intent original y muestras del comportamiento observado. Un score de 0 indica sin deriva; sobre 0.30 dispara una escalada; sobre 0.40 activa rollback automático.",
    related: ["Goal drift score","Embeddings","SRE Agent","Evals","Intent spec"],
    category: "riesgo",
  },
  "Goal drift score": {
    short: "Puntuación de deriva del objetivo",
    def: "Número entre 0 y 1 que mide cuánto se ha desviado el comportamiento del agente respecto al intent original. Calculado con text-embedding-3-large comparando embeddings del intent spec original vs muestras de comportamiento en producción. Umbral de warning: 0.30. Umbral de auto-rollback: 0.40.",
    related: ["Goal drift","Embeddings","Acceptance rate","Supervision burden"],
    category: "métrica",
  },
  "HITL": {
    short: "Human-in-the-Loop",
    def: "Patrón de governance donde el agente solicita aprobación humana antes de ejecutar una acción. En el ADLC hay dos variantes: HITL puro (el agente bloquea y espera), y HOTL — Human-on-the-Loop (el agente actúa y el humano supervisa con capacidad de override). El tier del agente determina cuál aplica.",
    related: ["Tier","HOTL","Audit trail","ProjectState"],
    category: "governance",
  },
  "HOTL": {
    short: "Human-on-the-Loop",
    def: "Variante del HITL donde el agente ejecuta la acción y el humano supervisa con capacidad de override posterior. Aplica a agentes Tier 2. El humano tiene una ventana de 4 horas para intervenir; si no hay respuesta, la acción se auto-confirma.",
    related: ["HITL","Tier","Supervision burden"],
    category: "governance",
  },
  "Tier": {
    short: "Nivel de control de governance",
    def: "Clasificación que determina cuánto control de governance aplica a un agente específico. No es propiedad de la fase sino del agente individual. Tier 1: solo logging automático. Tier 2: revisión humana con ventana de 4h. Tier 3: bloqueo completo hasta aprobación explícita. En fintech, toda acción sobre datos de clientes es Tier 3.",
    related: ["HITL","Audit trail","Forbidden zones","Compliance"],
    category: "governance",
  },
  "ProjectState": {
    short: "Estado del proyecto",
    def: "El único objeto que fluye entre todos los agentes del ADLC. Contiene el estado completo del sistema en cada momento: tareas, resultados por agente, checkpoints HITL, audit trail, métricas de comportamiento y context budget. Nunca se muta directamente — cada agente recibe una copia, la modifica, y retorna la copia actualizada.",
    related: ["Agente","Audit trail","Context budget","Orquestador"],
    category: "técnico",
  },
  "Orquestador": {
    short: "Agente orquestador central",
    def: "El agente que coordina a todos los demás usando LLM-driven routing. Es el único que usa Claude Opus 4 (todos los demás usan Sonnet). No ejecuta tareas — decide qué agente activar en cada momento según el ProjectState. Gestiona el context budget y activa el protocolo de escalada ante errores en cascada.",
    related: ["ADLC","Agente","ProjectState","LLM-driven routing","Circuit breaker"],
    category: "técnico",
  },
  "LLM-driven routing": {
    short: "Enrutamiento conducido por LLM",
    def: "Patrón donde el orquestador usa un modelo de lenguaje (Opus 4) para decidir dinámicamente qué agente activar a continuación, en lugar de seguir un grafo de flujo fijo. El LLM evalúa el estado actual del proyecto y elige la acción más apropiada.",
    related: ["Orquestador","ProjectState","LangGraph"],
    category: "técnico",
  },
  "Capability Matrix": {
    short: "Matriz de capacidades",
    def: "Tabla que separa explícitamente qué decisiones quedan bajo el LLM (razonamiento no determinístico) y cuáles deben ser lógica determinista (código fijo). En fintech es una decisión regulatoria: los cálculos financieros siempre son deterministas, nunca delegados al LLM. Producida por el Intent Agent en Fase 1.",
    related: ["Intent spec","Agente","Compliance","LLM-driven routing"],
    category: "técnico",
  },
  "Intent spec": {
    short: "Especificación de intención",
    def: "Documento versionado (con hash) que describe qué debe hacer el sistema, por qué, y bajo qué restricciones — antes de que se escriba una línea de código. Es el artefacto central del Spec-Driven Development. Si el intent spec cambia sin aprobación, el pipeline de CI/CD lo detecta y bloquea.",
    related: ["Spec-Driven Development","Capability Matrix","Goal drift"],
    category: "técnico",
  },
  "Spec-Driven Development": {
    short: "Desarrollo guiado por especificación",
    def: "Metodología donde las especificaciones son ciudadanos de primera clase del proceso de desarrollo — versionadas, hasheadas, y ejecutables. Los agentes son guiados por specs, no por instrucciones ad-hoc. La analogía es 'control de versiones para el pensamiento'.",
    related: ["Intent spec","Capability Matrix","ADLC"],
    category: "técnico",
  },
  "Audit trail": {
    short: "Registro de auditoría",
    def: "Log inmutable de cada acción ejecutada por cada agente, con timestamp, hash del estado antes y después, tier, y si hubo intervención humana. En el ADLC es append-only — nunca se puede modificar ni eliminar una entrada. En contexto fintech, retención mínima de 365 días según CMF Chile.",
    related: ["HITL","Tier","Compliance","ProjectState"],
    category: "governance",
  },
  "Acceptance rate": {
    short: "Tasa de aceptación",
    def: "KPI del PMO que mide el porcentaje de acciones propuestas por el agente que son aceptadas sin modificación. Target: > 0.80. Por debajo de 0.65 indica que el agente necesita tuning. Por debajo de 0.50 significa que el overhead de revisar su output supera el beneficio — el agente no está agregando valor neto.",
    related: ["Supervision burden","Evals","Goal drift score"],
    category: "métrica",
  },
  "Supervision burden": {
    short: "Carga de supervisión",
    def: "KPI del PMO que mide las horas-humano de supervisión requeridas por semana para operar el agente. Target: < 4h/semana. Si supera 8h/semana, la automatización no está siendo eficiente. La tendencia esperada es que disminuya con el tiempo gracias al Agent Development Flywheel.",
    related: ["Acceptance rate","Agent Development Flywheel","HITL","PMO"],
    category: "métrica",
  },
  "Agent Development Flywheel": {
    short: "Volante de mejora continua",
    def: "Ciclo continuo donde los incidentes de producción se convierten en nuevos evals, que se usan para mejorar los prompts de los agentes, que son desplegados y generan nuevos datos de comportamiento. El sistema mejora activamente con el tiempo en lugar de degradarse. Operado por el Learning Agent en Fase 5.",
    related: ["Evals","Goal drift","Supervision burden","Learning Agent"],
    category: "concepto",
  },
  "Circuit breaker": {
    short: "Interruptor automático de errores",
    def: "Patrón de resiliencia que monitorea los fallos de un agente y, si supera el umbral (3 fallos consecutivos por defecto), abre el circuito y bloquea nuevas ejecuciones de ese agente. Al abrirse, registra una entrada en el audit trail y escala automáticamente al nivel de autoridad correspondiente al tier del agente.",
    related: ["Orquestador","Agente","Audit trail","Escalada"],
    category: "técnico",
  },
  "Escalada": {
    short: "Protocolo de escalada",
    def: "Proceso automático que se activa cuando un agente detecta una condición crítica (drift excesivo, error en cascada, violación de política). El sistema notifica al nivel de autoridad correspondiente: Tier 1 → Tech Lead, Tier 2 → Engineering Manager, Tier 3 → CTO o Compliance Officer.",
    related: ["Circuit breaker","Tier","HITL","Audit trail"],
    category: "governance",
  },
  "Forbidden zones": {
    short: "Zonas prohibidas",
    def: "Acciones que ningún agente puede ejecutar bajo ninguna circunstancia sin aprobación explícita, independientemente del tier. En fintech típicamente incluyen: decisión de riesgo crediticio, apertura de cuentas, modificación de límites transaccionales. Definidas en el Human-Agent Responsibility Map durante Fase 0.",
    related: ["Tier","HITL","Compliance","Responsibility map"],
    category: "governance",
  },
  "Responsibility map": {
    short: "Mapa de responsabilidad humano-agente",
    def: "Artefacto producido por el Mapping Agent en Fase 0 que define para cada tipo de acción del sistema: si el agente puede ejecutarla directamente, si requiere aprobación humana, y quién tiene autoridad para aprobar. Es la base de todo el sistema de governance — si está mal, todos los tiers quedan construidos sobre supuestos incorrectos.",
    related: ["Forbidden zones","Tier","HITL","Compliance"],
    category: "governance",
  },
  "Embeddings": {
    short: "Representaciones vectoriales",
    def: "Representaciones numéricas de texto en un espacio vectorial de alta dimensión. En el ADLC se usan para dos propósitos: (1) calcular goal drift comparando el vector del intent original vs muestras de comportamiento, y (2) deduplicar alertas del SRE Agent comparando la similitud semántica de incidentes recientes.",
    related: ["Goal drift","Goal drift score","SRE Agent"],
    category: "técnico",
  },
  "Compliance": {
    short: "Cumplimiento regulatorio",
    def: "En el contexto del ADLC para fintech chileno, compliance se refiere a las obligaciones regulatorias de la CMF (Comisión para el Mercado Financiero). Implica que ciertos cálculos deben ser deterministas, ciertas acciones requieren dual control, el audit trail debe retenerse 365 días, y los datos de clientes requieren Tier 3.",
    related: ["Audit trail","Tier","Forbidden zones","Responsibility map"],
    category: "governance",
  },
  "LangGraph": {
    short: "Framework de orquestación de agentes",
    def: "Framework de Python desarrollado por LangChain para construir sistemas multi-agente como grafos de estado. En el ADLC es la capa de orquestación preferida: el ProjectState fluye como el estado del grafo, y los agentes son nodos que reciben y retornan ese estado.",
    related: ["Orquestador","ProjectState","LLM-driven routing"],
    category: "herramienta",
  },
  "LangSmith": {
    short: "Plataforma de trazabilidad de LLMs",
    def: "Herramienta de observabilidad para aplicaciones basadas en LLMs. En el ADLC, el decorator @traceable en el BaseAgent envía automáticamente cada llamada al LLM a LangSmith, incluyendo el input, el output, la latencia y el costo. Obligatorio en todos los agentes del sistema.",
    related: ["Agente","Orquestador","Audit trail"],
    category: "herramienta",
  },
  "Context budget": {
    short: "Presupuesto de contexto",
    def: "Número máximo de tokens disponibles para una ejecución del agente (por defecto 180,000 tokens). El BaseAgent monitorea el consumo y emite una advertencia al llegar al 90% del límite. Si se agota, el agente pausa la ejecución para evitar pérdida de contexto — uno de los errores más costosos en sistemas agénticos.",
    related: ["ProjectState","Agente","Orquestador"],
    category: "técnico",
  },
  "PMO": {
    short: "Project Management Office",
    def: "En el ADLC, el PMO transforma su rol de función de reporte a unidad de inteligencia estratégica. Sus tres responsabilidades nuevas son: (1) diseñar la Capability Matrix, (2) operar los checkpoints HITL, y (3) monitorear los KPIs de comportamiento. Su trabajo más valioso ocurre en Fase 0, antes de que exista una línea de código.",
    related: ["Acceptance rate","Supervision burden","Goal drift score","HITL","Capability Matrix"],
    category: "rol",
  },
  "SAST": {
    short: "Static Application Security Testing",
    def: "Análisis estático de código fuente para detectar vulnerabilidades de seguridad sin ejecutar el programa. En el ADLC lo ejecuta el Review Agent usando Bandit (para Python), como parte del pre-merge check. Una vulnerabilidad crítica genera una recomendación 'block' que escala automáticamente.",
    related: ["SCA","Review Agent","Audit trail"],
    category: "técnico",
  },
  "SCA": {
    short: "Software Composition Analysis",
    def: "Análisis de las dependencias de software para detectar vulnerabilidades conocidas (CVEs) y problemas de licencias. En el ADLC lo ejecuta el Review Agent usando pip-audit. También verifica que cada dependencia existe en PyPI (protección contra hallucinated dependencies — un riesgo específico del código generado por LLMs).",
    related: ["SAST","Review Agent","Hallucinated dependencies"],
    category: "técnico",
  },
  "Hallucinated dependencies": {
    short: "Dependencias alucinadas",
    def: "Paquetes de software que un LLM recomienda instalar pero que no existen en el registro oficial (PyPI). Aproximadamente el 20% de las recomendaciones de paquetes de LLMs pueden ser hallucinations. En el ADLC, el Coding Agent valida cada dependencia contra PyPI antes de instalarla, y el Review Agent corre SCA como segunda línea de defensa.",
    related: ["SCA","Agente","Compliance"],
    category: "riesgo",
  },
  "Rollout canary": {
    short: "Despliegue canario",
    def: "Estrategia de despliegue progresivo donde se expone el nuevo sistema a una fracción creciente del tráfico real antes de la producción completa: 5% (equipo interno) → 15% (piloto controlado) → 30% (canary) → 100%. En cada etapa se miden los KPIs de comportamiento y el sistema puede retroceder automáticamente si los indicadores se deterioran.",
    related: ["ADLC","Tier","Audit trail","SRE Agent"],
    category: "técnico",
  },
  "Policy-as-code": {
    short: "Políticas como código",
    def: "Enfoque donde las políticas de compliance y governance se expresan como código ejecutable (no como documentos PDF). En el ADLC, el Policy Agent verifica automáticamente en tiempo real que cada acción del sistema está autorizada según el Responsibility Map. Permite auditoría automática y enforcement sin intervención humana para cada acción.",
    related: ["Compliance","Audit trail","Tier","Responsibility map"],
    category: "técnico",
  },
  "Inner loop": {
    short: "Ciclo interno de desarrollo",
    def: "El ciclo más rápido del ADLC: Coding Agent genera código → Review Agent evalúa → Orquestador decide si continuar o iterar. Corresponde a la Fase 2. El objetivo es que este ciclo sea tan rápido como sea posible sin sacrificar calidad.",
    related: ["Outer loop","Agente","Orquestador"],
    category: "concepto",
  },
  "Outer loop": {
    short: "Ciclo externo de producción",
    def: "El ciclo de largo plazo del ADLC que ocurre en producción (Fase 5): el sistema está desplegado, el SRE Agent monitorea, el Learning Agent mejora los evals, y el Feedback Agent actualiza el Responsibility Map de Fase 0. El outer loop es lo que hace que el sistema mejore con el tiempo.",
    related: ["Inner loop","Agent Development Flywheel","SRE Agent"],
    category: "concepto",
  },
  "ADR": {
    short: "Architecture Decision Record",
    def: "Documento que registra una decisión arquitectónica importante: el contexto que llevó a la decisión, la decisión tomada, y las consecuencias esperadas. En el ADLC los ADRs son producidos por el Architecture Agent y son inmutables — si la decisión cambia, se crea un nuevo ADR que depreca el anterior.",
    related: ["Intent spec","Orquestador"],
    category: "técnico",
  },
};

const CATEGORIES = {
  marco:      { label: "Marco de trabajo",  color: "#534AB7" },
  concepto:   { label: "Concepto",          color: "#185FA5" },
  técnico:    { label: "Técnico",           color: "#1D9E75" },
  governance: { label: "Governance",        color: "#BA7517" },
  métrica:    { label: "Métrica",           color: "#993C1D" },
  riesgo:     { label: "Riesgo",            color: "#E24B4A" },
  herramienta:{ label: "Herramienta",       color: "#3B6D11" },
  rol:        { label: "Rol",               color: "#888780" },
};

// ─── THEME ─────────────────────────────────────────────────────────────────────
const THEMES = {
  light: { bg:"#F8F7F4", bgCard:"#FFFFFF", bgSubtle:"#F1EFE8", bgMuted:"#FAFAF8", border:"#E0DDD6", borderMid:"#D3D1C7", text:"#1C1B18", textSub:"#5F5E5A", textMuted:"#888780", textFaint:"#B4B2A9", headerBg:"#1C1B18", headerText:"#F1EFE8", consoleBg:"#1C1B18" },
  dark:  { bg:"#111110", bgCard:"#1C1B18", bgSubtle:"#2A2925", bgMuted:"#1A1918", border:"#333330", borderMid:"#444440", text:"#E8E6DF", textSub:"#A8A6A0", textMuted:"#666460", textFaint:"#444440", headerBg:"#0A0A09", headerText:"#E8E6DF", consoleBg:"#0A0A09" },
};

const C = {
  teal:{main:"#1D9E75",light:"#E1F5EE",dark:"#085041"},
  purple:{main:"#534AB7",light:"#EEEDFE",dark:"#26215C"},
  blue:{main:"#185FA5",light:"#E6F1FB",dark:"#042C53"},
  amber:{main:"#BA7517",light:"#FAEEDA",dark:"#412402"},
  coral:{main:"#993C1D",light:"#FAECE7",dark:"#4A1B0C"},
  green:{main:"#3B6D11",light:"#EAF3DE",dark:"#173404"},
  red:{main:"#E24B4A",light:"#FCEBEB",dark:"#501313"},
  gray:{main:"#888780",light:"#F1EFE8",dark:"#2C2C2A"},
};

const TIER_C={1:"#1D9E75",2:"#BA7517",3:"#E24B4A"};
const TIER_BG={1:"#E1F5EE",2:"#FAEEDA",3:"#FCEBEB"};
const TIER_L={1:"T1 — auto",2:"T2 — 4h",3:"T3 — block"};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── GLOSSARY TERM COMPONENT ────────────────────────────────────────────────────
// Wraps a word and shows a popover with definition + link to glossary
function Term({ word, label, onNavigate, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const entry = GLOSSARY[word];
  if (!entry) return <span>{label || word}</span>;
  const cat = CATEGORIES[entry.category];

  return (
    <span ref={ref} style={{ position: "relative", display: "inline" }}>
      <span
        onClick={() => setOpen(o => !o)}
        style={{
          borderBottom: `1px dashed ${cat.color}`,
          color: cat.color,
          cursor: "pointer",
          fontWeight: 600,
          transition: "opacity 0.15s",
        }}
      >{label || word}</span>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 998 }} />
          <div style={{
            position: "absolute", left: 0, top: "100%", marginTop: 6,
            zIndex: 999, width: 280, background: t.bgCard,
            border: `1px solid ${cat.color}`,
            borderRadius: 10, padding: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
            animation: "fadeIn 0.15s ease",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: cat.color }}>{word}</span>
              <span style={{ fontSize: 10, color: cat.color, background: `${cat.color}18`, padding: "2px 7px", borderRadius: 10, fontWeight: 700 }}>{cat.label}</span>
            </div>
            <div style={{ fontSize: 11, color: t.textSub, fontStyle: "italic", marginBottom: 6 }}>{entry.short}</div>
            <div style={{ fontSize: 12, color: t.text, lineHeight: 1.65, marginBottom: 10 }}>
              {entry.def.slice(0, 160)}{entry.def.length > 160 ? "…" : ""}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => { setOpen(false); onNavigate("glossary", word); }} style={{
                fontSize: 11, fontWeight: 700, color: "#fff", background: cat.color,
                border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit",
              }}>Ver en glosario →</button>
              {entry.related?.slice(0, 2).map(r => (
                <button key={r} onClick={() => { setOpen(false); onNavigate("glossary", r); }} style={{
                  fontSize: 10, color: t.textMuted, background: t.bgSubtle,
                  border: `1px solid ${t.border}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit",
                }}>{r}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// ─── GLOSSARY PAGE ────────────────────────────────────────────────────────────
function GlossaryPage({ t, dark, initialTerm }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(initialTerm || null);
  const detailRef = useRef();

  useEffect(() => {
    if (initialTerm) { setSelected(initialTerm); }
  }, [initialTerm]);

  useEffect(() => {
    if (selected && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selected]);

  const allTerms = Object.entries(GLOSSARY);
  const filtered = allTerms.filter(([word, entry]) => {
    const matchSearch = !search || word.toLowerCase().includes(search.toLowerCase()) || entry.def.toLowerCase().includes(search.toLowerCase()) || entry.short.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || entry.category === filter;
    return matchSearch && matchFilter;
  }).sort(([a], [b]) => a.localeCompare(b));

  const entry = selected ? GLOSSARY[selected] : null;
  const cat = entry ? CATEGORIES[entry.category] : null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", minHeight: "calc(100vh - 52px)", background: t.bg }}>
      {/* Left: term list */}
      <div style={{ background: t.bgSubtle, borderRight: `1px solid ${t.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Search + filter */}
        <div style={{ padding: "14px 12px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar término..."
            style={{
              width: "100%", padding: "7px 10px", borderRadius: 8, fontSize: 12,
              border: `1px solid ${t.border}`, background: t.bgCard, color: t.text,
              fontFamily: "inherit", outline: "none", marginBottom: 8,
            }}
          />
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <button onClick={() => setFilter("all")} style={{
              padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: filter === "all" ? 700 : 400,
              border: `1px solid ${filter === "all" ? t.text : t.border}`,
              background: filter === "all" ? t.text : "transparent", color: filter === "all" ? t.bgCard : t.textMuted,
              cursor: "pointer", fontFamily: "inherit",
            }}>Todos</button>
            {Object.entries(CATEGORIES).map(([key, cat]) => (
              <button key={key} onClick={() => setFilter(filter === key ? "all" : key)} style={{
                padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: filter === key ? 700 : 400,
                border: `1px solid ${filter === key ? cat.color : t.border}`,
                background: filter === key ? `${cat.color}22` : "transparent",
                color: filter === key ? cat.color : t.textMuted,
                cursor: "pointer", fontFamily: "inherit",
              }}>{cat.label}</button>
            ))}
          </div>
        </div>
        {/* Term list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px" }}>
          <div style={{ fontSize: 10, color: t.textFaint, padding: "0 4px 6px", letterSpacing: "0.06em" }}>
            {filtered.length} términos
          </div>
          {filtered.map(([word, entry]) => {
            const c = CATEGORIES[entry.category];
            return (
              <button key={word} onClick={() => setSelected(word)} style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "8px 10px", borderRadius: 8, border: "none",
                background: selected === word ? t.bgCard : "transparent",
                cursor: "pointer", fontFamily: "inherit", marginBottom: 2,
                boxShadow: selected === word ? `0 1px 4px rgba(0,0,0,0.08)` : "none",
                borderLeft: selected === word ? `3px solid ${c.color}` : "3px solid transparent",
                transition: "all 0.15s",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: selected === word ? 700 : 500, color: selected === word ? c.color : t.text }}>{word}</span>
                  <span style={{ fontSize: 9, color: c.color, background: `${c.color}18`, padding: "1px 5px", borderRadius: 8, fontWeight: 700, flexShrink: 0 }}>{c.label}</span>
                </div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.short}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: detail */}
      <div style={{ padding: 32, overflowY: "auto", maxHeight: "calc(100vh - 52px)" }} ref={detailRef}>
        {entry ? (
          <div style={{ maxWidth: 680, animation: "fadeIn 0.25s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 11, color: cat.color, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4 }}>{cat.label.toUpperCase()}</div>
                <h1 style={{ fontSize: 28, fontWeight: 700, color: t.text, margin: 0, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.01em" }}>{selected}</h1>
              </div>
              <span style={{ fontSize: 12, color: cat.color, background: `${cat.color}18`, padding: "5px 12px", borderRadius: 20, fontWeight: 700, marginTop: 4, flexShrink: 0, border: `1px solid ${cat.color}30` }}>{entry.short}</span>
            </div>

            <div style={{ height: 2, background: `linear-gradient(to right, ${cat.color}, transparent)`, marginBottom: 20, borderRadius: 1 }} />

            <div style={{ fontSize: 15, color: t.textSub, lineHeight: 1.85, marginBottom: 24, padding: "16px 18px", background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10 }}>
              {entry.def}
            </div>

            {entry.related && entry.related.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 10 }}>TÉRMINOS RELACIONADOS</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {entry.related.map(r => {
                    const re = GLOSSARY[r];
                    const rc = re ? CATEGORIES[re.category] : null;
                    return (
                      <button key={r} onClick={() => setSelected(r)} style={{
                        padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                        border: `1px solid ${rc ? rc.color : t.border}40`,
                        background: rc ? `${rc.color}14` : t.bgSubtle,
                        color: rc ? rc.color : t.textSub,
                        cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                      }}>{r}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Usage in context */}
            <div style={{ background: t.bgSubtle, borderRadius: 10, padding: "14px 16px", border: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 8 }}>DÓNDE APARECE EN EL ADLC</div>
              <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.7 }}>
                {entry.category === "marco" && "Estructura general del sistema. Referenciado en CLAUDE.md como fuente de verdad del proyecto."}
                {entry.category === "técnico" && "Componente de implementación. Detallado en el CLAUDE.md bajo la sección de arquitectura y en los notebooks didácticos."}
                {entry.category === "governance" && "Parte del framework de governance. Implementado en /governance/ y visible en el audit trail del Dashboard Demo."}
                {entry.category === "métrica" && "KPI monitoreado por el PMO. Visible en tiempo real en el panel derecho del Dashboard Demo durante la ejecución."}
                {entry.category === "riesgo" && "Riesgo documentado en el Risk Framework. Mitigado por controles específicos en los agentes relevantes."}
                {entry.category === "herramienta" && "Herramienta del stack tecnológico. Especificada en la Capa 1-2 del diagrama de stack del ADLC."}
                {entry.category === "concepto" && "Concepto fundacional del ADLC. Explicado en la sección 'Aprender' de esta aplicación."}
                {entry.category === "rol" && "Rol organizacional. Su transformación en el ADLC se detalla en la sección PMO de la página Aprender."}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "70%", textAlign: "center" }}>
            <div style={{ fontSize: 36, opacity: 0.15, marginBottom: 16, color: t.text }}>◎</div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, color: t.textSub, marginBottom: 8 }}>Selecciona un término</div>
            <div style={{ fontSize: 12, color: t.textMuted, maxWidth: 320, lineHeight: 1.7 }}>
              El glosario contiene {allTerms.length} términos especializados del ADLC. Busca por nombre o filtra por categoría. Los términos subrayados en la app abren un popover rápido con definición.
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", maxWidth: 400 }}>
              {["Evals", "Goal drift", "HITL", "Capability Matrix", "Audit trail", "Agent Development Flywheel"].map(t2 => (
                <button key={t2} onClick={() => setSelected(t2)} style={{
                  padding: "5px 12px", borderRadius: 10, fontSize: 11, fontWeight: 600,
                  border: `1px solid ${CATEGORIES[GLOSSARY[t2].category].color}40`,
                  background: `${CATEGORIES[GLOSSARY[t2].category].color}14`,
                  color: CATEGORIES[GLOSSARY[t2].category].color,
                  cursor: "pointer", fontFamily: "inherit",
                }}>{t2}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── LEARN PAGE ────────────────────────────────────────────────────────────────
const PHASES_DATA = [
  { id:0,name:"Fase 0",subtitle:"Descubrimiento",color:C.teal,tier:"T1+T2",
    why:"El problema más caro del software agéntico es automatizar lo equivocado. Esta fase obliga a entender primero — ningún agente diseña ni codifica hasta que esta fase esté aprobada.",
    what:"Analiza pain points reales con evidencia existente (tickets, logs, grabaciones), evalúa data readiness, y define en el mapa de responsabilidad qué puede decidir un agente sin consultar a nadie.",
    produces:["pain_points_report.json","hypotheses.json","responsibility_map.json","constraint_map.json"],
    agents:["Discovery Agent","Hypothesis Agent","Mapping Agent"],
    agentDetails:[
      { name:"Discovery Agent", tier:1, tierLabel:"T1 — auto", desc:"Solo observa. Analiza tickets, logs de sistemas y documentación existente para construir un mapa de pain points con severidad y automation_potential. No propone soluciones ni arquitectura.", output:"pain_points_report.json", outputDesc:"3+ pain points con severidad, frecuencia y automation_potential (0-1)", hitl:false },
      { name:"Hypothesis Agent", tier:1, tierLabel:"T1 — auto", desc:"Convierte los pain points en hipótesis comprobables priorizadas por impacto × factibilidad / riesgo. Define las señales tempranas de drift que indicarían que la automatización está fallando.", output:"hypotheses.json", outputDesc:"Hipótesis rankeadas con criterios de éxito y señales de deriva", hitl:false },
      { name:"Mapping Agent", tier:2, tierLabel:"T2 — HITL", desc:"El único agente de Fase 0 con revisión humana. Produce el mapa de responsabilidad humano-agente: qué puede ejecutar el sistema solo, qué requiere aprobación, y cuáles son las forbidden zones absolutas.", output:"responsibility_map.json", outputDesc:"Responsibility matrix + forbidden zones + escalation authority", hitl:true },
    ]
  },
  { id:1,name:"Fase 1",subtitle:"Diseño",color:C.purple,tier:"T2",
    why:"Sin diseño explícito, el LLM toma decisiones financieras que deberían ser código determinista. La Capability Matrix previene ese riesgo regulatorio antes de escribir código.",
    what:"Escribe la spec de intent versionada con hash, construye la Capability Matrix (LLM vs determinista), define la arquitectura de agentes y el business case con criterios go/no-go.",
    produces:["intent_spec.md","capability_matrix.json","architecture_decision.json","business_case.json"],
    agents:["Intent Agent","Architecture Agent","Business Agent"],
    agentDetails:[
      { name:"Intent Agent", tier:2, tierLabel:"T2 — HITL", desc:"Spec-Driven Development: escribe el intent antes de cualquier código. Construye la Capability Matrix — la tabla que separa qué decisiones toma el LLM y cuáles son lógica determinista. En fintech: los cálculos financieros siempre son deterministas.", output:"intent_spec.md + capability_matrix.json", outputDesc:"Spec versionada con hash v1.0.0 + tabla LLM/determinista por dominio", hitl:true },
      { name:"Architecture Agent", tier:2, tierLabel:"T2 — HITL", desc:"Selecciona el patrón de agente (ReAct, Plan-Execute, híbrido) basado en la spec. Documenta ADRs con contexto, decisión y consecuencias. Produce el grafo de agentes: quién llama a quién y bajo qué condiciones.", output:"architecture_decision.json", outputDesc:"Patrón seleccionado + ADR-001 + grafo de agentes con entrypoint y exit conditions", hitl:true },
      { name:"Business Agent", tier:2, tierLabel:"T2 — HITL", desc:"Traduce la arquitectura a términos de negocio. Calcula ROI esperado, define el budget operacional máximo y establece los criterios go/no-go que el sistema verificará automáticamente antes de cada deploy.", output:"business_case.json", outputDesc:"ROI, budget máximo, criterios go/no-go: eval_pass_rate ≥ 0.85, supervision_burden < 4h", hitl:true },
    ]
  },
  { id:2,name:"Fase 2",subtitle:"Desarrollo",color:C.blue,tier:"T2",
    why:"El código generado por LLMs puede incluir dependencias que no existen — el 20% de las recomendaciones de paquetes pueden ser alucinaciones. El inner loop captura eso antes del merge.",
    what:"El orquestador (Opus 4) coordina el ciclo coding → review con LLM-driven routing. El Coding Agent valida cada dependencia en PyPI antes de instalarla. El Review Agent hace SAST + SCA automático.",
    produces:["source_code/","review_report.json","routing_decisions.json"],
    agents:["Orquestador Central","Coding Agent","Review Agent"],
    agentDetails:[
      { name:"Orquestador Central", tier:2, tierLabel:"T2 — routing", desc:"El único agente que usa Claude Opus 4. No ejecuta tareas — decide qué agente activar en cada momento usando LLM-driven routing. Lee el ProjectState completo y decide el siguiente paso. Gestiona el context budget y activa el protocolo de escalada ante errores.", output:"routing_decisions.json", outputDesc:"Log de decisiones de routing con justificación por cada transición", hitl:false },
      { name:"Coding Agent", tier:2, tierLabel:"T2 — HITL", desc:"Genera código según la spec aprobada. Antes de usar cualquier librería, verifica que existe en PyPI (anti-hallucinated dependencies). Genera tests junto con el código. Sus cambios van a una rama — no puede escribir directamente a producción (least privilege).", output:"source_code/", outputDesc:"Código generado + tests unitarios + listado de dependencias validadas en PyPI", hitl:false },
      { name:"Review Agent", tier:2, tierLabel:"T2 — HITL", desc:"SAST con Bandit, SCA con pip-audit, y verificación de la Capability Matrix. Tiene permisos de solo lectura — no puede escribir ni desplegar. Si detecta una violación crítica o una dependencia alucinada, bloquea y escala automáticamente.", output:"review_report.json", outputDesc:"overall_score + security_issues + capability_matrix_violations + merge_recommendation", hitl:true },
    ]
  },
  { id:3,name:"Fase 3",subtitle:"Validación",color:C.amber,tier:"T2+T3",
    why:"Un unit test verifica que el código devuelve el valor correcto. Un eval conductual verifica que el agente se comporta bien ante situaciones reales y adversariales. Son fundamentalmente distintos.",
    what:"Evals conductuales sobre distribuciones de inputs reales. Medición de goal drift con embeddings comparando el intent original vs comportamiento observado. HITL gate Tier 3 bloquea el paso a producción.",
    produces:["eval_results.json","validation_report.json","deploy_approval.json"],
    agents:["Testing Agent","Validation Agent","HITL Gate"],
    agentDetails:[
      { name:"Testing Agent", tier:2, tierLabel:"T2 — auto", desc:"Genera y ejecuta evals conductuales — no unit tests convencionales. Valida el agente ante inputs reales, casos extremos y prompts adversariales. Calcula el eval_pass_rate. Si los evals de seguridad o compliance fallan al 100%, bloquea automáticamente.", output:"eval_results.json", outputDesc:"eval_pass_rate + breakdown por categoría (behavioral, security, compliance) + casos fallidos", hitl:false },
      { name:"Validation Agent", tier:2, tierLabel:"T2 — auto", desc:"Calcula el goal_drift_score comparando embeddings del intent_spec original vs muestras de comportamiento observado en staging. Si drift > 0.30 escala automáticamente. También corre regression testing contra el baseline anterior.", output:"validation_report.json", outputDesc:"goal_drift_score (0-1) + staging E2E results + regression baseline comparison", hitl:false },
      { name:"HITL Gate", tier:3, tierLabel:"T3 — BLOQUEO", desc:"La puerta de producción. Verifica 3 condiciones simultáneas: eval_pass_rate ≥ umbral acordado, cero evals críticos fallidos, y acceptance_rate ≥ 0.70 en piloto. Si cualquiera falla, el sistema NO avanza. Requiere aprobación explícita del PMO.", output:"deploy_approval.json", outputDesc:"3 checks con valores reales + aprobación firmada con timestamp — evidencia regulatoria permanente", hitl:true },
    ]
  },
  { id:4,name:"Fase 4",subtitle:"Despliegue",color:C.coral,tier:"T3",
    why:"Un rollback de código no revierte el mundo real. Si el agente ya procesó transacciones, envió emails o modificó registros, el daño ocurrió aunque hagas git revert.",
    what:"Zona Tier 3 completa — todo bloquea hasta aprobación explícita. Rollout progresivo 5→15→30→100%. Cada acción firmada en audit trail con retención de 365 días (CMF Chile).",
    produces:["deploy_manifest.json","rollout_log.json","compliance_log.json"],
    agents:["CI/CD Agent","Rollout Agent","Policy Agent"],
    agentDetails:[
      { name:"CI/CD Agent", tier:3, tierLabel:"T3 — BLOQUEO", desc:"Ejecuta un pre-deploy checklist de 6 ítems no omitibles: todos los HITL checkpoints anteriores aprobados, eval_pass_rate sobre umbral, sin vulnerabilidades críticas, intent_spec sin cambios desde la aprobación. Solo si todo pasa construye el artifact firmado con hash.", output:"deploy_manifest.json", outputDesc:"Artifact firmado + hash SHA-256 + pre_deploy_checks: all_passed + evidencia para audit", hitl:false },
      { name:"Rollout Agent", tier:3, tierLabel:"T3 — BLOQUEO", desc:"Gestiona exposición gradual: 5% (equipo interno) → 15% (piloto) → 30% (canary) → 100%. En cada etapa mide KPIs de comportamiento. Si los indicadores se deterioran retrocede automáticamente sin esperar instrucción humana.", output:"rollout_log.json", outputDesc:"4 etapas con métricas reales, timestamps y decisión (avanzar/retroceder) en cada etapa", hitl:false },
      { name:"Policy Agent", tier:3, tierLabel:"T3 — BLOQUEO", desc:"Policy-as-code: verifica en tiempo real que cada acción está autorizada según el responsibility_map de Fase 0. Genera el audit trail inmutable con retención regulatoria. Si detecta una violación de política, bloquea y escala — no registra y continúa.", output:"compliance_log.json", outputDesc:"Log de verificaciones + audit trail completo + certificado de retención 365 días CMF", hitl:false },
    ]
  },
  { id:5,name:"Fase 5",subtitle:"Monitoreo",color:C.green,tier:"T2",
    why:"Los agentes en producción se desvían con el tiempo de formas sutiles y silenciosas. Sin monitoreo activo del comportamiento, el drift se vuelve invisible hasta que es un incidente.",
    what:"SRE Agent monitorea en polling (60s) y modo reactivo (webhooks). Learning Agent convierte incidentes en nuevos evals. Feedback Agent cierra el loop actualizando el constraint_map de Fase 0.",
    produces:["sre_report.json","eval_updates.json","pmo_report.json"],
    agents:["SRE Agent","Learning Agent","Feedback Agent"],
    agentDetails:[
      { name:"SRE Agent", tier:2, tierLabel:"T2 — auto", desc:"Opera en dos modos: polling cada 60s para degradación gradual, y reactivo via webhooks de Sentry/Prometheus para eventos críticos. Usa embeddings (voyage-code-2) para deduplicar alertas similares. Auto-rollback si goal_drift > 0.4 o error_rate_critical > 5%.", output:"sre_report.json", outputDesc:"Métricas de comportamiento en tiempo real + incidentes deduplicados + decisiones de rollback", hitl:false },
      { name:"Learning Agent", tier:2, tierLabel:"T2 — auto", desc:"El motor del Agent Development Flywheel. Analiza incidentes de producción, identifica patrones de comportamiento problemático, y genera nuevos evals para capturar esos escenarios. Propone ajustes a prompts con evidencia de comportamiento real.", output:"eval_updates.json", outputDesc:"Nuevos casos de eval generados + propuestas de ajuste a prompts + evidencia por caso", hitl:false },
      { name:"Feedback Agent", tier:2, tierLabel:"T2 — auto", desc:"Cierra el loop completo del ADLC. Convierte los aprendizajes de producción en actualizaciones del constraint_map y responsibility_map de Fase 0. Genera el reporte del PMO con tendencias de evolución del sistema.", output:"pmo_report.json", outputDesc:"PMO report: acceptance_rate, supervision_burden trend, goal_drift history + constraint_map updates", hitl:false },
    ]
  },
];

const REFERENCES = [
  {
    category: "Estructura de fases del ADLC",
    color: C.teal,
    items: [
      { authors: "EPAM Systems", year: "2026", title: "Introducing agentic development lifecycle (ADLC): Building and operating AI agents in production", url: "https://www.epam.com/insights/ai/blogs/agentic-development-lifecycle-explained", type: "Blog técnico" },
      { authors: "Arthur AI", year: "2025", title: "Introducing the agent development lifecycle (ADLC): Rethinking of the venerable SDLC for AI agents", url: "https://www.arthur.ai/blog/introducing-adlc", type: "Blog técnico" },
      { authors: "Salesforce", year: "s.f.", title: "The agent development lifecycle: From conception to production", url: "https://architect.salesforce.com/docs/architect/fundamentals/guide/agent-development-lifecycle", type: "Documentación oficial" },
      { authors: "Han Research", year: "2026", title: "AI-driven development lifecycle 2026 (AI-DLC 2026)", url: "https://han.guru/papers/ai-dlc-2026/", type: "Paper de investigación" },
      { authors: "Codebridge", year: "2026", title: "Agentic AI software development lifecycle: Secure ADLC playbook", url: "https://www.codebridge.tech/articles/agentic-ai-software-development-lifecycle-the-production-ready-playbook", type: "Playbook técnico" },
    ],
  },
  {
    category: "Framework de governance (3 Tiers)",
    color: C.amber,
    items: [
      { authors: "Infocomm Media Development Authority (IMDA)", year: "2026, enero 22", title: "Model AI Governance Framework for Agentic AI (Versión 1.0)", url: "https://www.imda.gov.sg/-/media/imda/files/about/emerging-tech-and-research/artificial-intelligence/mgf-for-agentic-ai.pdf", type: "Framework regulatorio — Gobierno de Singapur", highlight: true },
      { authors: "MintMCP", year: "2026, febrero 4", title: "Agentic AI governance framework: The 3-tiered approach for 2026", url: "https://www.mintmcp.com/blog/agentic-ai-goverance-framework", type: "Blog técnico" },
      { authors: "Microsoft Power Platform", year: "2026, abril 1", title: "Building trustworthy AI: A practical framework for adaptive governance", url: "https://www.microsoft.com/en-us/power-platform/blog/2026/04/01/building-trustworthy-ai-a-practical-framework-for-adaptive-governance/", type: "Blog oficial Microsoft" },
    ],
  },
  {
    category: "Gobernanza enterprise y rol del PMO",
    color: C.purple,
    items: [
      { authors: "Deloitte AI Institute", year: "2026", title: "The state of AI in the enterprise 2026", url: "https://www.deloitte.com/cz-sk/en/issues/generative-ai/state-of-ai-in-enterprise.html", type: "Reporte de industria" },
      { authors: "Arion Research", year: "2025, agosto 16", title: "Principles of agentic AI governance in 2025: Key frameworks and why they matter now", url: "https://www.arionresearch.com/blog/g9jiv24e3058xsivw6dig7h6py7wml", type: "Blog de investigación" },
      { authors: "Lexology", year: "2026, enero 19", title: "AI governance in 2026: From experimentation to maturity", url: "https://www.lexology.com/library/detail.aspx?g=3f9471f4-090e-4c86-8065-85cd35c40b35", type: "Análisis legal" },
    ],
  },
  {
    category: "Spec-Driven Development y CI/CD agéntico",
    color: C.blue,
    items: [
      { authors: "Microsoft Community Hub", year: "2026, febrero 5", title: "An AI-led SDLC: Building an end-to-end agentic software development lifecycle with Azure and GitHub", url: "https://techcommunity.microsoft.com/blog/appsonazureblog/an-ai-led-sdlc-building-an-end-to-end-agentic-software-development-lifecycle-wit/4491896", type: "Blog oficial Microsoft" },
      { authors: "GitLab & TCS", year: "2026, febrero 24", title: "Agentic SDLC: GitLab and TCS deliver intelligent orchestration across the enterprise", url: "https://about.gitlab.com/blog/agentic-sdlc-gitlab-and-tcs-deliver-intelligent-orchestration-across-the-enterprise/", type: "Blog oficial GitLab" },
      { authors: "Ran the Builder", year: "2026, febrero 3", title: "AI-driven SDLC: Build secure, scalable software with AI", url: "https://ranthebuilder.cloud/blog/ai-driven-sdlc/", type: "Blog técnico" },
    ],
  },
  {
    category: "Seguridad y riesgos en ADLC",
    color: C.red,
    items: [
      { authors: "Cycode", year: "2026, marzo 19", title: "Securing the agentic development lifecycle (ADLC)", url: "https://cycode.com/blog/securing-adlc/", type: "Blog de seguridad" },
      { authors: "Futurum Group", year: "2025, octubre 14", title: "Agentic AI expansion across SDLC: Building trust in AI", url: "https://futurumgroup.com/press-release/agentic-ai-expansion-across-sdlc-building-trust-in-ai/", type: "Reporte de analistas" },
    ],
  },
  {
    category: "Tendencias de mercado",
    color: C.green,
    items: [
      { authors: "Bay Tech Consulting", year: "s.f.", title: "Agentic SDLC: The AI-powered blueprint transforming software development", url: "https://www.baytechconsulting.com/blog/agentic-sdlc-ai-software-blueprint", type: "Blog de consultoría" },
      { authors: "Machine Learning Mastery", year: "2026, enero 5", title: "7 agentic AI trends to watch in 2026", url: "https://machinelearningmastery.com/7-agentic-ai-trends-to-watch-in-2026/", type: "Blog técnico" },
    ],
  },
];

const SDLC_ROWS = [
  {dim:"Especificación",sdlc:"Requisitos funcionales deterministas",adlc:"Intent + guardrails + Capability Matrix",exp:"En SDLC, los requisitos capturan todo el comportamiento esperado de antemano. En ADLC, el agente recibe un intent y restricciones — el 'cómo' lo decide el agente en tiempo de ejecución."},
  {dim:"Comportamiento",sdlc:"Predecible y estático",adlc:"Probabilístico, evoluciona con el tiempo",exp:"Dado el mismo input, el SDLC siempre produce el mismo output. El comportamiento del ADLC depende del modelo, el contexto, las herramientas disponibles y el historial."},
  {dim:"QA",sdlc:"Tests unitarios e integración",adlc:"Evals conductuales + behavioral testing",exp:"Un unit test verifica que una función devuelve el valor correcto. Un eval conductual verifica que el agente se comporta apropiadamente ante distribuciones de inputs reales, incluyendo casos adversariales."},
  {dim:"Handoffs",sdlc:"Documentos entre equipos",adlc:"ProjectState fluyendo entre agentes",exp:"En SDLC, un handoff implica crear documentos que otra persona lee. En ADLC, el ProjectState es el único objeto que viaja entre agentes — si no está en el estado, se perdió."},
  {dim:"Governance",sdlc:"Proceso paralelo de revisión",adlc:"Embebida en cada agente (Tier 1/2/3)",exp:"En SDLC, hay un equipo de QA y un proceso de revisión externo. En ADLC, cada agente tiene su tier de governance integrado — el policy agent verifica compliance en tiempo real."},
  {dim:"KPIs",sdlc:"Velocity, cobertura, bugs",adlc:"Acceptance rate, goal drift, supervision burden",exp:"Velocity y cobertura miden si el código funciona. El acceptance rate mide si el agente está agregando valor neto. El supervision burden mide si la automatización realmente reduce trabajo humano."},
  {dim:"Feedback loop",sdlc:"Retrospectiva al final del sprint",adlc:"Fase 5 actualiza Fase 0 en tiempo real",exp:"En SDLC, el equipo aprende en la retro del sprint. En ADLC, el Feedback Agent convierte incidentes de producción en nuevos evals que mejoran el sistema antes de la próxima iteración."},
  {dim:"Rol del PMO",sdlc:"Reporta estado y gestiona riesgos",adlc:"Diseña las reglas del juego para los agentes",exp:"En SDLC, el PMO reporta el estado del proyecto. En ADLC, el PMO diseña la Capability Matrix, opera los checkpoints HITL, y monitorea los KPIs de comportamiento."},
];

const WHY_DATA = [
  {title:"La iteración ya no es cara",body:"En SDLC, las fases secuenciales existían porque iterar era costoso. Con IA, la iteración es casi gratuita. Lo que cuesta es perder contexto en los handoffs. El ADLC optimiza para preservar contexto, no para minimizar iteraciones."},
  {title:"Los agentes optimizan hacia metas",body:"El software tradicional ejecuta instrucciones fijas. Un agente optimiza hacia un objetivo, lo que significa que puede encontrar caminos que nadie programó — algunos útiles, algunos peligrosos. La governance tiene que estar dentro del sistema, no afuera."},
  {title:"El comportamiento no es determinístico",body:"No se puede escribir un unit test para verificar que un agente 'interpretó correctamente la intención del cliente'. Se necesitan evals conductuales que validen comportamiento sobre distribuciones de inputs, no sobre casos puntuales."},
  {title:"El rollback no revierte el mundo",body:"Hacer git revert en un agente no deshace los emails que ya envió, las cuentas que ya abrió, las transacciones que ya procesó. En fintech esto es crítico. El HITL Tier 3 existe para bloquear antes, no para remediar después."},
];

const TIER_INFO = [
  {tier:1,label:"Tier 1 — Universal",color:C.teal,desc:"Aplica a todos los agentes sin excepción. Logging automático, guardrails mínimos, audit trail de cada acción. El agente ejecuta sin esperar aprobación.",examples:["Discovery Agent","Hypothesis Agent"]},
  {tier:2,label:"Tier 2 — Proporcional",color:C.amber,desc:"Para agentes de impacto medio. El humano tiene 4 horas para revisar y hacer override. Si no hay respuesta, el sistema se auto-aprueba.",examples:["Coding Agent","Review Agent","Agentes de Fase 1"]},
  {tier:3,label:"Tier 3 — Compliance",color:C.red,desc:"Para agentes críticos y acciones financieras. Bloqueo total hasta aprobación explícita. Zero Trust + least privilege. Dual control para operaciones > $10,000 USD.",examples:["Toda la Fase 4","Acciones sobre datos de clientes"]},
];

function LearnPage({ t, dark, onNavigate }) {
  const [section, setSection] = useState("intro");
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [agentTab, setAgentTab] = useState(0);
  const [compareRow, setCompareRow] = useState(null);
  const [whyIdx, setWhyIdx] = useState(0);
  const [tierIdx, setTierIdx] = useState(0);
  const phase = PHASES_DATA[phaseIdx];
  const T = (word, label) => <Term word={word} label={label} onNavigate={onNavigate} t={t} />;

  const NAV = [
    {id:"intro",label:"¿Qué es el ADLC?"},
    {id:"compare",label:"SDLC vs ADLC"},
    {id:"why",label:"Por qué cambió"},
    {id:"flow",label:"El flujo completo"},
    {id:"tiers",label:"Tiers de governance"},
    {id:"pmo",label:"El nuevo PMO"},
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "196px 1fr", minHeight: "calc(100vh - 52px)", background: t.bg }}>
      <div style={{ background: t.bgSubtle, borderRight: `1px solid ${t.border}`, padding: "16px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.12em", marginBottom: 8, paddingLeft: 4 }}>CONTENIDO</div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => setSection(n.id)} style={{
            textAlign: "left", padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: section === n.id ? t.bgCard : "transparent",
            color: section === n.id ? t.text : t.textSub,
            fontWeight: section === n.id ? 700 : 400, fontSize: 12, fontFamily: "inherit",
            boxShadow: section === n.id ? `0 1px 6px rgba(0,0,0,0.07)` : "none",
            borderLeft: section === n.id ? `3px solid ${C.teal.main}` : "3px solid transparent",
            transition: "all 0.18s",
          }}>{n.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, color: t.textFaint, padding: "0 4px", lineHeight: 1.6 }}>
          Los términos <span style={{ borderBottom: `1px dashed ${C.teal.main}`, color: C.teal.main }}>subrayados</span> tienen definición en el glosario. Haz clic para ver.
        </div>
      </div>

      <div style={{ padding: 32, overflowY: "auto", maxHeight: "calc(100vh - 52px)" }}>

        {section === "intro" && (
          <div style={{ maxWidth: 700, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: C.teal.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>INTRODUCCIÓN</div>
            <h1 style={{ fontSize: 30, fontWeight: 700, color: t.text, margin: "0 0 16px", fontFamily: "'Space Grotesk',sans-serif", lineHeight: 1.2 }}>
              ¿Qué es el {T("ADLC")} y por qué importa?
            </h1>
            <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.85, marginBottom: 20 }}>
              El {T("ADLC")} es un marco diseñado para construir sistemas donde los {T("Agente","agentes")} de IA son el núcleo del comportamiento. No es un {T("SDLC")} con IA encima — es un ciclo construido desde cero para sistemas probabilísticos.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
              {[
                { label: "SDLC tradicional", desc: "Comportamiento determinista. Especificado en tiempo de construcción. Predecible.", col: C.gray, icon: "◻" },
                { label: "ADLC agéntico", desc: `Los ${GLOSSARY["Agente"].short} razonan, se adaptan y actúan. Comportamiento probabilístico.`, col: C.teal, icon: "◈" },
              ].map(item => (
                <div key={item.label} style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 12, padding: 18 }}>
                  <div style={{ fontSize: 22, marginBottom: 8, color: item.col.main }}>{item.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.text, marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.7 }}>{item.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 12, padding: 18, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: t.text, marginBottom: 12 }}>4 principios que cambian todo</div>
              {[
                ["Los agentes optimizan hacia metas", `Los ${GLOSSARY.Agente.short} no ejecutan instrucciones fijas. Encuentran caminos que nadie programó.`],
                ["El contexto es el costo dominante", `La iteración es gratuita. Perder contexto en handoffs es lo que cuesta — por eso existe el ${GLOSSARY.ProjectState.short}.`],
                ["Governance por diseño", `La seguridad y ${GLOSSARY.Compliance.short} deben estar dentro del flujo — los ${GLOSSARY.Tier.short}s lo implementan.`],
                ["Prompts como infraestructura", `Un prompt no versionado es deuda técnica. Esto conecta con el ${GLOSSARY["Spec-Driven Development"].short}.`],
              ].map(([t1, t2]) => (
                <div key={t1} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.teal.main, marginTop: 6, flexShrink: 0 }} />
                  <div><span style={{ fontSize: 12, fontWeight: 700, color: t.text }}>{t1} — </span><span style={{ fontSize: 12, color: t.textSub }}>{t2}</span></div>
                </div>
              ))}
            </div>
            <button onClick={() => setSection("compare")} style={{ padding: "10px 20px", borderRadius: 8, background: C.teal.main, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              Siguiente: SDLC vs ADLC →
            </button>
          </div>
        )}

        {section === "compare" && (
          <div style={{ maxWidth: 800, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: C.purple.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>COMPARACIÓN</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 8px", fontFamily: "'Space Grotesk',sans-serif" }}>{T("SDLC")} tradicional vs {T("ADLC")}</h1>
            <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.7, marginBottom: 20 }}>Haz clic en cualquier fila para ver la explicación de por qué esa dimensión cambió.</p>
            <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
              {["Dimensión", "SDLC tradicional", "ADLC agéntico"].map((h, i) => (
                <div key={h} style={{ flex: i === 0 ? 0.8 : 1, padding: "7px 12px", background: i === 2 ? `${C.teal.main}18` : t.bgSubtle, borderBottom: `2px solid ${i === 2 ? C.teal.main : t.borderMid}`, fontSize: 10, fontWeight: 700, color: i === 2 ? C.teal.main : t.textMuted, letterSpacing: "0.06em" }}>{h}</div>
              ))}
            </div>
            {SDLC_ROWS.map((row, i) => (
              <div key={row.dim}>
                <div onClick={() => setCompareRow(compareRow === i ? null : i)} style={{ display: "flex", cursor: "pointer", borderBottom: `1px solid ${t.border}`, background: compareRow === i ? t.bgCard : "transparent", transition: "background 0.15s" }}>
                  <div style={{ flex: 0.8, padding: "9px 12px", fontSize: 12, fontWeight: 600, color: t.text }}>{row.dim}</div>
                  <div style={{ flex: 1, padding: "9px 12px", fontSize: 12, color: t.textSub }}>{row.sdlc}</div>
                  <div style={{ flex: 1, padding: "9px 12px", fontSize: 12, color: C.teal.main, fontWeight: 500 }}>{row.adlc}</div>
                </div>
                {compareRow === i && (
                  <div style={{ padding: "10px 12px", background: t.bgCard, borderBottom: `1px solid ${t.border}`, animation: "fadeIn 0.2s ease" }}>
                    <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.75 }}>{row.exp}</div>
                  </div>
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button onClick={() => setSection("intro")} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>← Anterior</button>
              <button onClick={() => setSection("why")} style={{ padding: "8px 16px", borderRadius: 8, background: C.purple.main, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Siguiente: Por qué cambió →</button>
            </div>
          </div>
        )}

        {section === "why" && (
          <div style={{ maxWidth: 700, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: C.blue.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>FUNDAMENTOS</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 8px", fontFamily: "'Space Grotesk',sans-serif" }}>Por qué el {T("SDLC")} ya no alcanza</h1>
            <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.7, marginBottom: 20 }}>Cuatro razones estructurales, no de preferencia tecnológica.</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {WHY_DATA.map((w, i) => (
                <button key={i} onClick={() => setWhyIdx(i)} style={{
                  flex: 1, padding: "8px 4px", borderRadius: 8,
                  border: `1px solid ${whyIdx === i ? C.blue.main : t.border}`,
                  background: whyIdx === i ? `${C.blue.main}18` : t.bgCard,
                  color: whyIdx === i ? C.blue.main : t.textSub,
                  fontSize: 11, fontWeight: whyIdx === i ? 700 : 400, cursor: "pointer", fontFamily: "inherit", transition: "all 0.18s",
                }}>{i + 1}</button>
              ))}
            </div>
            <div style={{ background: t.bgCard, border: `1px solid ${C.blue.main}`, borderRadius: 14, padding: 24, minHeight: 160, animation: "fadeIn 0.2s ease" }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: t.text, marginBottom: 12, fontFamily: "'Space Grotesk',sans-serif" }}>{WHY_DATA[whyIdx].title}</div>
              <div style={{ fontSize: 14, color: t.textSub, lineHeight: 1.85 }}>{WHY_DATA[whyIdx].body}</div>
            </div>
            <div style={{ display: "flex", gap: 3, marginTop: 12 }}>
              {[0, 1, 2, 3].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= whyIdx ? C.blue.main : t.border, transition: "background 0.3s" }} />)}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setWhyIdx(w => Math.max(0, w - 1))} disabled={whyIdx === 0} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, fontSize: 12, cursor: whyIdx === 0 ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: whyIdx === 0 ? 0.4 : 1 }}>← Anterior</button>
              <button onClick={() => whyIdx < 3 ? setWhyIdx(w => w + 1) : setSection("flow")} style={{ padding: "8px 14px", borderRadius: 8, background: C.blue.main, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{whyIdx < 3 ? "Siguiente →" : "Ver el flujo →"}</button>
            </div>
          </div>
        )}

        {section === "flow" && (() => {
          const ag = phase.agentDetails?.[agentTab];
          const TIER_C2 = { 1:"#1D9E75", 2:"#BA7517", 3:"#E24B4A" };
          const TIER_BG2 = { 1:"#E1F5EE", 2:"#FAEEDA", 3:"#FCEBEB" };
          return (
            <div style={{ maxWidth: 800, animation: "fadeIn 0.3s ease" }}>
              <div style={{ fontSize: 11, color: C.amber.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>FLUJO COMPLETO</div>
              <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 8px", fontFamily: "'Space Grotesk',sans-serif" }}>Las 6 fases del {T("ADLC")}</h1>
              <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.7, marginBottom: 16 }}>Selecciona una fase, luego cada agente para ver su rol exacto, tier, y los artefactos que produce.</p>

              {/* Fase tabs */}
              <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
                {PHASES_DATA.map((p, i) => (
                  <button key={i} onClick={() => { setPhaseIdx(i); setAgentTab(0); }} style={{ padding: "5px 12px", borderRadius: 20, border: `1px solid ${phaseIdx === i ? p.color.main : t.border}`, background: phaseIdx === i ? `${p.color.main}20` : t.bgCard, color: phaseIdx === i ? p.color.main : t.textSub, fontSize: 11, fontWeight: phaseIdx === i ? 700 : 400, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>{p.name}</button>
                ))}
              </div>

              {/* Phase card */}
              <div style={{ background: t.bgCard, border: `2px solid ${phase.color.main}`, borderRadius: 14, overflow: "hidden", animation: "fadeIn 0.2s ease" }}>

                {/* Phase header */}
                <div style={{ background: `${phase.color.main}16`, padding: "14px 18px", borderBottom: `1px solid ${phase.color.main}30`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: phase.color.main, fontFamily: "'Space Grotesk',sans-serif" }}>{phase.name} — {phase.subtitle}</div>
                    <div style={{ fontSize: 11, color: phase.color.main, opacity: 0.7, marginTop: 2 }}>Governance: {phase.tier} · {phase.agents.length} agentes</div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {phase.produces.map(p => (
                      <span key={p} style={{ fontSize: 10, color: phase.color.main, fontFamily: "monospace", padding: "2px 6px", background: `${phase.color.main}18`, borderRadius: 4, border: `1px solid ${phase.color.main}30` }}>{p}</span>
                    ))}
                  </div>
                </div>

                {/* Why + What summary */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, borderBottom: `1px solid ${t.border}` }}>
                  <div style={{ padding: "12px 16px", borderRight: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 5 }}>POR QUÉ EXISTE</div>
                    <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.7 }}>{phase.why}</div>
                  </div>
                  <div style={{ padding: "12px 16px" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 5 }}>QUÉ HACE</div>
                    <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.7 }}>{phase.what}</div>
                  </div>
                </div>

                {/* Agent tabs */}
                <div style={{ borderBottom: `1px solid ${t.border}`, display: "flex", padding: "0 16px" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", display: "flex", alignItems: "center", marginRight: 12 }}>AGENTES</div>
                  {phase.agentDetails?.map((a, i) => (
                    <button key={i} onClick={() => setAgentTab(i)} style={{
                      padding: "8px 14px", fontSize: 11, fontWeight: agentTab === i ? 700 : 400,
                      color: agentTab === i ? phase.color.main : t.textMuted,
                      borderBottom: agentTab === i ? `2px solid ${phase.color.main}` : "2px solid transparent",
                      background: "none", border: "none", borderBottom: agentTab === i ? `2px solid ${phase.color.main}` : "2px solid transparent",
                      cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                    }}>{a.name}</button>
                  ))}
                </div>

                {/* Agent detail panel */}
                {ag && (
                  <div style={{ padding: 18, animation: "fadeIn 0.2s ease" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{ag.name}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, color: TIER_C2[ag.tier], background: TIER_BG2[ag.tier], border: `1px solid ${TIER_C2[ag.tier]}40` }}>{ag.tierLabel}</span>
                        {ag.hitl && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, color: "#534AB7", background: "#EEEDFE", border: "1px solid #534AB740" }}>HITL requerido</span>}
                      </div>
                    </div>

                    <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.8, marginBottom: 16, padding: "12px 14px", background: t.bgSubtle, borderRadius: 8 }}>
                      {ag.desc}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ background: t.bgSubtle, borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 6 }}>ARTEFACTO QUE PRODUCE</div>
                        <div style={{ fontSize: 12, color: phase.color.main, fontFamily: "monospace", fontWeight: 700, marginBottom: 4 }}>{ag.output}</div>
                        <div style={{ fontSize: 11, color: t.textSub, lineHeight: 1.6 }}>{ag.outputDesc}</div>
                      </div>
                      <div style={{ background: t.bgSubtle, borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.08em", marginBottom: 6 }}>CAPA DE GOVERNANCE</div>
                        <div style={{ fontSize: 12, color: TIER_C2[ag.tier], fontWeight: 700, marginBottom: 4 }}>{ag.tierLabel}</div>
                        <div style={{ fontSize: 11, color: t.textSub, lineHeight: 1.6 }}>
                          {ag.tier === 1 && "Auto-continúa sin esperar aprobación. Todo queda en el audit trail."}
                          {ag.tier === 2 && (ag.hitl ? "Solicita aprobación humana. El sistema bloquea hasta respuesta (ventana 4h, auto-aprueba si no hay respuesta)." : "Tier 2 sin HITL directo — el orquestador puede escalar si detecta anomalías.")}
                          {ag.tier === 3 && "Bloqueo total. No hay auto-aprobación. Requiere firma explícita del PMO o Compliance Officer. Evidencia regulatoria permanente."}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {phaseIdx === 5 && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 9, background: `${C.teal.main}12`, border: `1px dashed ${C.teal.main}`, animation: "fadeIn 0.3s ease", fontSize: 12, color: t.textSub }}>
                  <span style={{ fontWeight: 700, color: C.teal.main }}>↻ El {T("Agent Development Flywheel","feedback loop")} cierra aquí</span> — El Feedback Agent toma los incidentes de producción y actualiza el constraint_map y el {T("Responsibility map")} de Fase 0. Cada vuelta hace el sistema más preciso.
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
                <button onClick={() => { setPhaseIdx(p => Math.max(0, p - 1)); setAgentTab(0); }} disabled={phaseIdx === 0} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, fontSize: 12, cursor: phaseIdx === 0 ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: phaseIdx === 0 ? 0.4 : 1 }}>← Anterior</button>
                <button onClick={() => { if (phaseIdx < 5) { setPhaseIdx(p => p + 1); setAgentTab(0); } else setSection("tiers"); }} style={{ padding: "7px 14px", borderRadius: 8, background: phase.color.main, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {phaseIdx < 5 ? "Siguiente fase →" : "Ver tiers →"}
                </button>
              </div>
            </div>
          );
        })()}

        {section === "tiers" && (
          <div style={{ maxWidth: 700, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: C.coral.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>GOVERNANCE</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 8px", fontFamily: "'Space Grotesk',sans-serif" }}>Los 3 {T("Tier","tiers")} de control</h1>
            <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.7, marginBottom: 20 }}>El tier no es propiedad de la fase — es propiedad del {T("Agente","agente")}. Lo que determina el tier es el riesgo de la acción, no el momento del ciclo.</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {TIER_INFO.map((ti, i) => (
                <button key={i} onClick={() => setTierIdx(i)} style={{ flex: 1, padding: "9px 6px", borderRadius: 9, border: `1px solid ${tierIdx === i ? ti.color.main : t.border}`, background: tierIdx === i ? `${ti.color.main}16` : t.bgCard, color: tierIdx === i ? ti.color.main : t.textSub, fontSize: 11, fontWeight: tierIdx === i ? 700 : 400, cursor: "pointer", fontFamily: "inherit", transition: "all 0.18s" }}>T{ti.tier}</button>
              ))}
            </div>
            {TIER_INFO.map((ti, i) => tierIdx === i && (
              <div key={i} style={{ background: t.bgCard, border: `2px solid ${ti.color.main}`, borderRadius: 12, padding: 20, animation: "fadeIn 0.2s ease" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: ti.color.main, marginBottom: 10, fontFamily: "'Space Grotesk',sans-serif" }}>{ti.label}</div>
                <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.8, marginBottom: 14 }}>{ti.desc}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[
                    ["Espera aprobación", i === 0 ? "No — auto-continúa" : i === 1 ? "Ventana de 4 horas" : "Bloqueo indefinido"],
                    ["Auto-aprobación", i === 0 ? "Sí, siempre" : i === 1 ? "Sí, si no hay respuesta en 4h" : "No — nunca"],
                    ["Ejemplos", ti.examples.join(", ")],
                  ].map(([k, v]) => (
                    <div key={k} style={{ background: t.bgSubtle, borderRadius: 7, padding: "9px 10px" }}>
                      <div style={{ fontSize: 9, color: t.textMuted, marginBottom: 3, fontWeight: 700 }}>{k}</div>
                      <div style={{ fontSize: 11, color: t.text, fontWeight: 500 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 16, background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: "0.06em", marginBottom: 10 }}>MAPA DE TIERS POR FASE</div>
              {PHASES_DATA.map(p => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 5, background: t.bgSubtle, marginBottom: 3 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: p.color.main, width: 56, flexShrink: 0 }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: t.textSub, flex: 1 }}>{p.subtitle}</span>
                  <div style={{ display: "flex", gap: 3 }}>
                    {p.tier.split("+").map(tt => { const n = parseInt(tt.replace("T", "")); return <span key={tt} style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 9, color: TIER_C[n], background: TIER_BG[n] }}>{TIER_L[n]}</span>; })}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setSection("flow")} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>← Anterior</button>
              <button onClick={() => setSection("pmo")} style={{ padding: "8px 14px", borderRadius: 8, background: C.coral.main, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>El nuevo PMO →</button>
            </div>
          </div>
        )}

        {section === "pmo" && (
          <div style={{ maxWidth: 700, animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: C.purple.main, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>ROL DEL PMO</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 8px", fontFamily: "'Space Grotesk',sans-serif" }}>De reportar a gobernar</h1>
            <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.75, marginBottom: 20 }}>
              El cambio más profundo del {T("ADLC")} no es técnico — es organizacional. El {T("PMO")} deja de reportar lo que pasó y comienza a diseñar las reglas bajo las que el sistema opera.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              {[
                { title: "PMO tradicional", items: ["Consolida reportes de estado", "Detecta problemas tras ocurrir", "Mide velocity y cobertura", "Aprueba entregables al final de fase", "Documenta lo que ya pasó"], col: C.gray, sign: "-" },
                { title: "PMO en ADLC", items: [`Diseña la ${GLOSSARY["Capability Matrix"].short}`, `Mide ${GLOSSARY["Goal drift"].short} antes del fallo`, `Monitorea ${GLOSSARY["Acceptance rate"].short} y ${GLOSSARY["Supervision burden"].short}`, `Opera los ${GLOSSARY.HITL.short} checkpoints`, `Genera evidencia regulatoria para ${GLOSSARY.Compliance.short}`], col: C.purple, sign: "+" },
              ].map(col => (
                <div key={col.title} style={{ background: t.bgCard, border: `1px solid ${col.col.main}40`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", background: `${col.col.main}12`, borderBottom: `1px solid ${col.col.main}28`, fontSize: 12, fontWeight: 700, color: col.col.main }}>{col.title}</div>
                  <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {col.items.map(item => (
                      <div key={item} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                        <span style={{ color: col.sign === "+" ? C.teal.main : t.textMuted, fontWeight: 700, fontSize: 12, flexShrink: 0, marginTop: 1 }}>{col.sign}</span>
                        <span style={{ fontSize: 12, color: t.textSub, lineHeight: 1.6 }}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ background: `${C.teal.main}12`, border: `1px solid ${C.teal.main}40`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.teal.main, marginBottom: 5 }}>La pregunta clave para el PMO</div>
              <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.75 }}>
                ¿Está el {T("Supervision burden")} disminuyendo con el tiempo? Si el {T("Agent Development Flywheel","Flywheel")} está funcionando, las horas de supervisión deben bajar sprint a sprint. Si no bajan, algo en el ciclo de aprendizaje está roto.
              </div>
            </div>
            <button onClick={() => setSection("intro")} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>← Volver al inicio</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DEMO PAGE ─────────────────────────────────────────────────────────────────
// ─── HITL ARTIFACTS ── JSON que se muestra al aprobar cada checkpoint ─────────
const HITL_ARTIFACTS = {
  mapping: {
    filename: "responsibility_map.json",
    desc: "Define qué puede ejecutar el sistema solo y cuáles son las zonas prohibidas absolutas. Este artefacto gobierna el comportamiento de todos los agentes.",
    data: {
      version: "1.0.0",
      project: "onboarding-empresas",
      responsibility_matrix: [
        { action_type: "validar_formato_documentos", agent_can_execute: true, requires_human_approval: false, tier: 1, reversible: true },
        { action_type: "enviar_notificacion_cliente", agent_can_execute: true, requires_human_approval: false, tier: 1, reversible: false },
        { action_type: "aprobar_kyc_final", agent_can_execute: false, requires_human_approval: true, approval_authority: "compliance_officer", tier: 3, reversible: false },
        { action_type: "apertura_cuenta_definitiva", agent_can_execute: false, requires_human_approval: true, approval_authority: "pmo_lead", tier: 3, reversible: false },
        { action_type: "calcular_score_riesgo", agent_can_execute: true, requires_human_approval: false, tier: 1, reversible: true, note: "Determinista — no LLM" },
      ],
      forbidden_zones: [
        { description: "Decisión de riesgo crediticio", applies_to: "all_agents", override_possible: false },
        { description: "Modificación de límites transaccionales", applies_to: "all_agents", override_possible: false },
      ],
      escalation_authority: { tier_1: "tech_lead", tier_2: "engineering_manager", tier_3: "cto_or_compliance_officer" },
    }
  },
  intent: {
    filename: "capability_matrix.json",
    desc: "Separa qué decisiones toma el LLM y cuáles deben ser lógica determinista. En fintech, los cálculos financieros SIEMPRE son deterministas.",
    data: {
      version: "1.0.0",
      llm_decisions: ["interpretar_documento_libre", "generar_mensaje_cliente", "clasificar_tipo_documento"],
      deterministic_logic: ["calcular_score_riesgo", "validar_rut_formato", "verificar_campos_obligatorios", "calcular_dias_habiles"],
      rationale: "Los cálculos financieros deben ser deterministas por regulación CMF. El LLM solo interviene donde hay ambigüedad semántica.",
      hash: "a3f7c2e1",
    }
  },
  architecture: {
    filename: "architecture_decision.json",
    desc: "Documenta el patrón elegido y por qué. Los ADRs son inmutables — si la decisión cambia, se crea uno nuevo que depreca el anterior.",
    data: {
      pattern: "hybrid",
      justification: "Plan-Execute para orquestación, ReAct para agentes especializados",
      adrs: [{ id: "ADR-001", status: "accepted", decision: "Usar patrón híbrido Plan-Execute + ReAct", consequences: "Mayor predictibilidad en el flujo, flexibilidad en ejecución de cada agente" }],
      agent_graph: { entry_point: "orchestrator", exit_conditions: ["all_phases_complete", "critical_error", "hitl_rejected"] },
    }
  },
  business: {
    filename: "business_case.json",
    desc: "Define el ROI esperado, el budget máximo, y los criterios go/no-go que el sistema verificará automáticamente antes de cada deploy.",
    data: {
      expected_roi: { time_saved_days: "5 → 1 día hábil", error_reduction_pct: 0.65 },
      operational_costs: { max_monthly_budget_usd: 500, cost_alert_threshold_usd: 400 },
      go_no_go_criteria: { minimum_eval_pass_rate: 0.90, max_supervision_burden_hours: 4, max_error_rate: 0.01, min_acceptance_rate: 0.80 },
    }
  },
  review: {
    filename: "review_report.json",
    desc: "Resultado del SAST (Bandit), SCA (pip-audit), y verificación de la Capability Matrix. Una recomendación 'block' escala sin esperar.",
    data: {
      overall_score: 0.91,
      security_issues: [],
      capability_matrix_violations: [],
      dependency_audit: { vulnerabilities: [], hallucinated_packages: [] },
      action_items: [{ priority: "medium", file: "agents/phase_0/discovery_agent.py", line: 47, description: "Complejidad ciclomática alta (12)" }],
      merge_recommendation: "approve",
    }
  },
  hitl_gate: {
    filename: "deploy_gate_check.json",
    desc: "Verificación de las 3 condiciones críticas antes de producción. Si cualquiera falla, el sistema se detiene completamente.",
    data: {
      checks: {
        eval_pass_rate: { value: 0.92, threshold: 0.90, passed: true },
        critical_evals_failed: { value: 0, threshold: 0, passed: true },
        acceptance_rate_pilot: { value: 0.84, threshold: 0.70, passed: true },
      },
      all_passed: true,
      gate_status: "OPEN — listo para despliegue",
      requires_explicit_approval: true,
      approver_required_role: "pmo_lead o compliance_officer",
    }
  },
};

// ─── ARTIFACT MARKDOWN ─── Versiones humano-legibles para entender los handoffs
// Se usa § como sustituto de backtick para evitar escaping en template literals.
const ARTIFACT_MD = (function(){
  const _md = (s) => s.replace(/§/g, "`");
  return {

"responsibility_map.json": _md(`# responsibility_map.json

**Producido por:** Mapping Agent · **Fase 0** — Descubrimiento
**Consumido por:** Intent Agent (Fase 1)
**Tier:** T2 — requiere HITL
**Versión:** 1.0.0 · **Proyecto:** onboarding-empresas

---

## Propósito

Define qué puede ejecutar el sistema **sin intervención humana** y cuáles son las zonas prohibidas absolutas. Es la base de toda la governance posterior — si este mapa está mal, todos los tiers quedan construidos sobre supuestos incorrectos.

## Responsibility Matrix

| Acción | Auto | Aprobación | Tier |
|---|---|---|---|
| validar_formato_documentos | sí | — | T1 |
| enviar_notificacion_cliente | sí | — | T1 |
| aprobar_kyc_final | no | compliance_officer | T3 |
| apertura_cuenta_definitiva | no | pmo_lead | T3 |
| calcular_score_riesgo | sí | — | T1 |

Nota: §calcular_score_riesgo§ es **determinista** — no usa LLM, es código fijo.

## Forbidden Zones

- **Decisión de riesgo crediticio** — sin override posible
- **Modificación de límites transaccionales** — sin override posible

## Escalation Authority

- **T1** → tech_lead
- **T2** → engineering_manager
- **T3** → cto_or_compliance_officer

## Handoff → Intent Agent (Fase 1)

El Intent Agent leerá este mapa para construir la **Capability Matrix**. Las filas marcadas como deterministas no pueden delegarse al LLM — esa es una restricción regulatoria CMF.
`),

"constraint_map.json": _md(`# constraint_map.json

**Producido por:** Mapping Agent · **Fase 0** — Descubrimiento
**Actualizado por:** Feedback Agent (Fase 5) — el outer loop alimenta esto
**Consumido por:** Todos los agentes — define los límites operacionales
**Tier:** T2 — requiere HITL inicial

---

## Propósito

Define las **restricciones técnicas y de negocio** que aplican durante toda la operación del sistema. A diferencia del responsibility_map (qué se puede hacer), el constraint_map dice **bajo qué condiciones**.

## Constraints Operacionales

- **Latencia máxima por agente:** 30s
- **Context budget por ejecución:** 180,000 tokens
- **Budget mensual:** USD 500
- **Retención de audit trail:** 365 días (CMF Chile)

## Constraints de Comportamiento

- **Goal drift máximo aceptable:** 0.30 (warning) / 0.40 (auto-rollback)
- **Eval pass rate mínimo:** 0.85
- **Acceptance rate mínimo:** 0.65
- **Supervision burden máximo:** 8 h/semana

## Outer Loop Updates

El **Feedback Agent** en Fase 5 toma incidentes de producción y propone updates a este archivo. Cada update pasa por HITL — el sistema NO modifica sus propias restricciones sin aprobación humana.

## Handoff → Todos los Agentes

Cada agente lee este mapa al inicio de su ejecución. Si una restricción se viola en runtime, se activa el **circuit breaker** del agente y escala según el tier.
`),

"intent_spec.md": _md(`# intent_spec.md

**Producido por:** Intent Agent · **Fase 1** — Diseño
**Consumido por:** Todos los agentes posteriores
**Tier:** T2 — requiere HITL
**Hash:** §v1.0.0:a3f7c2e1§ (versionado, monitoreado por CI/CD)

---

## Propósito

La spec de intent es el **artefacto central del Spec-Driven Development**. Describe qué debe hacer el sistema, por qué, y bajo qué restricciones — antes de que se escriba una línea de código. Si el intent_spec cambia sin aprobación, el pipeline de CI/CD lo detecta y bloquea.

## Estructura del Intent

- **Goal:** Automatizar el onboarding de clientes empresariales reduciendo el tiempo de 5 días a 1 día hábil
- **Non-goals:** No reemplazar la decisión de aprobación final del compliance officer
- **Success criteria:** Definidos en business_case.json
- **Constraints:** Definidos en constraint_map.json

## Versionado

El intent_spec tiene un hash criptográfico. El **Validation Agent** en Fase 3 calcula el §goal_drift_score§ comparando los embeddings del intent original vs muestras de comportamiento real en producción.

## Handoff → Todo el ADLC

- **Architecture Agent** lo usa para diseñar el grafo de agentes
- **Coding Agent** lo lee antes de cada generación de código
- **Validation Agent** lo embebe y compara contra producción
- **SRE Agent** dispara rollback si el drift contra este spec supera 0.40
`),

"capability_matrix.json": _md(`# capability_matrix.json

**Producido por:** Intent Agent · **Fase 1** — Diseño
**Consumido por:** Architecture Agent → Coding Agent → Review Agent
**Tier:** T2 — requiere HITL
**Hash:** §a3f7c2e1§

---

## Propósito

Separa explícitamente qué decisiones quedan bajo el LLM (razonamiento no determinístico) y cuáles deben ser **lógica determinista** (código fijo). En fintech esto es una decisión regulatoria, no técnica.

## Decisiones del LLM

- §interpretar_documento_libre§
- §generar_mensaje_cliente§
- §clasificar_tipo_documento§

## Lógica Determinista

- §calcular_score_riesgo§
- §validar_rut_formato§
- §verificar_campos_obligatorios§
- §calcular_dias_habiles§

## Rationale

Los cálculos financieros deben ser deterministas por regulación CMF. El LLM solo interviene donde hay ambigüedad semántica que un humano también encontraría ambigua.

## Handoff → Architecture / Coding / Review

- **Architecture Agent** usa esta matriz para diseñar el grafo: cada nodo determinista es una función pura, cada nodo LLM es una llamada al modelo con su prompt versionado
- **Coding Agent** la lee antes de generar código
- **Review Agent** la verifica como gate — si el código pone una decisión determinista detrás del LLM, escala con §capability_matrix_violations§
`),

"architecture_decision.json": _md(`# architecture_decision.json

**Producido por:** Architecture Agent · **Fase 1** — Diseño
**Consumido por:** Coding Agent y Orquestador Central (Fase 2)
**Tier:** T2 — requiere HITL
**Patrón:** §hybrid§ (Plan-Execute + ReAct)

---

## Decisión

Usar patrón **híbrido**:

- **Plan-Execute** para la orquestación de alto nivel
- **ReAct** para los agentes especializados que ejecutan tareas

## Justificación

Mayor predictibilidad en el flujo (Plan-Execute), con flexibilidad en la ejecución de cada agente individual (ReAct). Trazabilidad completa de las decisiones del orquestador en §routing_decisions.json§.

## ADR-001

- **Estado:** accepted
- **Decisión:** Usar patrón híbrido Plan-Execute + ReAct
- **Consecuencias:** Mayor predictibilidad en el flujo, flexibilidad en ejecución de cada agente

## Agent Graph

- **Entry point:** §orchestrator§
- **Exit conditions:** §all_phases_complete§ · §critical_error§ · §hitl_rejected§

## Handoff → Coding Agent (Fase 2)

Los ADRs son **inmutables**. Si el Coding Agent necesita desviarse de la decisión, no puede modificar el ADR — debe crear un nuevo ADR que deprece el anterior, pasando otra vez por HITL.
`),

"business_case.json": _md(`# business_case.json

**Producido por:** Business Agent · **Fase 1** — Diseño
**Consumido por:** CI/CD Agent (Fase 4) — verifica criterios go/no-go en cada deploy
**Tier:** T2 — requiere HITL

---

## ROI Esperado

- **Tiempo ahorrado:** 5 días hábiles → 1 día hábil
- **Reducción de errores:** 65%

## Costos Operacionales

- **Budget mensual máximo:** USD 500
- **Threshold de alerta:** USD 400

## Criterios Go/No-Go

| KPI | Umbral mínimo |
|---|---|
| §eval_pass_rate§ | ≥ 0.90 |
| §supervision_burden§ | < 4 h/semana |
| §error_rate§ | < 0.01 |
| §acceptance_rate§ | ≥ 0.80 |

## Handoff → CI/CD Agent (Fase 4)

El CI/CD Agent ejecutará un **pre-deploy checklist** que valida automáticamente estos 4 criterios contra los KPIs reales antes de construir el artifact firmado. Si cualquiera falla → bloqueo total, sin auto-aprobación.
`),

"review_report.json": _md(`# review_report.json

**Producido por:** Review Agent · **Fase 2** — Desarrollo
**Consumido por:** Orquestador Central → Testing Agent (Fase 3)
**Tier:** T2 — requiere HITL
**Score general:** §0.91§ · **Recomendación:** §approve§

---

## Verificaciones Ejecutadas

- **SAST** — Análisis estático con Bandit (Python)
- **SCA** — Software Composition Analysis con pip-audit
- **Capability Matrix** — Verificación contra el §capability_matrix.json§ de Fase 1
- **PyPI Check** — Anti-hallucinated dependencies

## Resultado

- §security_issues§: ninguno
- §capability_matrix_violations§: ninguna
- §dependency_audit.vulnerabilities§: ninguna
- §dependency_audit.hallucinated_packages§: ninguno

## Action Items

| Prioridad | Archivo | Línea | Descripción |
|---|---|---|---|
| medium | §agents/phase_0/discovery_agent.py§ | 47 | Complejidad ciclomática alta (12) |

## Handoff → Testing Agent (Fase 3)

Con §merge_recommendation: "approve"§ el orquestador avanza a Fase 3. El Testing Agent recibe el código aprobado y ejecutará evals conductuales sobre distribuciones de inputs reales — si los evals de seguridad o compliance fallan al 100%, **bloquea** sin importar este score.
`),

"eval_results.json": _md(`# eval_results.json

**Producido por:** Testing Agent · **Fase 3** — Validación
**Consumido por:** Validation Agent → HITL Gate (Fase 3)
**Tier:** T2 — auto

---

## Propósito

Resultado de los **evals conductuales** — no son unit tests. Validan el agente ante inputs reales, casos extremos y prompts adversariales sobre distribuciones de datos del mundo real.

## Eval Suite

| Categoría | Casos | Pasados | Pass rate |
|---|---|---|---|
| behavioral | 142 | 131 | 0.92 |
| security | 38 | 38 | 1.00 |
| compliance | 24 | 24 | 1.00 |
| edge_cases | 56 | 50 | 0.89 |

**Eval pass rate global:** 0.92

## Reglas Críticas

- **Security evals deben pasar al 100%** — un solo fallo bloquea el deploy
- **Compliance evals deben pasar al 100%** — un solo fallo bloquea el deploy
- **Behavioral evals:** mínimo 0.85 para considerar el agente apto

## Casos Fallidos

11 casos en escenarios de alta ambigüedad semántica. Pasan al Learning Agent (Fase 5) para ser convertidos en nuevos evals refinados.

## Handoff → Validation Agent

El Validation Agent toma este archivo y lo combina con el §goal_drift_score§ para producir el §validation_report.json§. Si las dos métricas pasan, escala al HITL Gate Tier 3.
`),

"validation_report.json": _md(`# validation_report.json

**Producido por:** Validation Agent · **Fase 3** — Validación
**Consumido por:** HITL Gate (Fase 3)
**Tier:** T2 — auto

---

## Propósito

Combina los resultados de **goal drift** y **regression testing en staging** para determinar si el sistema está listo para el HITL Gate de Tier 3.

## Goal Drift

- **Score actual:** 0.10
- **Threshold warning:** 0.30
- **Threshold auto-rollback:** 0.40
- **Status:** ✓ dentro de rango aceptable

Calculado con §text-embedding-3-large§ comparando el intent_spec.md original vs muestras de comportamiento observado en staging.

## Staging E2E

- **Tests ejecutados:** 28
- **Tests pasados:** 28
- **Latencia p99:** 1.2s

## Regression Baseline

Comparación contra la versión anterior en producción:

- **Acceptance rate:** estable (0.84 vs 0.83)
- **Supervision burden:** mejor (-15%)
- **Goal drift:** estable

## Handoff → HITL Gate (Fase 3)

El HITL Gate verifica 3 condiciones que combinan este reporte con eval_results.json. Si cualquiera falla, bloqueo total — el deploy NO procede.
`),

"deploy_gate_check.json": _md(`# deploy_gate_check.json

**Producido por:** HITL Gate · **Fase 3** — Validación
**Consumido por:** CI/CD Agent (Fase 4) — solo procede si §gate_status == "OPEN"§
**Tier:** T3 — bloqueo total
**Aprobación requerida:** §pmo_lead§ o §compliance_officer§

---

## Propósito

La **puerta de producción**. Verifica 3 condiciones simultáneas. Si cualquiera falla, el sistema NO avanza — bloqueo indefinido hasta intervención humana explícita.

## Checks

| Check | Valor | Umbral | Status |
|---|---|---|---|
| §eval_pass_rate§ | 0.92 | ≥ 0.90 | ✓ |
| §critical_evals_failed§ | 0 | = 0 | ✓ |
| §acceptance_rate_pilot§ | 0.84 | ≥ 0.70 | ✓ |

**all_passed:** true
**gate_status:** OPEN — listo para despliegue

## Reglas del Gate

- **No hay auto-aprobación** bajo ninguna circunstancia
- Requiere **firma explícita** con timestamp e identidad del aprobador
- La firma queda en el audit trail **permanentemente** (retención CMF: 365 días)

## Handoff → CI/CD Agent (Fase 4)

El CI/CD Agent verificará que §gate_status == "OPEN"§ y §requires_explicit_approval§ esté firmado antes de continuar con el §pre_deploy_checklist§. Si los KPIs cambiaron desde la aprobación, bloquea de todas formas.
`),

"deploy_manifest.json": _md(`# deploy_manifest.json

**Producido por:** CI/CD Agent · **Fase 4** — Despliegue
**Consumido por:** Rollout Agent (Fase 4)
**Tier:** T3 — bloqueo total

---

## Propósito

Artifact firmado con todos los datos necesarios para desplegar y revertir. **Inmutable** — el hash SHA-256 garantiza que lo que se desplegó es exactamente lo que se aprobó.

## Pre-Deploy Checklist

| Check | Status |
|---|---|
| Todos los HITL anteriores aprobados | ✓ |
| §eval_pass_rate >= threshold§ | ✓ |
| Sin vulnerabilidades críticas | ✓ |
| Intent spec sin cambios desde aprobación | ✓ |
| Capability Matrix sin violaciones | ✓ |
| Audit trail completo | ✓ |

**all_passed:** true

## Artifact

- **Hash SHA-256:** §e3b0c44298fc1c149afbf4c8996fb924...§
- **Build timestamp:** 2026-04-08T14:30:00Z
- **Built from commit:** §abc123§
- **Signature:** firmado por CI/CD Agent

## Handoff → Rollout Agent

El Rollout Agent toma este manifest y ejecuta el rollout progresivo: 5% → 15% → 30% → 100%. En cada etapa mide los KPIs y puede retroceder automáticamente sin intervención humana.
`),

"compliance_log.json": _md(`# compliance_log.json

**Producido por:** Policy Agent · **Fase 4** — Despliegue (ongoing)
**Consumido por:** Auditores externos · CMF Chile · Feedback Agent
**Tier:** T3 — bloqueo total
**Retención:** 365 días (regulación CMF)

---

## Propósito

**Policy-as-code** en runtime: cada acción del sistema en producción es verificada contra el §responsibility_map.json§ de Fase 0 antes de ejecutarse. Si una acción no está autorizada, se bloquea — no se registra y continúa.

## Estructura del Log

Cada entrada contiene:

- **Timestamp** ISO 8601
- **Agent** que intentó la acción
- **Action** intentada
- **Tier** del agente
- **Authorized:** boolean
- **Hash before/after** del ProjectState
- **Human in the loop:** boolean
- **Approver** (si aplica)

## Audit Trail Inmutable

- **Append-only** — nunca se modifica ni elimina una entrada
- **Hash chain** — cada entrada incluye el hash de la anterior (blockchain-style)
- **Retención mínima:** 365 días para CMF
- **Acceso:** solo lectura, incluso para administradores

## Handoff → Feedback Agent (Fase 5)

El Feedback Agent toma muestras del compliance_log para detectar patrones de uso, frecuencia de escaladas, y proponer actualizaciones al §responsibility_map§ para la próxima iteración del ADLC.
`),

"pmo_report.json": _md(`# pmo_report.json

**Producido por:** Feedback Agent · **Fase 5** — Monitoreo
**Consumido por:** PMO Lead · Engineering Manager · CTO
**Tier:** T2 — auto
**Frecuencia:** Semanal (sprint-based)

---

## Propósito

El reporte que cierra el **outer loop** del ADLC. Convierte los aprendizajes de producción en evidencia accionable para el PMO. Es la principal output del **Agent Development Flywheel**.

## KPIs del Sprint

| KPI | Valor | Target | Tendencia |
|---|---|---|---|
| §acceptance_rate§ | 0.84 | ≥ 0.80 | ↑ |
| §supervision_burden§ | 2.5 h/sem | < 4 | ↓ |
| §goal_drift_score§ | 0.10 | < 0.30 | estable |
| §eval_pass_rate§ | 0.92 | ≥ 0.85 | ↑ |

## Goal Drift History

Tendencia de los últimos 4 sprints (debe ser plana o decreciente):

- Sprint -3: 0.12
- Sprint -2: 0.11
- Sprint -1: 0.10
- Sprint actual: 0.10

## Constraint Map Updates Propuestos

Basado en datos de producción, el Feedback Agent propone:

- Subir el threshold de acceptance_rate de 0.65 → 0.70 (el sistema está sobre-rendimiento sostenido)
- Reducir context budget de 180k → 150k tokens (el promedio real es 92k)

**Cada update propuesto pasa por HITL antes de aplicarse.**

## Handoff → Fase 0 (cierre del loop)

El Feedback Agent envía estos updates aprobados al **Mapping Agent** de Fase 0 para una nueva iteración del ADLC. Así el sistema **mejora con el tiempo** en lugar de degradarse.
`),

  };
})();

const AGENTS_BY_PHASE = {
  0:[{id:"discovery",name:"Discovery Agent",tier:1,action:"Analiza pain points",output:"pain_points_report.json"},{id:"hypothesis",name:"Hypothesis Agent",tier:1,action:"Genera hipótesis",output:"hypotheses.json"},{id:"mapping",name:"Mapping Agent",tier:2,action:"Límites de autonomía",output:"responsibility_map.json",hitl:true}],
  1:[{id:"intent",name:"Intent Agent",tier:2,action:"Spec + Capability Matrix",output:"intent_spec.md",hitl:true},{id:"architecture",name:"Architecture Agent",tier:2,action:"Patrón + ADRs",output:"architecture_decision.json",hitl:true},{id:"business",name:"Business Agent",tier:2,action:"ROI + go/no-go",output:"business_case.json",hitl:true}],
  2:[{id:"orchestrator",name:"Orquestador",tier:2,action:"LLM-driven routing",output:"routing_decisions.json"},{id:"coding",name:"Coding Agent",tier:2,action:"Genera código + valida deps",output:"source_code/"},{id:"review",name:"Review Agent",tier:2,action:"SAST + SCA",output:"review_report.json",hitl:true}],
  3:[{id:"testing",name:"Testing Agent",tier:2,action:"Evals conductuales",output:"eval_results.json"},{id:"validation",name:"Validation Agent",tier:2,action:"Goal drift + staging",output:"validation_report.json"},{id:"hitl_gate",name:"HITL Gate",tier:3,action:"3 condiciones críticas",output:"deploy_approval.json",hitl:true}],
  4:[{id:"cicd",name:"CI/CD Agent",tier:3,action:"Pre-deploy checklist",output:"deploy_manifest.json"},{id:"rollout",name:"Rollout Agent",tier:3,action:"Canary 5→100%",output:"rollout_log.json"},{id:"policy",name:"Policy Agent",tier:3,action:"Compliance + audit",output:"compliance_log.json"}],
  5:[{id:"sre",name:"SRE Agent",tier:2,action:"Anomalías + rollback",output:"sre_report.json"},{id:"learning",name:"Learning Agent",tier:2,action:"Dev Flywheel",output:"eval_updates.json"},{id:"feedback",name:"Feedback Agent",tier:2,action:"Retro → Fase 0",output:"pmo_report.json"}],
};
const SCENARIOS={
  normal:{label:"Normal",description:"Flujo feliz — 6 fases sin incidentes",color:"#1D9E75",events:[],goalDrift:0.10,evalRate:0.92,requirementExample:"Automatizar validación de documentos en onboarding de clientes empresariales. Proceso actual: 5 días hábiles, 40% de rechazos por errores de formato."},
  drift:{label:"Goal Drift",description:"Drift 0.35 en Fase 3 — dispara escalada",color:"#BA7517",events:[{phase:3,agent:"validation",type:"drift",value:0.35}],goalDrift:0.35,evalRate:0.88,requirementExample:"Automatizar notificaciones de estado en proceso de crédito hipotecario. El equipo sospecha que el agente está enviando mensajes fuera del contexto correcto."},
  rejection:{label:"Rechazo HITL",description:"PMO rechaza Capability Matrix en Fase 1",color:"#993C1D",events:[{phase:1,agent:"intent",type:"rejection"}],goalDrift:0.10,evalRate:0.90,requirementExample:"Construir agente de scoring crediticio para PyMEs. El PMO rechaza delegar la decisión de riesgo al LLM."},
  cascade:{label:"Cascade",description:"Circuit breaker abre en Fase 2",color:"#E24B4A",events:[{phase:2,agent:"coding",type:"cascade",count:3}],goalDrift:0.10,evalRate:0.85,requirementExample:"Automatizar reconciliación de transacciones diarias. El sistema de pagos externos tiene alta latencia."}
};

// Artefactos clave que el ADLC entrega al completar el flujo (subset visible al usuario)
const DELIVERED_ARTIFACTS=[
  {phase:0,files:["responsibility_map.json","constraint_map.json"]},
  {phase:1,files:["intent_spec.md","capability_matrix.json"]},
  {phase:2,files:["review_report.json"]},
  {phase:3,files:["eval_results.json","validation_report.json"]},
  {phase:4,files:["deploy_manifest.json","compliance_log.json"]},
  {phase:5,files:["pmo_report.json"]},
];

// ─── MARKDOWN VIEW ─── Renderer minimalista para artefactos en MD ─────────────
function MarkdownView({ md, t }) {
  if (!md) return <div style={{fontSize:11,color:t.textFaint,padding:8,fontStyle:"italic"}}>Sin contenido markdown disponible para este artefacto.</div>;

  const inline = (text) => {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m, k = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) out.push(<strong key={k++} style={{color:t.text,fontWeight:700}}>{tok.slice(2,-2)}</strong>);
      else out.push(<code key={k++} style={{fontFamily:"monospace",fontSize:11,background:t.bgSubtle,padding:"1px 5px",borderRadius:3,color:"#534AB7",border:`1px solid ${t.border}`}}>{tok.slice(1,-1)}</code>);
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const lines = md.split("\n");
  const blocks = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      blocks.push(<h1 key={key++} style={{fontSize:17,fontWeight:700,color:t.text,margin:"0 0 8px",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.01em"}}>{line.slice(2)}</h1>);
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push(<h2 key={key++} style={{fontSize:13,fontWeight:700,color:t.text,margin:"14px 0 5px",fontFamily:"'Space Grotesk',sans-serif"}}>{line.slice(3)}</h2>);
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(<h3 key={key++} style={{fontSize:11,fontWeight:700,color:t.textSub,margin:"10px 0 4px",letterSpacing:"0.04em"}}>{line.slice(4)}</h3>);
      i++;
    } else if (line.trim() === "---") {
      blocks.push(<hr key={key++} style={{border:"none",borderTop:`1px solid ${t.border}`,margin:"10px 0"}}/>);
      i++;
    } else if (line.startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parseRow = (l) => l.split("|").slice(1, -1).map(c => c.trim());
      const header = parseRow(tableLines[0]);
      const body = tableLines.length > 2 ? tableLines.slice(2).map(parseRow) : [];
      blocks.push(
        <div key={key++} style={{overflowX:"auto",margin:"6px 0 10px"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead>
              <tr>{header.map((h,hi)=><th key={hi} style={{padding:"6px 9px",background:t.bgSubtle,border:`1px solid ${t.border}`,textAlign:"left",fontWeight:700,color:t.textMuted,fontSize:10,letterSpacing:"0.04em",whiteSpace:"nowrap"}}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((row,ri)=>(
                <tr key={ri}>{row.map((c,ci)=><td key={ci} style={{padding:"5px 9px",border:`1px solid ${t.border}`,color:t.textSub,verticalAlign:"top"}}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (/^\s*-\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{margin:"4px 0 10px 0",paddingLeft:18,fontSize:12,color:t.textSub,lineHeight:1.7}}>
          {items.map((it,ii)=><li key={ii} style={{marginBottom:2}}>{inline(it)}</li>)}
        </ul>
      );
    } else if (line.trim() === "") {
      i++;
    } else {
      blocks.push(<p key={key++} style={{fontSize:12,color:t.textSub,lineHeight:1.7,margin:"4px 0 8px"}}>{inline(line)}</p>);
      i++;
    }
  }

  return <div>{blocks}</div>;
}

// ─── PROJECT STATE HELPERS ─── Parsers, diff, mutación incremental ────────────
// Extrae filenames del campo `output` de un agente. Soporta "a.json", "a.md + b.json", "src/".
function parseOutputFiles(output) {
  if (!output) return [];
  return output.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
}

// Calcula diff top-level entre dos objetos (ignora artifacts y history para legibilidad).
// Retorna {added: [{k,v}], changed: [{k,from,to}], artifactsAdded: [filename]}
function diffState(prev, next) {
  const skip = new Set(["history", "artifacts"]);
  const added = [], changed = [];
  const prevObj = prev || {};
  for (const k of Object.keys(next)) {
    if (skip.has(k)) continue;
    if (!(k in prevObj)) {
      added.push({ k, v: next[k] });
    } else if (JSON.stringify(prevObj[k]) !== JSON.stringify(next[k])) {
      changed.push({ k, from: prevObj[k], to: next[k] });
    }
  }
  const prevArt = new Set(Object.keys(prevObj.artifacts || {}));
  const artifactsAdded = Object.keys(next.artifacts || {}).filter(f => !prevArt.has(f));
  return { added, changed, artifactsAdded };
}

// Aplica el efecto de un agente recién completado al ProjectState.
// Devuelve el nuevo estado (inmutable) — el caller decide si lo persiste.
function applyAgentToState(prev, { agent, phaseId, phaseName, auditCount, scenario }) {
  const base = prev || { artifacts: {}, history: [] };
  const next = {
    ...base,
    phase: phaseName,
    current_phase_id: phaseId,
    current_agent: agent.name,
    agents_completed: (base.agents_completed || 0) + 1,
    audit_entries: auditCount,
    artifacts: { ...(base.artifacts || {}) },
    history: base.history || [],
  };
  // Cada agente añade sus outputs al ProjectState.artifacts
  for (const f of parseOutputFiles(agent.output)) {
    next.artifacts[f] = { phase: phaseName, phaseId, agent: agent.name, ts: new Date().toISOString().slice(11,19) };
  }
  // Métricas específicas por agente (mismo cálculo que el código original, pero per-step)
  if (agent.id === "testing") next.eval_pass_rate = scenario.evalRate;
  if (agent.id === "validation") next.goal_drift_score = scenario.goalDrift;
  if (agent.id === "hitl_gate") next.acceptance_rate = Math.min(0.93, 0.70 + phaseId * 0.04);
  if (agent.id === "rollout") next.rollout_stage = "100%";
  if (agent.id === "sre") next.sre_status = "monitoring";
  // Inicializa los acumulados si es la primera vez
  if (next.eval_pass_rate === undefined) next.eval_pass_rate = base.eval_pass_rate || 0;
  if (next.goal_drift_score === undefined) next.goal_drift_score = base.goal_drift_score || 0;
  if (next.acceptance_rate === undefined) next.acceptance_rate = base.acceptance_rate || 0.70;
  return next;
}

// ─── PROJECT STATE SCHEMA ─── Estructura completa que el ADLC enriquece capa por capa
const PROJECT_STATE_SCHEMA = {
  // ── META ──────────────────────────────────────────────
  version: "1.0.0",
  project_id: "",
  created_at: "",
  phase: "iniciando",
  mode: "greenfield",        // greenfield | brownfield

  // ── CAPA 0: REQUERIMIENTO HUMANO ORIGINAL ─────────────
  requirement: {
    raw: "",                 // texto libre del usuario
    domain: "",              // fintech | healthcare | retail | etc
    project_type: "",        // nueva feature | nuevo sistema | mejora | migración
    constraints: [],         // restricciones explícitas del usuario
  },

  // ── CAPA 1: DESCUBRIMIENTO (Fase 0) ───────────────────
  discovery: {
    pain_points: [],         // [{description, severity, automation_potential}]
    data_readiness_score: 0, // 0-1
    hypotheses: [],          // [{id, description, priority, success_signal}]
    responsibility_map: {},
    constraint_map: {},
    context_type: "",
  },

  // ── CAPA 2: DISEÑO (Fase 1) ───────────────────────────
  design: {
    intent_spec: { content: "", version: "", hash: "" },
    capability_matrix: { llm_decisions: [], deterministic_logic: [] },
    user_stories: [],
    ux_context: { figma_url: "", design_tokens: {}, components: [], style_guide: "" },
    architecture: {
      pattern: "",
      stack: { language: "", framework: "", database: "", infra: "" },
      adr: [],
      agent_graph: {},
    },
    business_case: { roi_expected: "", max_monthly_budget_usd: 0, go_no_go_criteria: {} },
  },

  // ── CAPA 3: IMPLEMENTACIÓN (Fase 2) ───────────────────
  implementation: {
    files_generated: [],
    dependencies_validated: [],
    dependencies_rejected: [],
    review_score: 0,
    sast_issues: [],
    sca_issues: [],
  },

  // ── CAPA 4: QA (Fase 3) ───────────────────────────────
  qa: {
    evals_total: 0,
    evals_passed: 0,
    eval_pass_rate: 0,
    critical_failures: 0,
    goal_drift_score: 0,
    behavioral_samples: [],
    staging_validated: false,
  },

  // ── CAPA 5: DEVOPS / DEVSECOPS (Fase 4) ───────────────
  devops: {
    deploy_manifest_hash: "",
    pre_deploy_checks: {},
    rollout_stages: [],
    current_rollout_pct: 0,
    compliance: { policy_violations: 0, audit_trail_entries: 0, retention_days: 365, regulation: "CMF_Chile" },
    security: { sast_passed: false, sca_passed: false, secrets_scan_passed: false, container_scan_passed: false },
  },

  // ── CAPA 6: PRODUCTO (Fase 5) ─────────────────────────
  product: {
    deployed_at: "",
    url: "",
    acceptance_rate: 0,
    supervision_burden_hours: 0,
    incidents: [],
    flywheel_cycles: 0,
    pmo_report: {},
  },

  // ── META-ESTADO ───────────────────────────────────────
  agents_completed: 0,
  audit_entries: 0,
  context_budget_used: 0,
  context_budget_total: 180000,
};

function DemoPage({ t, dark, onNavigate, canonicalState, setCanonicalState, setCanonicalLive }) {
  const [running,setRunning]=useState(false);
  const [jsonTab,setJsonTab]=useState("info");
  const [currentPhase,setCurrentPhase]=useState(-1);
  const [currentAgent,setCurrentAgent]=useState(null);
  const [agentStatuses,setAgentStatuses]=useState({});
  const [auditLog,setAuditLog]=useState([]);
  const [hitlModal,setHitlModal]=useState(null);
  const [selectedScenario,setSelectedScenario]=useState("normal");
  const [requirement,setRequirement]=useState("");
  const [viewArtifact,setViewArtifact]=useState(null); // filename actual o null
  const [metrics,setMetrics]=useState({acceptance:0,escalation:0,burden:0,drift:0,eval:0});
  const [projectState,setProjectState]=useState(null);
  const [psTab,setPsTab]=useState("state"); // "state" | "diff" | "timeline"
  const [psHistoryIdx,setPsHistoryIdx]=useState(null); // índice en history seleccionado en timeline
  const [completedPhases,setCompletedPhases]=useState([]);
  const [rightTab,setRightTab]=useState("estado"); // "estado" | "evolucion" | "audit"
  const [log,setLog]=useState([]);
  const [incident,setIncident]=useState(null);
  const hitlRef=useRef(null);
  const cancelRef=useRef(false);
  const auditRef=useRef(auditLog);
  auditRef.current=auditLog;
  const scenario=SCENARIOS[selectedScenario];

  const addLog=useCallback((msg,type="info")=>setLog(p=>[...p.slice(-80),{msg,type,ts:new Date().toISOString().slice(11,19)}]),[]);
  const addAudit=useCallback((agent,action,tier,human=false)=>setAuditLog(p=>[...p.slice(-50),{ts:new Date().toISOString().slice(11,19),agent,action,tier,human,hash:Math.random().toString(36).slice(2,10)}]),[]);
  const waitHITL=useCallback(cp=>new Promise(res=>{hitlRef.current=res;setJsonTab("info");setHitlModal(cp);}),[]);
  const approve=useCallback(()=>{setHitlModal(null);addLog(`HITL aprobado — ${hitlModal?.agent}`,"success");addAudit(hitlModal?.agent,"HITL aprobado",hitlModal?.tier,true);hitlRef.current?.("approved");},[hitlModal,addLog,addAudit]);
  const reject=useCallback(()=>{setHitlModal(null);addLog(`HITL rechazado — ${hitlModal?.agent}`,"error");addAudit(hitlModal?.agent,"HITL rechazado",hitlModal?.tier,true);hitlRef.current?.("rejected");},[hitlModal,addLog,addAudit]);
  const setAS=useCallback((id,s)=>setAgentStatuses(p=>({...p,[id]:s})),[]);

  const runAgent=useCallback(async(agent,phase)=>{
    if(cancelRef.current)return"cancelled";
    setCurrentAgent(agent.id);setAS(agent.id,"running");
    addLog(`  > ${agent.name} ejecutando...`,"agent");addAudit(agent.name,agent.action,agent.tier);
    await sleep(700+Math.random()*400);if(cancelRef.current)return"cancelled";
    const ev=scenario.events.find(e=>e.phase===phase&&e.agent===agent.id);
    if(ev?.type==="cascade"){for(let i=0;i<3;i++){addLog(`    [ERROR] fallo ${i+1}/3`,"error");await sleep(350);}addLog("    [CIRCUIT BREAKER] abierto","error");setAS(agent.id,"error");setIncident({type:"cascade",agent:agent.name,phase});addAudit(agent.name,"circuit_breaker_open",agent.tier);return"cascade";}
    if(ev?.type==="drift"){addLog(`    [DRIFT] score=${ev.value}`,"error");setAS(agent.id,"error");setMetrics(m=>({...m,drift:ev.value}));setIncident({type:"drift",agent:agent.name,phase,value:ev.value});addAudit(agent.name,`goal_drift:${ev.value}`,agent.tier);return"drift";}
    if(agent.hitl){setAS(agent.id,"hitl");addLog(`    [HITL T${agent.tier}] esperando aprobación...`,"hitl");const r=await waitHITL({agent:agent.id,action:`Revisar: ${agent.output}`,tier:agent.tier,phase});if(cancelRef.current)return"cancelled";if(r==="rejected"){setAS(agent.id,"skipped");return"rejected";}}
    setAS(agent.id,"done");addLog(`    Output: ${agent.output}`,"output");addAudit(agent.name,`completado — ${agent.output}`,agent.tier,agent.hitl);
    setMetrics(m=>({...m,acceptance:Math.min(0.95,m.acceptance+0.02),escalation:Math.min(0.96,m.escalation+0.015)}));
    // Mutación incremental del ProjectState — un step por agente
    setProjectState(prev=>{
      const ph=PHASES_DATA[phase];
      const next=applyAgentToState(prev,{agent,phaseId:phase,phaseName:ph.name,auditCount:auditRef.current.length+1,scenario});
      const d=diffState(prev,next);
      const entry={ts:new Date().toISOString().slice(11,19),agent:agent.name,phase:ph.name,phaseId:phase,action:agent.action,diff:d,snapshot:{...next,history:undefined}};
      next.history=[...(prev?.history||[]),entry];
      const adds=d.artifactsAdded.length, chg=d.changed.length;
      if(adds||chg) addLog(`    ProjectState +${adds} artefacto${adds!==1?"s":""}${chg?`, ${chg} campo${chg!==1?"s":""} cambiado${chg!==1?"s":""}`:""}`,"output");
      return next;
    });
    return"ok";
  },[scenario,addLog,addAudit,waitHITL,setAS]);

  const runPhase=useCallback(async pid=>{
    if(cancelRef.current)return"cancelled";
    const ph=PHASES_DATA[pid];setCurrentPhase(pid);addLog(`\n[${ph.name.toUpperCase()} — ${ph.subtitle.toUpperCase()}]`,"phase");await sleep(300);
    for(const a of AGENTS_BY_PHASE[pid]){if(cancelRef.current)return"cancelled";const r=await runAgent(a,pid);if(r!=="ok")return r;await sleep(200);}
    setCompletedPhases(p=>[...p,pid]);addLog(`[${ph.name} COMPLETADA]`,"phase_done");
    if(pid===3)setMetrics(m=>({...m,eval:scenario.evalRate,drift:scenario.goalDrift,acceptance:Math.min(0.93,0.70+pid*0.04),escalation:0.87,burden:2.5}));
    // Enriquecimiento del ProjectState al cierre de cada fase — agrega la capa correspondiente
    setProjectState(prev=>{
      if(!prev) return prev;
      if(pid===0) return {...prev, discovery:{
        pain_points:[
          {description:"40% rechazos por formato de documentos", severity:"high", automation_potential:0.92},
          {description:"Notificaciones de estado manuales", severity:"medium", automation_potential:0.85},
          {description:"Re-solicitud de documentos faltantes", severity:"medium", automation_potential:0.78},
        ],
        data_readiness_score:0.81,
        hypotheses:[
          {id:"HYP-001", description:"Automatizar validación de formato puede reducir rechazos en 70%", priority:1, success_signal:"error_rate < 0.10"},
          {id:"HYP-002", description:"Notificaciones automáticas reducen tiempo de espera 2 días", priority:2, success_signal:"cycle_time < 3_days"},
        ],
        responsibility_map:{},
        constraint_map:{},
        context_type:"proceso_existente",
      }};
      if(pid===1) return {...prev, design:{
        intent_spec:{ version:"1.0.0", hash:"a3f7c2e1", content:"Spec generada por Intent Agent" },
        capability_matrix:{
          llm_decisions:["interpretar_documento_libre","generar_mensaje_cliente"],
          deterministic_logic:["calcular_score_riesgo","validar_rut_formato","calcular_dias_habiles"],
        },
        user_stories:[
          {id:"US-001", as_a:"ejecutivo de onboarding", i_want:"recibir alerta cuando faltan documentos", so_that:"puedo contactar al cliente sin revisar manualmente", acceptance_criteria:["notificación en menos de 5 min","incluye lista de documentos faltantes"]},
          {id:"US-002", as_a:"cliente empresa", i_want:"saber el estado de mi solicitud en tiempo real", so_that:"no necesito llamar al banco", acceptance_criteria:["actualización automática por email","estado visible en portal"]},
        ],
        ux_context:{ figma_url:"", design_tokens:{}, components:[], style_guide:"" },
        architecture:{
          pattern:"hybrid",
          stack:{language:"python", framework:"fastapi", database:"postgresql", infra:"docker"},
          adr:[{id:"ADR-001", decision:"Usar patrón híbrido Plan-Execute + ReAct", rationale:"Mayor predictibilidad en flujo principal", consequences:"Flexibilidad por agente"}],
          agent_graph:{},
        },
        business_case:{ roi_expected:"", max_monthly_budget_usd:0, go_no_go_criteria:{} },
      }};
      if(pid===2) return {...prev, implementation:{
        files_generated:[
          {path:"agents/validation_agent.py", language:"python", lines_of_code:187},
          {path:"agents/notification_agent.py", language:"python", lines_of_code:134},
          {path:"tests/test_validation.py", language:"python", lines_of_code:89},
        ],
        dependencies_validated:["pydantic==2.8","httpx==0.27","anthropic==0.34"],
        dependencies_rejected:[],
        review_score:0.91,
        sast_issues:[],
        sca_issues:[],
      }};
      if(pid===3) return {...prev, qa:{
        evals_total:24, evals_passed:22, eval_pass_rate:0.92,
        critical_failures:0, goal_drift_score:scenario.goalDrift,
        behavioral_samples:[], staging_validated:true,
      }};
      if(pid===4) return {...prev, devops:{
        deploy_manifest_hash:"sha256:a7f3b2e1c4d9",
        pre_deploy_checks:{security:true, compliance:true, evals:true, intent_unchanged:true},
        rollout_stages:[
          {pct:5,  status:"completed", metrics_at_stage:{error_rate:0.001, acceptance_rate:0.87}},
          {pct:15, status:"completed", metrics_at_stage:{error_rate:0.001, acceptance_rate:0.89}},
          {pct:30, status:"completed", metrics_at_stage:{error_rate:0.002, acceptance_rate:0.88}},
          {pct:100,status:"completed", metrics_at_stage:{error_rate:0.001, acceptance_rate:0.90}},
        ],
        current_rollout_pct:100,
        compliance:{policy_violations:0, audit_trail_entries:auditRef.current.length, retention_days:365, regulation:"CMF_Chile"},
        security:{sast_passed:true, sca_passed:true, secrets_scan_passed:true, container_scan_passed:true},
      }};
      if(pid===5) return {...prev, product:{
        deployed_at: new Date().toISOString(),
        url:"",
        acceptance_rate:0.90,
        supervision_burden_hours:2.5,
        incidents:[],
        flywheel_cycles:1,
        pmo_report:{},
      }};
      return prev;
    });
    // Enriquecimiento del canonical project_state por fase — mergea los stages del template MACHBank
    // con timestamps reales de ejecución. Fase 0→discovery+hypothesis+mapping, Fase 1→spec_dev+architecture+business,
    // Fase 2→coding, Fase 3→validation (tests+static), Fase 4→validation (security+deploy), Fase 5→solo last_updated.
    setCanonicalState(prev=>{
      const ts = new Date().toISOString();
      const stamp = (section) => ({ ...section, _enriched_at: ts });
      const next = { ...prev, meta: { ...(prev?.meta || {}), last_updated: ts } };
      if (pid === 0) {
        next.discovery  = stamp(MACHBANK_PROJECT_STATE.discovery);
        next.hypothesis = stamp(MACHBANK_PROJECT_STATE.hypothesis);
        next.mapping    = stamp(MACHBANK_PROJECT_STATE.mapping);
      } else if (pid === 1) {
        next.spec_dev     = stamp(MACHBANK_PROJECT_STATE.spec_dev);
        next.architecture = stamp(MACHBANK_PROJECT_STATE.architecture);
        next.business     = { ...stamp(MACHBANK_PROJECT_STATE.business), eval_score: scenario.evalRate };
      } else if (pid === 2) {
        next.coding = stamp(MACHBANK_PROJECT_STATE.coding);
      } else if (pid === 3) {
        // Validation parcial: solo test_results + static_analysis + behavioral evals
        const v = MACHBANK_PROJECT_STATE.validation;
        next.validation = {
          _enriched_by: "Validation Agent",
          _enriched_at: ts,
          test_results: {
            ...v.test_results,
            behavioral_evals: { ...v.test_results.behavioral_evals, pass_rate: scenario.evalRate },
          },
          static_analysis: v.static_analysis,
        };
      } else if (pid === 4) {
        // Validation completa: mergea security_scan + deploy_status al validation existente
        const v = MACHBANK_PROJECT_STATE.validation;
        next.validation = {
          ...(prev.validation || {}),
          _enriched_by: "Validation + CI/CD + Rollout Agents",
          _enriched_at: ts,
          security_scan: v.security_scan,
          deploy_status: v.deploy_status,
        };
      }
      return next;
    });
    return"ok";
  },[runAgent,addLog,scenario,setCanonicalState]);

  const startDemo=useCallback(async()=>{
    cancelRef.current=false;setRunning(true);setCurrentPhase(-1);setCurrentAgent(null);setAgentStatuses({});setAuditLog([]);setLog([]);setCompletedPhases([]);
    setMetrics({acceptance:0.70,escalation:0.75,burden:0,drift:0,eval:0});
    {
      const reqText = requirement.trim() || scenario.requirementExample;
      // Reset canonical state a seed — solo meta + inicio con el prompt real
      const nowIso = new Date().toISOString();
      setCanonicalLive(true);
      setCanonicalState({
        meta: {
          project_id: "demo-" + Date.now(),
          created_at: nowIso,
          last_updated: nowIso,
          version: "0.0.1",
          stack_reference: "MACHBank/BCI",
        },
        inicio: {
          _enriched_by: "Humano — Producto",
          _enriched_at: nowIso,
          prompt_inicial: reqText,
          timestamp: nowIso,
          requester: "Producto · Onboarding Empresas",
        },
      });
      setProjectState({
        ...PROJECT_STATE_SCHEMA,
        project_id: "demo-" + Date.now(),
        created_at: new Date().toISOString(),
        phase: "iniciando",
        mode: "greenfield",
        requirement: { ...PROJECT_STATE_SCHEMA.requirement, raw: reqText, domain: "fintech", project_type: "nuevo sistema" },
        current_phase_id: -1,
        current_agent: null,
        agents_completed: 0,
        audit_entries: 0,
        goal_drift_score: 0,
        eval_pass_rate: 0,
        acceptance_rate: 0.70,
        artifacts: {},
        history: [],
      });
    }
    setPsTab("state");setPsHistoryIdx(null);
    setIncident(null);addLog(`ADLC DEMO — ${scenario.label}`,"header");addLog(scenario.description,"info");await sleep(600);
    for(let p=0;p<6;p++){if(cancelRef.current)break;const r=await runPhase(p);if(r==="cancelled")break;if(r==="rejected"){addLog(`\n[SISTEMA] Rechazo → regresando a Fase 0`,"error");setCurrentPhase(0);break;}if(r==="cascade"||r==="drift"){addLog("\n[SISTEMA] Escalada activada","error");break;}await sleep(400);}
    if(!cancelRef.current)addLog("\n[ADLC COMPLETADO] ↻ Fase 5 → Fase 0","success");
    setRunning(false);setCurrentAgent(null);
  },[scenario,runPhase,addLog,requirement,setCanonicalState,setCanonicalLive]);

  const stopDemo=useCallback(()=>{cancelRef.current=true;setRunning(false);setCurrentAgent(null);addLog("[DETENIDO]","error");},[addLog]);
  const logC={header:"#AFA9EC",phase:"#7F77DD",phase_done:"#1D9E75",agent:"#85B7EB",output:"#9FE1CB",hitl:"#FAC775",success:"#1D9E75",error:"#F09595",info:t.textMuted};
  const sC={idle:{label:"esperando",color:t.textFaint,bg:t.bgSubtle},running:{label:"ejecutando...",color:"#185FA5",bg:"#E6F1FB"},hitl:{label:"esperando HITL",color:"#BA7517",bg:"#FAEEDA"},done:{label:"completado",color:"#1D9E75",bg:"#E1F5EE"},error:{label:"error — escalando",color:"#E24B4A",bg:"#FCEBEB"},skipped:{label:"retrocediendo",color:"#993C1D",bg:"#FAECE7"}};

  // Requerimiento efectivo (input del usuario o ejemplo predefinido del escenario)
  const effectiveRequirement = requirement.trim() || scenario.requirementExample;
  const truncatedReq = effectiveRequirement.length > 60 ? effectiveRequirement.slice(0,60)+"..." : effectiveRequirement;

  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 52px)",background:t.bg}}>
      {/* REQUERIMIENTO DE ENTRADA — panel expandido cuando idle, pill colapsada cuando running */}
      <div style={{background:t.bgSubtle,borderBottom:`1px solid ${t.border}`,padding:"10px 18px",flexShrink:0}}>
        {!running?(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
              <span style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.12em"}}>REQUERIMIENTO DE ENTRADA</span>
              <span style={{fontSize:10,color:t.textFaint,fontFamily:"'Space Grotesk',sans-serif"}}>el ADLC transformará esto en un sistema agéntico desplegado</span>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
              <textarea
                value={requirement}
                onChange={e=>setRequirement(e.target.value)}
                rows={2}
                placeholder={"Describe el requerimiento de software que el ADLC va a procesar... \nEj: Automatizar el onboarding de clientes empresariales en MachBank — proceso actual toma 5 días hábiles"}
                style={{
                  flex:1,resize:"vertical",minHeight:44,padding:"8px 10px",borderRadius:8,
                  border:`1px solid ${t.border}`,background:t.bgCard,color:t.text,
                  fontFamily:"inherit",fontSize:12,lineHeight:1.5,outline:"none",
                }}
              />
              <button
                onClick={()=>setRequirement(scenario.requirementExample)}
                title="Carga el requerimiento ejemplo del escenario seleccionado"
                style={{
                  padding:"7px 12px",borderRadius:7,fontSize:10,fontWeight:700,
                  border:`1px solid ${scenario.color}50`,background:`${scenario.color}14`,
                  color:scenario.color,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0,
                }}
              >Cargar ejemplo</button>
            </div>
          </div>
        ):(
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",flexShrink:0}}>ENTRADA:</span>
            <span title={effectiveRequirement} style={{
              display:"inline-block",padding:"4px 11px",borderRadius:14,
              background:`${scenario.color}14`,border:`1px solid ${scenario.color}40`,
              color:scenario.color,fontSize:11,fontWeight:600,
              maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
            }}>{truncatedReq}</span>
          </div>
        )}
      </div>
      <div style={{background:t.headerBg,padding:"7px 18px",display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
        <span style={{fontSize:10,color:"#555",marginRight:3}}>escenario:</span>
        {Object.entries(SCENARIOS).map(([key,s])=>(
          <button key={key} onClick={()=>!running&&setSelectedScenario(key)} title={s.description} style={{padding:"3px 11px",borderRadius:20,fontSize:11,fontWeight:700,cursor:running?"not-allowed":"pointer",border:`1px solid ${selectedScenario===key?s.color:"#444"}`,background:selectedScenario===key?`${s.color}22`:"transparent",color:selectedScenario===key?s.color:"#666",fontFamily:"inherit",transition:"all 0.15s"}}>
            {s.label}
          </button>
        ))}
        <div style={{flex:1}}/>
        {incident&&<div style={{fontSize:11,color:"#E24B4A",fontWeight:700}}>INCIDENTE ACTIVO</div>}
        {running&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#1D9E75"}}><div style={{width:5,height:5,borderRadius:"50%",background:"#1D9E75",animation:"pulse 1s infinite"}}/> ejecutando</div>}
        {!running?<button onClick={startDemo} style={{padding:"5px 14px",borderRadius:7,background:"#1D9E75",color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Ejecutar</button>
        :<button onClick={stopDemo} style={{padding:"5px 14px",borderRadius:7,background:"#E24B4A",color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Detener</button>}
      </div>
      <div style={{background:`${scenario.color}10`,borderBottom:`2px solid ${scenario.color}25`,padding:"4px 18px",flexShrink:0}}>
        <span style={{fontSize:11,color:scenario.color,fontWeight:600}}>{scenario.description}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"196px 1fr 256px",flex:1,overflow:"hidden"}}>
        {/* Phases */}
        <div style={{background:t.bgSubtle,borderRight:`1px solid ${t.border}`,padding:"10px 8px",display:"flex",flexDirection:"column",gap:3,overflowY:"auto"}}>
          <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",marginBottom:3}}>FASES</div>
          {PHASES_DATA.map(ph=>{
            const isA=currentPhase===ph.id,isDone=completedPhases.includes(ph.id);
            return(<div key={ph.id} title={ph.why} style={{padding:"7px 9px",borderRadius:7,border:`1px solid ${isA?ph.color.main:isDone?`${ph.color.main}45`:t.border}`,background:isA?t.bgCard:isDone?`${ph.color.light}${dark?"44":""}`:t.bgMuted,transition:"all 0.25s",opacity:!running&&!isDone&&currentPhase!==ph.id&&currentPhase!==-1?0.35:1,cursor:"help"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}>
                <span style={{fontSize:11,fontWeight:700,color:isA?ph.color.main:isDone?ph.color.main:t.textSub}}>{ph.name}</span>
                <span style={{fontSize:9,fontWeight:700,color:ph.color.main,background:`${ph.color.main}16`,padding:"1px 5px",borderRadius:8}}>{ph.tier}</span>
              </div>
              <div style={{fontSize:10,color:t.textMuted}}>{ph.subtitle}</div>
              {isA&&<div style={{marginTop:3,height:2,background:ph.color.main,borderRadius:1,animation:"pulse 1s infinite"}}/>}
              {isDone&&!isA&&<div style={{marginTop:2,fontSize:9,color:"#1D9E75",fontWeight:600}}>completada</div>}
            </div>);
          })}
          {completedPhases.length===6&&<div style={{marginTop:5,padding:"6px 9px",borderRadius:7,background:`${C.teal.light}${dark?"44":""}`,border:"1px dashed #1D9E75"}}><div style={{fontSize:10,color:"#0F6E56",fontWeight:700}}>↻ FEEDBACK LOOP</div><div style={{fontSize:9,color:"#1D9E75",marginTop:1}}>Fase 5 → Fase 0</div></div>}
        </div>
        {/* Agents */}
        <div style={{padding:13,overflowY:"auto"}}>
          {currentPhase>=0?(
            <>
              <div style={{marginBottom:9,display:"flex",alignItems:"center",gap:7}}>
                <span style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:14,fontWeight:700,color:PHASES_DATA[currentPhase]?.color.main}}>{PHASES_DATA[currentPhase]?.name} — {PHASES_DATA[currentPhase]?.subtitle}</span>
                {running&&<div style={{width:6,height:6,borderRadius:"50%",background:PHASES_DATA[currentPhase]?.color.main,animation:"pulse 0.8s infinite"}}/>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {AGENTS_BY_PHASE[currentPhase]?.map(a=>{
                  const st=agentStatuses[a.id]||"idle";const s=sC[st]||sC.idle;
                  return(<div key={a.id} title={`${a.name}: ${a.action}`} style={{background:currentAgent===a.id?t.bgCard:t.bgMuted,border:`1px solid ${currentAgent===a.id?PHASES_DATA[currentPhase]?.color.main:t.border}`,borderRadius:8,padding:"8px 10px",transition:"all 0.2s",opacity:st==="idle"?0.5:1,boxShadow:currentAgent===a.id?`0 2px 10px ${PHASES_DATA[currentPhase]?.color.main}18`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{fontSize:12,fontWeight:700,color:t.text}}>{a.name}</span>
                      <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:9,color:TIER_C[a.tier],background:TIER_BG[a.tier]}}>{TIER_L[a.tier]}</span>
                    </div>
                    <div style={{fontSize:11,color:t.textSub,marginBottom:4}}>{a.action}</div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:10,fontWeight:600,color:s.color,background:s.bg,padding:"2px 7px",borderRadius:9,border:`1px solid ${s.color}25`}}>{s.label}</span>
                      {st==="done"&&<span style={{fontSize:10,color:t.textFaint,fontFamily:"monospace"}}>{a.output}</span>}
                    </div>
                  </div>);
                })}
              </div>
              {incident&&<div style={{marginTop:11,padding:11,borderRadius:8,background:"#FCEBEB",border:"2px solid #E24B4A"}}><div style={{fontSize:12,fontWeight:700,color:"#E24B4A",marginBottom:3}}>{incident.type==="cascade"?"CIRCUIT BREAKER ABIERTO":"GOAL DRIFT DETECTADO"}</div><div style={{fontSize:11,color:"#791F1F"}}>{incident.type==="cascade"?"Sistema pausado. Engineering Manager notificado.":"SRE Agent activado. Rollback preventivo iniciado."}</div></div>}

              {/* PRODUCTO DE SALIDA — solo cuando el flujo termina exitosamente las 6 fases */}
              {completedPhases.length===6&&(
                <div style={{marginTop:14,border:`2px solid ${C.teal.main}`,borderRadius:12,overflow:"hidden",background:t.bgCard,animation:"fadeIn 0.5s ease"}}>
                  {/* Sección superior: SISTEMA ENTREGADO */}
                  <div style={{padding:"14px 16px",background:`${C.teal.main}10`,borderBottom:`1px solid ${C.teal.main}30`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:8}}>
                      <div style={{fontSize:10,fontWeight:800,color:C.teal.main,letterSpacing:"0.12em"}}>SISTEMA ENTREGADO</div>
                      <span style={{fontSize:10,fontWeight:700,color:C.teal.main,background:`${C.teal.main}18`,padding:"3px 9px",borderRadius:11,border:`1px solid ${C.teal.main}40`,whiteSpace:"nowrap",flexShrink:0}}>✓ Desplegado en producción</span>
                    </div>
                    <div style={{fontSize:14,fontWeight:700,color:t.text,fontFamily:"'Space Grotesk',sans-serif",lineHeight:1.4,marginBottom:6}}>{effectiveRequirement}</div>
                    <div style={{fontSize:10,color:t.textMuted,fontFamily:"monospace"}}>deploy: {new Date().toLocaleString("es-CL",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
                  </div>

                  {/* Sección de artefactos generados — clickables para ver MD */}
                  <div style={{padding:"12px 16px",borderBottom:`1px solid ${t.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
                      <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em"}}>ARTEFACTOS GENERADOS</div>
                      <div style={{fontSize:9,color:t.textFaint,fontStyle:"italic"}}>click para ver el handoff</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                      {DELIVERED_ARTIFACTS.flatMap(({phase,files})=>{
                        const ph=PHASES_DATA[phase];
                        return files.map(f=>(
                          <button key={f} onClick={()=>setViewArtifact(f)} title={`Ver ${f} en markdown`} style={{
                            display:"flex",alignItems:"center",gap:6,padding:"5px 9px",borderRadius:6,
                            background:`${ph.color.main}0E`,border:`1px solid ${ph.color.main}33`,
                            cursor:"pointer",fontFamily:"inherit",textAlign:"left",
                            transition:"all 0.15s",
                          }}
                          onMouseEnter={e=>{e.currentTarget.style.background=`${ph.color.main}22`;e.currentTarget.style.borderColor=`${ph.color.main}66`;}}
                          onMouseLeave={e=>{e.currentTarget.style.background=`${ph.color.main}0E`;e.currentTarget.style.borderColor=`${ph.color.main}33`;}}>
                            <span style={{fontSize:8,fontWeight:700,color:ph.color.main,background:`${ph.color.main}22`,padding:"1px 5px",borderRadius:4,letterSpacing:"0.05em",flexShrink:0}}>F{phase}</span>
                            <span style={{fontSize:11,fontFamily:"monospace",color:ph.color.main,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f}</span>
                          </button>
                        ));
                      })}
                    </div>
                  </div>

                  {/* Sección de métricas finales */}
                  <div style={{padding:"12px 16px",borderBottom:`1px solid ${t.border}`}}>
                    <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",marginBottom:8}}>MÉTRICAS FINALES</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
                      {[
                        {label:"acceptance_rate",v:metrics.acceptance,fmt:v=>v.toFixed(2)},
                        {label:"goal_drift_score",v:metrics.drift,fmt:v=>v.toFixed(2)},
                        {label:"eval_pass_rate",v:metrics.eval,fmt:v=>v.toFixed(2)},
                        {label:"supervision_burden",v:metrics.burden,fmt:v=>v.toFixed(1)+"h"},
                      ].map(m=>(
                        <div key={m.label} style={{background:t.bgSubtle,borderRadius:6,padding:"6px 8px"}}>
                          <div style={{fontSize:9,color:t.textMuted,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{m.label}</div>
                          <div style={{fontSize:13,fontWeight:700,color:t.text,fontFamily:"monospace"}}>{m.fmt(m.v)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Audit trail footer */}
                  <div style={{padding:"9px 16px",fontSize:10,color:t.textMuted,fontFamily:"monospace",background:t.bgMuted}}>
                    Audit trail: {auditLog.length} entradas — evidencia regulatoria CMF Chile
                  </div>
                </div>
              )}
            </>
          ):(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"60%",textAlign:"center"}}>
              <div style={{fontSize:22,opacity:0.15,marginBottom:10,color:t.text}}>◎</div>
              <div style={{fontSize:13,color:t.textSub,marginBottom:5,fontFamily:"'Space Grotesk',sans-serif"}}>Selecciona un escenario y ejecuta</div>
              <div style={{fontSize:11,color:t.textMuted,maxWidth:240,lineHeight:1.6}}>Los términos con borde punteado abren el glosario. Hover sobre agentes y fases para tooltips.</div>
            </div>
          )}
        </div>
        {/* Right */}
        <div style={{background:t.bgSubtle,borderLeft:`1px solid ${t.border}`,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* TAB BAR derecha — Estado / Evolución / Audit */}
          <div style={{display:"flex",borderBottom:`1px solid ${t.border}`,flexShrink:0,background:t.bgMuted}}>
            {[["estado","Estado"],["evolucion","Evolución"],["audit","Audit"]].map(([id,label])=>(
              <button key={id} onClick={()=>setRightTab(id)}
                style={{flex:1,padding:"8px 6px",background:rightTab===id?t.bgCard:"transparent",border:"none",borderBottom:rightTab===id?`2px solid ${C.purple.main}`:"2px solid transparent",fontSize:10,fontWeight:rightTab===id?700:600,color:rightTab===id?t.text:t.textMuted,cursor:"pointer",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"0.06em",textTransform:"uppercase",transition:"all 0.15s"}}>
                {label}
              </button>
            ))}
          </div>
          {rightTab==="estado"&&(<>
          <div style={{padding:"10px 12px",borderBottom:`1px solid ${t.border}`,flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em"}}>PROJECT STATE</div>
              {projectState?.history?.length>0&&<div style={{fontSize:9,color:t.textFaint,fontFamily:"monospace"}}>{projectState.history.length} mut</div>}
            </div>
            {projectState?(<>
              {/* Tabs */}
              <div style={{display:"flex",gap:2,marginBottom:6,borderBottom:`1px solid ${t.border}`}}>
                {[["state","estado"],["diff","diff"],["timeline","timeline"]].map(([id,label])=>(
                  <button key={id} onClick={()=>{setPsTab(id);if(id!=="timeline")setPsHistoryIdx(null);}}
                    style={{background:psTab===id?t.bgCard:"transparent",border:"none",borderBottom:psTab===id?`2px solid ${C.purple}`:"2px solid transparent",padding:"4px 8px",fontSize:9,fontWeight:600,color:psTab===id?t.text:t.textMuted,cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.05em",textTransform:"uppercase"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{flex:1,overflowY:"auto",fontSize:10,fontFamily:"monospace"}}>
                {/* TAB: ESTADO ACTUAL */}
                {psTab==="state"&&(()=>{
                  const view=psHistoryIdx!=null&&projectState.history[psHistoryIdx]?projectState.history[psHistoryIdx].snapshot:projectState;
                  const fields=[
                    ["phase",view.phase],
                    ["current_agent",view.current_agent||"—"],
                    ["agents_completed",view.agents_completed||0],
                    ["audit_entries",view.audit_entries||0],
                    ["eval_pass_rate",(view.eval_pass_rate??0).toFixed(2)],
                    ["goal_drift_score",(view.goal_drift_score??0).toFixed(2)],
                    ["acceptance_rate",(view.acceptance_rate??0).toFixed(2)],
                  ];
                  const arts=Object.entries(view.artifacts||{});
                  return(<div>
                    {psHistoryIdx!=null&&<div style={{fontSize:9,color:"#BA7517",marginBottom:5,fontFamily:"inherit",fontStyle:"italic"}}>📌 viendo snapshot histórico — <button onClick={()=>setPsHistoryIdx(null)} style={{background:"none",border:"none",color:C.purple,cursor:"pointer",fontSize:9,padding:0,textDecoration:"underline"}}>volver al actual</button></div>}
                    {fields.map(([k,v])=>(
                      <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:`1px dotted ${t.border}`}}>
                        <span style={{color:t.textFaint}}>{k}</span>
                        <span style={{color:t.text,fontWeight:600}}>{String(v)}</span>
                      </div>
                    ))}
                    <div style={{marginTop:8,fontSize:9,color:t.textMuted,letterSpacing:"0.05em",textTransform:"uppercase",fontWeight:700}}>artifacts ({arts.length})</div>
                    {arts.length===0?<div style={{color:t.textFaint,fontStyle:"italic",padding:"4px 0"}}>—</div>:
                      arts.map(([f,meta])=>(
                        <div key={f} style={{padding:"3px 0",borderBottom:`1px dotted ${t.border}`}}>
                          <div style={{color:t.text,fontWeight:600,wordBreak:"break-all"}}>{f}</div>
                          <div style={{color:t.textFaint,fontSize:9}}>← {meta.agent} · {meta.phase}</div>
                        </div>
                      ))
                    }
                  </div>);
                })()}
                {/* TAB: DIFF */}
                {psTab==="diff"&&(()=>{
                  const idx=psHistoryIdx!=null?psHistoryIdx:(projectState.history.length-1);
                  const entry=projectState.history[idx];
                  if(!entry)return<div style={{color:t.textFaint,fontStyle:"italic"}}>sin mutaciones todavía</div>;
                  const d=entry.diff;
                  return(<div>
                    <div style={{fontSize:9,color:t.textMuted,marginBottom:6}}>step {idx+1}/{projectState.history.length} · <span style={{color:t.text,fontWeight:600}}>{entry.agent}</span> · {entry.phase}</div>
                    {d.artifactsAdded.length>0&&<div style={{marginBottom:6}}>
                      <div style={{fontSize:9,color:"#1D9E75",fontWeight:700,marginBottom:2}}>+ ARTEFACTOS ({d.artifactsAdded.length})</div>
                      {d.artifactsAdded.map(f=>(
                        <div key={f} style={{color:"#1D9E75",padding:"1px 0 1px 8px",borderLeft:"2px solid #1D9E75",marginBottom:1,wordBreak:"break-all"}}>+ {f}</div>
                      ))}
                    </div>}
                    {d.changed.length>0&&<div style={{marginBottom:6}}>
                      <div style={{fontSize:9,color:"#BA7517",fontWeight:700,marginBottom:2}}>~ CAMPOS CAMBIADOS ({d.changed.length})</div>
                      {d.changed.map(c=>(
                        <div key={c.k} style={{padding:"2px 0 2px 8px",borderLeft:"2px solid #BA7517",marginBottom:2}}>
                          <div style={{color:t.text,fontWeight:600}}>{c.k}</div>
                          <div style={{color:"#E24B4A",fontSize:9}}>- {String(c.from)}</div>
                          <div style={{color:"#1D9E75",fontSize:9}}>+ {String(c.to)}</div>
                        </div>
                      ))}
                    </div>}
                    {d.added.length>0&&<div>
                      <div style={{fontSize:9,color:"#1D9E75",fontWeight:700,marginBottom:2}}>+ CAMPOS NUEVOS ({d.added.length})</div>
                      {d.added.map(a=>(
                        <div key={a.k} style={{color:"#1D9E75",padding:"1px 0 1px 8px",borderLeft:"2px solid #1D9E75",marginBottom:1}}>+ {a.k}: {String(a.v)}</div>
                      ))}
                    </div>}
                    {d.added.length===0&&d.changed.length===0&&d.artifactsAdded.length===0&&<div style={{color:t.textFaint,fontStyle:"italic"}}>sin cambios</div>}
                  </div>);
                })()}
                {/* TAB: TIMELINE */}
                {psTab==="timeline"&&(
                  projectState.history.length===0?<div style={{color:t.textFaint,fontStyle:"italic"}}>sin mutaciones todavía</div>:
                  <div>
                    {projectState.history.map((e,i)=>{
                      const sel=psHistoryIdx===i;
                      const nAdds=e.diff.artifactsAdded.length, nChg=e.diff.changed.length;
                      return(
                        <button key={i} onClick={()=>{setPsHistoryIdx(i);setPsTab("state");}}
                          style={{display:"block",width:"100%",textAlign:"left",background:sel?t.bgCard:"transparent",border:"none",borderLeft:`2px solid ${sel?C.purple:t.border}`,padding:"4px 8px",marginBottom:2,cursor:"pointer",fontFamily:"inherit"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                            <span style={{fontSize:9,color:t.textFaint}}>#{i+1} {e.ts}</span>
                            <span style={{fontSize:9,color:C.purple,fontWeight:600}}>{e.phase}</span>
                          </div>
                          <div style={{fontSize:10,color:t.text,fontWeight:600,marginTop:1}}>{e.agent}</div>
                          <div style={{fontSize:9,color:t.textMuted,marginTop:1}}>
                            {nAdds>0&&<span style={{color:"#1D9E75"}}>+{nAdds} art </span>}
                            {nChg>0&&<span style={{color:"#BA7517"}}>~{nChg} campos</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>):<div style={{fontSize:11,color:t.textFaint}}>sin estado</div>}
          </div>
          <div style={{padding:"10px 12px",borderBottom:`1px solid ${t.border}`,flexShrink:0}}>
            <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",marginBottom:7}}>KPIs PMO</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {[
                {label:"acceptance rate",v:metrics.acceptance,max:1,w:0.65,d:0.5},
                {label:"supervision burden",v:metrics.burden,max:8,u:"h",w:4,d:8,fmt:v=>v.toFixed(1)},
                {label:"goal drift score",v:metrics.drift,max:0.5,w:0.3,d:0.4},
                {label:"eval pass rate",v:metrics.eval,max:1,w:0.85,d:0.75},
              ].map(({label,v,max,u="",w,d,fmt})=>{
                const pct=Math.min((v/max)*100,100);
                const col=d&&v>=d?"#E24B4A":w&&v>=w?"#BA7517":"#1D9E75";
                return(<div key={label} style={{display:"flex",flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <span style={{fontSize:10,color:t.textMuted}}>{label}</span>
                    <span style={{fontSize:13,fontWeight:700,color:col,fontFamily:"monospace"}}>{fmt?fmt(v):v.toFixed(2)}{u}</span>
                  </div>
                  <div style={{height:3,background:t.bgSubtle,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:2,transition:"width 0.6s ease"}}/></div>
                </div>);
              })}
            </div>
          </div>
          </>)}
          {rightTab==="evolucion"&&(()=>{
            // Vista de evolución del ProjectState — capas que se acumulan fase por fase
            const ps = projectState;
            const reqRaw = ps?.requirement?.raw || effectiveRequirement || "";
            const reqTrunc = reqRaw.length>50?reqRaw.slice(0,50)+"...":reqRaw;
            const pillBase = {fontSize:9,fontFamily:"'IBM Plex Mono',monospace",padding:"1px 6px",borderRadius:3,background:t.bgSubtle,border:`1px solid ${t.border}`,color:t.text,whiteSpace:"nowrap",display:"inline-block"};
            const pillRed = {...pillBase,background:C.red.light,color:C.red.main,border:`1px solid ${C.red.main}40`};
            const pillGreen = {...pillBase,background:C.teal.light,color:C.teal.main,border:`1px solid ${C.teal.main}40`};
            const pillPurple = {...pillBase,background:C.purple.light,color:C.purple.main,border:`1px solid ${C.purple.main}40`};

            // Define las 7 capas con su fase asociada (-1 = siempre visible)
            const layers = [
              {phaseIdx:-1, color:C.gray, name:"Requerimiento", badge:"H0", build:()=>{
                const r=ps?.requirement||{};
                return [r.domain||"—", r.project_type||"—", `mode: ${ps?.mode||"—"}`].map(x=>({label:x,style:pillBase}));
              }},
              {phaseIdx:0, color:C.teal, name:"Descubrimiento", badge:"F0", build:()=>{
                const d=ps?.discovery||{};
                return [
                  {label:`${d.pain_points?.length||0} pain points`,style:pillBase},
                  {label:`readiness: ${Math.round((d.data_readiness_score||0)*100)}%`,style:pillBase},
                  {label:`${d.hypotheses?.length||0} hipótesis`,style:pillBase},
                  {label:d.context_type||"—",style:pillBase},
                ];
              }},
              {phaseIdx:1, color:C.purple, name:"Diseño", badge:"F1", build:()=>{
                const dz=ps?.design||{};
                const arr=[
                  {label:`intent v${dz.intent_spec?.version||"—"}`,style:pillBase},
                  {label:`${dz.user_stories?.length||0} user stories`,style:pillBase},
                  {label:`stack: ${dz.architecture?.stack?.language||"—"}/${dz.architecture?.stack?.framework||"—"}`,style:pillBase},
                  {label:`${dz.architecture?.adr?.length||0} ADRs`,style:pillBase},
                ];
                if(dz.ux_context?.figma_url) arr.push({label:"figma: conectado",style:pillPurple});
                return arr;
              }},
              {phaseIdx:2, color:C.blue, name:"Implementación", badge:"F2", build:()=>{
                const im=ps?.implementation||{};
                const arr=[
                  {label:`${im.files_generated?.length||0} archivos`,style:pillBase},
                  {label:`${im.dependencies_validated?.length||0} deps validadas`,style:pillBase},
                  {label:`review: ${Math.round((im.review_score||0)*100)}%`,style:pillBase},
                ];
                if((im.dependencies_rejected?.length||0)>0) arr.push({label:`${im.dependencies_rejected.length} alucinadas bloqueadas`,style:pillRed});
                return arr;
              }},
              {phaseIdx:3, color:C.amber, name:"QA", badge:"F3", build:()=>{
                const q=ps?.qa||{};
                const arr=[
                  {label:`evals: ${q.evals_passed||0}/${q.evals_total||0}`,style:pillBase},
                  {label:`drift: ${(q.goal_drift_score||0).toFixed(2)}`,style:pillBase},
                ];
                if((q.goal_drift_score||0)>0.30) arr.push({label:"DRIFT ALTO",style:pillRed});
                if(q.critical_failures===0) arr.push({label:"sin críticos",style:pillGreen});
                return arr;
              }},
              {phaseIdx:4, color:C.coral, name:"DevOps/DevSecOps", badge:"F4", build:()=>{
                const dv=ps?.devops||{};
                return [
                  {label:`rollout ${dv.current_rollout_pct||0}%`,style:pillBase},
                  {label:dv.security?.sast_passed?"SAST ✓":"SAST —",style:pillBase},
                  {label:dv.security?.sca_passed?"SCA ✓":"SCA —",style:pillBase},
                  {label:`compliance: ${dv.compliance?.regulation==="CMF_Chile"?"CMF":(dv.compliance?.regulation||"—")}`,style:pillBase},
                  {label:`${dv.compliance?.audit_trail_entries||0} entradas audit`,style:pillBase},
                ];
              }},
              {phaseIdx:5, color:C.green, name:"Producto", badge:"F5", build:()=>{
                const pr=ps?.product||{};
                return [
                  {label:`acceptance: ${Math.round((pr.acceptance_rate||0)*100)}%`,style:pillBase},
                  {label:`burden: ${(pr.supervision_burden_hours||0).toFixed(1)}h/sem`,style:pillBase},
                  {label:`${pr.incidents?.length||0} incidentes`,style:pillBase},
                  {label:`flywheel: ${pr.flywheel_cycles||0} ciclos`,style:pillBase},
                ];
              }},
            ];

            const empty = (!completedPhases || completedPhases.length===0) && !running;

            return (
              <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
                {/* Encabezado */}
                <div style={{padding:"12px 12px 8px",borderBottom:`1px solid ${t.border}`,flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",fontFamily:"'Space Grotesk',sans-serif",marginBottom:4}}>ENRIQUECIMIENTO DEL PROJECTSTATE</div>
                  <div style={{fontSize:10,color:t.textSub,fontStyle:"italic",lineHeight:1.4}} title={reqRaw}>{reqTrunc||"—"}</div>
                </div>
                {/* Línea de tiempo */}
                <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>
                  {empty?(
                    <div style={{fontSize:11,color:t.textFaint,lineHeight:1.6,padding:"20px 4px",fontStyle:"italic"}}>
                      El enriquecimiento del ProjectState aparece aquí a medida que las fases se completan
                    </div>
                  ):layers.map((layer,li)=>{
                    const isActive = layer.phaseIdx===-1 || completedPhases.includes(layer.phaseIdx);
                    const pills = layer.build();
                    const isLast = li===layers.length-1;
                    return (
                      <div key={li} style={{display:"flex",gap:9,opacity:isActive?1:0.4,transition:"opacity 0.3s"}}>
                        {/* Indicador vertical: punto + línea */}
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,paddingTop:3}}>
                          <div style={{width:9,height:9,borderRadius:"50%",background:isActive?layer.color.main:t.bgSubtle,border:`2px solid ${isActive?layer.color.main:t.border}`,flexShrink:0}}/>
                          {!isLast&&<div style={{width:2,flex:1,minHeight:18,background:isActive?layer.color.main:t.border,marginTop:2,marginBottom:2}}/>}
                        </div>
                        {/* Contenido */}
                        <div style={{flex:1,paddingBottom:isLast?0:14,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                            <span style={{fontSize:10,fontWeight:700,color:isActive?layer.color.main:t.textFaint,fontFamily:"'Space Grotesk',sans-serif"}}>{layer.name}</span>
                            <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,color:layer.color.main,background:`${layer.color.main}18`,fontFamily:"'IBM Plex Mono',monospace"}}>{layer.badge}</span>
                          </div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                            {pills.map((p,pi)=>(<span key={pi} style={p.style}>{p.label}</span>))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          {rightTab==="audit"&&(
          <div style={{flex:1,padding:"10px 12px",overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{fontSize:9,fontWeight:700,color:t.textMuted,letterSpacing:"0.1em",marginBottom:5}}>AUDIT TRAIL ({auditLog.length})</div>
            <div style={{flex:1,overflowY:"auto"}}>
              {auditLog.length===0?<div style={{fontSize:11,color:t.textFaint}}>sin entradas</div>
              :[...auditLog].reverse().map((e,i)=>(
                <div key={i} style={{display:"flex",gap:5,alignItems:"flex-start",padding:"4px 0",borderBottom:`1px solid ${t.border}`,animation:"fadeIn 0.3s ease"}}>
                  <span style={{fontSize:9,color:t.textFaint,fontFamily:"monospace",whiteSpace:"nowrap",marginTop:1}}>{e.ts}</span>
                  <span style={{fontSize:9,fontWeight:700,color:TIER_C[e.tier],background:TIER_BG[e.tier],padding:"1px 4px",borderRadius:3,whiteSpace:"nowrap"}}>T{e.tier}</span>
                  <div style={{flex:1}}><span style={{fontSize:10,fontWeight:600,color:t.text}}>{e.agent}</span><span style={{fontSize:10,color:t.textSub}}> — {e.action}</span>{e.human&&<span style={{fontSize:9,color:"#534AB7",marginLeft:3}}>human</span>}</div>
                </div>
              ))}
            </div>
          </div>
          )}
        </div>
      </div>
      {/* Console */}
      <div style={{background:t.consoleBg,padding:"7px 18px",maxHeight:130,overflowY:"auto",flexShrink:0}}>
        <div style={{fontSize:9,fontWeight:700,color:"#333",letterSpacing:"0.1em",marginBottom:3}}>CONSOLE</div>
        {log.length===0?<div style={{fontSize:11,color:"#333",fontFamily:"monospace"}}>$ esperando...</div>
        :log.map((l,i)=><div key={i} style={{fontSize:11,color:logC[l.type]||"#888",fontFamily:"monospace",lineHeight:1.55}}><span style={{color:"#2A2925"}}>{l.ts} </span>{l.msg}</div>)}
      </div>
      {/* ARTIFACT VIEWER MODAL — abierto al click en una pill del panel de salida */}
      {viewArtifact&&(()=>{
        const phaseEntry=DELIVERED_ARTIFACTS.find(({files})=>files.includes(viewArtifact));
        const ph=phaseEntry?PHASES_DATA[phaseEntry.phase]:null;
        const accent=ph?.color.main||C.teal.main;
        return (
          <div onClick={()=>setViewArtifact(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,animation:"fadeIn 0.2s ease",padding:20}}>
            <div onClick={e=>e.stopPropagation()} style={{background:t.bgCard,borderRadius:14,width:640,maxWidth:"94vw",maxHeight:"90vh",display:"flex",flexDirection:"column",border:`2px solid ${accent}`,boxShadow:`0 0 0 4px ${accent}22, 0 20px 40px rgba(0,0,0,0.3)`}}>
              <div style={{padding:"14px 18px",borderBottom:`1px solid ${t.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0,background:`${accent}10`}}>
                <div style={{display:"flex",alignItems:"center",gap:9}}>
                  {ph&&<span style={{fontSize:9,fontWeight:700,color:accent,background:`${accent}22`,padding:"2px 7px",borderRadius:10,letterSpacing:"0.05em"}}>F{phaseEntry.phase} · {ph.subtitle}</span>}
                  <span style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color:accent}}>{viewArtifact}</span>
                </div>
                <button onClick={()=>setViewArtifact(null)} title="Cerrar" style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:t.textMuted,padding:"0 4px",fontFamily:"inherit",lineHeight:1}}>×</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"16px 22px"}}>
                <MarkdownView md={ARTIFACT_MD[viewArtifact]} t={t}/>
              </div>
              <div style={{padding:"10px 18px",borderTop:`1px solid ${t.border}`,fontSize:10,color:t.textFaint,fontFamily:"monospace",flexShrink:0,background:t.bgMuted}}>
                Esc o click fuera para cerrar
              </div>
            </div>
          </div>
        );
      })()}
      {/* HITL Modal */}
      {hitlModal&&(()=>{
        const artifact = HITL_ARTIFACTS[hitlModal.agent];
        const isT3 = hitlModal.tier===3;
        const borderC = isT3?"#E24B4A":"#BA7517";

        // Mini JSON viewer inline
        const JsonNode = ({data, depth=0}) => {
          const [open,setOpen] = useState(depth<2);
          if(data===null||data===undefined) return <span style={{color:"#888",fontFamily:"monospace",fontSize:11}}>null</span>;
          if(typeof data!=="object") {
            const c = typeof data==="boolean"?"#85B7EB":typeof data==="number"?"#9FE1CB":"#FAC775";
            return <span style={{color:c,fontFamily:"monospace",fontSize:11}}>{JSON.stringify(data)}</span>;
          }
          const isArr=Array.isArray(data);
          const keys=Object.keys(data);
          if(keys.length===0) return <span style={{color:"#888",fontFamily:"monospace",fontSize:11}}>{isArr?"[]":"{}"}</span>;
          return (
            <span>
              <button onClick={()=>setOpen(o=>!o)} style={{background:"none",border:"none",color:"#888",cursor:"pointer",padding:"0 2px",fontSize:10,fontFamily:"monospace"}}>{open?"▼":"▶"}</button>
              <span style={{color:"#666",fontFamily:"monospace",fontSize:11}}>{isArr?"[":"{"}</span>
              {!open&&<span style={{color:"#555",fontFamily:"monospace",fontSize:11,cursor:"pointer"}} onClick={()=>setOpen(true)}> …{keys.length} {isArr?"items":"keys"} </span>}
              {open&&<div style={{paddingLeft:14}}>
                {keys.map((k,i)=>(
                  <div key={k} style={{lineHeight:1.8}}>
                    {!isArr&&<span style={{color:"#AFA9EC",fontFamily:"monospace",fontSize:11}}>"{k}"</span>}
                    {!isArr&&<span style={{color:"#666",fontFamily:"monospace",fontSize:11}}>: </span>}
                    <JsonNode data={data[k]} depth={depth+1}/>
                    {i<keys.length-1&&<span style={{color:"#555",fontFamily:"monospace",fontSize:11}}>,</span>}
                  </div>
                ))}
              </div>}
              <span style={{color:"#666",fontFamily:"monospace",fontSize:11}}>{isArr?"]":"}"}</span>
            </span>
          );
        };

        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,animation:"fadeIn 0.2s ease"}}>
            <div style={{background:t.bgCard,borderRadius:14,width:480,maxWidth:"94vw",maxHeight:"90vh",display:"flex",flexDirection:"column",border:`2px solid ${borderC}`,boxShadow:`0 0 0 4px ${isT3?"#FCEBEB44":"#FAEEDA44"},0 20px 40px rgba(0,0,0,0.3)`}}>

              {/* Header */}
              <div style={{padding:"14px 18px 0",flexShrink:0}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontSize:11,fontWeight:800,letterSpacing:"0.06em",color:borderC}}>{isT3?"TIER 3 — BLOQUEO TOTAL":"TIER 2 — REVISIÓN"}</span>
                  <span style={{fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:10,color:TIER_C[hitlModal.tier],background:TIER_BG[hitlModal.tier]}}>{TIER_L[hitlModal.tier]}</span>
                </div>
                <div style={{fontSize:13,fontWeight:700,color:t.text,marginBottom:4}}>
                  Revisar y aprobar:{" "}
                  {artifact?(
                    <button onClick={()=>setJsonTab(jsonTab==="json"?"info":"json")} style={{
                      background:"none",border:"none",cursor:"pointer",padding:0,
                      fontSize:13,fontWeight:700,fontFamily:"monospace",
                      color:jsonTab==="json"?borderC:"#185FA5",
                      textDecoration:"underline",textDecorationStyle:"dashed",textUnderlineOffset:3,
                    }}>{artifact.filename}</button>
                  ):(
                    <span style={{fontFamily:"monospace",color:"#185FA5"}}>{hitlModal.action?.replace("Revisar: ","")}</span>
                  )}
                </div>
                <div style={{fontSize:11,color:t.textSub,marginBottom:10}}>
                  Agente: <span style={{fontWeight:600,color:"#185FA5"}}>{hitlModal.agent}</span>
                  {" · "}{PHASES_DATA[hitlModal.phase]?.name}
                </div>

                {/* Tabs */}
                <div style={{display:"flex",borderBottom:`1px solid ${t.border}`,marginBottom:0}}>
                  {[
                    {id:"info",label:"Descripción"},
                    {id:"md",label:"📝 Markdown"},
                    {id:"json",label:artifact?`📄 ${artifact.filename}`:"Ver JSON"},
                  ].map(tab=>(
                    <button key={tab.id} onClick={()=>setJsonTab(tab.id)} style={{
                      padding:"6px 14px",fontSize:11,fontWeight:jsonTab===tab.id?700:400,
                      color:jsonTab===tab.id?borderC:t.textMuted,
                      borderBottom:jsonTab===tab.id?`2px solid ${borderC}`:"2px solid transparent",
                      background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",marginBottom:-1,
                      transition:"all 0.15s",
                    }}>{tab.label}</button>
                  ))}
                </div>
              </div>

              {/* Body */}
              <div style={{flex:1,overflowY:"auto",padding:"12px 18px"}}>
                {jsonTab==="info"&&(
                  <div>
                    <div style={{fontSize:12,color:t.text,lineHeight:1.75,marginBottom:10}}>
                      {artifact?.desc||(isT3?"Acción irreversible. El sistema está completamente bloqueado.":"El sistema esperará 4h. Sin respuesta → auto-aprobación.")}
                    </div>
                    <div style={{background:t.bgSubtle,borderRadius:8,padding:"10px 12px",fontSize:11,color:t.textSub,lineHeight:1.7}}>
                      {isT3?(
                        <>Tu firma queda en el audit trail <strong>permanentemente</strong>. La acción es irreversible y genera evidencia regulatoria (CMF Chile). No hay auto-aprobación bajo ninguna circunstancia.</>
                      ):(
                        <>El sistema esperará 4 horas. Sin respuesta → se auto-aprueba. Tu decisión queda registrada con timestamp e identidad del aprobador.</>
                      )}
                    </div>
                    {artifact&&(
                      <button onClick={()=>setJsonTab("json")} style={{
                        marginTop:12,padding:"7px 14px",borderRadius:8,fontSize:11,fontWeight:700,
                        background:`${borderC}18`,color:borderC,border:`1px solid ${borderC}40`,
                        cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6,
                      }}>
                        <span>📄</span> Ver {artifact.filename} →
                      </button>
                    )}
                  </div>
                )}
                {jsonTab==="md"&&(
                  <div style={{padding:"4px 2px"}}>
                    <MarkdownView md={artifact?ARTIFACT_MD[artifact.filename]:null} t={t}/>
                  </div>
                )}
                {jsonTab==="json"&&(
                  <div style={{background:"#1C1B18",borderRadius:10,padding:"12px 14px",overflowX:"auto"}}>
                    {artifact?(
                      <JsonNode data={artifact.data} depth={0}/>
                    ):(
                      <div style={{color:"#888",fontFamily:"monospace",fontSize:11}}>
                        {JSON.stringify({agent:hitlModal.agent,phase:hitlModal.phase,tier:hitlModal.tier,timestamp:new Date().toISOString()},null,2)}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div style={{padding:"11px 18px 14px",borderTop:`1px solid ${t.border}`,display:"flex",gap:9,flexShrink:0}}>
                <button onClick={approve} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1D9E75",color:"#fff",border:"none",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Aprobar</button>
                <button onClick={reject} style={{flex:1,padding:"10px 0",borderRadius:8,border:"1px solid #E24B4A",background:"transparent",color:"#E24B4A",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Rechazar</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── INTRO PAGE ───────────────────────────────────────────────────────────────
const ERAS = [
  { decade: "1970s", name: "Cascada", color: C.gray, win: "Procesos ordenados, contratos claros, ideal para misiones espaciales y bancos centrales.", loss: "Cualquier cambio a mitad del proyecto rompía todo. El producto llegaba dos años tarde y obsoleto." },
  { decade: "1990s", name: "Procesos pesados (CMMI, RUP)", color: C.coral, win: "Trazabilidad y calidad enterprise, auditable de extremo a extremo.", loss: "Burocracia abrumadora. Comités de cambio que tardaban semanas. Documentación que pesaba más que el código." },
  { decade: "2000s", name: "Ágil", color: C.amber, win: "Iteraciones cortas, demos cada dos semanas, equipos pequeños y rápidos.", loss: "Sacrificó gobierno y trazabilidad. En industrias reguladas no encajaba sin parches." },
  { decade: "2010s", name: "DevOps", color: C.blue, win: "Borró la frontera entre desarrollo y operación. Despliegues diarios automatizados.", loss: "Funcionó solo donde había madurez técnica. Muchas empresas siguen sin lograrlo del todo." },
  { decade: "2020s", name: "Plataformas y SaaS", color: C.purple, win: "Los equipos consumen bloques en lugar de construir todo desde cero.", loss: "La complejidad migra al ecosistema. Ahora dependemos de proveedores que no controlamos." },
  { decade: "2025+", name: "Agéntico", color: C.teal, win: "Sistemas que ya no solo ayudan al desarrollador — toman decisiones, ejecutan y se autoevalúan.", loss: "Nuevos riesgos: comportamiento no determinista, drift del objetivo, necesidad de governance integrada al sistema." },
];

const PAINS = [
  { title: "El teléfono descompuesto", desc: "Lo que el cliente pide, lo que el PM entiende, lo que el desarrollador codifica y lo que el QA prueba — cada handoff pierde contexto. Para cuando el sistema llega a producción, nadie recuerda exactamente qué pidió el negocio." },
  { title: "La documentación que envejece", desc: "Documentos técnicos que dejan de reflejar el código a las pocas semanas. Quien necesita entender el sistema termina leyendo el código directamente, lo que reserva el conocimiento a unos pocos especialistas." },
  { title: "La caja negra del avance", desc: "“Vamos al 80%” repetido durante meses. Sin métricas reales del comportamiento del producto, el avance es una sensación, no un dato." },
  { title: "Cada cambio es una apuesta", desc: "Modificar un sistema vivo en producción siempre fue arriesgado. Los equipos aprendieron a temer los viernes, los fines de mes y los lanzamientos antes de feriados." },
  { title: "El equipo como cuello de botella", desc: "La velocidad y calidad del software dependen de cuántas personas tienes, cuánto saben y cuánto duran. Perder a una persona clave podía paralizar un proyecto entero." },
  { title: "Compliance como carga paralela", desc: "Seguridad, auditoría y regulación vivían en un proceso aparte. Llegaban al final, encontraban problemas y retrasaban el lanzamiento. Nunca se integraron al ciclo." },
];

const AI_POINTS = [
  { num: "01", title: "El trabajo repetitivo desaparece", desc: "Revisión de código, generación de tests, documentación, monitoreo de errores — tareas que consumían más de la mitad del tiempo de un equipo ahora las ejecuta el sistema. El humano queda libre para decidir, no para teclear." },
  { num: "02", title: "El contexto deja de perderse", desc: "Lo que en el modelo tradicional eran cinco documentos en cinco carpetas que nadie sincronizaba, ahora es un único objeto — el ProjectState — que viaja entre los agentes. Cada uno lo recibe, lo enriquece y lo entrega al siguiente. El conocimiento ya no se evapora en los handoffs." },
  { num: "03", title: "La supervisión se vuelve diseñable", desc: "Antes decidías “tengo equipo de QA, equipo de seguridad, equipo de cumplimiento”. Ahora decides en qué decisiones específicas del agente quieres intervención humana — y el sistema lo respeta como una regla técnica, no como un proceso opcional." },
];

const BUSINESS_CHANGES = [
  { k: "Velocidad", v: "No por escribir código más rápido, sino por eliminar los handoffs entre equipos que históricamente no se hablaban." },
  { k: "Trazabilidad", v: "Cada decisión del sistema queda registrada con justificación. Las auditorías dejan de ser una pesadilla retrospectiva." },
  { k: "Riesgo", v: "El rollback ya no espera a que alguien apriete un botón. Es automático cuando los indicadores de comportamiento se deterioran." },
  { k: "Costo", v: "El costo dominante deja de ser horas-persona y pasa a ser tokens más governance. La economía del software cambia de naturaleza." },
  { k: "Rol del PMO", v: "Pasa de reportar estado a diseñar las reglas del juego para los agentes. Se convierte en el arquitecto del sistema, no en su contador." },
];

const SIGNALS = [
  { source: "IMDA Singapore", year: "Enero 2026", title: "Primer framework regulatorio para IA agéntica", desc: "El gobierno de Singapur publica el Model AI Governance Framework for Agentic AI — el primer marco regulatorio del mundo específico para sistemas que toman decisiones autónomas. Define los tres tiers de governance que adoptamos en este modelo.", color: C.amber },
  { source: "Microsoft + GitHub", year: "Febrero 2026", title: "Un SDLC liderado por IA, de extremo a extremo", desc: "Microsoft documenta el primer ciclo de desarrollo completo orquestado por agentes en Azure y GitHub. La frontera entre asistente y ejecutor queda definitivamente cruzada.", color: C.blue },
  { source: "GitLab + TCS", year: "Febrero 2026", title: "Orquestación agéntica empresarial", desc: "Dos jugadores enterprise publican un caso conjunto: orquestación inteligente de equipos de desarrollo a través de agentes. La adopción deja de ser experimental.", color: C.purple },
  { source: "Deloitte AI Institute", year: "2026", title: "El estado de la IA en la empresa", desc: "El reporte anual de Deloitte confirma que la IA agéntica pasó de proof-of-concept a iniciativa estratégica en una mayoría de empresas Fortune 500.", color: C.teal },
];

function IntroPage({ t, dark, onNavigate }) {
  return (
    <div style={{ background: t.bg, overflowY: "auto", maxHeight: "calc(100vh - 52px)" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 32px 60px" }}>

        {/* HERO */}
        <div style={{ fontSize: 9, fontWeight: 700, color: C.teal.main, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 10 }}>
          ORIGEN
        </div>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.02em", lineHeight: 1.15, margin: "0 0 18px" }}>
          Por qué estamos cambiando la forma en que se construye software
        </h1>
        <p style={{ fontSize: 15, color: t.textSub, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 12px" }}>
          Esta página es para quienes deciden invertir en software sin necesariamente escribirlo. Si lideras un comité, un PMO o una unidad de negocio que depende de sistemas digitales, lo que sigue explica de dónde venimos, qué duele desde hace décadas, y por qué la inteligencia artificial — bien aplicada — está cambiando el costo, la velocidad y el riesgo de construir software.
        </p>

        {/* SECCIÓN 1 — QUÉ ES CONSTRUIR SOFTWARE */}
        <SectionLabel t={t} color={C.gray.main}>¿QUÉ HACEMOS CUANDO CONSTRUIMOS SOFTWARE?</SectionLabel>
        <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.75, fontFamily: "'Inter',sans-serif", margin: "0 0 12px" }}>
          Construir software no es escribir código. Es tomar una necesidad del negocio — automatizar un proceso, entender mejor a un cliente, abrir un canal nuevo — y traducirla en un sistema que funcione todos los días, sin descanso, ante usuarios reales y en condiciones impredecibles.
        </p>
        <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.75, fontFamily: "'Inter',sans-serif", margin: "0 0 8px" }}>
          La analogía más útil no es la de un proyecto: es la de una fábrica. Diseñas la línea, la construyes, la pruebas, la pones a operar y la mantienes funcionando mientras los productos cambian, las regulaciones cambian y las personas que la operaron originalmente se van. La diferencia es que en software esa fábrica vive en medio de un terremoto permanente.
        </p>

        {/* SECCIÓN 2 — TIMELINE 60 AÑOS */}
        <SectionLabel t={t} color={C.purple.main}>60 AÑOS EN UNA MIRADA</SectionLabel>
        <p style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 18px", fontStyle: "italic" }}>
          Cada generación intentó resolver los problemas que la anterior dejó abiertos. Ninguna los resolvió todos.
        </p>
        <div style={{ position: "relative", paddingLeft: 24 }}>
          <div style={{ position: "absolute", left: 6, top: 6, bottom: 6, width: 2, background: t.border }} />
          {ERAS.map((era, i) => (
            <div key={era.decade} style={{ position: "relative", marginBottom: i === ERAS.length - 1 ? 0 : 22 }}>
              <div style={{ position: "absolute", left: -22, top: 4, width: 12, height: 12, borderRadius: "50%", background: era.color.main, border: `2px solid ${t.bg}`, boxShadow: `0 0 0 2px ${era.color.main}` }} />
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: era.color.main, fontFamily: "'IBM Plex Mono',monospace", background: era.color.main + "18", padding: "2px 8px", borderRadius: 10 }}>{era.decade}</span>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", margin: 0, letterSpacing: "-0.01em" }}>{era.name}</h3>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 6 }}>
                <div style={{ background: t.bgSubtle, borderLeft: `2px solid ${C.teal.main}`, padding: "8px 11px", borderRadius: "0 6px 6px 0" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.teal.main, marginBottom: 3, letterSpacing: "0.05em" }}>QUÉ RESOLVIÓ</div>
                  <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.55, fontFamily: "'Inter',sans-serif" }}>{era.win}</div>
                </div>
                <div style={{ background: t.bgSubtle, borderLeft: `2px solid ${C.coral.main}`, padding: "8px 11px", borderRadius: "0 6px 6px 0" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.coral.main, marginBottom: 3, letterSpacing: "0.05em" }}>QUÉ DEJÓ PENDIENTE</div>
                  <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.55, fontFamily: "'Inter',sans-serif" }}>{era.loss}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* SECCIÓN 3 — LOS DOLORES */}
        <SectionLabel t={t} color={C.coral.main}>LOS DOLORES QUE NUNCA SE FUERON</SectionLabel>
        <p style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 16px", fontStyle: "italic" }}>
          Independiente de la metodología de moda, estos seis problemas reaparecen una y otra vez en proyectos de software de cualquier tamaño.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {PAINS.map((p, i) => (
            <div key={i} style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderTop: `2px solid ${C.coral.main}`, borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", marginBottom: 5, letterSpacing: "-0.01em" }}>{p.title}</div>
              <div style={{ fontSize: 11, color: t.textSub, lineHeight: 1.6, fontFamily: "'Inter',sans-serif" }}>{p.desc}</div>
            </div>
          ))}
        </div>

        {/* SECCIÓN 4 — QUÉ TRAE LA IA */}
        <SectionLabel t={t} color={C.teal.main}>QUÉ TRAE LA IA, Y POR QUÉ NO ES SOLO “CÓDIGO MÁS RÁPIDO”</SectionLabel>
        <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.75, fontFamily: "'Inter',sans-serif", margin: "0 0 12px" }}>
          La inteligencia artificial generativa empezó como un autocompletado más inteligente. Eso ya impresionaba en 2022, pero no era el cambio importante. El salto real vino después: cuando pasamos de <strong style={{ color: t.text }}>herramientas que ayudan</strong> a <strong style={{ color: t.text }}>agentes que deciden</strong>. Sistemas que leen el contexto, eligen la siguiente acción, ejecutan, evalúan el resultado, y deciden si seguir o pedir ayuda a un humano.
        </p>
        <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.75, fontFamily: "'Inter',sans-serif", margin: "0 0 18px" }}>
          Esa diferencia — pequeña en apariencia, enorme en consecuencias — cambia tres cosas fundamentales:
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {AI_POINTS.map((p) => (
            <div key={p.num} style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderLeft: `3px solid ${C.teal.main}`, borderRadius: "0 8px 8px 0", padding: "14px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.teal.main, fontFamily: "'Space Grotesk',sans-serif", lineHeight: 1, minWidth: 28 }}>{p.num}</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", marginBottom: 5, letterSpacing: "-0.01em" }}>{p.title}</div>
                <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.65, fontFamily: "'Inter',sans-serif" }}>{p.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* SECCIÓN 5 — QUÉ CAMBIA PARA EL NEGOCIO */}
        <SectionLabel t={t} color={C.blue.main}>QUÉ CAMBIA PARA EL NEGOCIO</SectionLabel>
        <p style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 16px", fontStyle: "italic" }}>
          Las consecuencias prácticas de este cambio no son técnicas — son financieras, operacionales y estratégicas.
        </p>
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden" }}>
          {BUSINESS_CHANGES.map((c, i) => (
            <div key={c.k} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 14, padding: "14px 18px", borderTop: i === 0 ? "none" : `1px solid ${t.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.blue.main, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "0.04em", textTransform: "uppercase", paddingTop: 1 }}>{c.k}</div>
              <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.65, fontFamily: "'Inter',sans-serif" }}>{c.v}</div>
            </div>
          ))}
        </div>

        {/* SECCIÓN 6 — SEÑALES */}
        <SectionLabel t={t} color={C.amber.main}>SEÑALES DE QUE VAMOS EN LA DIRECCIÓN CORRECTA</SectionLabel>
        <p style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 16px", fontStyle: "italic" }}>
          Estos no son anuncios de marketing. Son publicaciones recientes de instituciones, gobiernos y empresas que están moldeando cómo se construirá software en los próximos años.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {SIGNALS.map((s, i) => (
            <div key={i} onClick={() => onNavigate("refs")}
              style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderLeft: `3px solid ${s.color.main}`, borderRadius: "0 8px 8px 0", padding: "12px 14px", cursor: "pointer", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = t.bgSubtle}
              onMouseLeave={e => e.currentTarget.style.background = t.bgCard}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: s.color.main, background: s.color.main + "18", padding: "1px 7px", borderRadius: 10 }}>{s.source}</span>
                <span style={{ fontSize: 9, color: t.textMuted, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" }}>{s.year}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", lineHeight: 1.4, marginBottom: 5, letterSpacing: "-0.01em" }}>{s.title}</div>
              <div style={{ fontSize: 11, color: t.textSub, lineHeight: 1.55, fontFamily: "'Inter',sans-serif" }}>{s.desc}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: t.textFaint, fontStyle: "italic", textAlign: "center", fontFamily: "'Inter',sans-serif" }}>
          Click en cualquier señal para ver la lista completa de fuentes →
        </div>

        {/* CTA */}
        <div style={{ marginTop: 50, padding: "28px 30px", background: t.bgSubtle, border: `1px solid ${t.border}`, borderRadius: 12, textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.teal.main, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>CONTINÚA</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", margin: "0 0 8px", letterSpacing: "-0.015em" }}>
            ¿Cómo se ve esto en la práctica?
          </h2>
          <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.65, margin: "0 0 18px", maxWidth: 540, marginLeft: "auto", marginRight: "auto", fontFamily: "'Inter',sans-serif" }}>
            La sección Aprender presenta el modelo ADLC: las seis fases, los tres tiers de governance, los agentes y el rol del PMO. Está pensada para que un líder de negocio pueda navegarla sin necesidad de saber programar.
          </p>
          <button onClick={() => onNavigate("learn")} style={{
            background: C.teal.main, color: "#fff", border: "none", borderRadius: 8,
            padding: "11px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer",
            fontFamily: "inherit", letterSpacing: "0.02em",
          }}>
            Continuar con Aprender →
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper interno reutilizable para los labels de sección de IntroPage
function SectionLabel({ t, color, children }) {
  return (
    <div style={{ marginTop: 36, marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 6 }}>{children}</div>
      <div style={{ height: 1, background: t.border }} />
    </div>
  );
}

// ─── REFS PAGE ────────────────────────────────────────────────────────────────
function RefsPage({ t, dark }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const totalSources = REFERENCES.reduce((n, c) => n + c.items.length, 0);

  return (
    <div style={{ background: t.bg, overflowY: "auto", maxHeight: "calc(100vh - 52px)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: 32 }}>
        {/* Intro */}
        <div style={{ fontSize: 9, fontWeight: 700, color: C.teal.main, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>
          REFERENCIAS
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.015em", margin: "0 0 14px" }}>
          Fuentes del modelo ADLC
        </h1>
        <p style={{ fontSize: 13, color: t.textSub, lineHeight: 1.7, fontFamily: "'Inter',sans-serif", margin: "0 0 16px" }}>
          El modelo ADLC presentado en esta aplicación es una síntesis de múltiples frameworks publicados entre 2025 y 2026 por empresas tecnológicas, organismos regulatorios y firmas de investigación. Ninguna fuente individual contiene el modelo completo — la arquitectura de 6 fases, los 3 tiers de governance y los KPIs del PMO emergen de la combinación y adaptación al contexto fintech/CMF Chile.
        </p>
        <div style={{ background: t.bgSubtle, border: `1px solid ${t.border}`, borderRadius: 8, padding: "12px 14px", fontSize: 12, color: t.textSub, lineHeight: 1.6, fontFamily: "'Inter',sans-serif" }}>
          Las citas están en formato APA 7ª edición. Las URLs fueron verificadas en abril 2026. Algunos títulos han sido traducidos al español para consistencia con el resto del app.
        </div>

        {/* Categorías */}
        {REFERENCES.map((cat, ci) => (
          <div key={cat.category}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: cat.color.main, textTransform: "uppercase", marginTop: 28, marginBottom: 10 }}>
              {cat.category}
            </div>
            <div style={{ height: 1, background: t.border, marginBottom: 12 }} />
            {cat.items.map((item, ii) => {
              const key = `${ci}-${ii}`;
              const hover = hoverIdx === key;
              return (
                <div
                  key={key}
                  onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}
                  onMouseEnter={() => setHoverIdx(key)}
                  onMouseLeave={() => setHoverIdx(null)}
                  style={{
                    background: hover ? t.bgSubtle : t.bgCard,
                    border: `1px solid ${t.border}`,
                    borderLeft: `3px solid ${cat.color.main}`,
                    borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                    borderTopRightRadius: 8, borderBottomRightRadius: 8,
                    padding: "12px 14px",
                    marginBottom: 6,
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, color: cat.color.main,
                        background: cat.color.main + "18",
                        padding: "1px 7px", borderRadius: 10,
                      }}>{item.type}</span>
                      {item.highlight && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: C.amber.main,
                          background: C.amber.light,
                          padding: "1px 7px", borderRadius: 10,
                        }}>Fuente primaria</span>
                      )}
                    </div>
                    <span style={{ fontSize: 10, color: t.textMuted, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" }}>{item.year}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text, lineHeight: 1.6, marginTop: 4, marginBottom: 4, fontFamily: "'Inter',sans-serif" }}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: 11, color: t.textSub, fontStyle: "italic", fontFamily: "'Inter',sans-serif", marginBottom: 3 }}>
                    {item.authors}
                  </div>
                  <div style={{
                    fontSize: 10,
                    fontFamily: "'IBM Plex Mono',monospace",
                    color: hover ? cat.color.main : t.textFaint,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "100%",
                    transition: "color 0.15s",
                  }}>{item.url}</div>
                </div>
              );
            })}
          </div>
        ))}

        {/* Cierre */}
        <div style={{ height: 1, background: t.border, margin: "32px 0 14px" }} />
        <div style={{ textAlign: "center", fontSize: 11, color: t.textMuted, fontFamily: "'Inter',sans-serif" }}>
          {totalSources} fuentes · {REFERENCES.length} categorías · Período cubierto: 2025–2026
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: t.textFaint, marginTop: 4, fontFamily: "'Inter',sans-serif", lineHeight: 1.6, paddingBottom: 24 }}>
          Todas las fuentes son de acceso público. El framework regulatorio de referencia es el Singapore IMDA Model AI Governance Framework for Agentic AI (enero 2026).
        </div>
      </div>
    </div>
  );
}

// ─── BUILD PAGE — Catálogo de agentes con specs completas anti-alucinación
const AGENT_SPECS = [
  // ════ FASE 0 — DESCUBRIMIENTO ════
  {
    id: "discovery", phase: 0, name: "Discovery Agent", tier: 1, model: "Sonnet",
    purpose: "Observa evidencia existente (tickets, logs, docs) y categoriza pain points. NO propone soluciones.",
    reads: ["requirement.raw", "external: tickets, logs, documentos"],
    writes: ["discovery.pain_points[]", "discovery.data_readiness_score"],
    tools: [
      "read_tickets(filter, date_range) — read-only",
      "read_logs(service, date_range) — read-only",
      "read_docs(path_glob) — read-only",
    ],
    prompt: `Eres un analista observacional. Lee evidencia y categoriza pain points.
REGLAS DURAS:
- NO propongas soluciones ni menciones IA/agentes.
- CADA pain_point requiere source_ref (id de ticket/log/doc citado).
- Si no hay evidencia: devuelve []. NUNCA inventes.
SCHEMA: {pain_points: [{description, severity, automation_potential, source_ref}]}`,
    antiHall: [
      "source_ref obligatorio — Pydantic strict rechaza outputs sin ref",
      "Lista vacía permitida — preferible a invención",
      "Max 2 retries con error específico, después escala a humano",
      "Tool whitelist: solo lectura, sin acceso a APIs externas no listadas",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # reads: state.requirement.raw + tools
    # writes: state.discovery.pain_points, .data_readiness_score`,
    failures: [
      "0 evidencia → devuelve [] y data_readiness_score=0 (no escala)",
      "Schema invalid → 2 retries → escala T2",
      "Tool error → audit + retry exponencial (max 3)",
    ],
  },
  {
    id: "hypothesis", phase: 0, name: "Hypothesis Agent", tier: 1, model: "Sonnet",
    purpose: "Convierte pain points en hipótesis comprobables priorizadas. Define las señales tempranas de drift.",
    reads: ["discovery.pain_points"],
    writes: ["discovery.hypotheses[]"],
    tools: ["—  (puro razonamiento sobre el state)"],
    prompt: `Convierte cada pain_point en hipótesis comprobable.
REGLAS:
- CADA hipótesis necesita success_signal medible (ej: "error_rate < 0.10", no "mejor experiencia").
- Prioridad = impacto × factibilidad / riesgo (entero 1-5).
- NO inventes hipótesis sin pain_point asociado.
SCHEMA: {hypotheses: [{id, description, priority, success_signal, source_pain_id}]}`,
    antiHall: [
      "source_pain_id debe existir en discovery.pain_points (validación cruzada)",
      "success_signal debe contener un operador (<, >, =) — regex check",
      "Max hipótesis = 2 × pain_points.length (no infla la lista)",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # reads: state.discovery.pain_points
    # writes: state.discovery.hypotheses`,
    failures: [
      "0 pain_points → no ejecuta, retorna state sin cambios",
      "success_signal sin operador → retry con ejemplo en el prompt",
    ],
  },
  {
    id: "mapping", phase: 0, name: "Mapping Agent", tier: 2, model: "Sonnet",
    purpose: "Produce el responsibility map: qué puede el agente, qué requiere humano, forbidden zones absolutas. HITL obligatorio.",
    reads: ["discovery.pain_points", "discovery.hypotheses", "compliance_policies (externo)"],
    writes: ["discovery.responsibility_map", "discovery.constraint_map"],
    tools: [
      "read_compliance_policy(domain) — read-only",
      "request_human_approval(payload) — HITL bloqueante",
    ],
    prompt: `Eres el Mapping Agent. Tu output es la base del governance.
REGLAS DURAS:
- TODA acción del sistema debe estar clasificada: agent_only | hitl_required | forbidden.
- forbidden_zones es una lista cerrada — si no estás 100% seguro, márcala forbidden.
- Output requiere aprobación humana (HITL Tier 2) antes de retornar.
SCHEMA: {responsibility_map: {action: classification}, forbidden_zones: [str], escalation_authority: {tier: role}}`,
    antiHall: [
      "Ninguna acción puede quedar sin clasificar — schema validation",
      "forbidden_zones por default contiene las acciones de compliance leídas",
      "HITL obligatorio: el output no se commitea al state sin aprobación humana",
      "Comparación contra policy file: si conflicto, force forbidden",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # reads: state.discovery + compliance_policies
    # writes: state.discovery.responsibility_map (post-HITL)`,
    failures: [
      "HITL rechazado → state sin cambios + audit del rechazo + escala",
      "Conflicto policy vs propuesta → auto-conservador (forbidden)",
    ],
  },

  // ════ FASE 1 — DISEÑO ════
  {
    id: "intent", phase: 1, name: "Intent Agent", tier: 2, model: "Sonnet",
    purpose: "Escribe la intent_spec versionada y la Capability Matrix. Es el artefacto pivote del proyecto.",
    reads: ["requirement.raw", "discovery.*"],
    writes: ["design.intent_spec", "design.capability_matrix"],
    tools: [
      "compute_sha256(text) — determinista",
      "request_human_approval(payload) — HITL Tier 2",
    ],
    prompt: `Escribe la intent_spec en markdown estructurado. Cada decisión debe estar en la Capability Matrix.
REGLAS DURAS:
- TODA operación financiera/médica/regulatoria → deterministic_logic, NO llm_decisions.
- intent_spec.hash = sha256(content) — calculado por tool, no por LLM.
- Sin aprobación humana, el spec NO se commitea.
SCHEMA: {intent_spec: {content, version, hash}, capability_matrix: {llm_decisions: [], deterministic_logic: []}}`,
    antiHall: [
      "Hash calculado por tool determinista — el LLM nunca inventa hashes",
      "Allowlist de keywords forzados a deterministic: 'calcular', 'validar formato', 'verificar regulación'",
      "HITL obligatorio + diff vs versión anterior si existe",
      "JSON mode estricto en la salida",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # tool: hash = compute_sha256(spec_md)
    # writes: state.design.intent_spec (post-HITL)`,
    failures: [
      "Keywords financieros en llm_decisions → reject + retry con regla explícita",
      "HITL rechazado → vuelve a Fase 0",
    ],
  },
  {
    id: "architecture", phase: 1, name: "Architecture Agent", tier: 2, model: "Sonnet",
    purpose: "Selecciona patrón (ReAct/Plan-Execute/híbrido), stack, y produce ADRs versionados con grafo de agentes.",
    reads: ["design.intent_spec", "design.capability_matrix"],
    writes: ["design.architecture", "design.architecture.adr[]"],
    tools: [
      "list_known_patterns() — devuelve allowlist de patrones soportados",
      "list_supported_stacks() — devuelve allowlist de combinaciones stack válidas",
    ],
    prompt: `Diseña arquitectura. Solo puedes elegir patrones/stacks de las allowlists devueltas por las tools.
REGLAS DURAS:
- pattern ∈ list_known_patterns() — si propones algo fuera, rechazo.
- stack debe ser combinación válida de list_supported_stacks().
- CADA ADR necesita: contexto, decisión, alternativas consideradas, consecuencias.
SCHEMA: {pattern, stack, adr: [{id, decision, rationale, alternatives, consequences}], agent_graph}`,
    antiHall: [
      "Allowlist de patterns/stacks evita 'inventar' frameworks inexistentes",
      "Validación: el ID del ADR es secuencial (ADR-001, ADR-002...) — generado por código",
      "Cada ADR debe citar al menos 1 alternativa rechazada",
      "agent_graph validado contra grafo (sin ciclos, entrypoint definido)",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # tools: patterns = list_known_patterns(); stacks = list_supported_stacks()
    # writes: state.design.architecture`,
    failures: [
      "Pattern fuera de allowlist → reject inmediato",
      "Grafo con ciclos → reject + retry con grafo simplificado",
    ],
  },
  {
    id: "business", phase: 1, name: "Business Agent", tier: 2, model: "Sonnet",
    purpose: "Traduce arquitectura a ROI esperado, budget máximo, criterios go/no-go medibles.",
    reads: ["design.intent_spec", "design.architecture"],
    writes: ["design.business_case"],
    tools: [
      "estimate_llm_cost(model, tokens_estimate) — calculadora determinista",
      "compute_roi(revenue_est, cost_est) — fórmula determinista",
    ],
    prompt: `Calcula business case. Los números los da SIEMPRE una tool, nunca tu razonamiento.
REGLAS DURAS:
- ROI = compute_roi(...) — NO calcules tú.
- max_monthly_budget_usd = estimate_llm_cost(...) × safety_factor — viene de tool.
- go_no_go_criteria deben ser inequalities medibles.
SCHEMA: {roi_expected, max_monthly_budget_usd, go_no_go_criteria: {metric: threshold}}`,
    antiHall: [
      "Cálculos numéricos delegados 100% a tools deterministas",
      "Schema rechaza go/no-go que no sean inequalities (regex check)",
      "Sanity check: ROI < 10x → ok, > 10x → flag para HITL",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # tools: cost = estimate_llm_cost(...); roi = compute_roi(...)
    # writes: state.design.business_case`,
    failures: [
      "LLM intenta hacer aritmética → tool fail + retry con regla explícita",
      "go/no-go sin threshold numérico → reject",
    ],
  },

  // ════ FASE 2 — DESARROLLO ════
  {
    id: "orchestrator", phase: 2, name: "Orquestador Central", tier: 2, model: "Opus",
    purpose: "ÚNICO agente que usa Opus. Decide qué agente activar usando LLM-driven routing. NO ejecuta tareas.",
    reads: ["state COMPLETO"],
    writes: ["routing_decisions[]", "current_agent"],
    tools: [
      "list_available_agents() — devuelve registry de agentes disponibles",
      "get_agent_status(id) — read-only del status",
      "invoke_agent(id, state) — ejecuta otro agente",
    ],
    prompt: `Eres el orquestador. Lee el state completo y decide qué agente activar.
REGLAS DURAS:
- Solo puedes invocar agentes de list_available_agents() — no inventes nombres.
- CADA decisión requiere justificación (rationale ≥ 1 oración).
- Si context_budget_used > 0.9 × total: PAUSA y escala.
- Circuit breaker: si un agente falla 3 veces, márcalo como blocked y escala.
SCHEMA: {decision: agent_id, rationale, expected_outcome}`,
    antiHall: [
      "Tool list_available_agents() es la única fuente — no se aceptan IDs inventados",
      "Decisiones validadas contra registry antes de invoke_agent",
      "Context budget tracking obligatorio — no auto-extiende",
      "Loop guard: si invoca el mismo agente 2 veces consecutivas → escala",
    ],
    interface: `def run(state: ProjectState) -> AgentDecision:
    # tool: agents = list_available_agents()
    # decision = LLM(state, agents)
    # validate(decision.id in [a.id for a in agents])
    # invoke_agent(decision.id, state)`,
    failures: [
      "Agent_id inventado → reject + retry con lista explícita",
      "Loop infinito detectado → circuit breaker + escala T3",
      "Context budget excedido → pausa + audit",
    ],
  },
  {
    id: "coding", phase: 2, name: "Coding Agent", tier: 2, model: "Sonnet",
    purpose: "Genera código según la spec. Valida CADA dependencia contra PyPI antes de instalar (anti-hallucinated deps).",
    reads: ["design.intent_spec", "design.capability_matrix", "design.architecture"],
    writes: ["implementation.files_generated[]", "implementation.dependencies_validated[]"],
    tools: [
      "verify_pypi_package(name, version) — HTTP GET a pypi.org, retorna bool",
      "write_file(path, content) — escribe en branch (no main)",
      "run_unit_tests(path) — ejecuta tests generados",
    ],
    prompt: `Genera código según la spec aprobada.
REGLAS DURAS:
- ANTES de usar cualquier import: verify_pypi_package(name, version). Si false: NO la uses.
- TODA función generada necesita un test unitario en el mismo commit.
- NO toques main — solo branch.
- Capability Matrix: si una operación está marcada deterministic_logic, NO la implementes con LLM call.
SCHEMA: {files: [{path, content, language}], dependencies: [{name, version, verified: bool}]}`,
    antiHall: [
      "verify_pypi_package es la única forma de aprobar una dep — sin call, schema falla",
      "Test obligatorio por función — code coverage = 100% en lo nuevo",
      "Capability Matrix enforced en runtime: el CI verifica que no hay LLM calls en zonas deterministic",
      "Branch protection: el agente físicamente no tiene permisos en main",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # for dep in proposed_deps:
    #     if not verify_pypi_package(dep.name, dep.version):
    #         reject(dep)
    # writes: state.implementation.files_generated`,
    failures: [
      "PyPI verify falla → dep va a dependencies_rejected, retry con alternativa",
      "Test falla → no commitea, retry con fix",
      "LLM call en zona deterministic → reject + audit",
    ],
  },
  {
    id: "review", phase: 2, name: "Review Agent", tier: 2, model: "Sonnet",
    purpose: "SAST (Bandit) + SCA (pip-audit) + verificación Capability Matrix. Permisos read-only. Bloquea si hay críticos.",
    reads: ["implementation.files_generated", "design.capability_matrix"],
    writes: ["implementation.review_score", "implementation.sast_issues[]", "implementation.sca_issues[]"],
    tools: [
      "run_bandit(path) — SAST estático",
      "run_pip_audit(requirements) — SCA contra CVEs",
      "grep_llm_calls(path) — verifica capability matrix",
    ],
    prompt: `Eres revisor. Tu output es solo el reporte — NO modificas código.
REGLAS DURAS:
- Tools son la única fuente de verdad (Bandit, pip-audit, grep). NO opines sobre seguridad sin tool result.
- merge_recommendation ∈ {approve, request_changes, block} basado en thresholds explícitos.
- Critical SAST = block automático.
SCHEMA: {sast_issues, sca_issues, capability_matrix_violations, overall_score, merge_recommendation}`,
    antiHall: [
      "Read-only permisos: el agente físicamente no puede escribir código",
      "TODA recomendación cita tool output específico (line number, CVE id)",
      "Sin tool output, schema invalid → reject",
      "merge_recommendation determinada por reglas, no por LLM judgment",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # sast = run_bandit(files); sca = run_pip_audit(deps)
    # writes: state.implementation.review_score, sast_issues, sca_issues`,
    failures: [
      "SAST critical → merge_recommendation=block + escala",
      "Tool unavailable → no asume seguridad: defaultea a block",
    ],
  },

  // ════ FASE 3 — VALIDACIÓN ════
  {
    id: "testing", phase: 3, name: "Testing Agent", tier: 2, model: "Sonnet",
    purpose: "Genera y ejecuta evals conductuales. Calcula eval_pass_rate. NO unit tests.",
    reads: ["design.intent_spec", "implementation.files_generated"],
    writes: ["qa.evals_total", "qa.evals_passed", "qa.eval_pass_rate", "qa.behavioral_samples[]"],
    tools: [
      "generate_eval_cases(intent_hash, n) — usa intent como ground truth",
      "run_eval(case_id) — ejecuta caso contra el sistema y captura output",
      "compare_to_expected(output, expected) — usa LLM-as-judge con rubric",
    ],
    prompt: `Genera evals desde el intent_spec. Cada eval valida comportamiento sobre distribuciones reales.
REGLAS DURAS:
- evals categorizados: behavioral, security, compliance.
- security y compliance requieren 100% pass — un solo fallo bloquea.
- Evidence en cada result: input, output, expected, judge_rationale.
SCHEMA: {evals: [{id, category, input, expected, actual, passed, evidence}], pass_rate}`,
    antiHall: [
      "Casos generados a partir del intent_hash — si el intent cambia, los evals se regeneran",
      "LLM-as-judge usa rubric explícito (no 'parece bien')",
      "Evidence obligatoria — sin evidence, schema rechaza",
      "100% threshold automático en security/compliance, no negociable",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # cases = generate_eval_cases(state.design.intent_spec.hash, n=50)
    # for case in cases: result = run_eval(case.id)
    # writes: state.qa`,
    failures: [
      "Security/compliance < 100% → block + escala T3",
      "behavioral < 0.85 → request_changes",
    ],
  },
  {
    id: "validation", phase: 3, name: "Validation Agent", tier: 2, model: "Sonnet",
    purpose: "Calcula goal_drift_score con embeddings. Compara intent_spec original vs comportamiento observado.",
    reads: ["design.intent_spec", "qa.behavioral_samples"],
    writes: ["qa.goal_drift_score", "qa.staging_validated"],
    tools: [
      "embed(text, model='text-embedding-3-large') — determinista por seed",
      "cosine_distance(v1, v2) — fórmula matemática",
      "run_e2e_staging() — corre suite E2E en staging",
    ],
    prompt: `Mide goal drift. Cálculos numéricos SIEMPRE por tool.
REGLAS DURAS:
- drift = cosine_distance(embed(intent), embed(samples)) — calculado por tool.
- threshold warning: 0.30 — auto-rollback: 0.40.
- NO interpretes los números — reportas el resultado y aplicas la regla.
SCHEMA: {drift_score, samples_count, e2e_status, recommendation}`,
    antiHall: [
      "Embeddings y cosine son determinísticos — tool only",
      "Threshold como código, no como LLM judgment",
      "samples_count ≥ 30 obligatorio (estadísticamente significativo)",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # v1 = embed(state.design.intent_spec.content)
    # v2 = embed_avg(state.qa.behavioral_samples)
    # drift = cosine_distance(v1, v2)
    # writes: state.qa.goal_drift_score`,
    failures: [
      "drift > 0.40 → auto-rollback + escala T3",
      "samples_count < 30 → no calcula, requiere más datos",
    ],
  },
  {
    id: "hitl_gate", phase: 3, name: "HITL Gate", tier: 3, model: "—  (no LLM, reglas)",
    purpose: "La puerta de producción. Verifica 3 condiciones antes de avanzar. NO es un LLM — es lógica determinista + firma humana.",
    reads: ["qa.eval_pass_rate", "qa.critical_failures", "metrics.acceptance_rate"],
    writes: ["deploy_approval"],
    tools: [
      "check_threshold(value, op, threshold) — determinista",
      "request_human_signature(payload) — HITL Tier 3 bloqueante",
    ],
    prompt: `(este agente NO usa LLM — es código)
def hitl_gate(state):
    checks = [
        check_threshold(state.qa.eval_pass_rate, '>=', 0.85),
        check_threshold(state.qa.critical_failures, '==', 0),
        check_threshold(state.metrics.acceptance_rate, '>=', 0.70),
    ]
    if not all(checks): return BLOCK
    return request_human_signature({checks, state_hash})`,
    antiHall: [
      "NO hay LLM = imposible alucinar",
      "Firma humana criptográfica obligatoria — guardada en audit con state hash",
      "Si el state cambia post-firma, hash mismatch → re-firma requerida",
    ],
    interface: `def run(state: ProjectState) -> Approval:
    # 100% determinista + HITL bloqueante
    # writes: state.deploy_approval (con signature)`,
    failures: [
      "Cualquier check falso → BLOCK inmediato",
      "Firma humana ausente → no hay deploy",
      "Hash mismatch → invalida firma previa",
    ],
  },

  // ════ FASE 4 — DESPLIEGUE ════
  {
    id: "cicd", phase: 4, name: "CI/CD Agent", tier: 3, model: "—  (no LLM, reglas)",
    purpose: "Ejecuta pre-deploy checklist de 6 items no omitibles. Construye artifact firmado.",
    reads: ["state COMPLETO"],
    writes: ["devops.deploy_manifest_hash", "devops.pre_deploy_checks"],
    tools: [
      "verify_hitl_approvals() — todos los HITL aprobados",
      "verify_eval_threshold() — eval_pass_rate sobre umbral",
      "verify_intent_unchanged(hash) — spec no cambió post-aprobación",
      "build_artifact() — construye + firma con hash SHA-256",
    ],
    prompt: `(NO LLM — checklist determinista)
checks = {
    'hitl_approved': verify_hitl_approvals(state),
    'evals_passed': verify_eval_threshold(state, 0.85),
    'no_critical_sast': state.implementation.sast_issues == [],
    'no_critical_sca': state.implementation.sca_issues == [],
    'intent_unchanged': verify_intent_unchanged(state.design.intent_spec.hash),
    'capability_matrix_enforced': verify_no_llm_in_deterministic_zones(),
}
if not all(checks.values()): return BLOCK
manifest = build_artifact(state)`,
    antiHall: [
      "Todos los checks son tool calls deterministas",
      "Artifact hash calculado por código, no por LLM",
      "Cualquier check falso → BLOCK absoluto",
    ],
    interface: `def run(state: ProjectState) -> Manifest:
    # 6 checks deterministas + artifact firmado
    # writes: state.devops.deploy_manifest_hash`,
    failures: [
      "Cualquier check falso → BLOCK + audit + escala",
      "Build falla → no manifest, retry manual",
    ],
  },
  {
    id: "rollout", phase: 4, name: "Rollout Agent", tier: 3, model: "Sonnet",
    purpose: "Gestiona rollout 5%→15%→30%→100%. Mide KPIs en cada etapa. Auto-rollback si deterioro.",
    reads: ["devops.deploy_manifest_hash", "live_metrics (externo)"],
    writes: ["devops.rollout_stages[]", "devops.current_rollout_pct"],
    tools: [
      "set_traffic_pct(pct) — flag de feature",
      "read_live_metrics(window) — error_rate, latency, acceptance",
      "rollback_to(previous_manifest) — atómico",
    ],
    prompt: `Gestiona rollout progresivo. Decisión avanzar/retroceder por reglas, NO judgment.
REGLAS DURAS:
- Stages: [5, 15, 30, 100] — fijos, no negociable.
- En cada stage: espera N minutos, lee métricas, aplica reglas:
  - error_rate > 0.01 → rollback
  - acceptance_rate < 0.65 → rollback
  - drift > 0.40 → rollback
- AUTO-rollback es tool call, no requiere humano.
SCHEMA: {stage, pct, metrics, decision: 'advance' | 'rollback'}`,
    antiHall: [
      "Stages hardcodeados — el LLM no inventa porcentajes",
      "Decisión basada en thresholds, no en interpretación",
      "rollback es tool determinista — atómico, sin interpretación",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # for stage in [5, 15, 30, 100]:
    #     set_traffic_pct(stage); wait(N)
    #     metrics = read_live_metrics(window)
    #     if violates_thresholds(metrics): rollback_to(prev); break
    # writes: state.devops.rollout_stages`,
    failures: [
      "Threshold violation → rollback automático + escala",
      "Tool unavailable → pausa rollout, no avanza ciegamente",
    ],
  },
  {
    id: "policy", phase: 4, name: "Policy Agent", tier: 3, model: "—  (no LLM, OPA)",
    purpose: "Policy-as-code: valida en tiempo real que cada acción está autorizada según el responsibility_map.",
    reads: ["discovery.responsibility_map", "todas las acciones del sistema"],
    writes: ["devops.compliance.policy_violations", "devops.compliance.audit_trail_entries"],
    tools: [
      "opa_eval(policy, input) — Open Policy Agent o equivalente",
      "audit_append(entry) — append-only en storage inmutable",
    ],
    prompt: `(NO LLM — OPA / Rego policies)
package adlc.governance
default allow = false
allow {
    input.action in data.responsibility_map.agent_only
}
allow {
    input.action in data.responsibility_map.hitl_required
    input.has_approval == true
}
deny[msg] {
    input.action in data.responsibility_map.forbidden_zones
    msg := "forbidden zone violation"
}`,
    antiHall: [
      "OPA es 100% determinista — imposible alucinar policy decisions",
      "Audit trail append-only físicamente (DB triggers)",
      "Cada decisión registrada con input completo + result",
    ],
    interface: `def run(action) -> Decision:
    # decision = opa_eval(policy, action)
    # audit_append({action, decision, ts, hash})
    # return decision`,
    failures: [
      "Política deny → bloquea acción + escala según tier",
      "OPA unavailable → defaultea a deny (fail-secure)",
    ],
  },

  // ════ FASE 5 — MONITOREO ════
  {
    id: "sre", phase: 5, name: "SRE Agent", tier: 2, model: "Sonnet",
    purpose: "Monitoreo dual: polling 60s + reactivo (webhooks). Dedup con embeddings. Auto-rollback si drift > 0.4.",
    reads: ["live_metrics", "incident_stream"],
    writes: ["product.incidents[]"],
    tools: [
      "read_metrics(service, window) — Prometheus",
      "read_alerts() — Sentry/PagerDuty",
      "embed(text) — para dedup",
      "trigger_rollback() — si umbral excedido",
      "page_oncall(severity, summary) — notifica humano",
    ],
    prompt: `Monitorea producción. NO inventes incidentes — solo reporta lo que las tools devuelven.
REGLAS DURAS:
- Cada incidente debe citar metric_id o alert_id.
- Dedup: si nuevo incident.embedding tiene cosine_dist < 0.15 con uno reciente, agrupar.
- Auto-rollback: drift > 0.40 OR error_rate_critical > 0.05 → trigger_rollback() automático.
SCHEMA: {incidents: [{id, source_ref, severity, dedup_group_id, action_taken}]}`,
    antiHall: [
      "source_ref obligatorio (metric_id o alert_id) — sin ref, schema invalid",
      "Decisiones de rollback por threshold, no por judgment",
      "Dedup numérico con embeddings, no por similitud textual subjetiva",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # Cada 60s: metrics = read_metrics(...)
    # Reactivo: alerts = read_alerts()
    # if violates_thresholds(): trigger_rollback()
    # writes: state.product.incidents`,
    failures: [
      "Threshold crítico → rollback + page_oncall",
      "Tool unavailable → page_oncall (no asume todo está bien)",
    ],
  },
  {
    id: "learning", phase: 5, name: "Learning Agent", tier: 2, model: "Sonnet",
    purpose: "Convierte incidentes en nuevos evals. Motor del Agent Development Flywheel.",
    reads: ["product.incidents", "qa.behavioral_samples"],
    writes: ["qa.evals (nuevos casos)"],
    tools: [
      "fetch_incident_details(id) — read-only",
      "generate_eval_from_incident(incident) — produce eval case",
      "validate_eval_schema(case) — schema check",
    ],
    prompt: `Convierte incidentes en evals reproducibles.
REGLAS DURAS:
- CADA eval generado debe tener source_incident_id.
- El eval debe ser determinista y repetible — input fijo, expected definido.
- NO modificas evals existentes — solo agregas nuevos.
SCHEMA: {new_evals: [{id, source_incident_id, input, expected, category}]}`,
    antiHall: [
      "source_incident_id obligatorio — debe existir en product.incidents",
      "Schema validation antes de commitear — rechazo si malformado",
      "Append-only: el agente no tiene permiso para tocar evals existentes",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # for incident in recent_incidents:
    #     case = generate_eval_from_incident(incident)
    #     if validate_eval_schema(case): state.qa.evals.append(case)`,
    failures: [
      "Schema invalid → reject, no commitea",
      "Incident sin detalles suficientes → skip + audit",
    ],
  },
  {
    id: "feedback", phase: 5, name: "Feedback Agent", tier: 2, model: "Sonnet",
    purpose: "Cierra el loop completo. Convierte aprendizajes en updates del responsibility_map de Fase 0.",
    reads: ["product.*", "qa.*"],
    writes: ["product.pmo_report", "discovery.constraint_map (propuesta)"],
    tools: [
      "compute_kpi_trends() — determinista",
      "propose_constraint_update(evidence) — propuesta, no commit",
      "request_human_approval(payload) — HITL Tier 2",
    ],
    prompt: `Genera PMO report y propone updates al constraint_map.
REGLAS DURAS:
- Trends calculados por tool, NO por LLM.
- Updates al constraint_map son PROPUESTAS — requieren HITL antes de commit.
- Cada propuesta cita evidence (incident_ids, metric_trends).
SCHEMA: {pmo_report: {kpis, trends}, constraint_proposals: [{change, evidence, requires_hitl: true}]}`,
    antiHall: [
      "Trends son tool calls — no aritmética del LLM",
      "Propuestas no se aplican sin HITL — el agente no tiene write directo a constraint_map",
      "Evidence obligatoria en cada propuesta",
    ],
    interface: `def run(state: ProjectState) -> ProjectState:
    # trends = compute_kpi_trends(state)
    # proposals = propose_constraint_updates(...)
    # writes: state.product.pmo_report (proposals quedan pending HITL)`,
    failures: [
      "Propuesta sin evidence → reject",
      "HITL rechaza → propuesta archivada con razón",
    ],
  },
];

const BUILD_STEPS = [
  {
    id: "prereq",
    kind: "intro",
    num: "00",
    title: "Antes de empezar",
    color: C.gray,
    duration: "1 semana",
    summary: "Decide si tu organización está lista. Saltarse esto es la causa #1 de fracaso de proyectos agénticos.",
    blocks: {
      who: "Sponsor ejecutivo + futuro PMO agéntico + Compliance Officer",
      deliver: ["Memo ejecutivo de 1 página firmado", "Lista de stakeholders con autoridad", "Riesgo regulatorio mapeado"],
      business: "Construir un sistema agéntico no es un proyecto técnico — es un cambio de gobierno. Si la organización no entiende que la IA va a tomar decisiones que antes tomaban personas, el proyecto fracasa políticamente antes que técnicamente.",
      tech: "No escribas código aún. Verifica: (1) acceso a un LLM enterprise (Claude API o equivalente con DPA firmado), (2) un equipo de al menos 1 PMO + 1 ingeniero senior + 1 compliance, (3) un caso de uso con datos disponibles.",
      risk: "Sin sponsor ejecutivo nombrado, el primer 'no' de compliance mata el proyecto. Sin compliance involucrado desde día uno, vas a reescribir la arquitectura cuando descubras que tu agente no puede tocar datos de clientes.",
    },
    checklist: [
      "Existe un sponsor ejecutivo con autoridad presupuestaria",
      "Compliance acepta participar desde la Fase 0",
      "Hay al menos un caso de uso con datos accesibles",
      "El presupuesto cubre 6 meses mínimos sin ROI medible",
    ],
  },
  {
    id: "step1",
    kind: "step",
    num: "01",
    title: "Fundaciones organizacionales",
    color: C.teal,
    duration: "1–2 semanas",
    summary: "El PMO agéntico se nombra antes que el primer agente. La política de tiers se acuerda antes de la primera línea de código.",
    blocks: {
      who: "Sponsor ejecutivo (decide) + PMO designado (lidera) + Compliance + Tech Lead",
      deliver: [
        "Tier Policy documentada (qué acciones son T1/T2/T3 en tu dominio)",
        "Charter del PMO agéntico — sus 3 nuevas responsabilidades",
        "Caso de uso #1 elegido — debe ser de bajo riesgo, alto aprendizaje",
        "Forbidden zones list firmada por compliance",
      ],
      business: "El error más común es elegir como primer caso 'el más importante'. El primer caso debe ser el que más enseña con menor costo si falla. Piensa: notificaciones internas, validaciones de formato, resumen de tickets — no decisiones de crédito.",
      tech: "Crea un repo monorepo: /governance (políticas como código), /agents, /evals, /infra. Define el tier de cada acción posible del primer caso de uso en un archivo YAML versionado. Compliance firma ese YAML.",
      risk: "Empezar por el caso 'estrella' significa que el primer error público incendia la confianza interna y mata todo el programa. Empieza pequeño, gana credibilidad, escala.",
    },
    checklist: [
      "PMO agéntico tiene asignación formal (no es 'también haces esto')",
      "Tier policy aprobada por compliance",
      "Primer caso de uso documentado y firmado",
      "Forbidden zones explícitas",
    ],
  },
  {
    id: "step2",
    kind: "step",
    num: "02",
    title: "Stack técnico mínimo viable",
    color: C.purple,
    duration: "2–3 semanas",
    summary: "5 piezas. Ni una más. La tentación de adoptar 'la mejor herramienta para todo' es lo que convierte semanas en trimestres.",
    blocks: {
      who: "Tech Lead (lidera) + Platform Engineer + InfoSec",
      deliver: [
        "LLM provider con DPA y rate limits acordados",
        "Framework de orquestación instalado (ej: LangGraph)",
        "Plataforma de observabilidad de LLMs (ej: LangSmith) con tracing en todos los agentes",
        "Audit storage append-only (ej: tabla en Postgres con triggers anti-update)",
        "CI/CD adaptado: pipeline con steps de SAST, SCA, eval gate, intent_spec hash check",
      ],
      business: "Cada pieza del stack es una decisión que vas a vivir 2 años. Más importante que elegir 'la mejor', es elegir piezas que tu equipo entienda y pueda mantener un sábado en la noche cuando algo se rompa.",
      tech: "Stack de referencia: Python 3.11+, LangGraph para grafos de agentes, LangSmith para tracing (decorator @traceable obligatorio en todos los agentes), Anthropic Claude (Opus 4 para orquestación, Sonnet para agentes worker), Postgres con tabla audit_trail append-only, GitHub Actions o GitLab CI.",
      risk: "Saltarse audit storage al inicio porque 'lo agregamos después' es el error más caro: sin audit trail desde día uno, tu primer incidente es imposible de investigar y compliance bloquea producción.",
    },
    checklist: [
      "Todos los agentes están instrumentados con tracing desde el primer día",
      "Audit storage es físicamente append-only (no solo por convención)",
      "El pipeline de CI bloquea si el intent_spec cambia sin aprobación",
      "Hay un runbook para cuando el LLM provider tiene un outage",
    ],
  },
  {
    id: "step3",
    kind: "step",
    num: "03",
    title: "ProjectState y BaseAgent",
    color: C.blue,
    duration: "1 semana",
    summary: "El ProjectState es el único objeto que viaja entre agentes. Si no está en el estado, se perdió. Esto se construye antes que cualquier agente.",
    blocks: {
      who: "Tech Lead + 1 ingeniero",
      deliver: [
        "Schema del ProjectState versionado (JSON Schema o Pydantic)",
        "BaseAgent class con: tracing automático, context budget tracking, error handling, audit logging",
        "Tests unitarios que validan inmutabilidad del estado entre agentes",
      ],
      business: "Esto es la 'gramática' del sistema. Igual que las bases de datos relacionales tienen un schema, el ADLC tiene el ProjectState. Mientras más rico el schema, más capacidad tienen los agentes de razonar sobre el estado completo.",
      tech: "Patrón inmutable: cada agente recibe una copia del state, retorna una copia modificada, jamás muta in-place. El BaseAgent valida el context budget (default 180k tokens) y emite warning al 90%. Cada agente registra en audit_trail antes de retornar.",
      risk: "Si el estado se muta in-place, debugging se vuelve imposible — no puedes reconstruir qué agente cambió qué. Es la diferencia entre git con historial y editar archivos sin commits.",
    },
    checklist: [
      "ProjectState tiene versión semver y migración entre versiones",
      "BaseAgent fuerza tracing — no se puede instanciar sin LangSmith config",
      "Context budget se monitorea y se loguea por agente",
      "Cada mutación del estado genera una entrada de audit",
    ],
  },
  {
    id: "step4",
    kind: "step",
    num: "04",
    title: "Fase 0 primero — Discovery, Hypothesis, Mapping",
    color: C.teal,
    duration: "3–4 semanas",
    summary: "La tentación es saltar a 'codear el agente'. La Fase 0 parece lenta pero ahorra meses después. El responsibility map es lo más caro de hacerse mal.",
    blocks: {
      who: "PMO (lidera Mapping) + Discovery Agent + experto del dominio",
      deliver: [
        "pain_points_report.json — mínimo 3 puntos con severidad y automation_potential",
        "hypotheses.json — hipótesis priorizadas con criterio de éxito",
        "responsibility_map.json — qué puede el agente, qué requiere humano, qué está prohibido",
        "Primera infraestructura de HITL: cómo el sistema pausa y notifica",
      ],
      business: "Esta fase es donde el negocio toma decisiones que el código va a respetar para siempre. Un mal mapa de responsabilidad significa que después tu agente está operando fuera de los límites que la organización jamás aprobó conscientemente.",
      tech: "Discovery Agent es Tier 1 (solo lee). Mapping Agent es Tier 2 (HITL obligatorio). Construye HITL como un sistema de cola: el agente publica un 'request', un humano lo aprueba/rechaza, el agente lo recoge. No bloques con polling síncrono.",
      risk: "Saltar la Fase 0 es la causa raíz del 70% de los incidentes en producción de sistemas agénticos. Lo que parece 'obvio' al equipo técnico no lo es para legal, compliance o el cliente final.",
    },
    checklist: [
      "Mapping Agent fue revisado por compliance antes de implementarse",
      "El responsibility map cubre el 100% de las acciones del primer caso de uso",
      "Hay infraestructura para HITL operativa (cola + notificaciones)",
      "Las forbidden zones están en código, no solo en documentos",
    ],
  },
  {
    id: "step5",
    kind: "step",
    num: "05",
    title: "Capability Matrix y Fase 1",
    color: C.purple,
    duration: "2 semanas",
    summary: "Aquí decides qué decisiones le das al LLM y cuáles son código fijo. En dominios regulados, esta línea es regulatoria, no técnica.",
    blocks: {
      who: "PMO + Tech Lead + Compliance",
      deliver: [
        "intent_spec.md versionado con hash SHA-256",
        "capability_matrix.json — separación explícita LLM vs determinista",
        "ADRs (Architecture Decision Records) firmados",
        "business_case.json con criterios go/no-go medibles",
      ],
      business: "La Capability Matrix es la decisión más importante del proyecto. Ejemplo fintech: ¿el cálculo de intereses lo hace el LLM o un módulo determinista? La respuesta correcta SIEMPRE es determinista. El LLM puede explicar el cálculo en lenguaje natural, pero nunca calcularlo.",
      tech: "Hashea el intent_spec con SHA-256 y guarda el hash en el pipeline de CI. Si cambia sin aprobación, el deploy se bloquea. La capability_matrix debe ser un YAML/JSON que el código del agente lee — si una decisión está marcada 'determinística' y el agente intenta delegarla al LLM, falla en runtime.",
      risk: "Sin Capability Matrix explícita, el LLM termina tomando decisiones financieras o médicas que no debería. Cuando regulación pregunte '¿quién decidió esto?', no vas a tener respuesta.",
    },
    checklist: [
      "Intent spec tiene hash y está en el pipeline de CI",
      "Capability matrix se valida en runtime, no solo en review",
      "Cada ADR tiene contexto, decisión y consecuencias",
      "Los go/no-go criteria son números, no adjetivos",
    ],
  },
  {
    id: "step6",
    kind: "step",
    num: "06",
    title: "Inner loop — Fase 2 (orquestador + coding + review)",
    color: C.blue,
    duration: "3 semanas",
    summary: "El primer agente que escribe código. Aquí es crítico el control anti-alucinación de dependencias.",
    blocks: {
      who: "Tech Lead + ingenieros",
      deliver: [
        "Orquestador con LLM-driven routing (Opus 4)",
        "Coding Agent que valida cada dependencia contra PyPI antes de instalar",
        "Review Agent con SAST (Bandit) + SCA (pip-audit) + verificación de Capability Matrix",
        "Routing decisions log con justificación por transición",
      ],
      business: "El 20% de las recomendaciones de paquetes de los LLMs son 'alucinaciones' — paquetes que no existen pero suenan plausibles. Atacantes ya están registrando esos nombres con malware. El Coding Agent SIEMPRE valida que el paquete existe antes de tocarlo.",
      tech: "Orquestador único con Opus (caro pero la decisión vale el costo). Workers con Sonnet (más rápido, más barato). Coding Agent: HTTP GET a pypi.org/simple/<package> antes de pip install. Review Agent: bandit -r src/, pip-audit, y un check de que las llamadas LLM están solo donde la capability_matrix lo permite.",
      risk: "Dependencias alucinadas son un vector de supply chain attack real. Saltar este check es como hacer git pull desde un repo desconocido.",
    },
    checklist: [
      "Coding Agent rechaza paquetes inexistentes",
      "Review Agent tiene permisos solo de lectura",
      "Cada decisión del orquestador queda logueada",
      "Los tests generados por el Coding Agent corren en CI",
    ],
  },
  {
    id: "step7",
    kind: "step",
    num: "07",
    title: "Evals conductuales — Fase 3",
    color: C.amber,
    duration: "3 semanas",
    summary: "Evals NO son unit tests. Validan comportamiento ante distribuciones reales, no entradas puntuales. Sin evals, no hay producción.",
    blocks: {
      who: "Tech Lead + experto del dominio (crítico) + PMO",
      deliver: [
        "Eval suite con casos reales, casos extremos y casos adversariales",
        "Goal drift measurement con embeddings (text-embedding-3-large)",
        "HITL gate Tier 3 que bloquea producción si: eval_pass_rate < 0.85 ó critical_failures > 0",
      ],
      business: "Un unit test verifica 'la función devuelve 7'. Un eval verifica 'el agente respondió apropiadamente al cliente molesto'. La diferencia es la diferencia entre software y un agente. Si no tienes evals, no tienes garantía de comportamiento — solo esperanza.",
      tech: "Eval suite mínima: 30 casos por categoría (behavioral, security, compliance). Goal drift: embed el intent_spec original, embed muestras del comportamiento en staging, calcula distancia coseno. Threshold: warning a 0.30, auto-rollback a 0.40. El experto del dominio escribe los casos, no el ingeniero.",
      risk: "Producir sin evals es producir sin saber qué hace tu sistema. El primer incidente público es el que descubre que tu agente respondía mal a un caso obvio que nadie probó.",
    },
    checklist: [
      "Eval suite cubre los 3 niveles (comportamental, seguridad, compliance)",
      "Goal drift se mide automáticamente en cada deploy",
      "El HITL gate requiere firma humana — no se auto-aprueba",
      "Los casos de eval son escritos por dominio, no solo por ingeniería",
    ],
  },
  {
    id: "step8",
    kind: "step",
    num: "08",
    title: "Despliegue Tier 3 — Fase 4",
    color: C.coral,
    duration: "2 semanas",
    summary: "Zona Tier 3 completa. Todo bloquea. Rollout progresivo. Cada acción firmada en audit trail. Esto es lo que regulación va a auditar.",
    blocks: {
      who: "Tech Lead + Compliance + InfoSec + Operaciones",
      deliver: [
        "Deploy manifest firmado con hash SHA-256",
        "Rollout estratégico 5% → 15% → 30% → 100% con métricas en cada etapa",
        "Policy Agent con políticas como código verificando cada acción",
        "Audit trail con retención regulatoria configurada (365 días para CMF Chile)",
      ],
      business: "Un rollback de código no revierte el mundo real. Si el agente envió emails, modificó cuentas, publicó decisiones — el daño está hecho. El rollout progresivo existe para detectar el problema cuando afecta al 5%, no al 100%.",
      tech: "CI/CD Agent: pre-deploy checklist de 6 items no omitibles. Rollout Agent: feature flags + canary con métricas automáticas. Auto-rollback si error_rate > umbral o goal_drift > 0.40 en cualquier etapa. Policy Agent: OPA o equivalente, todas las políticas en /governance/policies como código.",
      risk: "Saltar el rollout progresivo significa que tu primer error está en producción al 100%. En fintech esto puede ser un incidente reportable a regulador.",
    },
    checklist: [
      "Pre-deploy checklist de 6 items implementado en CI",
      "Auto-rollback funciona en staging — probado",
      "Audit trail tiene retención configurada según tu regulación",
      "Compliance firmó el deploy manifest del primer release",
    ],
  },
  {
    id: "step9",
    kind: "step",
    num: "09",
    title: "Outer loop — Fase 5 (SRE, Learning, Flywheel)",
    color: C.green,
    duration: "Continuo",
    summary: "El agente está en producción. Ahora empieza el trabajo más importante: que mejore con el tiempo en lugar de degradarse.",
    blocks: {
      who: "PMO (monitorea KPIs) + SRE + Tech Lead",
      deliver: [
        "SRE Agent monitoreando en polling (60s) + reactivo (webhooks)",
        "Learning Agent que convierte incidentes en nuevos evals automáticamente",
        "Feedback Agent que actualiza el constraint_map de Fase 0 con aprendizajes reales",
        "PMO report semanal con tendencias de los 3 KPIs",
      ],
      business: "Sin Fase 5, los agentes en producción se degradan silenciosamente — drift de comportamiento, accumulated debt en evals desactualizados, supervision burden creciente. Con Fase 5, el sistema mejora cada semana porque cada incidente se convierte en un test que evita el siguiente.",
      tech: "SRE Agent dual-mode: polling cada 60s + suscripción a webhooks de Sentry/Prometheus. Dedup de alertas con embeddings (voyage-code-2). Learning Agent corre nightly sobre incidentes de las últimas 24h y propone nuevos evals. Feedback Agent corre semanalmente con review humana.",
      risk: "El 'set and forget' es donde mueren los proyectos agénticos. El sistema no se mantiene solo — necesita el flywheel activo.",
    },
    checklist: [
      "SRE Agent corriendo continuamente en producción",
      "Nuevos evals se agregan automáticamente desde incidentes",
      "PMO revisa los 3 KPIs cada semana — no cada trimestre",
      "Hay un proceso para deprecar agentes que no cumplen los KPIs",
    ],
  },
  {
    id: "antipatterns",
    kind: "intro",
    num: "★",
    title: "8 errores comunes — y cómo evitarlos",
    color: C.red,
    duration: "Lectura",
    summary: "Patrones que matan proyectos agénticos. Si reconoces alguno en tu equipo, párate y arregla antes de seguir.",
    blocks: {
      who: "Todo el equipo",
      deliver: [],
      business: "Estos errores se repiten en 9 de cada 10 proyectos fallidos. No son errores técnicos — son errores de proceso, alcance o gobierno.",
      tech: "1. Empezar por el caso más importante (mata credibilidad). 2. Saltar Fase 0 ('ya sabemos qué queremos'). 3. Tratar el LLM como código determinista. 4. Audit trail 'lo agregamos después'. 5. Evals = unit tests. 6. PMO = solo reporta. 7. Compliance llamado al final. 8. No medir goal drift hasta que ya hay incidentes.",
      risk: "Cada uno de estos antipatterns aparece tarde en el proyecto pero su raíz está en las primeras 2 semanas. Revisar mensualmente.",
    },
    checklist: [
      "El equipo conoce los 8 antipatterns",
      "Hay revisión mensual donde cualquiera puede llamar 'antipattern'",
    ],
  },
  {
    id: "catalog",
    kind: "catalog",
    num: "⚙",
    title: "Catálogo de agentes",
    color: C.purple,
    duration: "Referencia",
    summary: "Spec completa de los 18 agentes del ADLC: entradas/salidas en el ProjectState, tools en whitelist, prompt skeleton y controles anti-alucinación.",
    blocks: { who: "", deliver: [], business: "", tech: "", risk: "" },
    checklist: [],
  },
  {
    id: "maturity",
    kind: "intro",
    num: "✦",
    title: "Checklist de madurez",
    color: C.amber,
    duration: "Continuo",
    summary: "4 niveles. El error más común es declarar 'producción' cuando estás en piloto.",
    blocks: {
      who: "PMO + sponsor ejecutivo",
      deliver: [],
      business: "Saber en qué nivel estás te permite hablar honestamente con stakeholders. 'Estamos en piloto' es muy distinto de 'estamos en producción'.",
      tech: "Nivel 1 — EXPERIMENTAL: 1 agente, sin HITL, sin audit, ambiente aislado. Nivel 2 — PILOTO: HITL operativo, audit trail, < 10 usuarios reales, KPIs en dashboards. Nivel 3 — PRODUCCIÓN: rollout 100%, compliance firmado, SRE 24/7, evals corriendo. Nivel 4 — ESCALADO: múltiples casos de uso, plataforma reusable, learning agent generando evals semanalmente.",
      risk: "Saltarse niveles es la causa #2 de incidentes públicos (después de saltar Fase 0).",
    },
    checklist: [
      "Sabes en qué nivel está cada agente",
      "Tienes criterios claros para promover entre niveles",
      "El sponsor ejecutivo conoce el nivel real, no el aspiracional",
    ],
  },
];

function BuildPage({ t, dark, onNavigate }) {
  const [stepIdx, setStepIdx] = useState(0);
  const [catalogPhase, setCatalogPhase] = useState(0);
  const step = BUILD_STEPS[stepIdx];
  const T = (word, label) => <Term word={word} label={label} onNavigate={onNavigate} t={t} />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "calc(100vh - 52px)", background: t.bg }}>
      {/* Sidebar */}
      <div style={{ background: t.bgSubtle, borderRight: `1px solid ${t.border}`, padding: "16px 10px", overflowY: "auto", maxHeight: "calc(100vh - 52px)" }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.12em", marginBottom: 10, paddingLeft: 4 }}>GUÍA DE CONSTRUCCIÓN</div>
        <div style={{ fontSize: 10, color: t.textFaint, padding: "0 4px 12px", lineHeight: 1.6 }}>
          12 pasos para llevar el ADLC del papel a producción. Para equipos mixtos — técnicos y no técnicos.
        </div>
        {BUILD_STEPS.map((s, i) => {
          const active = i === stepIdx;
          return (
            <button key={s.id} onClick={() => setStepIdx(i)} style={{
              display: "flex", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
              background: active ? t.bgCard : "transparent",
              fontWeight: active ? 700 : 400, fontSize: 11, fontFamily: "inherit",
              boxShadow: active ? `0 1px 6px rgba(0,0,0,0.07)` : "none",
              borderLeft: active ? `3px solid ${s.color.main}` : "3px solid transparent",
              transition: "all 0.18s", marginBottom: 2, gap: 8, alignItems: "center",
            }}>
              <span style={{
                fontSize: 9, fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700,
                color: active ? s.color.main : t.textFaint,
                background: active ? `${s.color.main}18` : "transparent",
                padding: "2px 5px", borderRadius: 3, flexShrink: 0, minWidth: 22, textAlign: "center",
              }}>{s.num}</span>
              <span style={{ color: active ? t.text : t.textSub, lineHeight: 1.35 }}>{s.title}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ padding: "32px 40px", overflowY: "auto", maxHeight: "calc(100vh - 52px)" }}>
        {step.kind === "catalog" ? (
          <div style={{ maxWidth: 920, animation: "fadeIn 0.3s ease" }}>
            {/* Header del catálogo */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.purple.main, background: `${C.purple.main}18`, padding: "4px 12px", borderRadius: 4, fontFamily: "'IBM Plex Mono',monospace" }}>⚙</span>
              <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>CATÁLOGO</span>
              <span style={{ fontSize: 10, color: t.textFaint, marginLeft: "auto", fontFamily: "'IBM Plex Mono',monospace" }}>18 agentes · 6 fases</span>
            </div>
            <h1 style={{ fontSize: 32, fontWeight: 700, color: t.text, margin: "0 0 12px", fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.01em", lineHeight: 1.15 }}>
              Catálogo de agentes
            </h1>
            <div style={{ height: 2, background: `linear-gradient(to right, ${C.purple.main}, transparent)`, marginBottom: 18, borderRadius: 1 }} />
            <p style={{ fontSize: 14, color: t.textSub, lineHeight: 1.75, marginBottom: 20 }}>
              Cada agente tiene su <b>spec completa</b>: tier, modelo, entradas/salidas en el {T("ProjectState")}, tools permitidas en whitelist, esqueleto del system prompt, y los controles anti-alucinación específicos. Esta es la referencia ejecutable para construir cada agente del ADLC sin que invente cosas.
            </p>

            {/* Phase tabs */}
            <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
              {PHASES_DATA.map(ph => (
                <button key={ph.id} onClick={() => setCatalogPhase(ph.id)} style={{
                  padding: "7px 14px", borderRadius: 8, border: `1px solid ${catalogPhase === ph.id ? ph.color.main : t.border}`,
                  background: catalogPhase === ph.id ? `${ph.color.main}14` : t.bgCard,
                  color: catalogPhase === ph.id ? ph.color.main : t.textSub,
                  fontSize: 11, fontWeight: catalogPhase === ph.id ? 700 : 500,
                  cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, opacity: 0.7 }}>F{ph.id}</span>
                  <span>{ph.subtitle}</span>
                </button>
              ))}
            </div>

            {/* Agent cards de la fase seleccionada */}
            {AGENT_SPECS.filter(a => a.phase === catalogPhase).map(agent => {
              const ph = PHASES_DATA[agent.phase];
              return (
                <div key={agent.id} style={{
                  background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 12,
                  marginBottom: 18, overflow: "hidden",
                  borderLeft: `4px solid ${ph.color.main}`,
                }}>
                  {/* Header */}
                  <div style={{ padding: "14px 18px", borderBottom: `1px solid ${t.border}`, background: `${ph.color.main}08` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0, fontFamily: "'Space Grotesk',sans-serif" }}>{agent.name}</h2>
                      <span style={{ fontSize: 9, fontWeight: 700, color: TIER_C[agent.tier], background: TIER_BG[agent.tier], padding: "2px 7px", borderRadius: 10, fontFamily: "'IBM Plex Mono',monospace" }}>T{agent.tier}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: ph.color.main, background: `${ph.color.main}18`, padding: "2px 7px", borderRadius: 10, fontFamily: "'IBM Plex Mono',monospace" }}>F{agent.phase}</span>
                      <span style={{ fontSize: 9, color: t.textMuted, marginLeft: "auto", fontFamily: "'IBM Plex Mono',monospace" }}>model: {agent.model}</span>
                    </div>
                    <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.6, marginTop: 6 }}>{agent.purpose}</div>
                  </div>

                  {/* Reads / Writes */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${t.border}` }}>
                    <div style={{ padding: "12px 16px", borderRight: `1px solid ${t.border}` }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>← LEE DEL PROJECTSTATE</div>
                      {agent.reads.map((r, i) => (
                        <div key={i} style={{ fontSize: 10, color: t.text, fontFamily: "'IBM Plex Mono',monospace", padding: "1px 0" }}>· {r}</div>
                      ))}
                    </div>
                    <div style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>→ ESCRIBE AL PROJECTSTATE</div>
                      {agent.writes.map((w, i) => (
                        <div key={i} style={{ fontSize: 10, color: ph.color.main, fontFamily: "'IBM Plex Mono',monospace", padding: "1px 0", fontWeight: 600 }}>· {w}</div>
                      ))}
                    </div>
                  </div>

                  {/* Tools whitelist */}
                  <div style={{ padding: "12px 16px", borderBottom: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>🔧 TOOLS (WHITELIST)</div>
                    {agent.tools.map((tool, i) => (
                      <div key={i} style={{ fontSize: 10, color: t.text, fontFamily: "'IBM Plex Mono',monospace", padding: "2px 0", lineHeight: 1.5 }}>· {tool}</div>
                    ))}
                  </div>

                  {/* Prompt skeleton */}
                  <div style={{ padding: "12px 16px", borderBottom: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>📝 SYSTEM PROMPT (ESQUELETO)</div>
                    <pre style={{ fontSize: 10, color: t.textSub, fontFamily: "'IBM Plex Mono',monospace", background: t.bgSubtle, padding: "10px 12px", borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55, border: `1px solid ${t.border}` }}>{agent.prompt}</pre>
                  </div>

                  {/* Anti-hallucination */}
                  <div style={{ padding: "12px 16px", borderBottom: `1px solid ${t.border}`, background: `${C.red.main}06` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: C.red.main, letterSpacing: "0.1em", marginBottom: 5 }}>🛡 ANTI-ALUCINACIÓN</div>
                    {agent.antiHall.map((h, i) => (
                      <div key={i} style={{ fontSize: 11, color: t.text, padding: "2px 0", lineHeight: 1.55, display: "flex", gap: 6 }}>
                        <span style={{ color: C.red.main, flexShrink: 0 }}>▸</span>
                        <span>{h}</span>
                      </div>
                    ))}
                  </div>

                  {/* Interface */}
                  <div style={{ padding: "12px 16px", borderBottom: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>🔌 INTERFAZ DE ORQUESTACIÓN</div>
                    <pre style={{ fontSize: 10, color: t.text, fontFamily: "'IBM Plex Mono',monospace", background: t.bgSubtle, padding: "10px 12px", borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55, border: `1px solid ${t.border}` }}>{agent.interface}</pre>
                  </div>

                  {/* Failure modes */}
                  <div style={{ padding: "12px 16px" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 5 }}>⚠ MODOS DE FALLA</div>
                    {agent.failures.map((f, i) => (
                      <div key={i} style={{ fontSize: 11, color: t.textSub, padding: "2px 0", lineHeight: 1.55, display: "flex", gap: 6 }}>
                        <span style={{ color: C.amber.main, flexShrink: 0 }}>▸</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Nav prev/next */}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, paddingTop: 12, borderTop: `1px solid ${t.border}`, marginTop: 8 }}>
              <button onClick={() => setStepIdx(i => Math.max(0, i - 1))} style={{
                padding: "8px 14px", borderRadius: 8, border: `1px solid ${t.border}`,
                background: t.bgCard, color: t.textSub,
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}>← Anterior</button>
              <button onClick={() => setStepIdx(i => Math.min(BUILD_STEPS.length - 1, i + 1))} style={{
                padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.purple.main}40`,
                background: `${C.purple.main}14`, color: C.purple.main,
                fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}>Siguiente →</button>
            </div>
          </div>
        ) : (
        <div style={{ maxWidth: 760, animation: "fadeIn 0.3s ease" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={{
              fontSize: 13, fontWeight: 700, color: step.color.main,
              background: `${step.color.main}18`, padding: "4px 12px", borderRadius: 4,
              fontFamily: "'IBM Plex Mono',monospace", letterSpacing: "0.05em",
            }}>{step.num}</span>
            <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {step.kind === "step" ? `PASO ${parseInt(step.num)}` : step.id === "prereq" ? "PRERREQUISITO" : step.id === "antipatterns" ? "ANTI-PATTERNS" : "MADUREZ"}
            </span>
            <span style={{ fontSize: 10, color: t.textFaint, marginLeft: "auto", fontFamily: "'IBM Plex Mono',monospace" }}>⏱ {step.duration}</span>
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: t.text, margin: "0 0 12px", fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.01em", lineHeight: 1.15 }}>
            {step.title}
          </h1>
          <div style={{ height: 2, background: `linear-gradient(to right, ${step.color.main}, transparent)`, marginBottom: 18, borderRadius: 1 }} />
          <p style={{ fontSize: 15, color: t.textSub, lineHeight: 1.75, marginBottom: 24, fontStyle: "italic" }}>
            {step.summary}
          </p>

          {/* Quién + Entregables */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 6 }}>QUIÉN LIDERA</div>
              <div style={{ fontSize: 12, color: t.text, lineHeight: 1.6 }}>{step.blocks.who}</div>
            </div>
            <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 6 }}>QUÉ ENTREGAS</div>
              {step.blocks.deliver.length === 0 ? (
                <div style={{ fontSize: 11, color: t.textFaint, fontStyle: "italic" }}>—</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: t.text, lineHeight: 1.6 }}>
                  {step.blocks.deliver.map((d, i) => <li key={i} style={{ marginBottom: 3 }}>{d}</li>)}
                </ul>
              )}
            </div>
          </div>

          {/* Vista negocio */}
          <div style={{ background: `${step.color.main}10`, border: `1px solid ${step.color.main}30`, borderRadius: 10, padding: "14px 18px", marginBottom: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: step.color.main, letterSpacing: "0.1em", marginBottom: 6 }}>🧠 POR QUÉ IMPORTA — VISTA NEGOCIO</div>
            <div style={{ fontSize: 13, color: t.text, lineHeight: 1.7 }}>{step.blocks.business}</div>
          </div>

          {/* Vista técnica */}
          <div style={{ background: t.bgSubtle, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 6 }}>🛠 CÓMO — VISTA TÉCNICA</div>
            <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.7, fontFamily: "'IBM Plex Mono',monospace" }}>{step.blocks.tech}</div>
          </div>

          {/* Riesgo */}
          <div style={{ background: `${C.red.light}${dark ? "33" : ""}`, border: `1px solid ${C.red.main}40`, borderRadius: 10, padding: "14px 18px", marginBottom: 18 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.red.main, letterSpacing: "0.1em", marginBottom: 6 }}>⚠ RIESGO SI TE LO SALTAS</div>
            <div style={{ fontSize: 12, color: t.text, lineHeight: 1.7 }}>{step.blocks.risk}</div>
          </div>

          {/* Checklist */}
          {step.checklist && step.checklist.length > 0 && (
            <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 24 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em", marginBottom: 10 }}>✓ CHECKLIST PARA AVANZAR</div>
              {step.checklist.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", borderBottom: i < step.checklist.length - 1 ? `1px dotted ${t.border}` : "none" }}>
                  <span style={{ fontSize: 11, color: step.color.main, marginTop: 1, flexShrink: 0 }}>□</span>
                  <span style={{ fontSize: 12, color: t.textSub, lineHeight: 1.55 }}>{c}</span>
                </div>
              ))}
            </div>
          )}

          {/* Nav prev/next */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
            <button onClick={() => setStepIdx(i => Math.max(0, i - 1))} disabled={stepIdx === 0} style={{
              padding: "8px 14px", borderRadius: 8, border: `1px solid ${t.border}`,
              background: stepIdx === 0 ? "transparent" : t.bgCard,
              color: stepIdx === 0 ? t.textFaint : t.textSub,
              fontSize: 11, fontWeight: 600, cursor: stepIdx === 0 ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}>← Anterior</button>
            <button onClick={() => setStepIdx(i => Math.min(BUILD_STEPS.length - 1, i + 1))} disabled={stepIdx === BUILD_STEPS.length - 1} style={{
              padding: "8px 14px", borderRadius: 8, border: `1px solid ${step.color.main}40`,
              background: stepIdx === BUILD_STEPS.length - 1 ? "transparent" : `${step.color.main}14`,
              color: stepIdx === BUILD_STEPS.length - 1 ? t.textFaint : step.color.main,
              fontSize: 11, fontWeight: 700, cursor: stepIdx === BUILD_STEPS.length - 1 ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}>Siguiente →</button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ─── CANONICAL PROJECT STATE — MACHBank onboarding empresas ──────────────────
// Stack referencia MACHBank/BCI. Caso: carga de documentos para onboarding empresas.
// Este es el artefacto central que se enriquece en cada etapa del ADLC.
const MACHBANK_PROJECT_STATE = {
  meta: {
    project_id: "mbo-onboarding-empresas-2026-04",
    created_at: "2026-04-09T08:30:00-04:00",
    last_updated: "2026-04-09T21:00:00-04:00",
    version: "1.0.0",
    stack_reference: "MACHBank/BCI",
  },
  inicio: {
    _enriched_by: "Humano — Producto",
    _enriched_at: "2026-04-09T08:30:00-04:00",
    prompt_inicial: "Quiero implementar en MACHBank el flujo de carga de documentos de validación de identidad para empresas que quieren ejecutar su onboarding.",
    timestamp: "2026-04-09T08:30:00-04:00",
    requester: "Producto · Onboarding Empresas",
  },
  discovery: {
    _enriched_by: "Discovery Agent",
    _enriched_at: "2026-04-09T08:42:00-04:00",
    existing_docs: [
      "Manual_Onboarding_Empresas_v3.2.pdf",
      "API_KYC_Internal_2025.md",
      "Compliance_CMF_Empresas_2025.pdf",
      "MACH_Design_System_v4.2.fig",
    ],
    related_tickets: [
      { id: "MBO-1247", title: "40% rechazos por formato PDF", severity: "high" },
      { id: "MBO-1389", title: "Notificaciones de estado son manuales", severity: "medium" },
      { id: "MBO-1402", title: "Re-solicitud constante de documentos faltantes", severity: "medium" },
    ],
    codebase_references: [
      "mach-ios/Onboarding/DocUploadVC.swift",
      "mach-android/onboarding/DocUploadFragment.kt",
      "mach-backend/kyc-service/src/validators/",
      "mach-backend/notification-service/src/templates/",
    ],
    gaps_identified: [
      "No existe validación de formato pre-upload en cliente móvil",
      "No hay tracking de estado visible al cliente durante KYC",
      "Mensajería de error es genérica — no indica qué documento corregir",
    ],
  },
  hypothesis: {
    _enriched_by: "Hypothesis Agent",
    _enriched_at: "2026-04-09T08:51:00-04:00",
    hypothesis: "Validar formato y completitud de documentos en el cliente móvil antes del upload reducirá rechazos del 40% actual a menos del 10%, y notificaciones automáticas de estado eliminarán el 80% de las llamadas al call center sobre estado de KYC.",
    success_criteria: "rechazos < 0.10 durante 30 días post-deploy AND calls_estado < 0.20 del baseline",
    impact_score: 9,
    feasibility_score: 7,
    risk_score: 3,
    priority: 8.4,
  },
  mapping: {
    _enriched_by: "Mapping Agent (+ HITL Compliance)",
    _enriched_at: "2026-04-09T11:34:00-04:00",
    human_agent_map: {
      validar_formato_documento: "agent_only",
      clasificar_tipo_documento: "agent_only",
      extraer_texto_ocr: "agent_only",
      generar_mensaje_a_cliente: "agent_only",
      aprobar_excepcion_formato: "hitl_required",
      rechazar_documento_definitivamente: "hitl_required",
      aprobar_kyc_final_cliente: "forbidden",
      modificar_politicas_kyc: "forbidden",
    },
    scope_boundaries: [
      "Solo opera sobre tipos de documento ya autorizados regulatoriamente",
      "No toma decisiones finales de aprobación de cliente",
      "No modifica políticas KYC ni umbrales de riesgo",
    ],
    human_approval_status: "approved",
    approval_deadline: "2026-04-09T13:08:00-04:00",
    approved_by: "compliance.officer@machbank.cl",
    approved_at: "2026-04-09T11:34:00-04:00",
  },
  spec_dev: {
    _enriched_by: "Spec/Intent Agent",
    _enriched_at: "2026-04-09T11:52:00-04:00",
    feature_intent: "Permitir a empresas subir documentos de validación de identidad con feedback inmediato sobre formato y completitud, y recibir notificaciones automáticas de estado durante todo el proceso de KYC.",
    intent_hash: "sha256:a3f7c2e1b9d4f8c6e2a1...",
    intent_version: "1.0.0",
    capability_matrix: {
      llm_decisions: [
        "Clasificar tipo de documento desde imagen",
        "Extraer texto vía OCR semántico",
        "Generar mensaje personalizado al cliente sobre documentos faltantes",
      ],
      deterministic_logic: [
        "Validar tamaño máximo del archivo (10MB)",
        "Validar formato MIME (PDF/JPG/PNG)",
        "Calcular score de completitud documental",
        "Verificar RUT de empresa contra SII",
        "Calcular días hábiles de plazo regulatorio",
      ],
    },
    acceptance_criteria: [
      "Usuario recibe feedback de validación en < 2 segundos post-upload",
      "Estado del proceso KYC visible en app durante todo el flujo",
      "Notificación push al cambiar estado en backend",
      "Compatible con iOS 16+ y Android 10+",
      "Funciona offline-first con sync diferido",
    ],
  },
  architecture: {
    _enriched_by: "Architecture Agent",
    _enriched_at: "2026-04-09T12:18:00-04:00",
    tech_stack: {
      mobile_ios: "Swift 5.9 + SwiftUI + Combine",
      mobile_android: "Kotlin + Jetpack Compose + Coroutines",
      backend: "Java 17 + Spring Boot 3.2",
      database: "PostgreSQL 15 + S3 (documentos cifrados)",
      messaging: "Apache Kafka (eventos de estado)",
      llm_gateway: "MACH Internal LLM Gateway → Claude Sonnet",
    },
    patterns: [
      "MVVM en mobile",
      "BFF (Backend for Frontend) en backend",
      "Event-driven via Kafka para notificaciones",
      "Repository pattern para acceso a documentos",
    ],
    ui_kit_reference: "MACH Design System v4.2 — componentes Form, FileUpload, StatusTracker, Toast",
    infra_constraints: [
      "Llamadas a LLM exclusivamente vía gateway interno (no salida directa a internet)",
      "Documentos NUNCA salen del datacenter de Chile (residencia de datos CMF)",
      "Audit trail integrado con sistema de compliance corporativo (SOX)",
      "Latencia P95 móvil < 500ms para feedback de validación",
    ],
    api_contracts: [
      "POST /v2/onboarding/empresas/{id}/documentos",
      "GET /v2/onboarding/empresas/{id}/estado",
      "PATCH /v2/onboarding/empresas/{id}/notificaciones",
      "WS /v2/onboarding/empresas/{id}/eventos (websocket para estado)",
    ],
  },
  business: {
    _enriched_by: "Business Agent",
    _enriched_at: "2026-04-09T12:42:00-04:00",
    business_case: "Reducir tiempo de onboarding empresas de 5 días a < 2 días eliminando ciclos de re-trabajo. Impacto directo en NPS empresarial (+15 pts proyectado) y conversión de leads (de 62% a 78%).",
    cost_estimate: {
      monthly_usd: 18000,
      breakdown: { llm_gateway: 6000, storage_s3: 2500, compute: 4500, ops_supervision: 5000 },
    },
    value_estimate: {
      monthly_usd: 240000,
      drivers: [
        "~600 empresas/mes onboardeadas",
        "60% menos rechazos documentales",
        "70% menos calls a call center por estado",
      ],
    },
    go_no_go: {
      eval_pass_rate_min: 0.85,
      supervision_burden_max_hours_week: 4,
      security_critical_issues_max: 0,
      goal_drift_max: 0.30,
    },
    eval_score: 0.92,
    go_no_go_decision: "GO",
  },
  coding: {
    _enriched_by: "Orchestrator + Coding Agents",
    _enriched_at: "2026-04-09T15:14:00-04:00",
    files_modified: [
      { path: "mach-ios/Onboarding/DocUploadVC.swift", lines: 187, type: "modified" },
      { path: "mach-ios/Onboarding/Validators/FormatValidator.swift", lines: 94, type: "added" },
      { path: "mach-android/onboarding/DocUploadFragment.kt", lines: 234, type: "modified" },
      { path: "mach-android/onboarding/validators/FormatValidator.kt", lines: 102, type: "added" },
      { path: "mach-backend/kyc-service/src/main/java/cl/mach/kyc/agents/DocClassifierAgent.java", lines: 198, type: "added" },
      { path: "mach-backend/kyc-service/src/main/java/cl/mach/kyc/agents/NotificationAgent.java", lines: 156, type: "added" },
      { path: "mach-backend/kyc-service/src/main/java/cl/mach/kyc/validators/DocFormatValidator.java", lines: 156, type: "added" },
    ],
    unit_tests: [
      { path: "mach-ios/OnboardingTests/DocUploadTests.swift", count: 12, passing: 12 },
      { path: "mach-android/onboardingTests/DocUploadFragmentTest.kt", count: 14, passing: 14 },
      { path: "mach-backend/kyc-service/src/test/java/cl/mach/kyc/validators/DocFormatValidatorTest.java", count: 23, passing: 23 },
    ],
    dependencies: [
      { name: "anthropic-sdk-java", version: "0.8.0", verified: true, source: "internal-gateway" },
      { name: "AWS-SDK-iOS", version: "2.30.4", verified: true, source: "cocoapods" },
      { name: "kotlinx-coroutines", version: "1.7.3", verified: true, source: "maven-central" },
    ],
    pr_reference: "MBO-PR-3421: feat(onboarding) — validación pre-upload + notificaciones automáticas",
  },
  validation: {
    _enriched_by: "Validation Agent",
    _enriched_at: "2026-04-09T21:00:00-04:00",
    test_results: {
      unit: { total: 49, passed: 49, failed: 0 },
      integration: { total: 12, passed: 12, failed: 0 },
      e2e: { total: 8, passed: 8, failed: 0 },
      behavioral_evals: { total: 24, passed: 22, failed: 2, pass_rate: 0.92 },
    },
    static_analysis: {
      sonarqube: { issues: 0, bugs: 0, vulnerabilities: 0, code_smells: 3 },
      sast_bandit_equivalent: { critical: 0, high: 0, medium: 2 },
    },
    security_scan: {
      dependency_cves: 0,
      secrets_scan: "clean",
      penetration_test: "passed",
      compliance_check: "CMF Chile — passed",
    },
    deploy_status: {
      stages: [
        { pct: 5, status: "completed", at: "2026-04-09T17:15:00-04:00", metrics: { error_rate: 0.001, acceptance: 0.87 } },
        { pct: 15, status: "completed", at: "2026-04-09T18:00:00-04:00", metrics: { error_rate: 0.001, acceptance: 0.89 } },
        { pct: 30, status: "completed", at: "2026-04-09T19:30:00-04:00", metrics: { error_rate: 0.002, acceptance: 0.88 } },
        { pct: 100, status: "completed", at: "2026-04-09T21:00:00-04:00", metrics: { error_rate: 0.001, acceptance: 0.90 } },
      ],
      current: "production",
      url: "https://mach.cl/empresas/onboarding",
    },
  },
};

// Orden canónico de los 11 stages (para render y filtros).
// stack_contract: consolidacion de stack inmutable (post-mapping, pre-spec).
// publish: push del artefacto + creacion de repo/PR tras validation.
const CANONICAL_STAGES = [
  { key: "inicio", num: "0", label: "Inicio", color: C.gray },
  { key: "discovery", num: "1", label: "Discovery", color: C.teal },
  { key: "hypothesis", num: "2", label: "Hypothesis", color: C.teal },
  { key: "mapping", num: "3", label: "Mapping", color: C.amber },
  { key: "stack_contract", num: "4", label: "Stack Contract", color: C.amber },
  { key: "spec_dev", num: "5", label: "Spec Development", color: C.purple },
  { key: "architecture", num: "6", label: "Architecture", color: C.purple },
  { key: "business", num: "7", label: "Business", color: C.purple },
  { key: "coding", num: "8", label: "Coding", color: C.blue },
  { key: "validation", num: "9", label: "Validation", color: C.coral },
  { key: "publish", num: "10", label: "Publish", color: C.teal },
];

// ─── CANONICAL STATE → MARKDOWN ───────────────────────────────────────────────
// Convierte el project_state canónico a markdown legible para humanos.
// Preserva el orden de los stages y la trazabilidad del _enriched_by.
function projectStateToMarkdown(state) {
  const L = [];
  const push = (s = "") => L.push(s);
  const meta = state.meta || {};
  push(`# Project State — ${meta.project_id || "—"}`);
  push("");
  push(`**Stack de referencia:** ${meta.stack_reference || "—"}  `);
  push(`**Versión:** ${meta.version || "—"}  `);
  push(`**Creado:** ${meta.created_at || "—"}  `);
  push(`**Última actualización:** ${meta.last_updated || "—"}`);
  push("");
  push("---");
  push("");

  const renderValue = (v, indent = 0) => {
    const pad = "  ".repeat(indent);
    if (Array.isArray(v)) {
      v.forEach(item => {
        if (typeof item === "object" && item !== null) {
          const parts = Object.entries(item).map(([k, val]) => `**${k}:** ${val}`).join(" · ");
          push(`${pad}- ${parts}`);
        } else {
          push(`${pad}- ${item}`);
        }
      });
    } else if (typeof v === "object" && v !== null) {
      Object.entries(v).forEach(([k, val]) => {
        if (typeof val === "object" && val !== null) {
          push(`${pad}- **${k}:**`);
          renderValue(val, indent + 1);
        } else {
          push(`${pad}- **${k}:** ${val}`);
        }
      });
    } else {
      push(`${pad}${v}`);
    }
  };

  CANONICAL_STAGES.forEach(stage => {
    const s = state[stage.key];
    if (!s) return;
    push(`## ${stage.num} · ${stage.label}`);
    push(`*Enriquecido por: **${s._enriched_by || "—"}** · ${s._enriched_at || "—"}*`);
    push("");
    Object.entries(s).forEach(([k, v]) => {
      if (k.startsWith("_")) return;
      if (typeof v === "string") {
        if (k === "prompt_inicial" || k === "hypothesis" || k === "feature_intent" || k === "business_case") {
          push(`**${k}:**`);
          push(`> ${v}`);
          push("");
        } else {
          push(`- **${k}:** ${v}`);
        }
      } else if (typeof v === "number" || typeof v === "boolean") {
        push(`- **${k}:** ${v}`);
      } else {
        push(`**${k}:**`);
        renderValue(v, 0);
        push("");
      }
    });
    push("");
    push("---");
    push("");
  });
  return L.join("\n");
}

// ─── PROJECT STATE PAGE ───────────────────────────────────────────────────────
// Muestra el project_state canónico (MACHBank onboarding empresas) en formato
// dual JSON + Markdown, con stage filter y anotación de quién enriqueció cada capa.
function ProjectStatePage({ t, dark, onNavigate, canonicalState, canonicalLive, onResetExample }) {
  const [view, setView] = useState("both"); // "json" | "md" | "both"
  const [stageFilter, setStageFilter] = useState("all"); // "all" | stage.key
  const state = canonicalState || MACHBANK_PROJECT_STATE;

  // Estado filtrado por stage (preserva meta siempre)
  const filteredState = stageFilter === "all"
    ? state
    : { meta: state.meta, [stageFilter]: state[stageFilter] };

  const jsonStr = JSON.stringify(filteredState, null, 2);
  const mdStr = projectStateToMarkdown(filteredState);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 52px)", background: t.bg }}>
      {/* Header */}
      <div style={{ padding: "20px 32px 14px", borderBottom: `1px solid ${t.border}`, background: t.bgSubtle, flexShrink: 0 }}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: C.purple.main, fontWeight: 700, letterSpacing: "0.1em" }}>ARTEFACTO CENTRAL · DUAL JSON + MD</span>
            {canonicalLive && (
              <span style={{
                fontSize: 9, fontWeight: 700, color: "#fff",
                background: C.red.main, padding: "2px 8px", borderRadius: 10,
                letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 5,
                animation: "pulse 1.8s ease-in-out infinite",
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />
                EN VIVO
              </span>
            )}
            {canonicalLive && onResetExample && (
              <button onClick={onResetExample} style={{
                fontSize: 10, padding: "3px 10px", borderRadius: 12,
                border: `1px solid ${t.border}`, background: t.bgCard,
                color: t.textSub, cursor: "pointer", fontFamily: "inherit",
              }}>↻ restaurar ejemplo estático</button>
            )}
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: t.text, margin: "0 0 4px", fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.01em" }}>
            Project State — {state.meta?.project_id || "—"}
          </h1>
          <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.6, marginBottom: 12 }}>
            {canonicalLive
              ? <>Vista <b>en vivo</b> del artefacto que corre en el Demo interactivo. Cada vez que una fase completa, su stage se enriquece aquí. Stack <b>{state.meta?.stack_reference}</b>.</>
              : <>El único artefacto que viaja entre agentes del ADLC. Se enriquece progresivamente en 9 etapas. Este ejemplo muestra el caso <b>carga de documentos de onboarding para empresas</b> en el stack <b>{state.meta?.stack_reference}</b>. Cada etapa anota quién la enriqueció y cuándo.</>
            }
          </div>

          {/* Controles */}
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            {/* View toggle */}
            <div style={{ display: "flex", gap: 0, borderRadius: 8, border: `1px solid ${t.border}`, overflow: "hidden" }}>
              {[["both", "JSON + MD"], ["json", "Solo JSON"], ["md", "Solo Markdown"]].map(([id, label]) => (
                <button key={id} onClick={() => setView(id)} style={{
                  padding: "6px 14px", border: "none", cursor: "pointer", fontFamily: "inherit",
                  background: view === id ? C.purple.main : t.bgCard,
                  color: view === id ? "#fff" : t.textSub,
                  fontSize: 11, fontWeight: view === id ? 700 : 500,
                }}>{label}</button>
              ))}
            </div>

            {/* Stage filter */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: t.textMuted, letterSpacing: "0.08em", fontWeight: 700 }}>STAGE:</span>
              <button onClick={() => setStageFilter("all")} style={{
                padding: "4px 10px", borderRadius: 12, fontSize: 10, fontWeight: stageFilter === "all" ? 700 : 500,
                border: `1px solid ${stageFilter === "all" ? t.text : t.border}`,
                background: stageFilter === "all" ? t.text : "transparent",
                color: stageFilter === "all" ? t.bgCard : t.textMuted,
                cursor: "pointer", fontFamily: "inherit",
              }}>todos</button>
              {CANONICAL_STAGES.map(s => (
                <button key={s.key} onClick={() => setStageFilter(s.key)} style={{
                  padding: "4px 10px", borderRadius: 12, fontSize: 10, fontWeight: stageFilter === s.key ? 700 : 500,
                  border: `1px solid ${stageFilter === s.key ? s.color.main : t.border}`,
                  background: stageFilter === s.key ? `${s.color.main}18` : "transparent",
                  color: stageFilter === s.key ? s.color.main : t.textMuted,
                  cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", gap: 4,
                }}>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", opacity: 0.7 }}>{s.num}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stage enrichment timeline (siempre visible) */}
      <div style={{ padding: "14px 32px", background: t.bgMuted, borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {CANONICAL_STAGES.map(stage => {
            const s = state[stage.key];
            const empty = !s;
            return (
              <div key={stage.key} onClick={() => !empty && setStageFilter(stage.key)} style={{
                flex: "1 1 180px", minWidth: 180, background: t.bgCard,
                border: `1px solid ${t.border}`, borderLeft: `3px solid ${empty ? t.border : stage.color.main}`,
                borderRadius: 6, padding: "8px 10px",
                cursor: empty ? "default" : "pointer",
                opacity: empty ? 0.45 : 1,
                transition: "all 0.15s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: empty ? t.textFaint : stage.color.main, fontFamily: "'IBM Plex Mono',monospace" }}>{stage.num}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: empty ? t.textMuted : t.text }}>{stage.label}</span>
                  {empty && <span style={{ fontSize: 8, color: t.textFaint, marginLeft: "auto", fontStyle: "italic" }}>pendiente</span>}
                </div>
                <div style={{ fontSize: 9, color: t.textMuted, fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1.4 }}>
                  ← {s?._enriched_by || "—"}
                </div>
                <div style={{ fontSize: 9, color: t.textFaint, fontFamily: "'IBM Plex Mono',monospace", marginTop: 1 }}>
                  {s?._enriched_at?.slice(11, 16) || "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Content — dual panes */}
      <div style={{ flex: 1, padding: "18px 32px", overflow: "hidden" }}>
        <div style={{
          maxWidth: 1280, margin: "0 auto",
          display: "grid",
          gridTemplateColumns: view === "both" ? "1fr 1fr" : "1fr",
          gap: 16,
          height: "100%",
        }}>
          {(view === "json" || view === "both") && (
            <div style={{ display: "flex", flexDirection: "column", background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "8px 14px", borderBottom: `1px solid ${t.border}`, background: t.bgSubtle, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em" }}>📦 JSON (para agentes)</span>
                <button onClick={() => navigator.clipboard?.writeText(jsonStr)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 5, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, cursor: "pointer", fontFamily: "inherit" }}>copiar</button>
              </div>
              <pre style={{
                flex: 1, margin: 0, padding: "14px 16px", overflow: "auto",
                fontSize: 10.5, lineHeight: 1.55,
                fontFamily: "'IBM Plex Mono',monospace",
                color: t.text, background: t.bgCard,
                whiteSpace: "pre", maxHeight: "calc(100vh - 340px)",
              }}>{jsonStr}</pre>
            </div>
          )}

          {(view === "md" || view === "both") && (
            <div style={{ display: "flex", flexDirection: "column", background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "8px 14px", borderBottom: `1px solid ${t.border}`, background: t.bgSubtle, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: "0.1em" }}>📄 Markdown (para humanos)</span>
                <button onClick={() => navigator.clipboard?.writeText(mdStr)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 5, border: `1px solid ${t.border}`, background: t.bgCard, color: t.textSub, cursor: "pointer", fontFamily: "inherit" }}>copiar</button>
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: "14px 20px", maxHeight: "calc(100vh - 340px)" }}>
                <MarkdownView md={mdStr} t={t} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── OPERATIONS / HITL REVIEW ─────────────────────────────────────────────────
// Página operacional para revisar y resolver HITL checkpoints del engine.
// Consume la API FastAPI del engine.
// Default: usa el mismo hostname del browser, puerto 8000. Así sirve cuando
// la UI se accede desde otra máquina (ej. http://192.168.1.186:5173/ →
// API http://192.168.1.186:8000). Override explícito con VITE_API_URL.
// Endpoints:
//   GET  /hitl/pending         → lista checkpoints pendientes
//   GET  /hitl/{id}            → detalle
//   POST /hitl/{id}/resolve    → {run_id, decision, resolver, feedback}
function resolveApiBase() {
  if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (typeof window !== "undefined" && window.location) {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "http://localhost:8000";
}
const API_BASE = resolveApiBase();

// ----------------------------------------------------------------------
// Auth — API key compartida (Fase 7 paso 1)
// ----------------------------------------------------------------------
// Single-tenant: la API tiene UNA key compartida en ADLC_API_KEY env var.
// La UI la guarda en localStorage y la envia como Authorization: Bearer
// en cada fetch. Si la API esta en modo dev (sin ADLC_API_KEY), la UI no
// pide key y los fetches funcionan sin Authorization.
//
// Flujo: AuthGate hace GET /healthz al mount. Si auth_required:true y no
// hay key guardada, muestra modal. Si una llamada devuelve 401, AuthGate
// limpia la key y vuelve a mostrar el modal (la key probablemente rotó).

const API_KEY_STORAGE = "adlc_api_key";

function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || null; } catch { return null; }
}
function setApiKey(k) {
  try { localStorage.setItem(API_KEY_STORAGE, k); } catch {}
}
function clearApiKey() {
  try { localStorage.removeItem(API_KEY_STORAGE); } catch {}
}

// apiFetch envuelve fetch agregando API_BASE + Authorization. Lanza un
// CustomEvent "adlc:401" cuando la API responde 401, para que AuthGate
// reabra el modal de la key. Devuelve el Response como fetch nativo.
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = getApiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const r = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (r.status === 401) {
    clearApiKey();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("adlc:401"));
    }
  }
  return r;
}

// Orden canónico de las 8 phases del ciclo ADLC. Debe matchear cycle.py.
const ADLC_PHASES = [
  { id: "discovery",      label: "Discovery" },
  { id: "hypothesis",     label: "Hypothesis" },
  { id: "mapping",        label: "Mapping" },
  { id: "stack_contract", label: "Stack Contract" },
  { id: "spec",           label: "Spec" },
  { id: "architecture",   label: "Architecture" },
  { id: "business",       label: "Business" },
  { id: "coding",         label: "Coding" },
  { id: "validation",     label: "Validation" },
  { id: "publish",        label: "Publish" },
];

// Gradiente rojo -> amarillo -> verde -> azul para las 10 phases canónicas.
// HSL hue: 0 (rojo) a 210 (azul cielo al publicar).
const PHASE_COLORS = {
  discovery:      "hsl(0,   70%, 62%)",  // rojo
  hypothesis:     "hsl(15,  75%, 58%)",  // rojo-naranja
  mapping:        "hsl(30,  80%, 55%)",  // naranja
  stack_contract: "hsl(42,  80%, 55%)",  // naranja-oro
  spec:           "hsl(55,  80%, 55%)",  // amarillo
  architecture:   "hsl(70,  70%, 55%)",  // amarillo-verde
  business:       "hsl(90,  65%, 55%)",  // verde-lima
  coding:         "hsl(115, 60%, 50%)",  // verde
  validation:     "hsl(145, 55%, 48%)",  // verde-cian
  publish:        "hsl(200, 65%, 52%)",  // azul (publicado)
};
const PHASE_DEFAULT_COLOR = "#8a8a82";

function colorLines(lines) {
  // Iterar y mantener currentPhase. La linea "[executor] phase=X agent=..."
  // aplica el color X a si misma y a todas las lineas siguientes hasta el
  // proximo cambio.
  let currentPhase = null;
  const result = [];
  const phaseRe = /\[executor\]\s+phase=(\w+)/;
  for (const line of lines) {
    const m = phaseRe.exec(line);
    if (m) currentPhase = m[1];
    const color = currentPhase ? (PHASE_COLORS[currentPhase] || PHASE_DEFAULT_COLOR) : PHASE_DEFAULT_COLOR;
    result.push({ line, color, phase: currentPhase });
  }
  return result;
}

function RunLogConsole({ runId, t, dark }) {
  const [lines, setLines] = useState([]);
  const [err, setErr] = useState(null);
  const cursorRef = useRef(0);
  const preRef = useRef(null);

  // Polling robusto a remounts: no depende de cursor en el closure (usa
  // useRef para que actualice sin re-ejecutar el useEffect). Resetea
  // lines y cursor al arranque para que un cambio de runId o remount de
  // tab recargue desde cero. Flag cancelled contra race conditions.
  useEffect(() => {
    let cancelled = false;
    cursorRef.current = 0;
    setLines([]);
    setErr(null);

    const poll = async () => {
      try {
        const r = await apiFetch(`/runs/${runId}/logs?since=${cursorRef.current}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        if (data.lines && data.lines.length > 0) {
          setLines(prev => [...prev, ...data.lines]);
        }
        if (typeof data.next === "number") {
          cursorRef.current = data.next;
        }
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      }
    };

    poll();
    const iv = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [runId]);

  useEffect(() => {
    // Auto-scroll al fondo cuando hay líneas nuevas
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines]);

  const colored = colorLines(lines);

  return (
    <div style={{ marginTop: 8 }}>
      <div
        ref={preRef}
        style={{
          background: "#0A0A09",
          border: `1px solid ${t.border}`,
          borderRadius: 5,
          padding: 10,
          fontSize: 10.5,
          lineHeight: 1.5,
          maxHeight: 260,
          overflow: "auto",
          fontFamily: "'IBM Plex Mono',monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: 0,
        }}
      >
        {colored.length === 0 && (
          <div style={{ color: "#8a8a82" }}>
            {err ? `⚠ ${err}` : "(sin logs todavía — esperando primera phase)"}
          </div>
        )}
        {colored.map((item, i) => (
          <div key={i} style={{ color: item.color }}>{item.line}</div>
        ))}
      </div>
      {/* Leyenda del gradiente */}
      {colored.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginTop: 4, fontSize: 9, flexWrap: "wrap" }}>
          {Object.entries(PHASE_COLORS).map(([phase, color]) => (
            <span key={phase} style={{
              color, fontWeight: 700, letterSpacing: "0.02em",
              textTransform: "uppercase",
            }}>
              {phase.slice(0, 4)}
            </span>
          ))}
        </div>
      )}
      {err && <div style={{ fontSize: 10, color: "#c33", marginTop: 3 }}>⚠ {err}</div>}
    </div>
  );
}

function RunTimeline({ run, t, dark }) {
  const completed = new Set(run.completed_phases || []);
  // "current" = primera phase sin completar (solo si el run está running/pending)
  const firstPending = ADLC_PHASES.find(p => !completed.has(p.id));
  const currentPhase = run.status === "awaiting_hitl"
    ? null  // pausado: no hay "next" activa
    : (firstPending?.id || null);
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
      {ADLC_PHASES.map((p, i) => {
        const done = completed.has(p.id);
        const isCurrent = p.id === currentPhase;
        let bg, color, border;
        if (done) {
          bg = C.teal.main; color = "#fff"; border = C.teal.main;
        } else if (isCurrent) {
          bg = C.teal.light; color = C.teal.dark; border = C.teal.main;
        } else {
          bg = t.bgSubtle; color = t.textSub; border = t.border;
        }
        return (
          <div key={p.id} title={p.label} style={{
            flex: 1, minWidth: 0,
            background: bg, color, border: `1px solid ${border}`,
            padding: "4px 2px", borderRadius: 3,
            fontSize: 9, fontWeight: 700, textAlign: "center",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            animation: isCurrent ? "pulse 1.4s infinite" : undefined,
            textTransform: "uppercase", letterSpacing: "0.02em",
          }}>
            {done ? "✓ " : (isCurrent ? "• " : "")}{p.label.slice(0, 4)}
          </div>
        );
      })}
    </div>
  );
}

// Color del badge según status del run
function statusColor(status, C, t) {
  switch (status) {
    case "completed":     return C.green.main;
    case "running":       return C.teal.main;
    case "awaiting_hitl": return C.amber.main;
    case "pending":       return "#888";
    case "failed":        return C.red.main;
    case "aborted":       return "#666";
    default:              return t.textSub;
  }
}

// ─── ReportSection: collapsible section for run report ───────────────────────
function ReportSection({ title, defaultOpen = false, count, badge, children, t }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8, border: `1px solid ${t.border}`, borderRadius: 6, overflow: "hidden" }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "8px 12px", cursor: "pointer", background: t.bgSubtle,
          display: "flex", alignItems: "center", gap: 8,
        }}
      >
        <span style={{ fontSize: 9, color: t.textSub }}>{open ? "▼" : "▶"}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: t.text, letterSpacing: "0.02em" }}>{title}</span>
        {count != null && <span style={{ fontSize: 9, color: C.teal.main, fontWeight: 700 }}>{count}</span>}
        {badge && <span style={{ fontSize: 8, padding: "1px 6px", borderRadius: 8, background: badge.color, color: "#fff", fontWeight: 700 }}>{badge.text}</span>}
      </div>
      {open && <div style={{ padding: "10px 14px" }}>{children}</div>}
    </div>
  );
}

// ─── reportToMarkdown: generates markdown copy of run report ─────────────────
function reportToMarkdown(s, run) {
  const ln = (t) => t + "\n";
  let md = "";
  md += ln(`# Reporte de Run: ${run?.run_id || "?"}`);
  md += ln(`**Estado**: ${run?.status || "?"} | **Eval**: ${run?.eval_score ?? "N/A"}/100`);
  md += ln(`**Prompt**: ${s.prompt_inicial || ""}`);
  md += ln(`**Solicitante**: ${s.requester || ""} | **Repo**: ${s.target_repo || "N/A"}`);
  md += ln(`**Inicio**: ${run?.started_at?.slice(0, 19) || ""} | **Fin**: ${run?.finished_at?.slice(0, 19) || ""}`);
  md += ln("");
  if (s.feature_intent) { md += ln("## Feature Intent"); md += ln(typeof s.feature_intent === "string" ? s.feature_intent : JSON.stringify(s.feature_intent)); md += ln(""); }
  if (s.hypothesis) { md += ln("## Hipótesis"); md += ln(typeof s.hypothesis === "string" ? s.hypothesis : JSON.stringify(s.hypothesis)); md += ln(""); }
  if (s.go_no_go) { md += ln(`## Decisión Go/No-Go: ${s.go_no_go.decision || "?"}`); (s.go_no_go.reasons || []).forEach(r => { md += ln(`- ${r}`); }); md += ln(""); }
  if (s.files_modified) { md += ln(`## Modificaciones de código (${Array.isArray(s.files_modified) ? s.files_modified.length : 0} archivos)`); (Array.isArray(s.files_modified) ? s.files_modified : []).forEach(f => { md += ln(`- ${f}`); }); md += ln(""); }
  if (s.unit_tests) { md += ln(`## Tests: ${s.unit_tests.passed_count || 0} passed (exit ${s.unit_tests.exit_code ?? "?"})`); if (s.unit_tests.stdout_tail) md += ln("```\n" + s.unit_tests.stdout_tail + "\n```"); md += ln(""); }
  if (s.scope_boundaries) { md += ln("## Scope"); md += ln("### In Scope"); (s.scope_boundaries.in_scope || []).forEach(i => { md += ln(`- ${i}`); }); md += ln("### Out of Scope"); (s.scope_boundaries.out_of_scope || []).forEach(o => { md += ln(`- ${o}`); }); md += ln(""); }
  if (s.tech_stack) { md += ln("## Tech Stack"); md += ln("```json\n" + JSON.stringify(s.tech_stack, null, 2) + "\n```"); md += ln(""); }
  if (s.acceptance_criteria) { md += ln("## Acceptance Criteria"); (Array.isArray(s.acceptance_criteria) ? s.acceptance_criteria : []).forEach((ac, i) => { md += ln(`${i + 1}. ${ac.criterion || ac}`); }); md += ln(""); }
  if (s.existing_docs?.length) { md += ln("## Fuentes consultadas"); s.existing_docs.forEach(d => { md += ln(`- ${typeof d === "string" ? d : (d.path || d.title || JSON.stringify(d))}`); }); md += ln(""); }
  if (s.gaps_identified?.length) { md += ln("## Gaps identificados"); s.gaps_identified.forEach(g => { md += ln(`- ${typeof g === "string" ? g : (g?.description || g?.gap || g?.title || JSON.stringify(g))}`); }); md += ln(""); }
  return md;
}

// ─── RunSummaryReport: structured view of completed run ──────────────────────
function RunSummaryReport({ jsonState: s, run, t, dark }) {
  if (!s) return null;
  const goColor = s.go_no_go?.decision === "go" ? C.green.main : s.go_no_go?.decision === "no_go" ? C.red.main : t.textSub;
  const filesCount = Array.isArray(s.files_modified) ? s.files_modified.length : 0;
  const testsOk = s.unit_tests?.exit_code === 0;

  const renderList = (arr) => (arr || []).map((item, i) => (
    <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 3, paddingLeft: 10, borderLeft: `2px solid ${t.border}`, lineHeight: 1.5 }}>
      {typeof item === "string" ? item : (item.path || item.title || item.criterion || JSON.stringify(item))}
      {item.relevance && <div style={{ fontSize: 9, color: t.textSub, marginTop: 1 }}>{item.relevance}</div>}
      {item.summary && <div style={{ fontSize: 9, color: t.textSub, marginTop: 1 }}>{item.summary}</div>}
      {item.metric && <div style={{ fontSize: 9, color: t.textSub, marginTop: 1 }}>Métrica: {item.metric}</div>}
    </div>
  ));

  return (
    <div>
      {/* Executive summary bar */}
      <div style={{
        display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap",
        padding: "10px 14px", background: t.bgSubtle, borderRadius: 6, border: `1px solid ${t.border}`,
        alignItems: "center",
      }}>
        {s.go_no_go?.decision && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 10, background: goColor, color: "#fff", textTransform: "uppercase" }}>
            {s.go_no_go.decision}
          </span>
        )}
        {s.eval_score?.total != null && (
          <span style={{ fontSize: 11, color: t.text }}>Eval: <strong>{s.eval_score.total}/100</strong></span>
        )}
        {run?.eval_score != null && !s.eval_score?.total && (
          <span style={{ fontSize: 11, color: t.text }}>Eval: <strong>{run.eval_score}/100</strong></span>
        )}
        {s.impact_score?.score != null && (
          <span style={{ fontSize: 11, color: t.text }}>Impact: <strong>{s.impact_score.score}/10</strong></span>
        )}
        {filesCount > 0 && <span style={{ fontSize: 11, color: t.text }}>{filesCount} archivos</span>}
        {s.unit_tests?.passed_count != null && (
          <span style={{ fontSize: 11, color: testsOk ? C.green.main : C.red.main }}>{s.unit_tests.passed_count} tests passed</span>
        )}
        <span style={{ fontSize: 10, color: t.textSub }}>{s.deploy_status || ""}</span>
      </div>

      {/* Feature Intent */}
      {s.feature_intent && (
        <div style={{
          fontSize: 11, color: t.text, lineHeight: 1.6, marginBottom: 12,
          padding: "10px 14px", background: dark ? "#111" : "#f5f5f0", borderRadius: 6,
          borderLeft: `3px solid ${C.teal.main}`,
        }}>
          {typeof s.feature_intent === "string" ? s.feature_intent : JSON.stringify(s.feature_intent)}
        </div>
      )}

      {/* Code Modifications */}
      {(filesCount > 0 || s.pr_reference) && (
        <ReportSection title="Modificaciones de código" defaultOpen={true} count={`${filesCount} archivos`} t={t}>
          {Array.isArray(s.files_modified) && s.files_modified.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: C.teal.main }}>+</span>
              <code style={{ fontSize: 10, color: t.text }}>{f}</code>
            </div>
          ))}
          {s.pr_reference && s.pr_reference !== "pending" && s.pr_reference !== "blocked" && (
            <div style={{ marginTop: 6, fontSize: 10, color: t.text }}>PR: <code>{s.pr_reference}</code></div>
          )}
          {s.pr_reference === "pending" && <div style={{ marginTop: 6, fontSize: 10, color: t.textSub, fontStyle: "italic" }}>PR pendiente de creación</div>}
        </ReportSection>
      )}

      {/* Tests & Validation */}
      {(s.unit_tests || s.test_results || s.static_analysis) && (
        <ReportSection title="Validación y tests" defaultOpen={true}
          badge={testsOk ? { text: "PASSED", color: C.green.main } : s.unit_tests?.exit_code != null ? { text: "FAILED", color: C.red.main } : null}
          t={t}
        >
          {s.unit_tests && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: t.text, marginBottom: 4 }}>
                Exit code: <strong style={{ color: testsOk ? C.green.main : C.red.main }}>{s.unit_tests.exit_code ?? "N/A"}</strong>
                {" · "}{s.unit_tests.passed_count || 0} tests passed
              </div>
              {s.unit_tests.stdout_tail && (
                <pre style={{
                  background: dark ? "#0A0A09" : "#F8F7F4", color: dark ? "#E8E6DF" : "#1C1B18",
                  border: `1px solid ${t.border}`, borderRadius: 4, padding: 8, fontSize: 9,
                  maxHeight: 180, overflow: "auto", fontFamily: "'IBM Plex Mono',monospace",
                  whiteSpace: "pre-wrap", margin: 0,
                }}>{s.unit_tests.stdout_tail}</pre>
              )}
            </div>
          )}
          {s.test_results && typeof s.test_results === "object" && (
            <div style={{ fontSize: 10, color: t.textSub }}>
              {s.test_results.coverage_summary && <div>Coverage: {s.test_results.coverage_summary}</div>}
              {s.test_results.baseline_ok != null && <div>Baseline: {s.test_results.baseline_ok ? "OK" : "FAIL"}</div>}
            </div>
          )}
          {s.static_analysis && typeof s.static_analysis === "object" && (
            <div style={{ fontSize: 10, color: t.textSub, marginTop: 4 }}>
              Static analysis: {s.static_analysis.status || "N/A"} {s.static_analysis.notes && `— ${s.static_analysis.notes}`}
            </div>
          )}
        </ReportSection>
      )}

      {/* Implementation Plan */}
      {(s.hypothesis || s.success_criteria) && (
        <ReportSection title="Plan de implementación" defaultOpen={false} t={t}>
          {s.hypothesis && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Hipótesis</div>
              <div style={{ fontSize: 10, color: t.text, lineHeight: 1.6, borderLeft: `2px solid ${C.teal.main}`, paddingLeft: 10 }}>
                {typeof s.hypothesis === "string" ? s.hypothesis : JSON.stringify(s.hypothesis)}
              </div>
            </div>
          )}
          {s.success_criteria && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Criterios de éxito</div>
              {renderList(s.success_criteria)}
            </div>
          )}
          {s.acceptance_criteria && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Acceptance criteria</div>
              {renderList(s.acceptance_criteria)}
            </div>
          )}
          {s.human_agent_map && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Responsabilidades</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.teal.main, marginBottom: 4 }}>Agente</div>
                  {(s.human_agent_map.agent || []).map((a, i) => <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 3, lineHeight: 1.5 }}>• {a}</div>)}
                </div>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#E6A23C", marginBottom: 4 }}>Humano</div>
                  {(s.human_agent_map.human || []).map((h, i) => <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 3, lineHeight: 1.5 }}>• {h}</div>)}
                </div>
              </div>
            </div>
          )}
        </ReportSection>
      )}

      {/* Scope */}
      {s.scope_boundaries && (
        <ReportSection title="Alcance" defaultOpen={false} t={t}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.green.main, marginBottom: 4, textTransform: "uppercase" }}>In Scope</div>
              {(s.scope_boundaries.in_scope || []).map((i, idx) => <div key={idx} style={{ fontSize: 10, color: t.text, marginBottom: 3, lineHeight: 1.5 }}>✓ {i}</div>)}
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.red.main, marginBottom: 4, textTransform: "uppercase" }}>Out of Scope</div>
              {(s.scope_boundaries.out_of_scope || []).map((o, idx) => <div key={idx} style={{ fontSize: 10, color: t.textSub, marginBottom: 3, lineHeight: 1.5 }}>✕ {o}</div>)}
            </div>
          </div>
        </ReportSection>
      )}

      {/* Architecture */}
      {(s.tech_stack || s.patterns) && (
        <ReportSection title="Arquitectura" defaultOpen={false} t={t}>
          {s.tech_stack && Object.keys(s.tech_stack).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Tech stack</div>
              <pre style={{
                background: dark ? "#0A0A09" : "#F8F7F4", color: dark ? "#E8E6DF" : "#1C1B18",
                border: `1px solid ${t.border}`, borderRadius: 4, padding: 8, fontSize: 9,
                fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "pre-wrap", margin: 0,
              }}>{JSON.stringify(s.tech_stack, null, 2)}</pre>
            </div>
          )}
          {s.patterns && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Patrones</div>
              {Array.isArray(s.patterns) ? s.patterns.map((p, i) => <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>• {p}</div>)
                : <pre style={{ background: dark ? "#0A0A09" : "#F8F7F4", border: `1px solid ${t.border}`, borderRadius: 4, padding: 8, fontSize: 9, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "pre-wrap", margin: 0, color: t.text }}>{JSON.stringify(s.patterns, null, 2)}</pre>}
            </div>
          )}
        </ReportSection>
      )}

      {/* Business case */}
      {s.business_case && (
        <ReportSection title="Business case" defaultOpen={false} t={t}>
          <div style={{ fontSize: 10, color: t.text, lineHeight: 1.6 }}>
            {typeof s.business_case === "string" ? s.business_case : JSON.stringify(s.business_case)}
          </div>
          {s.go_no_go?.reasons && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Razones</div>
              {s.go_no_go.reasons.map((r, i) => <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 3, lineHeight: 1.5 }}>• {r}</div>)}
            </div>
          )}
        </ReportSection>
      )}

      {/* Sources */}
      {(s.existing_docs?.length > 0 || s.codebase_references?.length > 0 || s.related_tickets?.length > 0) && (
        <ReportSection title="Fuentes consultadas" defaultOpen={false}
          count={`${(s.existing_docs || []).length + (s.codebase_references || []).length + (s.related_tickets || []).length}`}
          t={t}
        >
          {s.existing_docs?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Documentos</div>
              {renderList(s.existing_docs)}
            </div>
          )}
          {s.codebase_references?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Código referenciado</div>
              {renderList(s.codebase_references)}
            </div>
          )}
          {s.related_tickets?.length > 0 && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 4 }}>Tickets</div>
              {renderList(s.related_tickets)}
            </div>
          )}
        </ReportSection>
      )}

      {/* Gaps */}
      {s.gaps_identified?.length > 0 && (
        <ReportSection title="Gaps identificados" defaultOpen={false} count={`${s.gaps_identified.length}`} t={t}>
          {s.gaps_identified.map((g, i) => (
            <div key={i} style={{ fontSize: 10, color: t.text, marginBottom: 4, paddingLeft: 10, borderLeft: `2px solid #E6A23C`, lineHeight: 1.5 }}>{typeof g === "string" ? g : (g?.description || g?.gap || g?.title || JSON.stringify(g))}</div>
          ))}
        </ReportSection>
      )}
    </div>
  );
}

// ─── Gate Events Panel ────────────────────────────────────────────────────
// Lee /runs/:id/history y cuenta occurrences por phase. Si una phase aparece
// mas de una vez, es que hubo retry del gate (cada attempt appendea una
// state_version). Tambien parsea los logs buscando `[gate] phase=X PASSED|FAILED`
// para violaciones textuales.
function GateEventsPanel({ runId, t, dark }) {
  const [history, setHistory] = useState(null);
  const [logs, setLogs] = useState("");

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [hRes, lRes] = await Promise.all([
          apiFetch(`/runs/${runId}/history`),
          apiFetch(`/runs/${runId}/logs?since=0`),
        ]);
        if (hRes.ok) {
          const h = await hRes.json();
          if (!cancel) setHistory(Array.isArray(h) ? h : []);
        }
        if (lRes.ok) {
          const l = await lRes.json();
          if (!cancel) setLogs(typeof l?.logs === "string" ? l.logs : (l?.logs || []).join("\n"));
        }
      } catch {
        // silent — panel opcional
      }
    })();
    return () => { cancel = true; };
  }, [runId]);

  if (!history) return null;

  // Conteo de attempts por phase.
  const attemptsByPhase = new Map();
  for (const v of history) {
    const k = v.phase || "?";
    attemptsByPhase.set(k, (attemptsByPhase.get(k) || 0) + 1);
  }
  const retried = [...attemptsByPhase.entries()].filter(([, n]) => n > 1);

  // Parse gate events de logs.
  const gateLines = (logs || "")
    .split("\n")
    .filter((l) => l.includes("[gate]"))
    .map((l) => {
      const passed = /phase=(\S+).*PASSED.*attempt (\d+)/.exec(l);
      if (passed) return { phase: passed[1], status: "passed", attempt: Number(passed[2]) };
      const failed = /phase=(\S+).*FAILED\s+attempt=(\d+)/.exec(l);
      if (failed) return { phase: failed[1], status: "failed", attempt: Number(failed[2]), raw: l };
      return null;
    })
    .filter(Boolean);

  if (retried.length === 0 && gateLines.length === 0) return null;

  return (
    <div style={{
      marginTop: 10, padding: "8px 10px",
      background: dark ? "#1a1a1a" : "#f8f8f6",
      border: `1px solid ${t.border}`, borderRadius: 4,
      fontSize: 11, color: t.text,
    }}>
      <div style={{ fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6, color: t.textSub }}>
        Gate events
      </div>
      {retried.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <span style={{ fontWeight: 700, color: "#c57a3a" }}>Phases con retry:</span>{" "}
          {retried.map(([phase, n]) => (
            <span key={phase} style={{
              display: "inline-block", marginRight: 6,
              padding: "1px 6px", borderRadius: 3,
              background: "#c57a3a22", color: "#c57a3a",
              fontFamily: "monospace", fontSize: 10, fontWeight: 700,
            }}>
              {phase} ×{n}
            </span>
          ))}
        </div>
      )}
      {gateLines.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "monospace", fontSize: 10 }}>
          {gateLines.map((g, i) => (
            <div key={i} style={{ color: g.status === "passed" ? "#1D9E75" : "#c33" }}>
              {g.status === "passed" ? "✓" : "✗"} gate.{g.phase} attempt {g.attempt} {g.status === "failed" && g.raw?.includes("violations=") ? `— ${g.raw.split("violations=")[1]?.slice(0, 140)}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function RunDetailPanel({ runId, run, t, dark, onAbort }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState("report"); // report | raw

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await apiFetch(`/runs/${runId}/state`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancel) setState(data);
      } catch (e) {
        if (!cancel) setErr(String(e.message || e));
      }
    })();
    return () => { cancel = true; };
  }, [runId]);

  const handleCopy = () => {
    let text;
    if (viewMode === "report" && state?.json_state) {
      text = reportToMarkdown(state.json_state, run);
    } else {
      const summary = {
        run_id: runId, status: run?.status || "unknown", prompt: run?.prompt || "",
        requester: run?.requester || "", target_repo: run?.target_repo || "",
        started_at: run?.started_at || "", finished_at: run?.finished_at || "",
        completed_phases: run?.completed_phases || [], eval_score: run?.eval_score ?? null,
        error: run?.error || null, state: state?.json_state || null,
      };
      text = JSON.stringify(summary, null, 2);
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isCompleted = run?.status === "completed" || run?.status === "failed";

  return (
    <div style={{ marginTop: 8 }}>
      {err && <div style={{ fontSize: 10, color: "#c33" }}>⚠ {err}</div>}
      <GateEventsPanel runId={runId} t={t} dark={dark} />
      {state && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginBottom: 6 }}>
            {isCompleted && (
              <>
                <button onClick={() => setViewMode("report")} style={{
                  padding: "3px 10px", fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                  background: viewMode === "report" ? C.teal.main : "transparent",
                  color: viewMode === "report" ? "#fff" : t.textSub,
                  border: `1px solid ${viewMode === "report" ? C.teal.main : t.border}`,
                  borderRadius: "4px 0 0 4px",
                }}>Reporte</button>
                <button onClick={() => setViewMode("raw")} style={{
                  padding: "3px 10px", fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                  background: viewMode === "raw" ? C.teal.main : "transparent",
                  color: viewMode === "raw" ? "#fff" : t.textSub,
                  border: `1px solid ${viewMode === "raw" ? C.teal.main : t.border}`,
                  borderRadius: "0 4px 4px 0", marginLeft: -1,
                }}>JSON</button>
              </>
            )}
            <button
              onClick={handleCopy}
              style={{
                padding: "3px 10px", background: copied ? C.green.main : "transparent",
                color: copied ? "#fff" : t.textSub,
                border: `1px solid ${copied ? C.green.main : t.border}`,
                borderRadius: 4, fontSize: 10, fontFamily: "inherit",
                fontWeight: 700, cursor: "pointer", transition: "all 0.2s", marginLeft: 6,
                animation: copied ? "copyFlash 0.6s ease" : "none",
              }}
            >
              {copied ? "Copiado" : viewMode === "report" ? "Copiar Markdown" : "Copiar JSON"}
            </button>
            <style>{`
              @keyframes copyFlash {
                0% { transform: scale(1); }
                20% { transform: scale(1.15); box-shadow: 0 0 12px ${C.green.main}; }
                50% { transform: scale(1.05); }
                100% { transform: scale(1); box-shadow: none; }
              }
            `}</style>
          </div>
          {viewMode === "report" && isCompleted && state.json_state ? (
            <RunSummaryReport jsonState={state.json_state} run={run} t={t} dark={dark} />
          ) : (
            <pre style={{
              background: dark ? "#0A0A09" : "#F8F7F4",
              color: dark ? "#E8E6DF" : "#1C1B18",
              border: `1px solid ${t.border}`,
              borderRadius: 5, padding: 10, fontSize: 10,
              maxHeight: 400, overflow: "auto",
              fontFamily: "'IBM Plex Mono',monospace",
              whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
            }}>{JSON.stringify(state.json_state, null, 2)}</pre>
          )}
        </>
      )}
    </div>
  );
}

// ─── DashboardView: métricas agregadas desde GET /stats ──────────────────────
// El backend calcula los agregados sobre el TOTAL histórico de runs
// (no limitado a recientes). Antes esto se hacía en cliente sobre los
// últimos 20 runs, que mentía cuando había más historial. Polling cada 5s.
function DashboardView({ activeRuns, t, dark }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await apiFetch(`/stats`);
        if (!r.ok) throw new Error(`/stats HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) { setStats(data); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Loading / error states
  if (err && !stats) {
    return <div style={{ padding: 20, color: "#c33", fontSize: 12 }}>⚠ {err}</div>;
  }
  if (!stats) {
    return <div style={{ padding: 20, color: t.textSub, fontSize: 12 }}>Cargando métricas...</div>;
  }

  const byStatus = stats.runs_by_status || {};
  const totalCompleted = byStatus.completed || 0;
  const avgDurationSec = stats.avg_run_duration_sec;
  const formatDuration = (s) => {
    if (s == null) return "—";
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s - m * 60);
    return `${m}m ${rs}s`;
  };
  const formatCost = (c) => `$${(c || 0).toFixed(2)}`;
  const formatPhaseMs = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const statCard = (label, value, color, sub) => (
    <div style={{
      flex: 1, minWidth: 140,
      background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8,
      padding: 14,
    }}>
      <div style={{ fontSize: 9, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: "-0.02em", lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: t.textSub, marginTop: 4 }}>{sub}</div>}
    </div>
  );

  // Mini bar chart: runs por status
  const statusOrder = ["completed", "running", "awaiting_hitl", "pending", "failed", "aborted"];
  const maxCount = Math.max(1, ...statusOrder.map(s => byStatus[s] || 0));

  const phaseEntries = Object.entries(stats.avg_phase_duration_ms || {})
    .sort(([, a], [, b]) => b - a);
  const maxPhaseMs = Math.max(1, ...phaseEntries.map(([, ms]) => ms));

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {statCard("Total runs", stats.total_runs, t.text,
          `${stats.runs_last_7_days} en últimos 7 días`)}
        {statCard("En curso", activeRuns.length, C.teal.main,
          `${byStatus.running || 0} running · ${byStatus.awaiting_hitl || 0} HITL`)}
        {statCard("Completados", byStatus.completed || 0, C.green.main,
          `${((byStatus.completed || 0) * 100 / Math.max(1, stats.total_runs)).toFixed(0)}% del total`)}
        {statCard("Failed", byStatus.failed || 0, C.red.main,
          byStatus.aborted ? `+${byStatus.aborted} aborted` : null)}
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {statCard("Duración promedio", formatDuration(avgDurationSec), t.text,
          `sobre ${totalCompleted} completados`)}
        {statCard("Costo total", formatCost(stats.total_cost_usd), t.text,
          `${formatCost(stats.cost_last_7_days_usd)} últimos 7 días`)}
        {statCard("Agent runs", stats.total_agent_runs, t.text,
          totalCompleted > 0
            ? `~${(stats.total_agent_runs / Math.max(1, stats.total_runs)).toFixed(1)} por run`
            : null)}
      </div>

      {/* Distribución por status — bar chart */}
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 12, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Distribución por status
        </div>
        {statusOrder.map(s => {
          const n = byStatus[s] || 0;
          const pct = (n / maxCount) * 100;
          const color = statusColor(s, C, t);
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, fontSize: 11 }}>
              <div style={{ width: 110, color: t.textSub, textTransform: "uppercase", fontSize: 9, letterSpacing: "0.04em", fontWeight: 700 }}>{s}</div>
              <div style={{ flex: 1, height: 14, background: t.bgSubtle, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", width: `${pct}%`, background: color,
                  transition: "width 0.3s",
                }} />
              </div>
              <div style={{ width: 28, textAlign: "right", color: t.text, fontWeight: 700, fontFamily: "monospace" }}>{n}</div>
            </div>
          );
        })}
      </div>

      {/* Avg duration por phase — bar chart horizontal coloreado */}
      {phaseEntries.length > 0 && (
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 12, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Duración promedio por phase
          </div>
          {phaseEntries.map(([phase, ms]) => {
            const pct = (ms / maxPhaseMs) * 100;
            const color = PHASE_COLORS[phase] || PHASE_DEFAULT_COLOR;
            return (
              <div key={phase} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, fontSize: 11 }}>
                <div style={{ width: 110, color: t.textSub, textTransform: "uppercase", fontSize: 9, letterSpacing: "0.04em", fontWeight: 700 }}>{phase}</div>
                <div style={{ flex: 1, height: 14, background: t.bgSubtle, borderRadius: 3, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${pct}%`, background: color,
                    transition: "width 0.3s",
                  }} />
                </div>
                <div style={{ width: 56, textAlign: "right", color: t.text, fontWeight: 700, fontFamily: "monospace", fontSize: 10 }}>{formatPhaseMs(ms)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Timeline compacto de activeRuns como shortcut al tab del run */}
      {activeRuns.length > 0 && (
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Runs en curso — abrí el tab para ver detalle
          </div>
          {activeRuns.map(run => (
            <div key={run.run_id} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, marginBottom: 4 }}>
                <code style={{ color: t.text, fontWeight: 700 }}>{run.run_id}</code>
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 9,
                  background: statusColor(run.status, C, t), color: "#fff",
                  textTransform: "uppercase", letterSpacing: "0.04em",
                }}>{run.status}</span>
                <span style={{ color: t.textSub }}>{(run.completed_phases || []).length}/10</span>
              </div>
              <RunTimeline run={run} t={t} dark={dark} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── HistoricoView: lista de runs recientes con expand detail ─────────────────
function HistoricoView({ recentRuns, openDetail, setOpenDetail, abortRun, t, dark }) {
  return (
    <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
        Historial reciente ({recentRuns.length})
      </div>
      {recentRuns.length === 0 && (
        <div style={{ fontSize: 12, color: t.textSub, padding: "10px 2px" }}>Sin runs todavía.</div>
      )}
      {recentRuns.map(run => {
        const sc = statusColor(run.status, C, t);
        const completedCount = (run.completed_phases || []).length;
        const isActive = ["pending", "running", "awaiting_hitl"].includes(run.status);
        const isOpen = openDetail[run.run_id];
        return (
          <div key={run.run_id} style={{
            marginBottom: 8, padding: 8, borderRadius: 5,
            background: isOpen ? t.bgSubtle : "transparent",
            border: `1px solid ${isOpen ? C.teal.main : t.border}`,
          }}>
            <div
              onClick={() => setOpenDetail(o => ({ ...o, [run.run_id]: !o[run.run_id] }))}
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }}
            >
              <span style={{ fontSize: 10, color: t.textSub, width: 12 }}>{isOpen ? "▼" : "▶"}</span>
              <code style={{ fontSize: 10, color: t.text, fontWeight: 700 }}>{run.run_id}</code>
              <span style={{
                fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 9,
                background: sc, color: "#fff", textTransform: "uppercase", letterSpacing: "0.04em",
              }}>{run.status}</span>
              <span style={{ fontSize: 9, color: t.textSub }}>{completedCount}/10</span>
              <span style={{ fontSize: 10, color: t.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {run.prompt}
              </span>
              <span style={{ fontSize: 9, color: t.textSub }}>
                {run.started_at?.slice(5, 16).replace("T", " ") || ""}
              </span>
            </div>
            {isOpen && (
              <div style={{ marginTop: 8, paddingLeft: 20 }}>
                {run.error && (
                  <div style={{ fontSize: 10, color: C.red.main, marginBottom: 6, fontFamily: "monospace" }}>
                    error: {run.error}
                  </div>
                )}
                <div style={{ fontSize: 10, color: t.textSub, marginBottom: 4 }}>
                  phases ejecutadas: {(run.completed_phases || []).join(" → ") || "(ninguna)"}
                </div>
                <PixelPipeline run={run} dark={dark} />
                {isActive && (
                  <button
                    onClick={() => { if (confirm(`Abort run ${run.run_id}?`)) abortRun(run.run_id); }}
                    style={{
                      padding: "3px 10px", marginTop: 4, marginRight: 6,
                      background: "transparent", color: C.red.main,
                      border: `1px solid ${C.red.main}`, borderRadius: 4,
                      fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    ✕ Abort
                  </button>
                )}
                <ReportErrorBoundary>
                  <RunDetailPanel runId={run.run_id} run={run} t={t} dark={dark} />
                </ReportErrorBoundary>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── ActiveRunView: vista de UN run en curso con logs + pending HITL ──────────
function ActiveRunView({
  runId, run, pending, selected, setSelected,
  resolver, setResolver, feedback, setFeedback,
  resolving, onResolve, abortRun, t, dark,
}) {
  const runPending = pending.filter(cp => cp.run_id === runId);
  // Si hay exactamente 1 pending y ninguno selected, auto-seleccionar
  useEffect(() => {
    if (runPending.length === 1 && !selected) {
      setSelected(runPending[0]);
    }
  }, [runPending, selected, setSelected]);

  if (!run) {
    return (
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 30, textAlign: "center", color: t.textSub }}>
        Run {runId} ya no está activo. Revisalo en el tab Histórico.
      </div>
    );
  }

  const sc = statusColor(run.status, C, t);
  const completedCount = (run.completed_phases || []).length;

  return (
    <div>
      {/* Header del run */}
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <code style={{ fontSize: 12, color: t.text, fontWeight: 700 }}>{runId}</code>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
            background: sc, color: "#fff", textTransform: "uppercase", letterSpacing: "0.04em",
          }}>{run.status}</span>
          <span style={{ fontSize: 11, color: t.textSub }}>{completedCount}/10 phases</span>
          <span style={{ fontSize: 11, color: t.textSub, marginLeft: "auto" }}>
            started: {run.started_at?.slice(5, 19).replace("T", " ") || ""}
          </span>
        </div>
        <div style={{ fontSize: 12, color: t.textSub, marginBottom: 10 }}>{run.prompt}</div>
        <RunTimeline run={run} t={t} dark={dark} />
        <PixelPipeline run={run} dark={dark} />
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => { if (confirm(`Abort run ${runId}?`)) abortRun(runId); }}
            style={{
              padding: "4px 12px", background: "transparent", color: C.red.main,
              border: `1px solid ${C.red.main}`, borderRadius: 4,
              fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
            }}
          >
            ✕ Abort run
          </button>
        </div>
      </div>

      {/* Logs en vivo */}
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Console (streaming)
        </div>
        <RunLogConsole runId={runId} t={t} dark={dark} />
      </div>

      {/* Pending HITL + detalle — solo si el run está awaiting_hitl */}
      {run.status === "awaiting_hitl" && (
        <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: 16 }}>
          <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Pendientes ({runPending.length})
            </div>
            {runPending.length === 0 && (
              <div style={{ fontSize: 11, color: t.textSub, padding: 10, textAlign: "center" }}>
                Sin checkpoints pendientes
              </div>
            )}
            {runPending.map(cp => (
              <div key={cp.id} onClick={() => setSelected(cp)} style={{
                padding: 10, marginBottom: 6, borderRadius: 6, cursor: "pointer",
                background: selected?.id === cp.id ? (dark ? "#1e2a2a" : "#e8f6f5") : "transparent",
                border: `1px solid ${selected?.id === cp.id ? C.teal.main : t.border}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.teal.main, marginBottom: 2 }}>{cp.agent}</div>
                <div style={{ fontSize: 9, color: t.textSub, fontFamily: "monospace" }}>{cp.id}</div>
                <div style={{ fontSize: 10, color: t.textSub, marginTop: 2 }}>next: {cp.next_phase || "—"}</div>
              </div>
            ))}
          </div>

          <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 16, minHeight: 400 }}>
            {!selected && (
              <div style={{ fontSize: 12, color: t.textSub, textAlign: "center", padding: 60 }}>
                Seleccioná un checkpoint pendiente
              </div>
            )}
            {selected && (
              <div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em" }}>Agent · phase</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: t.text }}>{selected.agent} · {selected.phase}</div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                    Pending state patch
                  </div>
                  <pre style={{
                    background: dark ? "#0A0A09" : "#F8F7F4",
                    color: dark ? "#E8E6DF" : "#1C1B18",
                    border: `1px solid ${t.border}`,
                    borderRadius: 6, padding: 12, fontSize: 11,
                    maxHeight: 340, overflow: "auto",
                    fontFamily: "'IBM Plex Mono',monospace",
                    whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
                  }}>{JSON.stringify(selected.pending_state_patch, null, 2)}</pre>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
                    Tu email (resolver)
                  </label>
                  <input value={resolver} onChange={e => setResolver(e.target.value)} style={{
                    width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "inherit",
                    background: t.bg, color: t.text, border: `1px solid ${t.border}`, borderRadius: 5,
                  }} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
                    Feedback (opcional approve, obligatorio reject)
                  </label>
                  <textarea value={feedback} onChange={e => setFeedback(e.target.value)} rows={3} style={{
                    width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "inherit",
                    background: t.bg, color: t.text, border: `1px solid ${t.border}`, borderRadius: 5,
                    resize: "vertical",
                  }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => onResolve("approved")} disabled={resolving} style={{
                    flex: 1, padding: "10px 14px", background: C.green.main, color: "#fff", border: "none",
                    borderRadius: 6, cursor: resolving ? "wait" : "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 700,
                  }}>{resolving ? "..." : "Approve & Continue"}</button>
                  <button onClick={() => onResolve("rejected")} disabled={resolving || !feedback} style={{
                    flex: 1, padding: "10px 14px", background: C.red.main, color: "#fff", border: "none",
                    borderRadius: 6, cursor: (resolving || !feedback) ? "not-allowed" : "pointer",
                    fontSize: 13, fontFamily: "inherit", fontWeight: 700, opacity: (resolving || !feedback) ? 0.5 : 1,
                  }}>{resolving ? "..." : "Reject & Fail Run"}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// AuthGate envuelve OperationsPage. Al mount hace GET /healthz: si la
// API esta abierta (auth_required:false), renderiza children directo. Si
// no, requiere que haya una key en localStorage; si falta o se invalida
// (evento "adlc:401"), muestra el modal de input. Una vez guardada, los
// hijos se rerenderean y los fetches subsecuentes ya llevan Authorization.
function AuthGate({ t, dark, children }) {
  const [phase, setPhase] = useState("checking");  // checking | open | needs_key | ready | error
  const [error, setError] = useState(null);
  const [draftKey, setDraftKey] = useState("");

  const checkHealth = useCallback(async () => {
    setPhase("checking"); setError(null);
    try {
      const r = await fetch(`${API_BASE}/healthz`);
      if (!r.ok) throw new Error(`/healthz HTTP ${r.status}`);
      const data = await r.json();
      if (!data.auth_required) {
        setPhase("open");
        return;
      }
      if (getApiKey()) {
        setPhase("ready");
      } else {
        setPhase("needs_key");
      }
    } catch (e) {
      setError(String(e.message || e));
      setPhase("error");
    }
  }, []);

  useEffect(() => { checkHealth(); }, [checkHealth]);

  // Listen for 401 events from apiFetch — la key fue rechazada, pedirla
  // de nuevo. apiFetch ya limpio la storage antes del dispatch.
  useEffect(() => {
    const onUnauthorized = () => setPhase("needs_key");
    if (typeof window !== "undefined") {
      window.addEventListener("adlc:401", onUnauthorized);
      return () => window.removeEventListener("adlc:401", onUnauthorized);
    }
  }, []);

  const submit = (e) => {
    e?.preventDefault?.();
    const k = draftKey.trim();
    if (!k) return;
    setApiKey(k);
    setDraftKey("");
    setPhase("ready");
  };

  if (phase === "checking") {
    return (
      <div style={{ padding: 20, color: t.fgMuted, fontSize: 13 }}>
        Verificando estado de auth...
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ color: "#c33", fontSize: 13, marginBottom: 8 }}>
          ⚠ No pude alcanzar la API en <code>{API_BASE}</code>: {error}
        </div>
        <button onClick={checkHealth} style={{
          background: t.accent, color: "#fff", border: "none",
          padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
        }}>Reintentar</button>
      </div>
    );
  }
  if (phase === "needs_key") {
    return (
      <div style={{
        maxWidth: 480, margin: "60px auto", padding: 24,
        background: t.bgSubtle, border: `1px solid ${t.border}`, borderRadius: 8,
      }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>
          API key requerida
        </div>
        <div style={{ fontSize: 12, color: t.fgMuted, marginBottom: 14, lineHeight: 1.5 }}>
          La API de ADLC está corriendo en modo autenticado. Pegá la key
          configurada en <code>ADLC_API_KEY</code> del backend para
          continuar. Se guarda en <code>localStorage</code> de tu browser.
        </div>
        <form onSubmit={submit}>
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="ADLC_API_KEY"
            autoFocus
            style={{
              width: "100%", padding: "10px 12px",
              border: `1px solid ${t.border}`, borderRadius: 5,
              background: dark ? "#0A0A09" : "#fff",
              color: t.fg, fontSize: 13, fontFamily: "monospace",
              boxSizing: "border-box", marginBottom: 12,
            }}
          />
          <button type="submit" disabled={!draftKey.trim()} style={{
            background: t.accent, color: "#fff", border: "none",
            padding: "10px 18px", borderRadius: 6,
            cursor: draftKey.trim() ? "pointer" : "not-allowed",
            opacity: draftKey.trim() ? 1 : 0.5,
            fontSize: 13, fontWeight: 600,
          }}>Guardar y entrar</button>
        </form>
      </div>
    );
  }
  // open o ready → renderizar children
  return children;
}

// ─── Repo category constants ─────────────────────────────────────────────────
const REPO_CATEGORIES = [
  { id: "desarrollo_back", label: "Desarrollo Back", color: "#4A90D9" },
  { id: "desarrollo_front", label: "Desarrollo Front", color: "#E6A23C" },
  { id: "arquitectura", label: "Arquitectura", color: "#67C23A" },
  { id: "design_system", label: "Design System", color: "#9B59B6" },
  { id: "ux", label: "UX / Diseño", color: "#F56C6C" },
  { id: "infra", label: "Infraestructura", color: "#909399" },
  { id: "seguridad", label: "Seguridad", color: "#B37FEB" },
];

// ─── NuevoRunView: form para crear un run + panel de contexto ────────────────
function NuevoRunView({ contextData, ghRepos, prompt, setPrompt, requester, setRequester, repoSelections, setRepoSelections, submitting, onSubmit, t, dark }) {
  const [openAreas, setOpenAreas] = useState({});
  const [repoFilter, setRepoFilter] = useState("");
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const toggleArea = (key) => setOpenAreas(o => ({ ...o, [key]: !o[key] }));

  // repoSelections = { "owner/repo": ["desarrollo_back", "arquitectura"], ... }
  const selectedRepos = Object.keys(repoSelections).filter(k => repoSelections[k].length > 0);
  const hasDevRepo = selectedRepos.some(n => (repoSelections[n] || []).some(c => c.startsWith("desarrollo_")));
  const missingDevRepo = selectedRepos.length > 0 && !hasDevRepo;
  const filteredGhRepos = (ghRepos || []).filter(r =>
    !repoFilter || r.full_name.toLowerCase().includes(repoFilter.toLowerCase()) ||
    (r.description || "").toLowerCase().includes(repoFilter.toLowerCase())
  );

  const toggleRepoCategory = (repoName, catId) => {
    setRepoSelections(prev => {
      const current = prev[repoName] || [];
      const next = current.includes(catId)
        ? current.filter(c => c !== catId)
        : [...current, catId];
      const copy = { ...prev };
      if (next.length === 0) delete copy[repoName];
      else copy[repoName] = next;
      return copy;
    });
  };

  const renderVal = (val, depth = 0) => {
    if (val == null) return null;
    if (Array.isArray(val)) return (
      <ul style={{ margin: "2px 0", paddingLeft: 16 }}>
        {val.map((v, i) => <li key={i} style={{ fontSize: 10, color: t.text, lineHeight: 1.6 }}>{typeof v === "object" ? renderVal(v, depth + 1) : String(v)}</li>)}
      </ul>
    );
    if (typeof val === "object") return (
      <div style={{ paddingLeft: depth > 0 ? 10 : 0 }}>
        {Object.entries(val).map(([k, v]) => (
          <div key={k} style={{ marginBottom: 3 }}>
            <span style={{ fontSize: 9, color: t.textSub, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>{k}: </span>
            {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
              ? <span style={{ fontSize: 10, color: t.text }}>{String(v)}</span>
              : renderVal(v, depth + 1)}
          </div>
        ))}
      </div>
    );
    return <span style={{ fontSize: 10, color: t.text }}>{String(val)}</span>;
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)", gap: 16 }}>
      {/* LEFT: Form (prompt + email + submit) */}
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 14, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Nuevo requerimiento
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
            Prompt / descripción del requerimiento
          </label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={8}
            placeholder="Describe el requerimiento de negocio o técnico que quieres implementar..."
            style={{
              width: "100%", padding: "10px 12px", fontSize: 12, fontFamily: "inherit",
              background: dark ? "#0A0A09" : "#fff", color: t.text,
              border: `1px solid ${t.border}`, borderRadius: 5,
              boxSizing: "border-box", resize: "vertical", lineHeight: 1.5,
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            <button
              onClick={() => {
                setPrompt("Extender la app iOS nativa (Swift/SwiftUI) de pagos con una extensión para Apple Watch que permita generar y mostrar el código QR de pago. Debe reusar la lógica existente de QRGenerator y PaymentService del módulo MachPayCore (SwiftPM library target) sin modificarlos — el watchOS app consume el mismo core via import. Entregables: target watchOS 'MachPayWatch' con una vista SwiftUI que muestra QR del último pago pendiente, sincronización via WatchConnectivity (WCSession emulado con protocolo propio, mock en tests), y al menos 3 tests XCTest: render del QR desde un Payment conocido, fallback cuando no hay payment activo, envío/recepción del mensaje WCSession. Los tests existentes del MachPayCore (QRGeneratorTests, PaymentServiceTests) deben seguir pasando. Sin modificar archivos existentes salvo Package.swift para sumar el nuevo target.");
                const repos = ghRepos || [];
                const fixture = repos.find(r => r.full_name.includes("adlc-fixture-machpay-ios")) || repos.find(r => r.full_name.includes("adlc-fixture-mobile")) || repos.find(r => r.full_name.includes("adlc-fixture-"));
                if (fixture) {
                  setRepoSelections({ [fixture.full_name]: ["desarrollo_back"] });
                }
              }}
              style={{
                padding: "4px 10px", background: "transparent",
                color: t.textSub, border: `1px dashed ${t.border}`, borderRadius: 4,
                fontSize: 9, fontFamily: "inherit", cursor: "pointer",
              }}
              title="Brownfield: extiende MachPay iOS para Apple Watch reusando QR core"
            >
              Ejemplo brownfield: QR de pago en Apple Watch (Swift)
            </button>
            <button
              onClick={() => {
                setPrompt("Crear app iOS nativa 'mach-onboarding' en Swift/SwiftUI para onboarding de clientes nuevos con análisis facial EMULADO (no integrar libs reales de ML/Vision — simular respuestas con un FacialAnalysisService protocolo + FakeFacialAnalysisService que retorna scores determinísticos según el nombre del archivo de imagen). Flujo: 3 pantallas (datos básicos → captura foto → revisión y envío). Backend Fastify+TypeScript 'mach-onboarding-api' con base de datos fake en memoria (Map) que expone: POST /onboardings {nombre, rut, email} retorna 201 con onboarding_id; POST /onboardings/:id/facial {imageBase64} retorna {match_score:0-100, liveness_score:0-100, decision:approved|review|rejected} usando valores determinísticos pre-cargados en el fake DB; GET /onboardings/:id devuelve estado actual. Incluir fixtures en el fake DB con 3 casos de prueba: aprobado alto score, revisión manual, rechazado. Tests: XCTest para Swift (view model con servicio fake, 3 casos) y Vitest para backend (4 endpoints × decisiones). Estructura SwiftPM + workspace Node/pnpm. No incluir deployment ni CI.");
                setRepoSelections({});
              }}
              style={{
                padding: "4px 10px", background: "transparent",
                color: t.textSub, border: `1px dashed ${t.border}`, borderRadius: 4,
                fontSize: 9, fontFamily: "inherit", cursor: "pointer",
              }}
              title="Greenfield: app iOS onboarding con análisis facial emulado + backend Fastify fake DB"
            >
              Ejemplo greenfield: onboarding con análisis facial (Swift + Fastify)
            </button>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 10, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
            Solicitante (email)
          </label>
          <input
            value={requester}
            onChange={e => setRequester(e.target.value)}
            placeholder="usuario@empresa.cl"
            style={{
              width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "inherit",
              background: dark ? "#0A0A09" : "#fff", color: t.text,
              border: `1px solid ${t.border}`, borderRadius: 5, boxSizing: "border-box",
            }}
          />
        </div>
        {/* Repos seleccionados resumen */}
        {selectedRepos.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: t.textSub, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
              Repos seleccionados ({selectedRepos.length})
            </div>
            {selectedRepos.map(repoName => (
              <div key={repoName} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                <code style={{ fontSize: 9, color: t.text }}>{repoName}</code>
                <div style={{ display: "flex", gap: 2 }}>
                  {(repoSelections[repoName] || []).map(catId => {
                    const cat = REPO_CATEGORIES.find(c => c.id === catId);
                    return cat ? <span key={catId} style={{ fontSize: 7, padding: "0px 4px", borderRadius: 6, background: cat.color, color: "#fff", fontWeight: 700 }}>{cat.label}</span> : null;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {missingDevRepo && (
          <div style={{ padding: "8px 12px", background: "#FFF3CD", border: "1px solid #FFEAA7", borderRadius: 6, fontSize: 11, color: "#856404", marginBottom: 8 }}>
            Seleccionaste repos pero ninguno tiene categoria <b>Desarrollo Back</b> o <b>Desarrollo Front</b>. ADLC necesita al menos un repo de desarrollo como target — los de Arquitectura, Design System, UX, etc. son solo referencias.
          </div>
        )}
        <button
          onClick={onSubmit}
          disabled={submitting || !prompt.trim() || !requester.trim() || missingDevRepo}
          style={{
            padding: "10px 20px", background: C.teal.main, color: "#fff", border: "none",
            borderRadius: 6, fontSize: 13, fontFamily: "inherit", fontWeight: 700,
            cursor: submitting || !prompt.trim() || !requester.trim() || missingDevRepo ? "not-allowed" : "pointer",
            opacity: submitting || !prompt.trim() || !requester.trim() || missingDevRepo ? 0.5 : 1,
          }}
        >
          {submitting ? "Creando run..." : "Lanzar ciclo ADLC"}
        </button>
      </div>

      {/* RIGHT: Ecosistema de código (repos + stack docs) */}
      <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 14, maxHeight: 700, overflow: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.textSub, marginBottom: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Ecosistema de código
        </div>
        {contextData?.target?.name && (
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text, marginBottom: 2 }}>
            {contextData.target.name}
          </div>
        )}
        {contextData?.target?.description && (
          <div style={{ fontSize: 10, color: t.textSub, marginBottom: 10, lineHeight: 1.5 }}>
            {contextData.target.description}
          </div>
        )}

        {/* Repositorios */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: t.text }}>Repositorios ({selectedRepos.length} seleccionados)</span>
            <button
              onClick={() => setShowRepoPicker(!showRepoPicker)}
              style={{
                padding: "3px 10px", background: "transparent", color: C.teal.main,
                border: `1px solid ${C.teal.main}`, borderRadius: 4,
                fontSize: 9, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
              }}
            >
              {showRepoPicker ? "Cerrar" : "+ Agregar"}
            </button>
          </div>
          {selectedRepos.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              {selectedRepos.map(repoName => (
                <div key={repoName} style={{
                  display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
                  padding: "4px 8px", background: t.bgSubtle, borderRadius: 4, border: `1px solid ${t.border}`,
                }}>
                  <code style={{ fontSize: 10, color: t.text, flex: 1 }}>{repoName}</code>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                    {(repoSelections[repoName] || []).map(catId => {
                      const cat = REPO_CATEGORIES.find(c => c.id === catId);
                      return cat ? (
                        <span key={catId} style={{
                          fontSize: 8, padding: "1px 5px", borderRadius: 8,
                          background: cat.color, color: "#fff", fontWeight: 700,
                        }}>{cat.label}</span>
                      ) : null;
                    })}
                  </div>
                  <span
                    onClick={() => setRepoSelections(prev => { const c = { ...prev }; delete c[repoName]; return c; })}
                    style={{ fontSize: 10, color: t.textSub, cursor: "pointer", padding: "0 2px" }}
                  >✕</span>
                </div>
              ))}
            </div>
          )}
          {showRepoPicker && (
            <div style={{
              border: `1px solid ${t.border}`, borderRadius: 6, padding: 10,
              background: dark ? "#0A0A09" : "#FAFAF8", maxHeight: 280, overflow: "auto",
            }}>
              <input
                value={repoFilter}
                onChange={e => setRepoFilter(e.target.value)}
                placeholder="Buscar repo..."
                style={{
                  width: "100%", padding: "6px 8px", fontSize: 11, fontFamily: "inherit",
                  background: dark ? "#111" : "#fff", color: t.text,
                  border: `1px solid ${t.border}`, borderRadius: 4, boxSizing: "border-box",
                  marginBottom: 8,
                }}
              />
              {!ghRepos && <div style={{ fontSize: 10, color: t.textSub, padding: 8, textAlign: "center" }}>Cargando repos de GitHub...</div>}
              {ghRepos?.length === 0 && <div style={{ fontSize: 10, color: t.textSub, padding: 8 }}>No se encontraron repos.</div>}
              {filteredGhRepos.slice(0, 50).map(repo => {
                const cats = repoSelections[repo.full_name] || [];
                return (
                  <div key={repo.full_name} style={{
                    padding: "6px 8px", marginBottom: 3, borderRadius: 4,
                    background: cats.length > 0 ? (dark ? "#1a2a1a" : "#f0faf0") : "transparent",
                    border: `1px solid ${cats.length > 0 ? C.teal.main + "44" : t.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <code style={{ fontSize: 10, color: t.text, fontWeight: 600 }}>{repo.full_name}</code>
                      {repo.private && <span style={{ fontSize: 7, color: t.textSub, border: `1px solid ${t.textSub}`, padding: "0 3px", borderRadius: 3 }}>PRIVATE</span>}
                      {repo.language && <span style={{ fontSize: 8, color: t.textSub }}>{repo.language}</span>}
                    </div>
                    {repo.description && <div style={{ fontSize: 9, color: t.textSub, marginBottom: 4 }}>{repo.description}</div>}
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {REPO_CATEGORIES.map(cat => {
                        const active = cats.includes(cat.id);
                        return (
                          <button
                            key={cat.id}
                            onClick={() => toggleRepoCategory(repo.full_name, cat.id)}
                            style={{
                              fontSize: 8, padding: "2px 6px", borderRadius: 8,
                              background: active ? cat.color : "transparent",
                              color: active ? "#fff" : t.textSub,
                              border: `1px solid ${active ? cat.color : t.border}`,
                              cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
                            }}
                          >{cat.label}</button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Areas: stack docs + repos asignados a cada categoría */}
        {(() => {
          // Map repo categories → area keys
          const catToArea = {
            desarrollo_back: "backend", desarrollo_front: "frontend",
            arquitectura: "backend", ux: "ux_ui_kit",
            infra: "infrastructure", seguridad: "compliance",
          };
          // Build repos-per-area from selections
          const reposByArea = {};
          for (const [repoName, cats] of Object.entries(repoSelections)) {
            for (const catId of cats) {
              const areaKey = catToArea[catId] || catId;
              if (!reposByArea[areaKey]) reposByArea[areaKey] = [];
              const cat = REPO_CATEGORIES.find(c => c.id === catId);
              reposByArea[areaKey].push({ name: repoName, catLabel: cat?.label || catId, catColor: cat?.color || t.textSub });
            }
          }
          // All area keys (from context + from selections)
          const allAreaKeys = new Set([
            ...Object.keys(contextData?.areas || {}),
            ...Object.keys(reposByArea),
          ]);
          const areaLabels = { backend: "Backend", frontend: "Frontend", ux_ui_kit: "UX / UI Kit", infrastructure: "Infraestructura", compliance: "Compliance / Seguridad" };
          return [...allAreaKeys].map(key => {
            const area = contextData?.areas?.[key];
            const isOpen = openAreas[key];
            const hasDocs = area?.docs && Object.keys(area.docs).length > 0;
            const areaRepos = reposByArea[key] || [];
            const hasContent = hasDocs || areaRepos.length > 0;
            return (
              <div key={key} style={{
                marginBottom: 5, border: `1px solid ${t.border}`, borderRadius: 5,
                background: isOpen ? t.bgSubtle : "transparent",
              }}>
                <div
                  onClick={() => toggleArea(key)}
                  style={{
                    padding: "6px 10px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <span style={{ fontSize: 9, color: t.textSub }}>{isOpen ? "▼" : "▶"}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: t.text }}>{area?.label || areaLabels[key] || key}</span>
                  {areaRepos.length > 0 && <span style={{ fontSize: 8, color: C.teal.main, fontWeight: 700 }}>{areaRepos.length} repo{areaRepos.length > 1 ? "s" : ""}</span>}
                  {!hasContent && <span style={{ fontSize: 9, color: t.textSub, fontStyle: "italic" }}>(sin docs ni repos)</span>}
                </div>
                {isOpen && (
                  <div style={{ padding: "4px 10px 10px 24px" }}>
                    {areaRepos.length > 0 && (
                      <div style={{ marginBottom: hasDocs ? 8 : 0 }}>
                        {areaRepos.map((r, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                            <span style={{ fontSize: 8, color: t.textSub }}>&#9679;</span>
                            <code style={{ fontSize: 10, color: t.text }}>{r.name}</code>
                            <span style={{ fontSize: 7, padding: "0px 4px", borderRadius: 6, background: r.catColor, color: "#fff", fontWeight: 700 }}>{r.catLabel}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {hasDocs && renderVal(area.docs)}
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

function OperationsPage({ t, dark }) {
  const [pending, setPending] = useState([]);
  const [activeRuns, setActiveRuns] = useState([]);
  const [recentRuns, setRecentRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);  // checkpoint seleccionado
  const [resolver, setResolver] = useState("tester@x");
  const [feedback, setFeedback] = useState("");
  const [resolving, setResolving] = useState(false);
  const [toast, setToast] = useState(null);
  const [openLogs, setOpenLogs] = useState({});  // run_id → bool (runs activos, legacy)
  const [openDetail, setOpenDetail] = useState({});  // run_id → bool (runs recientes)
  const [subTab, setSubTab] = useState("dashboard");  // dashboard | historico | nuevo_run | run:<id>
  // New Run form
  const [newRunPrompt, setNewRunPrompt] = useState("");
  const [newRunRequester, setNewRunRequester] = useState("");
  const [repoSelections, setRepoSelections] = useState({});  // { "owner/repo": ["desarrollo_back", ...] }
  const [contextData, setContextData] = useState(null);
  const [ghRepos, setGhRepos] = useState(null);  // GitHub repos list
  const [submittingRun, setSubmittingRun] = useState(false);

  const loadPending = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [rPending, rActive, rRecent] = await Promise.all([
        apiFetch(`/hitl/pending`),
        apiFetch(`/runs/active`),
        apiFetch(`/runs/recent?limit=20`),
      ]);
      if (!rPending.ok) throw new Error(`GET /hitl/pending → ${rPending.status}`);
      if (!rActive.ok) throw new Error(`GET /runs/active → ${rActive.status}`);
      if (!rRecent.ok) throw new Error(`GET /runs/recent → ${rRecent.status}`);
      const dataPending = await rPending.json();
      const dataActive = await rActive.json();
      const dataRecent = await rRecent.json();
      setPending(dataPending);
      setActiveRuns(dataActive);
      setRecentRuns(dataRecent);
      if (selected) {
        const fresh = dataPending.find(c => c.id === selected.id);
        setSelected(fresh || null);
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const abortRun = useCallback(async (runId) => {
    try {
      const r = await apiFetch(`/runs/${runId}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user aborted from UI" }),
      });
      if (!r.ok) throw new Error(`POST /abort → ${r.status}`);
      setToast(`Run ${runId} aborted`);
      await loadPending();
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [loadPending]);

  useEffect(() => {
    loadPending();
    const iv = setInterval(loadPending, 5000);  // poll cada 5s
    return () => clearInterval(iv);
  }, []);  // eslint-disable-line

  // Si el subTab es de un run que ya no está activo, fallback a histórico
  useEffect(() => {
    if (subTab.startsWith("run:")) {
      const rid = subTab.slice(4);
      if (!activeRuns.find(r => r.run_id === rid)) {
        setSubTab("historico");
      }
    }
  }, [activeRuns, subTab]);

  const resolve = async (decision) => {
    if (!selected) return;
    setResolving(true); setError(null);
    try {
      const r = await apiFetch(`/hitl/${selected.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: selected.run_id,
          decision,
          resolver,
          feedback: feedback || null,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`POST resolve → ${r.status}: ${body.slice(0, 200)}`);
      }
      setToast(`Checkpoint ${selected.id} ${decision}`);
      setFeedback("");
      setSelected(null);
      await loadPending();
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setResolving(false);
    }
  };

  // Load context + GitHub repos when nuevo_run tab is selected
  useEffect(() => {
    if (subTab === "nuevo_run") {
      if (!contextData) {
        apiFetch("/context").then(r => r.ok ? r.json() : null).then(data => {
          if (data) setContextData(data);
        }).catch(() => {});
      }
      if (!ghRepos) {
        apiFetch("/repos").then(r => r.ok ? r.json() : null).then(data => {
          if (data?.repos) setGhRepos(data.repos);
          if (data?.user?.email && !newRunRequester) setNewRunRequester(data.user.email);
        }).catch(() => {});
      }
    }
  }, [subTab]);  // eslint-disable-line

  const submitNewRun = useCallback(async () => {
    if (!newRunPrompt.trim() || !newRunRequester.trim()) return;
    setSubmittingRun(true); setError(null);
    try {
      // target_repo = primer repo con categoria desarrollo_*. Los repos con
      // categoria arquitectura / design_system / ux son referencias, no
      // target. Si no hay ningun desarrollo_*, se bloquea el submit.
      const selectedRepoNames = Object.keys(repoSelections).filter(k => repoSelections[k].length > 0);
      const devRepoNames = selectedRepoNames.filter(n => (repoSelections[n] || []).some(c => c.startsWith("desarrollo_")));
      if (selectedRepoNames.length > 0 && devRepoNames.length === 0) {
        throw new Error("Necesitás al menos un repo con categoría Desarrollo Back o Desarrollo Front como target. Los repos de Arquitectura, Design System, UX, etc. son solo referencias.");
      }
      const targetRepo = devRepoNames[0] || null;
      const r = await apiFetch("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: newRunPrompt.trim(),
          requester: newRunRequester.trim(),
          target_repo: targetRepo,
          metadata: selectedRepoNames.length > 0 ? { repos: repoSelections } : null,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`POST /runs → ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();
      setToast(`Run ${data.run_id} creado`);
      setNewRunPrompt("");
      setTimeout(() => setToast(null), 3000);
      await loadPending();
      setSubTab(`run:${data.run_id}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmittingRun(false);
    }
  }, [newRunPrompt, newRunRequester, repoSelections, loadPending]);

  // Tabs disponibles: dashboard + histórico + nuevo run + uno por cada run activo
  const subTabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "historico", label: "Histórico" },
    { id: "nuevo_run", label: "+ Nuevo Run" },
    ...activeRuns.map(r => ({
      id: `run:${r.run_id}`,
      label: r.run_id.replace(/^run_/, "⚡ "),
      status: r.status,
    })),
  ];

  const currentRunId = subTab.startsWith("run:") ? subTab.slice(4) : null;
  const currentRun = currentRunId ? activeRuns.find(r => r.run_id === currentRunId) : null;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px", color: t.text }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Operaciones / HITL Review</h1>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
            API: <code style={{ background: t.bgSubtle, padding: "1px 6px", borderRadius: 3 }}>{API_BASE}</code>
            {" · "}Polling cada 5s
          </div>
        </div>
        <button onClick={loadPending} disabled={loading} style={{
          padding: "8px 14px", background: C.teal.main, color: "#fff", border: "none",
          borderRadius: 6, cursor: loading ? "wait" : "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
        }}>{loading ? "Cargando..." : "Refrescar"}</button>
      </div>

      {/* SUB-TAB BAR */}
      <div style={{
        display: "flex", gap: 2, marginBottom: 16, borderBottom: `2px solid ${t.border}`,
        overflowX: "auto", paddingBottom: 0,
      }}>
        {subTabs.map(tab => {
          const isActive = subTab === tab.id;
          const isRunTab = tab.id.startsWith("run:");
          const runStatusColor = isRunTab && tab.status ? statusColor(tab.status, C, t) : null;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              style={{
                padding: "10px 16px",
                background: isActive ? t.bgCard : "transparent",
                color: isActive ? t.text : t.textSub,
                border: "none",
                borderTop: `1px solid ${isActive ? t.border : "transparent"}`,
                borderLeft: `1px solid ${isActive ? t.border : "transparent"}`,
                borderRight: `1px solid ${isActive ? t.border : "transparent"}`,
                borderBottom: isActive ? `2px solid ${t.bgCard}` : "2px solid transparent",
                borderRadius: "5px 5px 0 0",
                marginBottom: -2,
                fontSize: 11, fontFamily: "inherit", fontWeight: isActive ? 700 : 500,
                cursor: "pointer", letterSpacing: "0.02em",
                whiteSpace: "nowrap", flexShrink: 0,
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {tab.label}
              {runStatusColor && (
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: runStatusColor,
                  animation: tab.status === "running" ? "pulse 1.4s infinite" : undefined,
                }} />
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ background: "#fee", border: "1px solid #c33", color: "#900", padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 12 }}>
          Error: {error}
        </div>
      )}
      {toast && (
        <div style={{ background: "#efe", border: `1px solid ${C.green.main}`, color: "#070", padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 12 }}>
          {toast}
        </div>
      )}

      {/* VIEWS */}
      {subTab === "dashboard" && (
        <DashboardView activeRuns={activeRuns} t={t} dark={dark} />
      )}
      {subTab === "nuevo_run" && (
        <NuevoRunView
          contextData={contextData}
          ghRepos={ghRepos}
          prompt={newRunPrompt} setPrompt={setNewRunPrompt}
          requester={newRunRequester} setRequester={setNewRunRequester}
          repoSelections={repoSelections} setRepoSelections={setRepoSelections}
          submitting={submittingRun}
          onSubmit={submitNewRun}
          t={t} dark={dark}
        />
      )}
      {subTab === "historico" && (
        <HistoricoView
          recentRuns={recentRuns}
          openDetail={openDetail}
          setOpenDetail={setOpenDetail}
          abortRun={abortRun}
          t={t}
          dark={dark}
        />
      )}
      {currentRunId && (
        <ActiveRunView
          runId={currentRunId}
          run={currentRun}
          pending={pending}
          selected={selected}
          setSelected={setSelected}
          resolver={resolver}
          setResolver={setResolver}
          feedback={feedback}
          setFeedback={setFeedback}
          resolving={resolving}
          onResolve={resolve}
          abortRun={abortRun}
          t={t}
          dark={dark}
        />
      )}
    </div>
  );
}


// ─── ConfigPage: agent specs viewer/editor ──────────────────────────────────
function ConfigPage({ t, dark }) {
  const [specs, setSpecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    apiFetch("/agent-specs").then(r => r.ok ? r.json() : null).then(data => {
      if (data?.specs) { setSpecs(data.specs); if (data.specs.length > 0) setSelectedAgent(data.specs[0].agent); }
      setLoading(false);
    }).catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  const currentSpec = specs.find(s => s.agent === selectedAgent);

  const startEdit = () => {
    if (currentSpec) { setEditContent(currentSpec.raw); setEditing(true); }
  };
  const cancelEdit = () => { setEditing(false); setEditContent(""); };
  const saveEdit = async () => {
    if (!currentSpec) return;
    setSaving(true);
    try {
      const r = await apiFetch(`/agent-specs/${currentSpec.agent}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setToast(`Guardado (backup: ${data.backup})`);
      // Reload specs
      const r2 = await apiFetch("/agent-specs");
      if (r2.ok) { const d2 = await r2.json(); if (d2?.specs) setSpecs(d2.specs); }
      setEditing(false);
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const phaseColors = {
    discovery: "#4A90D9", hypothesis: "#67C23A", mapping: "#E6A23C",
    stack_contract: "#D98C4A", spec: "#F56C6C", architecture: "#909399",
    business: "#B37FEB", coding: "#00B894", validation: "#E63946",
    publish: "#1D9E75",
  };

  if (loading) return <div style={{ padding: 40, color: t.textSub, textAlign: "center" }}>Cargando agent specs...</div>;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px", color: t.text }}>
      <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, margin: "0 0 6px 0", letterSpacing: "-0.02em" }}>
        Configuración de agentes
      </h1>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 18 }}>
        Prompts, guardrails, tools y budget de cada fase del ciclo ADLC. Editable con backup automático.
      </div>

      {error && <div style={{ background: "#fee", border: "1px solid #c33", color: "#900", padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 12 }}>Error: {error}</div>}
      {toast && <div style={{ background: "#efe", border: `1px solid ${C.green.main}`, color: "#070", padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 12 }}>{toast}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 16 }}>
        {/* Left: agent list */}
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Fases del ciclo ({specs.length})
          </div>
          {specs.map((spec, idx) => {
            const active = selectedAgent === spec.agent;
            const pc = phaseColors[spec.phase] || t.textSub;
            return (
              <div
                key={spec.agent}
                onClick={() => { setSelectedAgent(spec.agent); setEditing(false); }}
                style={{
                  padding: "8px 10px", marginBottom: 3, borderRadius: 5, cursor: "pointer",
                  background: active ? t.bgSubtle : "transparent",
                  border: `1px solid ${active ? C.teal.main : "transparent"}`,
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: pc, width: 14, textAlign: "center" }}>{idx + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.text }}>{spec.agent}</div>
                  <div style={{ fontSize: 8, color: t.textSub }}>{spec.tier || "reasoning"} · {spec.model || "default"}</div>
                </div>
                {spec.hitl?.enabled && <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 4, background: "#E6A23C", color: "#fff", fontWeight: 700 }}>HITL</span>}
              </div>
            );
          })}
        </div>

        {/* Right: spec detail */}
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8, padding: 16 }}>
          {!currentSpec && <div style={{ color: t.textSub, padding: 40, textAlign: "center" }}>Selecciona un agente</div>}
          {currentSpec && !editing && (
            <div>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: t.text, fontFamily: "'Space Grotesk',sans-serif" }}>{currentSpec.agent}</div>
                <span style={{
                  fontSize: 9, padding: "2px 8px", borderRadius: 10,
                  background: phaseColors[currentSpec.phase] || t.textSub, color: "#fff", fontWeight: 700,
                }}>{currentSpec.phase}</span>
                <span style={{ fontSize: 10, color: t.textSub }}>{currentSpec.model || "model default"}</span>
                <div style={{ flex: 1 }} />
                <button onClick={startEdit} style={{
                  padding: "5px 14px", background: "transparent", color: C.teal.main,
                  border: `1px solid ${C.teal.main}`, borderRadius: 4,
                  fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                }}>Editar YAML</button>
              </div>

              {/* Description */}
              {currentSpec.description && (
                <div style={{ fontSize: 11, color: t.textSub, marginBottom: 14, lineHeight: 1.5, background: t.bgSubtle, padding: "8px 10px", borderRadius: 5 }}>
                  {currentSpec.description}
                </div>
              )}

              {/* Cards grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {/* Tools */}
                <div style={{ border: `1px solid ${t.border}`, borderRadius: 5, padding: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 6 }}>Tools ({(currentSpec.tools_whitelist || []).length})</div>
                  {(currentSpec.tools_whitelist || []).map(tool => (
                    <div key={tool} style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>
                      <code style={{ background: t.bgSubtle, padding: "1px 5px", borderRadius: 3 }}>{tool}</code>
                    </div>
                  ))}
                  {(currentSpec.tools_whitelist || []).length === 0 && <div style={{ fontSize: 10, color: t.textSub, fontStyle: "italic" }}>Sin tools</div>}
                </div>

                {/* Guardrails */}
                <div style={{ border: `1px solid ${t.border}`, borderRadius: 5, padding: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 6 }}>Guardrails</div>
                  {currentSpec.guardrails?.max_iterations && <div style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>Max iter: <strong>{currentSpec.guardrails.max_iterations}</strong></div>}
                  {(currentSpec.guardrails?.required_outputs || []).map(o => (
                    <div key={o} style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>Required: <code style={{ background: t.bgSubtle, padding: "1px 4px", borderRadius: 3 }}>{o}</code></div>
                  ))}
                </div>

                {/* Reads/Writes */}
                <div style={{ border: `1px solid ${t.border}`, borderRadius: 5, padding: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 6 }}>Reads</div>
                  {(currentSpec.reads || []).map(r => <div key={r} style={{ fontSize: 10, color: t.text, marginBottom: 1 }}><code>{r}</code></div>)}
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginTop: 8, marginBottom: 6 }}>Writes</div>
                  {(currentSpec.writes || []).map(w => <div key={w} style={{ fontSize: 10, color: C.teal.main, marginBottom: 1 }}><code>{w}</code></div>)}
                </div>

                {/* Budget + HITL */}
                <div style={{ border: `1px solid ${t.border}`, borderRadius: 5, padding: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 6 }}>Budget</div>
                  {currentSpec.budget?.max_cost_usd && <div style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>Max: <strong>${currentSpec.budget.max_cost_usd}</strong></div>}
                  {currentSpec.budget?.timeout_minutes && <div style={{ fontSize: 10, color: t.text, marginBottom: 2 }}>Timeout: {currentSpec.budget.timeout_minutes}min</div>}
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginTop: 8, marginBottom: 6 }}>HITL</div>
                  <div style={{ fontSize: 10, color: currentSpec.hitl?.enabled ? "#E6A23C" : t.textSub }}>
                    {currentSpec.hitl?.enabled ? "Habilitado — pausa post-fase" : "Deshabilitado"}
                  </div>
                </div>
              </div>

              {/* System prompt */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: t.textSub, textTransform: "uppercase", marginBottom: 6, letterSpacing: "0.04em" }}>System Prompt</div>
                <pre style={{
                  background: dark ? "#0A0A09" : "#F8F7F4", color: dark ? "#E8E6DF" : "#1C1B18",
                  border: `1px solid ${t.border}`, borderRadius: 5, padding: 12, fontSize: 10,
                  maxHeight: 400, overflow: "auto", fontFamily: "'IBM Plex Mono',monospace",
                  whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, lineHeight: 1.6,
                }}>{currentSpec.system_prompt || "(sin system prompt)"}</pre>
              </div>
            </div>
          )}

          {/* Edit mode */}
          {currentSpec && editing && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Editando: {currentSpec.agent}.yaml</div>
                <div style={{ flex: 1 }} />
                <button onClick={cancelEdit} style={{
                  padding: "5px 12px", background: "transparent", color: t.textSub,
                  border: `1px solid ${t.border}`, borderRadius: 4,
                  fontSize: 10, fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                }}>Cancelar</button>
                <button onClick={saveEdit} disabled={saving} style={{
                  padding: "5px 14px", background: C.teal.main, color: "#fff",
                  border: "none", borderRadius: 4,
                  fontSize: 10, fontFamily: "inherit", fontWeight: 700,
                  cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1,
                }}>{saving ? "Guardando..." : "Guardar"}</button>
              </div>
              <div style={{ fontSize: 9, color: t.textSub, marginBottom: 8 }}>
                Se creará un backup automático del archivo anterior en agent_specs/.backups/
              </div>
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                style={{
                  width: "100%", minHeight: 500, padding: "12px 14px", fontSize: 11,
                  fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1.5,
                  background: dark ? "#0A0A09" : "#FAFAF8", color: dark ? "#E8E6DF" : "#1C1B18",
                  border: `1px solid ${t.border}`, borderRadius: 6,
                  boxSizing: "border-box", resize: "vertical",
                  tabSize: 2,
                }}
                spellCheck={false}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("intro");
  const [dark, setDark] = useState(false);
  const [glossaryTerm, setGlossaryTerm] = useState(null);
  // Canonical project_state compartido entre Demo y Project State
  const [canonicalState, setCanonicalState] = useState(MACHBANK_PROJECT_STATE);
  const [canonicalLive, setCanonicalLive] = useState(false);
  const resetCanonicalExample = useCallback(() => {
    setCanonicalState(MACHBANK_PROJECT_STATE);
    setCanonicalLive(false);
  }, []);
  const t = THEMES[dark ? "dark" : "light"];

  const handleNavigate = useCallback((dest, term) => {
    if (dest === "glossary") { setGlossaryTerm(term); setPage("glossary"); }
    else setPage(dest);
  }, []);

  const pages = [
    { id: "intro", label: "Origen" },
    { id: "learn", label: "Aprender" },
    { id: "build", label: "Construir" },
    { id: "demo",  label: "Demo interactivo" },
    { id: "state", label: "Project State" },
    { id: "ops",   label: "Operaciones" },
    { id: "config", label: "Agentes" },
    { id: "glossary", label: `Glosario (${Object.keys(GLOSSARY).length})` },
    { id: "refs",  label: "Fuentes" },
  ];

  return (
    <div style={{ fontFamily: "'IBM Plex Mono',monospace,sans-serif", background: t.bg, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@500;700&display=swap');
        @keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.45}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#888;border-radius:2px}
        *{box-sizing:border-box}
      `}</style>

      {/* NAV */}
      <div style={{ background: t.headerBg, padding: "0 20px", display: "flex", alignItems: "center", height: 52, gap: 0, borderBottom: `1px solid ${dark ? "#1a1a18" : "#333"}`, flexShrink: 0 }}>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700, color: t.headerText, marginRight: 20, letterSpacing: "-0.02em" }}>ADLC</div>
        {pages.map(pg => (
          <button key={pg.id} onClick={() => { setPage(pg.id); if (pg.id !== "glossary") setGlossaryTerm(null); }} style={{
            padding: "0 16px", height: 52, background: "none", border: "none", cursor: "pointer",
            color: page === pg.id ? t.headerText : "#666",
            fontWeight: page === pg.id ? 700 : 400, fontSize: 12, fontFamily: "inherit",
            borderBottom: page === pg.id ? `2px solid ${C.teal.main}` : "2px solid transparent",
            transition: "all 0.15s", letterSpacing: "0.01em",
          }}>{pg.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setDark(d => !d)} title={dark ? "Modo claro" : "Modo oscuro"} style={{ width: 34, height: 18, borderRadius: 9, background: dark ? C.teal.main : "#555", border: "none", cursor: "pointer", position: "relative", padding: 0, transition: "background 0.2s", flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 2, left: dark ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }} />
        </button>
        <span style={{ fontSize: 10, color: "#666", marginLeft: 7 }}>{dark ? "Oscuro" : "Claro"}</span>
      </div>

      {page === "intro"    && <IntroPage    t={t} dark={dark} onNavigate={handleNavigate} />}
      {page === "learn"    && <LearnPage    t={t} dark={dark} onNavigate={handleNavigate} />}
      {page === "build"    && <BuildPage    t={t} dark={dark} onNavigate={handleNavigate} />}
      {page === "demo"     && <DemoPage     t={t} dark={dark} onNavigate={handleNavigate} canonicalState={canonicalState} setCanonicalState={setCanonicalState} setCanonicalLive={setCanonicalLive} />}
      {page === "state"    && <ProjectStatePage t={t} dark={dark} onNavigate={handleNavigate} canonicalState={canonicalState} canonicalLive={canonicalLive} onResetExample={resetCanonicalExample} />}
      {page === "ops"      && <AuthGate t={t} dark={dark}><OperationsPage t={t} dark={dark} /></AuthGate>}
      {page === "config"   && <AuthGate t={t} dark={dark}><ConfigPage t={t} dark={dark} /></AuthGate>}
      {page === "glossary" && <GlossaryPage t={t} dark={dark} initialTerm={glossaryTerm} />}
      {page === "refs"     && <RefsPage     t={t} dark={dark} />}
    </div>
  );
}
