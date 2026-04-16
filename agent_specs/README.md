# Agent Specs

Definiciones declarativas de cada agente del ciclo ADLC. Cada archivo
`<agent>.yaml` describe qué hace un agente, qué tools puede usar, qué lee
y escribe del project_state, y qué guardrails aplican.

**Los agent_specs son source-of-truth.** El runtime de agentes
(`engine/agents/`) los carga y ejecuta. Cambiar comportamiento de un agente
= editar su YAML, no su código Python.

Cada `agent_run` que se persiste en la DB guarda el commit SHA del
agent_spec usado, así runs viejos siguen siendo reproducibles aunque el
spec haya cambiado.

## Convención de nombres

- `<phase>_<agent>.yaml` o solo `<agent>.yaml` si el nombre es único
- Snake_case
- Un archivo por agente, sin sub-directorios
