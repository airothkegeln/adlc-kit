# Business Agent — por qué hoy es "teatro" y cómo funcionará en serio

## TL;DR

El **Business Agent** existe en el catálogo de agentes ADLC, pero en la
versión actual de la plataforma su veredicto **go/no-go** es teatro: sigue
una heurística simple sobre el `project_state` y produce un score plausible
pero no validado contra realidad.

Esto es **deliberado**. Lo dejamos así por una razón concreta: un Business
Agent serio necesita un **eval dataset etiquetado** que hoy no tenemos. Sin
ese dataset, cualquier "pass rate ≥ 0.85" que reporte es inventado.

## Qué hace el Business Agent en el ciclo

Es la sexta etapa del flujo canónico de 9 pasos. Recibe el `project_state`
ya enriquecido por Discovery → Hypothesis → Mapping → Spec → Architecture y
debe responder:

1. **¿El caso de negocio se sostiene?** — ¿el costo estimado < valor
   estimado, considerando el riesgo del Hypothesis Agent?
2. **¿Se cumple el criterio go/no-go?** — umbral configurable
3. **¿La capability_matrix es defendible?** — ¿lo que se delega al LLM no
   pone en riesgo cálculos financieros o decisiones regulatorias?
4. **¿Pasa el eval gate?** — pass rate ≥ 0.85 contra el dataset

Sus outputs al `project_state`:

```yaml
business_case: "..."
cost_estimate_usd: 42000
value_estimate_usd: 180000
risk_adjusted_value: 95000
go_no_go: "go"
eval_score: 0.91
rationale: "..."
```

## Cómo funciona HOY (teatro)

El agente:

1. Lee el `project_state` actual.
2. Usa el LLM para generar `business_case`, `cost_estimate`, `value_estimate`
   con un prompt razonable.
3. Calcula `risk_adjusted_value = value_estimate × (1 - risk_score)`.
4. Decide `go_no_go` con la regla: `go` si `risk_adjusted_value > 2 ×
   cost_estimate`, sino `no_go`.
5. **Reporta `eval_score` como un número generado por el LLM** sin pasar
   por ningún dataset real. Esto es la parte teatro.

El usuario en la UI ve un dictamen razonable pero **debe saber que no es
una validación contra evidencia histórica.**

La UI marca explícitamente este agente con un badge `⚠ teatro hasta v2`
para que nadie confunda el output con una validación real.

## Cómo funcionará en serio (v2)

Para que el Business Agent deje de ser teatro necesitamos tres cosas:

### 1. Eval dataset

Un set de **30-50 casos pasados** del cliente target (ej. MACHBank) con
ground truth conocido:

```yaml
case_id: bci_2024_q3_mobile_otp
project_state_snapshot: { ... }   # cómo se veía el state al llegar a Business
ground_truth:
  go_no_go: "go"
  actual_outcome: "shipped, $1.2M revenue, 2 incidents"
  retrospective_score: 0.85
```

Construirlo a mano es la única opción al inicio. Tiempo estimado: 1-2
días con un product manager del cliente. Es la parte más cara pero la más
importante.

### 2. Eval runner

Componente que toma el dataset, corre el Business Agent contra cada
snapshot, compara su decisión vs ground_truth y produce:

- `precision`, `recall`, `accuracy`
- Confusion matrix go/no-go
- Lista de casos donde falla

Este runner vive en `engine/eval/business_eval.py` y se invoca:

- Automáticamente en CI cada vez que cambia `agent_specs/business.yaml`
- Antes de cada run real (gate de salud)
- Por demanda desde la UI

### 3. Gate enforcement

Solo cuando `eval_score >= 0.85` el orquestador deja avanzar el run a la
etapa siguiente. Si está por debajo, el run se pausa con HITL pidiendo
revisión humana del business case.

## Hoja de ruta concreta

| Versión | Estado del Business Agent                                                |
| ------- | ------------------------------------------------------------------------ |
| v0 (hoy) | Teatro. Score generado por LLM. Badge visible en UI.                    |
| v0.5    | Mismo comportamiento, pero `eval_score` se omite del output (honesto).   |
| v1      | Eval dataset construido (30-50 casos). Eval runner funcional. Sin gate.  |
| v2      | Gate activo. Run se pausa si eval_score < 0.85.                          |
| v3      | Dataset autocrece con runs reales etiquetados retroactivamente.          |

## Por qué no lo construimos ahora

- El dataset requiere acceso a histórico real de decisiones del cliente
- Sin ese histórico, cualquier eval es sintético y por tanto teatro disfrazado
- Mejor ser explícitos sobre la limitación que pretender que está resuelta

## Para contribuidores

Si quieres avanzar este agente a v1 sin tener el dataset del cliente:

1. Crea un dataset sintético en `engine/eval/datasets/synthetic_business.yaml`
2. Marca claramente que es sintético
3. Implementa el eval runner en `engine/eval/business_eval.py`
4. El gate sigue desactivado hasta tener dataset real
