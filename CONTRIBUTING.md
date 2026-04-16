# Contributing to ADLC Kit (MACHBank edition)

> Este repositorio es un **kit de inicio** derivado del flujo ADLC
> (Agentic Development Lifecycle) desarrollado originalmente por
> **Andrés Rothkegel** ([@airothkegeln](https://github.com/airothkegeln)).
> Ver [NOTICE.md](./NOTICE.md) y [LICENSE](./LICENSE) para detalles de
> atribución.

Gracias por tu interés en ADLC. Este documento describe cómo
contribuir y cómo está organizado el proyecto para que terceros puedan
extenderlo sin tocar el núcleo.

## Modelo de contribución

- **Repositorio canónico del flujo ADLC:** `github.com/airothkegeln/adlc`
- **Este kit:** `github.com/airothkegeln/adlc-kit`
- **Pull requests** al repo canónico son revisados y mergeados
  **exclusivamente por el dueño del repo**. No hay merge automático.
- **Forks son bienvenidos.** Si forkeas este proyecto, debes:
  1. Mantener la licencia CC BY-SA 4.0.
  2. Indicar explícitamente en tu README que es una modificación de
     ADLC original de Andrés Rothkegel (`github.com/airothkegeln/adlc`).
  3. Compartir tus modificaciones bajo la misma licencia.

## Filosofía de diseño: adapters aislados

ADLC Platform está diseñado para que los componentes intercambiables
vivan detrás de interfaces estables. Esto permite que un contribuidor
agregue un nuevo proveedor (LLM, sandbox, storage, etc.) sin tocar el
resto del sistema.

Los adapters aislados son:

| Componente     | Interfaz                          | Implementación default       |
| -------------- | --------------------------------- | ---------------------------- |
| LLM Provider   | `engine/llm/base.py`              | `anthropic_provider.py`      |
| Orchestrator   | `engine/orchestrator/base.py`     | `simple_orchestrator.py`     |
| State Store    | `engine/storage/base.py`          | `postgres_store.py`          |
| Sandbox        | `engine/sandbox/base.py`          | `docker_sandbox.py`          |
| HITL Transport | `engine/hitl/base.py`             | `web_transport.py`, `email_ses_transport.py` |
| Tracer         | `engine/observability/base.py`    | `structlog_tracer.py`        |

### Cómo agregar un nuevo LLM provider

1. Crear `engine/llm/mi_provider.py` que implemente `LLMProvider`.
2. Registrarlo en `engine/llm/registry.py`.
3. Agregar tests en `engine/llm/tests/test_mi_provider.py`.
4. Documentar en `docs/adding_an_llm_provider.md`.
5. **No tocar nada fuera de `engine/llm/`.**

El mismo patrón aplica para los demás componentes (sandbox, storage,
orchestrator, hitl, observability). Las guías específicas se irán
agregando en `docs/` — por ahora `docs/adding_an_llm_provider.md` es
la referencia canónica.

## Estructura del repo

```
adlc/
  src/                 ← Frontend React (UI / consola operativa)
  engine/              ← Backend Python (orquestador + agentes)
  agent_specs/         ← YAML versionado de cada agente
  config/              ← Configuración (LLM, retención, infra constraints)
  docs/                ← Arquitectura, guías de extensión, roadmap
  amplify.yml          ← Build config del frontend (Amplify)
  docker-compose.yml   ← Stack local completo sin AWS
  LICENSE              ← CC BY-SA 4.0
```

## Antes de mandar un PR

- [ ] El cambio respeta el aislamiento de adapters
- [ ] Tests pasan (`pytest engine/` y `npm test` si aplica)
- [ ] README/docs actualizados si el cambio afecta cómo se usa el sistema
- [ ] El commit message sigue conventional commits (`feat:`, `fix:`, `docs:`, etc.)

## Reportar bugs y proponer features

Abre un issue en el repo canónico con contexto suficiente para reproducir.
