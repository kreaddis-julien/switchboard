# Agent Teams — Spec de portage (prototype)

> Statut : **prototype / branche jetable** (`agent-teams-proto`). Gated, OFF par défaut.
> Source : portage adapté du fork `ivandobskygithub/switchboard`.
> Cible : notre Switchboard (Electron, macOS, renderer vanilla refait shadcn/Geist, `main.js`/`preload.js` divergents).

## 1. Objectif

Orchestrer une **équipe de sessions Claude Code coordonnées** pour construire de façon (semi-)autonome à partir d'un seul objectif :

- un **planner** (modèle fort) découpe l'objectif en tâches feuilles ;
- des **workers** (modèle low-cost) implémentent chaque tâche dans son **propre worktree git** ;
- des **reviewers** valident (correction, tests, sécurité, style) avec vote au quorum ;
- coordination **par fichiers** (`<projet>/.switchboard/runs/<runId>/`), pas de serveur ni DB → état reconstructible après crash.

Cas d'usage KreAddis : gros chantiers de modules Odoo, refactors multi-fichiers, migrations de version.

## 2. Contrainte DONNÉES (décision structurante — contexte pro)

**Aucune donnée ne doit sortir de la machine, sauf vers Anthropic.**

| Rôle | Modèles autorisés | Egress |
|------|-------------------|--------|
| Planner / master | Claude (Opus/Sonnet) | → Anthropic |
| Reviewer | Claude (Sonnet/Opus) | → Anthropic |
| Workers low-cost | **Claude Haiku** *ou* **local** (Ollama/LM Studio) | Haiku → Anthropic ; local → **rien ne sort** |

**Exclus par défaut** : DeepSeek, Kimi/Moonshot, tout endpoint hébergé tiers. Aucun preset de ce type livré.

### Garde-fou technique (obligatoire)
- À l'enregistrement d'un profil worker : `ANTHROPIC_BASE_URL` doit être **`api.anthropic.com`** OU une **adresse loopback** (`127.0.0.1` / `localhost` / `[::1]`). Tout autre hôte est **refusé**.
- **Opt-out** : réglage `agentTeamsAllowExternalModels` (défaut **false**). S'il est activé, un **avertissement explicite** (« vos données peuvent sortir vers un tiers ») s'affiche, puis les endpoints hébergés tiers deviennent autorisés. Sécurisé par défaut, débridable en connaissance de cause.

## 3. Mécanisme de sélection des modèles

Réutilise l'abstraction **profils** d'ivandobsky (`profiles.js`) : un profil = un bundle de variables d'env injectées dans le PTY au spawn. Valeurs littérales OU références `$VAR` (le secret reste dans l'env hôte, jamais dans la ligne de commande). Le run **mappe chaque tier de complexité → un profil** (`resolveProfile`: override par tâche → tier → défaut du rôle).

### Phasage
- **v1 — worker = Claude Haiku** : 100 % Anthropic, immédiat, zéro shim, zéro egress tiers. + garde-fou endpoint. **Cible du premier prototype.**
- **v2 — worker = local** (Ollama/LM Studio) : zéro egress total, via un **shim Anthropic-compat local** (LiteLLM / claude-code-router — le shim tourne en local). Bouton « Détecter les modèles locaux » (probe `:11434/api/tags` Ollama, `:1234/v1/models` LM Studio) → crée un profil pointant le shim local.

## 4. Architecture (modules à porter, depuis ivandobsky)

Cœur back (~2 700 l.) :
- `orch-protocol.js` (~701) — schéma run/plan/tasks, `taskComplexity`, `tierCap`, `resolveProfile`, transitions d'état.
- `orch-spawner.js` (~913) — dispatch des workers/reviewers, caps de concurrence par tier, file-overlap guard, anti-injection des nudges PTY.
- `orch-templates.js` (~443) — prompts/cheat-sheet injectés, agent-pack `/sb-*`.
- `orch-ipc.js` (~273) — IPC renderer ↔ orchestrateur.
- `orch-watcher.js` (~172) — surveille `events.jsonl` / l'état du run.
- `orch-cost.js` (~122) — télémétrie coût réelle (`costUSD` lu dans les transcripts) + stop-loss budget.
- `orch-bootstrap.js` (~85) — install idempotente de l'agent-pack dans `~/.claude/commands`.

Dépendances (à porter d'abord) :
- `profiles.js` (~? l.) — bundles d'env par profil + **garde-fou endpoint** (notre ajout).
- `session-profiles.js` — persiste le profil par session (badge sidebar).
- `worktree-manager.js` (~197) — `git worktree add/remove`, gère `win32`+`darwin` (Mac OK vérifié).

GUI : `public/orchestration-view.js` (~869) — board kanban, plan, timeline, pause/resume — **à réconcilier avec notre design shadcn/Geist**.

Coordination disque : `<projet>/.switchboard/runs/<runId>/` → `run.json`, `plan.md`, `tasks/*.json`, `reviews/`, `events.jsonl`.

## 5. Gating & sécurité opérationnelle

- Flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, posé dans `ptyEnv` par `main.js` **uniquement si** `sessionOptions.agentTeams` est vrai. **Défaut : désactivé.** Ne gate que la coordination inter-agents ; les sous-agents standards (outil Task) restent actifs.
- **Stop-loss budget** (`maxBudgetUsd` / `maxOutputTokens`) met le run en pause — indispensable car un run autonome spawn N sessions `claude` payantes.
- Phase gates déterministes (lint/tests dans le worktree d'intégration) avant merge.

## 6. Dépendances externes

Aucune lib npm nouvelle. Requiert : binaire `git` (worktrees), CLI `claude` (PATH), profils de modèles créés par l'utilisateur. v2 ajoute : un runtime local (Ollama/LM Studio) + un shim Anthropic-compat local.

## 7. Plan de portage (ordre)

1. **Fondations** : `profiles.js` (+ garde-fou endpoint + opt-out) → `session-profiles.js` → `worktree-manager.js`. Avec tests.
2. **Cœur orchestrateur** : `orch-protocol.js` → `orch-cost.js` → `orch-spawner.js` → `orch-watcher.js` → `orch-bootstrap.js` → `orch-templates.js`.
3. **IPC** : `orch-ipc.js` + intégration `main.js`/`preload.js` (divergents → adaptation).
4. **GUI** : `orchestration-view.js` réconcilié shadcn/Geist + onglet.
5. **Gating** : flag + réglage `agentTeamsAllowExternalModels` + presets profils (Haiku).
6. **Validation bout-en-bout** : un run Odoo réel (planner Opus + worker Haiku) + contrôle du coût, AVANT toute adoption.

## 8. Risques

- **Intégration** : `main.js` fortement divergent (port non trivial).
- **Opérationnel** : runs autonomes payants → stop-loss + flag obligatoires.
- **GUI** : board à refaire au design maison.
- **Coût/temps** : sous-système ~8-9 k lignes → effort L, plusieurs incréments.

## 9. État au 2026-06-15 (VALIDÉ end-to-end)

Branche `agent-teams-proto` (= `main` + commits jusqu'à `ef08d03`, poussée sur `fork`). Tout porté/testé (~176 tests). Run réel réussi : plan → approbation → worker édite+commit en worktree → 2 reviewers approuvent → master merge → stop-loss budget OK. Nesting sidebar (workers sous le master) FAIT. **Prérequis config machine** (cf. mémoire `switchboard-agent-teams-proto`) : `~/.claude/settings.json` `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:"0"` + trappe Agent Teams dans `~/.claude/hooks/check-readonly.sh` (backups `.bak-*`). Modèles : Anthropic-only + local (garde-fou egress dans `profiles.js`, opt-out `agentTeamsAllowExternalModels`).

## 10. Suivis à implémenter (prochaine session)

### (b) Option « auto-approve » par run (sauter le gate human-in-the-loop de /sb-plan)
Par défaut `/sb-plan` planifie **puis attend l'approbation user** avant `/sb-decompose` + `status:active` + `/sb-orchestrate` (gate volontaire). Rendre ça optionnel par run :
1. **`orch-protocol.js`** : ajouter `autoApprove: false` à `DEFAULT_POLICY`. La validation policy (boucle ~l.267-275) ne vérifie que `maxBudgetUsd`/`maxOutputTokens` (numériques) + `validateCmd` → un booléen `autoApprove` passe (préservé via `{...DEFAULT_POLICY, ...policy}` dans `createRun`). Rien d'autre à valider.
2. **`orch-templates.js` `rolePrompt('master', run, ...)`** : si `run.policy?.autoApprove`, **append** au prompt master une consigne qui surcharge l'attente, p.ex. : « AUTO-APPROVE actif : n'attends PAS l'approbation utilisateur après le plan — enchaîne immédiatement /sb-decompose pour les chunks prêts, mets run.json status=active, puis lance /sb-orchestrate. » (Le prompt système prime sur le texte de /sb-plan.)
3. **`public/orchestration-view.js` `showNewRunDialog`** : ajouter une case **« Auto-approve plan (no human gate) »** (défaut DÉCOCHÉ = sûr). À la création : `if (autoApproveCheckbox.checked) policy.autoApprove = true;` (dans l'objet `policy` déjà envoyé à `createRun`).
- Défaut OFF = sûr (l'humain relit le plan) ; coché = autonomie totale depuis l'objectif. Tester un run avec la case cochée → doit décomposer + spawner sans intervention.

### (c) Polish CSS du board aux tokens shadcn
Le CSS Agent Teams (~154 l. en fin de `public/style.css`, bloc « Agent Teams (orchestration) ») a été porté tel quel d'ivandobsky avec des **couleurs GitHub-ish en dur** (`#58a6ff`, `#56d364`, `#d29922`, `#f85149`, `#a371f7`, `#adbac7`…). La modale est déjà theme-aware (faite). Reste à remapper les **pills** (`.orch-run-status-*`, `.orch-status-*`, `.orch-cx-*`, `.orch-lens-*`) sur nos tokens : `--ok`/`--ok-rgb` (vert), `--warn`/`--warn-rgb` (pêche), `--err`/`--err-rgb` (rouge), `--amber`/`--amber-rgb` (jaune), `--info` si dispo (bleu) ou `--mauve` (violet), et fonds `rgb(var(--on)/0.x)`. Cohérence avec l'accent orange `--accent`. Purement cosmétique, zéro risque fonctionnel.
