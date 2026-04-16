# Cómo agregar un nuevo LLM Provider

ADLC Platform está diseñado para que agregar un proveedor de LLM nuevo
**toque exclusivamente la carpeta `engine/llm/`**. El resto del sistema
no necesita saber qué proveedor está activo.

## Pasos

### 1. Implementar `LLMProvider`

Crea `engine/llm/<mi_provider>.py`:

```python
from .base import LLMProvider, LLMResponse, Message, ToolSpec, StreamChunk
from .registry import register


@register("mi_provider")
def _factory(config: dict) -> "MiProvider":
    return MiProvider(
        api_key=config["api_key"],
        model=config.get("model_default", "default-model"),
    )


class MiProvider(LLMProvider):
    def __init__(self, api_key: str, model: str):
        self._api_key = api_key
        self._model = model
        # Inicializa tu SDK aquí

    def complete(self, messages, system=None, tools=None,
                 max_tokens=4096, temperature=0.0) -> LLMResponse:
        # Llamada a tu API
        ...
        return LLMResponse(
            content="...",
            tool_calls=[...],
            tokens_in=...,
            tokens_out=...,
            cost_usd=...,
            model_id=self._model,
            finish_reason="stop",
        )

    def stream(self, messages, system=None, tools=None,
               max_tokens=4096, temperature=0.0):
        # Generator de StreamChunk
        ...

    @property
    def supports_tools(self) -> bool:
        return True

    @property
    def model_id(self) -> str:
        return self._model

    @property
    def context_window(self) -> int:
        return 200_000
```

### 2. Registrar lazy import en `registry.py`

Agrega tu provider al bloque de imports lazy:

```python
def get_provider(config: dict) -> LLMProvider:
    name = config.get("provider", "anthropic")

    if name == "anthropic":
        from . import anthropic_provider
    elif name == "mi_provider":
        from . import mi_provider           # ← agregar
    ...
```

### 3. Tests

Crea `engine/llm/tests/test_mi_provider.py`. Mockea las llamadas HTTP a
tu API. No requiere API key real para CI.

### 4. Documentación

Agrega un párrafo al README raíz mencionando el nuevo provider en la
tabla de adapters.

### 5. Configuración

El usuario activa tu provider editando `config/adlc.config.yaml`:

```yaml
llm:
  provider: mi_provider
  model_default: default-model
  api_key: "..."
```

## Reglas

- **NO toques nada fuera de `engine/llm/`.** Si tu provider necesita
  cambios en otra capa, abre un issue antes de codear.
- **Implementa la interfaz completa.** No dejes métodos sin implementar.
- **Reporta tokens y costo reales** en cada `LLMResponse`. El budget
  enforcement depende de eso.
- **Soporte de tools es obligatorio** si quieres que tu provider sirva
  para agentes que usan tool_whitelist (que son la mayoría). Si tu modelo
  no soporta tools nativos, devuelve `supports_tools = False` y los
  agentes que requieren tools fallarán explícitamente al cargarse.

## Proveedores ya implementados

- `anthropic` — default. Claude Opus / Sonnet / Haiku.

## Proveedores como contribución bienvenida

- `openai` — GPT-4 / GPT-4o
- `bedrock` — Claude / Titan / Llama vía AWS
- `mistral` — Mistral Large / Codestral
- `local` — Ollama, llama.cpp, vLLM
- `gemini` — Google Gemini

Si implementas alguno, abre un PR al repo canónico.
