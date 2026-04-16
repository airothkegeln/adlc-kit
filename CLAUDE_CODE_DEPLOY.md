# CLAUDE_CODE_DEPLOY.md
> Instrucciones para Claude Code: desplegar adlc-demo en AWS Amplify.
> Ejecutar en orden. No saltarse pasos.

---

## El proyecto ya está creado

La estructura del proyecto está en la carpeta `adlc-demo/` con estos archivos listos:

```
adlc-demo/
├── .gitignore
├── amplify.yml          ← Amplify lee esto automáticamente
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx
    └── App.jsx          ← el app completo (1395 líneas)
```

---

## Paso 1 — Instalar dependencias y verificar build

```bash
cd adlc-demo
npm install
npm run build
```

Si el build pasa sin errores, aparece la carpeta `dist/`. Verificar con:
```bash
ls dist/
```

Si hay errores, los más comunes son:
- **Hook en callback**: verificar que no hay `useState` dentro de funciones de callback — todos los hooks deben estar al nivel del componente
- **Import faltante**: asegurarse que `src/main.jsx` importa desde `./App.jsx`

---

## Paso 2 — Verificar localmente (opcional pero recomendado)

```bash
npm run preview
```

Abrir http://localhost:4173 y verificar:
- Las 3 páginas cargan (Aprender, Demo interactivo, Glosario)
- Modo oscuro/claro funciona con el toggle
- El demo ejecuta con el botón "Ejecutar"
- Los checkpoints HITL abren el modal con el JSON viewer
- La sección "El flujo completo" muestra tabs de agentes

---

## Paso 3 — Crear repositorio en GitHub

```bash
cd adlc-demo
git init
git add .
git commit -m "feat: ADLC Platform demo — initial deploy"
```

Crear el repo en GitHub (sin README, sin .gitignore — ya los tenemos):
```bash
# Reemplazar [tu-usuario] con tu usuario de GitHub
git remote add origin https://github.com/[tu-usuario]/adlc-demo.git
git branch -M main
git push -u origin main
```

---

## Paso 4 — Configurar en AWS Amplify Console

1. Ir a: https://console.aws.amazon.com/amplify
2. Click **"Create new app"**
3. Seleccionar **"Host web app"**
4. Seleccionar **GitHub** → autorizar acceso → elegir repo `adlc-demo` → branch `main`
5. En **Build settings**: Amplify detecta el `amplify.yml` automáticamente
6. Confirmar que **Output directory** es `dist`
7. Click **"Save and deploy"**

El primer deploy toma ~3 minutos. Amplify asigna una URL:
`https://main.xxxxxxxxxx.amplifyapp.com`

---

## Paso 5 — Verificar el deploy

Abrir la URL de Amplify y confirmar el checklist:
- [ ] Las 3 páginas cargan correctamente
- [ ] Las fuentes IBM Plex Mono y Space Grotesk se ven bien
- [ ] Modo oscuro/claro funciona
- [ ] Demo ejecuta los 4 escenarios
- [ ] HITL modal muestra el JSON con collapse/expand
- [ ] Sección "El flujo completo" — tabs por agente con detalle
- [ ] Glosario busca y filtra por categoría

---

## Redeploy automático

Todo push a `main` triggeriza un nuevo deploy automáticamente en Amplify.
Para hacer cambios al app: editar `src/App.jsx` → commit → push → Amplify hace el resto.

---

## Variables de entorno

Este demo NO requiere ninguna variable de entorno. Es un SPA estático puro.
Costo estimado en Amplify: **$0/mes** dentro del free tier para tráfico moderado.

---

## Comando para Claude Code

```
"El proyecto adlc-demo ya está en la carpeta adlc-demo/.
Ejecuta: npm install && npm run build
Si el build pasa, crea el repo en GitHub, haz el push,
y dame las instrucciones exactas para conectarlo a AWS Amplify."
```
