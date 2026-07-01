// i18n.js — lightweight localisation layer for the renderer.
//
// Loaded FIRST (before every other renderer script) so `t()` is available
// globally. There is no build step and no module system here: this attaches a
// global `t` plus `window.I18N`.
//
// Model:
//   - I18N.lang is the active language ('en' | 'fr'), cached synchronously so
//     t() never awaits. app.js calls initI18n() once at startup to load the
//     user's saved language BEFORE the first render.
//   - t('some.key', { name: 'x' }) → looks up STRINGS[lang][key], falls back to
//     English, then to the key itself; interpolates {placeholders}.
//   - Static HTML carries data-i18n / data-i18n-title / data-i18n-placeholder /
//     data-i18n-aria attributes; applyStaticI18n() fills them in.
//   - Changing language saves the setting and reloads the window, so every view
//     re-renders in the new language without threading a re-render through each.

(function () {
  const FALLBACK = 'en';
  const SUPPORTED = ['en', 'fr'];

  // ── Dictionaries ────────────────────────────────────────────────────────
  // Keys are dot-namespaced by area. English is the source of truth; any key
  // missing from `fr` falls back to English so the UI is never blank.
  const STRINGS = {
    en: {
      // sidebar tabs / chrome
      'tab.sessions': 'Sessions',
      'tab.plans': 'Plans',
      'tab.memory': 'Agent Files',
      'tab.stats': 'Stats',
      'sidebar.show': 'Show sidebar',
      'sidebar.hide': 'Hide sidebar',
      // session filters
      'filter.running': 'Show running only',
      'filter.pinned': 'Show pinned only',
      'filter.today': "Show today's sessions only",
      'filter.archived': 'Show archived sessions',
      'filter.resort': 'Re-sort sessions',
      'filter.refresh': 'Refresh sessions (rescan files, clear ghosts)',
      'filter.add_project': 'Add project',
      // search
      'search.placeholder': 'Search sessions...',
      'search.clear': 'Clear search',
      'search.titles_only': 'Search titles only',
      // empty / viewer titles
      'stats.hint': 'Click the Stats tab to view activity heatmap.',
      'placeholder.title': 'No session selected',
      'placeholder.sub': 'Pick a session in the sidebar to open it.',
      'stats.title': 'Activity',
      'settings.title': 'Settings',
      'jsonl.title': 'Message History',
      'grid.title': 'Session Overview',
      'terminal.stop': 'Stop process',
      // update toast
      'update.ready': 'Update ready — restart to apply',
      'update.restart': 'Restart',
      'update.later': 'Later',
      // settings — language field
      'settings.language': 'Language',
      'settings.language_hint': 'Interface language. Changing it reloads the window.',
      'lang.en': 'English',
      'lang.fr': 'Français',
      // sidebar — session row + actions menu
      'session.stop': 'Stop session',
      'session.fork': 'Fork session',
      'session.view_messages': 'View messages',
      'session.resume': 'Resume (attach terminal)',
      'session.resume_config': 'Resume with config',
      'session.actions': 'Actions',
      'session.archive': 'Archive',
      'session.unarchive': 'Unarchive',
      'session.pin': 'Pin',
      'session.unpin': 'Unpin',
      'session.menu.resume': 'Resume',
      'session.menu.stop': 'Stop',
      'session.menu.fork': 'Fork',
      'session.delete': 'Delete session',
      'session.delete_confirm': 'Delete "{name}"? Its transcript is removed permanently — this cannot be undone.',
      'session.delete_running': 'This session is running — stop it before deleting.',
      'sidebar.older': '+ {n} older',
      'sidebar.hide_older': '- hide older',
      'sidebar.subsession': '{n} subsession',
      'sidebar.subsessions': '{n} subsessions',
      // sidebar — project header
      'proj.new_session': 'New session',
      'proj.scheduled_task_title': 'Create scheduled task',
      'proj.scheduled_task': 'Scheduled task',
      'proj.settings': 'Project settings',
      'proj.archive_all': 'Archive all sessions',
      'proj.archive_sessions': 'Archive sessions',
      'proj.archive_group': 'Archive all sessions in group',
      'proj.actions': 'Project actions',
      'proj.path_missing': 'Project folder not found on disk — open project settings (gear) to Relocate it',
      'worktree.hide': 'Hide worktree',
      'worktree.delete': 'Delete worktree from disk',
      'worktree.new_session': 'New session in worktree',
      // session / project dialogs (dialogs.js)
      'dlg.perm_mode': 'Permission Mode',
      'perm.default': 'Default', 'perm.default_d': 'Prompt for all actions',
      'perm.accept': 'Accept Edits', 'perm.accept_d': 'Auto-accept file edits, prompt for others',
      'perm.plan': 'Plan Mode', 'perm.plan_d': 'Read-only exploration, no writes',
      'perm.dont_ask': "Don't Ask", 'perm.dont_ask_d': 'Auto-deny tools not explicitly allowed',
      'perm.bypass': 'Bypass', 'perm.bypass_d': 'Auto-accept all tool calls',
      'perm.dangerous': 'Dangerous Skip', 'perm.dangerous_d': 'Skip all safety prompts (use with caution)',
      'dlg.new_session': 'New Session', 'dlg.resume_session': 'Resume Session',
      'dlg.worktree': 'Worktree', 'dlg.worktree_d': 'Run session in an isolated git worktree', 'dlg.worktree_ph': 'name (optional)',
      'dlg.chrome': 'Chrome', 'dlg.chrome_d': 'Enable Chrome browser automation',
      'dlg.prelaunch': 'Pre-launch Command', 'dlg.prelaunch_d': 'Prepended to the claude command', 'dlg.prelaunch_ph': 'e.g. aws-vault exec profile --',
      'dlg.adddirs': 'Additional Directories', 'dlg.adddirs_d': 'Extra directories to include (comma-separated)', 'dlg.adddirs_ph': '/path/to/dir1, /path/to/dir2',
      'dlg.cancel': 'Cancel', 'dlg.start': 'Start', 'dlg.resume': 'Resume',
      'dlg.add_project': 'Add Project',
      'dlg.add_project_hint': 'Select a folder to create a new project. To start a session in an existing project, use the + on its project header.',
      'dlg.path_ph': '/path/to/project', 'dlg.browse': 'Browse', 'dlg.add': 'Add',
      'dlg.err_folder': 'Please enter a folder path.',
      // Settings panel (settings-panel.js)
      'set.title': 'Settings — ', 'set.title_project': 'Project Settings — ',
      'set.perm_mode': 'Permission Mode', 'set.perm_mode_d': 'Permission mode passed to the <code>claude</code> command',
      'set.perm_default_none': 'Default (none)',
      'set.use_global': 'Use global default',
      'set.worktree': 'Worktree', 'set.worktree_d': 'Enable worktree for new sessions',
      'set.worktree_name': 'Worktree Name', 'set.worktree_name_d': 'Custom name for worktree branches',
      'set.chrome': 'Chrome', 'set.chrome_d': 'Enable Chrome browser automation',
      'set.add_dirs': 'Additional Directories', 'set.add_dirs_d': 'Extra directories to include in Claude sessions',
      'set.prelaunch': 'Pre-launch Command', 'set.prelaunch_d': 'Prepended to the claude command (e.g. "aws-vault exec profile --")',
      'set.group': 'Group', 'set.group_d': 'Group this project under a labeled divider in the sidebar (blank = none).',
      'set.proj_folder': 'Project folder', 'set.proj_folder_d': 'If the repo moved or was renamed, point Switchboard at its new location.',
      'set.hide_project': 'Hide Project', 'set.hide_project_d': 'Hides this project from the sidebar. Session files are not deleted.',
      'set.appearance': 'Appearance', 'set.appearance_d': 'App theme. Auto follows the macOS appearance (incl. automatic light/dark).',
      'set.term_theme': 'Terminal Theme', 'set.term_theme_d': 'Color theme for terminal sessions',
      'set.shell': 'Shell Profile', 'set.shell_d': 'Shell used for terminal and Claude sessions. Changes take effect for new sessions only.',
      'set.restore_startup': 'Restore sessions on startup', 'set.restore_startup_d': 'Re-open the Claude sessions that were open when Switchboard last closed. Each is resumed in turn.',
      'set.opt.restore_off': "Don't restore", 'set.opt.restore_ask': 'Ask on startup', 'set.opt.restore_auto': 'Restore automatically',
      'restore.toast_msg': 'Restore {n} session{s} from last time?', 'restore.btn_restore': 'Restore', 'restore.btn_dismiss': 'Dismiss',
      'set.sound': 'Sound Notifications', 'set.sound_d': 'Play a chime when a non-focused session finishes a run or needs your attention',
      'set.system_notif': 'System Notifications', 'set.system_notif_d': 'macOS Notification Center alert (click to focus the session) + a dock badge counting sessions that need attention',
      'set.max_visible': 'Max Visible Sessions', 'set.max_visible_d': 'Show up to this many sessions before collapsing the rest behind "+N older"',
      'set.max_age': 'Session Max Age (days)', 'set.max_age_d': 'Projects whose newest session is older than this auto-collapse in the sidebar',
      'set.ide': 'IDE Emulation', 'set.ide_d': 'Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. New sessions only.',
      'set.show_plans': 'Show Plans Tab', 'set.show_plans_d': 'Show the Plans tab in the sidebar',
      'set.show_memory': 'Show Agent Files Tab', 'set.show_memory_d': 'Show the Agent Files (memory) tab in the sidebar',
      'set.show_stats': 'Show Stats Tab', 'set.show_stats_d': 'Show the Stats tab in the sidebar',
      'set.show_subagents': 'Show Subagent Sessions', 'set.show_subagents_d': 'Nest subagent transcripts under their parent ("N subsessions"). Off hides them from the sidebar entirely.',
      'set.version': 'Version',
      'set.autoupdate': 'Auto-update', 'set.autoupdate_d': 'Disabled in this fork — it is built locally from your own repo, so there are no releases to update from.',
      'set.cat.cli': 'Claude CLI', 'set.cat.project': 'Project', 'set.cat.general': 'General', 'set.cat.notifications': 'Notifications', 'set.cat.sessions': 'Sessions', 'set.cat.sidebar': 'Sidebar', 'set.cat.toolbar': 'Toolbar', 'set.cat.about': 'About',
      'set.opt.auto_system': 'Auto (system)', 'set.opt.light': 'Light', 'set.opt.dark': 'Dark', 'set.opt.auto_detect': 'Auto (detect)',
      'set.relocate': 'Relocate…', 'set.toolbar': 'Toolbar', 'set.in_popover': 'In popover', 'set.off': 'Off',
      'set.hidden_folders': 'Hidden folders', 'set.hidden_folders_d': "Folders removed from the sidebar via a project's gear → Hide Project. Unhide to bring one back.",
      'set.toolbar_hint': 'Drag to reorder. Choose whether each action sits in the toolbar or behind the "more" (⋯) popover.',
      'set.shortcut_hint': 'Click a shortcut, then press the new combination. At least one modifier ({mod1}, {mod2} or Shift) is required. Press Esc to cancel, or click again to reset to default.',
      'set.ph_group': 'e.g. Clients',
      'set.done': 'Done',
      // app.js — terminal header, toolbar, updater
      'app.new_session': 'New session',
      'app.loading': 'Loading…',
      'tb.t.grid': 'Session overview',
      'tb.t.collapse': 'Collapse / expand all projects',
      'tb.t.bookmarks': 'Bookmarks (⌘B)',
      'tb.t.more': 'More filters & actions',
      'tb.pin': 'Pin / favourite',
      'tb.running': 'Running only',
      'tb.overview': 'Session overview (grid)',
      'tb.collapse': 'Collapse all projects',
      'tb.bookmarks': 'Bookmarks',
      'tb.today': 'Today only',
      'tb.archive': 'Show archived',
      'tb.resort': 'Re-sort sessions',
      'tb.refresh': 'Refresh sessions (rescan)',
      'tb.add_project': 'Add project',
      'upd.checking': 'Checking for updates…',
      'upd.uptodate': 'Up to date',
      'upd.failed': 'Update check failed',
      'upd.new_ready': 'New Version Ready',
      'upd.release_notes': 'release notes',
      'upd.available_msg': 'A new version is available',
      'upd.download': 'Download',
      // relative timestamps (utils.formatDate)
      'time.just_now': 'just now',
      'time.mins': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
      // stats-view
      'stats.rate_limits': 'Rate Limits', 'stats.refresh': 'Refresh usage',
      'stats.cur_session': 'Current session', 'stats.week_all': 'Week (all models)', 'stats.week_sonnet': 'Week (Sonnet)', 'stats.week_opus': 'Week (Opus)',
      'stats.resets': 'Resets ', 'stats.last30': 'Last 30 days', 'stats.less': 'Less', 'stats.more': 'More',
      'stats.total_sessions': 'Total Sessions', 'stats.total_messages': 'Total Messages', 'stats.cur_streak': 'Current Streak', 'stats.longest_streak': 'Longest Streak',
      'stats.token_usage': 'Token usage', 'stats.total_tokens': 'Total tokens', 'stats.input': 'Input', 'stats.output': 'Output', 'stats.cache_read': 'Cache read', 'stats.tool_calls': 'Tool calls', 'stats.subagents': 'Subagents',
      // file panel / viewer toolbar
      'file.save': 'Save changes', 'file.close': 'Close panel', 'file.accept': 'Accept', 'file.reject': 'Reject',
      'file.ide_active': 'IDE Emulation is active. Go to Global Settings to disable.', 'file.ide': 'IDE Emulation',
      'vt.back': 'Back to editor', 'vt.md_preview': 'Toggle markdown preview', 'vt.copy_path': 'Copy file path', 'vt.copy_raw': 'Copy raw content', 'vt.wrap': 'Toggle line wrapping', 'vt.goto_line': 'Go to line (Cmd+G)',
      // command palette / terminal search
      'cmd.jump': 'Jump to session…', 'term.find': 'Find...',
      // bookmarks & tags
      'bm.tags_ph': 'comma, separated, tags', 'bm.edit_tags': 'Edit tags', 'bm.bookmark': 'Bookmark this message', 'bm.remove': 'Remove bookmark',
      // plans / memory
      'pm.no_plans': 'No plans found in ~/.claude/plans/', 'pm.no_memory': 'No memory files found.', 'pm.run_now': 'Run now', 'pm.running': 'Running...', 'pm.launched': 'Launched!',
      // keyboard shortcuts (SHORTCUT_DEFS)
      'sc.nav_label': 'Navigate sessions / grid', 'sc.nav_desc': 'Move between sessions (single view) or between cells (grid view)',
      'sc.prevnext_label': 'Previous / next session', 'sc.prevnext_desc': 'Cycle to the previous or next session',
      'sc.grid_label': 'Toggle grid view', 'sc.grid_desc': 'Show or hide the session grid overview',
      // grid + jsonl viewer
      'grid.other': 'Other',
      'jsonl.input': 'Input', 'jsonl.content': 'Content', 'jsonl.output': 'Output', 'jsonl.thinking': 'Thinking',
    },
    fr: {
      'tab.sessions': 'Sessions',
      'tab.plans': 'Plans',
      'tab.memory': 'Fichiers agent',
      'tab.stats': 'Stats',
      'sidebar.show': 'Afficher la barre latérale',
      'sidebar.hide': 'Masquer la barre latérale',
      'filter.running': 'Afficher seulement les sessions actives',
      'filter.pinned': 'Afficher seulement les épinglées',
      'filter.today': "Afficher seulement les sessions du jour",
      'filter.archived': 'Afficher les sessions archivées',
      'filter.resort': 'Retrier les sessions',
      'filter.refresh': 'Rafraîchir les sessions (re-scan, nettoyer les fantômes)',
      'filter.add_project': 'Ajouter un projet',
      'search.placeholder': 'Rechercher des sessions...',
      'search.clear': 'Effacer la recherche',
      'search.titles_only': 'Rechercher dans les titres seulement',
      'stats.hint': "Cliquez sur l'onglet Stats pour voir la heatmap d'activité.",
      'placeholder.title': 'Aucune session sélectionnée',
      'placeholder.sub': "Choisissez une session dans la barre latérale pour l'ouvrir.",
      'stats.title': 'Activité',
      'settings.title': 'Réglages',
      'jsonl.title': 'Historique des messages',
      'grid.title': 'Vue des sessions',
      'terminal.stop': 'Arrêter le processus',
      'update.ready': 'Mise à jour prête — redémarrer pour appliquer',
      'update.restart': 'Redémarrer',
      'update.later': 'Plus tard',
      'settings.language': 'Langue',
      'settings.language_hint': "Langue de l'interface. Le changement recharge la fenêtre.",
      'lang.en': 'English',
      'lang.fr': 'Français',
      'session.stop': 'Arrêter la session',
      'session.fork': 'Dupliquer la session',
      'session.view_messages': 'Voir les messages',
      'session.resume': 'Reprendre (attacher le terminal)',
      'session.resume_config': 'Reprendre avec config',
      'session.actions': 'Actions',
      'session.archive': 'Archiver',
      'session.unarchive': 'Désarchiver',
      'session.pin': 'Épingler',
      'session.unpin': 'Désépingler',
      'session.menu.resume': 'Reprendre',
      'session.menu.stop': 'Arrêter',
      'session.menu.fork': 'Dupliquer',
      'session.delete': 'Supprimer la session',
      'session.delete_confirm': 'Supprimer « {name} » ? Son transcript est supprimé définitivement — action irréversible.',
      'session.delete_running': 'Cette session est en cours — arrêtez-la avant de supprimer.',
      'sidebar.older': '+ {n} plus anciennes',
      'sidebar.hide_older': '- masquer les anciennes',
      'sidebar.subsession': '{n} sous-session',
      'sidebar.subsessions': '{n} sous-sessions',
      'proj.new_session': 'Nouvelle session',
      'proj.scheduled_task_title': 'Créer une tâche planifiée',
      'proj.scheduled_task': 'Tâche planifiée',
      'proj.settings': 'Réglages du projet',
      'proj.archive_all': 'Archiver toutes les sessions',
      'proj.archive_sessions': 'Archiver les sessions',
      'proj.archive_group': 'Archiver toutes les sessions du groupe',
      'proj.actions': 'Actions du projet',
      'proj.path_missing': "Dossier du projet introuvable sur le disque — ouvrez les réglages du projet (engrenage) pour le relocaliser",
      'worktree.hide': 'Masquer le worktree',
      'worktree.delete': 'Supprimer le worktree du disque',
      'worktree.new_session': 'Nouvelle session dans le worktree',
      'dlg.perm_mode': 'Mode de permission',
      'perm.default': 'Par défaut', 'perm.default_d': 'Demander pour toutes les actions',
      'perm.accept': 'Accepter les éditions', 'perm.accept_d': 'Accepter auto les éditions de fichiers, demander le reste',
      'perm.plan': 'Mode plan', 'perm.plan_d': 'Exploration en lecture seule, aucune écriture',
      'perm.dont_ask': 'Ne pas demander', 'perm.dont_ask_d': 'Refuser auto les outils non explicitement autorisés',
      'perm.bypass': 'Contourner', 'perm.bypass_d': 'Accepter auto tous les appels d’outils',
      'perm.dangerous': 'Contournement dangereux', 'perm.dangerous_d': 'Sauter toutes les confirmations de sécurité (à utiliser avec prudence)',
      'dlg.new_session': 'Nouvelle session', 'dlg.resume_session': 'Reprendre la session',
      'dlg.worktree': 'Worktree', 'dlg.worktree_d': 'Exécuter la session dans un worktree git isolé', 'dlg.worktree_ph': 'nom (optionnel)',
      'dlg.chrome': 'Chrome', 'dlg.chrome_d': 'Activer l’automatisation du navigateur Chrome',
      'dlg.prelaunch': 'Commande de pré-lancement', 'dlg.prelaunch_d': 'Préfixée à la commande claude', 'dlg.prelaunch_ph': 'ex. aws-vault exec profile --',
      'dlg.adddirs': 'Répertoires additionnels', 'dlg.adddirs_d': 'Répertoires supplémentaires à inclure (séparés par des virgules)', 'dlg.adddirs_ph': '/chemin/vers/dir1, /chemin/vers/dir2',
      'dlg.cancel': 'Annuler', 'dlg.start': 'Démarrer', 'dlg.resume': 'Reprendre',
      'dlg.add_project': 'Ajouter un projet',
      'dlg.add_project_hint': 'Sélectionnez un dossier pour créer un projet. Pour démarrer une session dans un projet existant, utilisez le + sur son en-tête.',
      'dlg.path_ph': '/chemin/vers/projet', 'dlg.browse': 'Parcourir', 'dlg.add': 'Ajouter',
      'dlg.err_folder': 'Veuillez saisir un chemin de dossier.',
      'set.title': 'Réglages — ', 'set.title_project': 'Réglages du projet — ',
      'set.perm_mode': 'Mode de permission', 'set.perm_mode_d': 'Mode de permission passé à la commande <code>claude</code>',
      'set.perm_default_none': 'Par défaut (aucun)',
      'set.use_global': 'Utiliser la valeur globale',
      'set.worktree': 'Worktree', 'set.worktree_d': 'Activer le worktree pour les nouvelles sessions',
      'set.worktree_name': 'Nom du worktree', 'set.worktree_name_d': 'Nom personnalisé pour les branches de worktree',
      'set.chrome': 'Chrome', 'set.chrome_d': 'Activer l’automatisation du navigateur Chrome',
      'set.add_dirs': 'Répertoires additionnels', 'set.add_dirs_d': 'Répertoires supplémentaires à inclure dans les sessions Claude',
      'set.prelaunch': 'Commande de pré-lancement', 'set.prelaunch_d': 'Préfixée à la commande claude (ex. "aws-vault exec profile --")',
      'set.group': 'Groupe', 'set.group_d': 'Regrouper ce projet sous un séparateur nommé dans la barre latérale (vide = aucun).',
      'set.proj_folder': 'Dossier du projet', 'set.proj_folder_d': 'Si le dépôt a été déplacé ou renommé, indiquez à Switchboard son nouvel emplacement.',
      'set.hide_project': 'Masquer le projet', 'set.hide_project_d': 'Masque ce projet de la barre latérale. Les fichiers de session ne sont pas supprimés.',
      'set.appearance': 'Apparence', 'set.appearance_d': 'Thème de l’app. Auto suit l’apparence macOS (clair/sombre automatique inclus).',
      'set.term_theme': 'Thème du terminal', 'set.term_theme_d': 'Thème de couleurs des sessions terminal',
      'set.shell': 'Profil shell', 'set.shell_d': 'Shell utilisé pour les sessions terminal et Claude. S’applique aux nouvelles sessions seulement.',
      'set.restore_startup': 'Restaurer les sessions au démarrage', 'set.restore_startup_d': 'Rouvrir les sessions Claude qui étaient ouvertes à la dernière fermeture de Switchboard. Chacune est reprise à tour de rôle.',
      'set.opt.restore_off': 'Ne pas restaurer', 'set.opt.restore_ask': 'Demander au démarrage', 'set.opt.restore_auto': 'Restaurer automatiquement',
      'restore.toast_msg': 'Restaurer {n} session{s} de la dernière fois ?', 'restore.btn_restore': 'Restaurer', 'restore.btn_dismiss': 'Ignorer',
      'set.sound': 'Notifications sonores', 'set.sound_d': 'Jouer un son quand une session non focalisée termine un run ou requiert votre attention',
      'set.system_notif': 'Notifications système', 'set.system_notif_d': 'Alerte du centre de notifications macOS (clic pour focaliser la session) + badge dock comptant les sessions à traiter',
      'set.max_visible': 'Sessions visibles max', 'set.max_visible_d': 'Afficher jusqu’à ce nombre de sessions avant de replier le reste derrière « +N plus anciennes »',
      'set.max_age': 'Âge max des sessions (jours)', 'set.max_age_d': 'Les projets dont la session la plus récente dépasse cet âge se replient automatiquement',
      'set.ide': 'Émulation IDE', 'set.ide_d': 'Émuler un IDE pour que Claude ouvre fichiers et diffs dans un panneau latéral. Désactivez pour utiliser votre propre IDE. Nouvelles sessions seulement.',
      'set.show_plans': 'Afficher l’onglet Plans', 'set.show_plans_d': 'Afficher l’onglet Plans dans la barre latérale',
      'set.show_memory': 'Afficher l’onglet Fichiers agent', 'set.show_memory_d': 'Afficher l’onglet Fichiers agent (mémoire) dans la barre latérale',
      'set.show_stats': 'Afficher l’onglet Stats', 'set.show_stats_d': 'Afficher l’onglet Stats dans la barre latérale',
      'set.show_subagents': 'Afficher les sous-sessions', 'set.show_subagents_d': 'Imbriquer les transcripts des sous-agents sous leur parent (« N sous-sessions »). Désactivé, ils sont masqués de la barre latérale.',
      'set.version': 'Version',
      'set.autoupdate': 'Mise à jour auto', 'set.autoupdate_d': 'Désactivée dans ce fork — il est compilé localement depuis votre propre dépôt, il n’y a donc pas de release à installer.',
      'set.cat.cli': 'Claude CLI', 'set.cat.project': 'Projet', 'set.cat.general': 'Général', 'set.cat.notifications': 'Notifications', 'set.cat.sessions': 'Sessions', 'set.cat.sidebar': 'Barre latérale', 'set.cat.toolbar': 'Barre d’outils', 'set.cat.about': 'À propos',
      'set.opt.auto_system': 'Auto (système)', 'set.opt.light': 'Clair', 'set.opt.dark': 'Sombre', 'set.opt.auto_detect': 'Auto (détection)',
      'set.relocate': 'Relocaliser…', 'set.toolbar': 'Barre d’outils', 'set.in_popover': 'Dans le popover', 'set.off': 'Désactivé',
      'set.hidden_folders': 'Dossiers masqués', 'set.hidden_folders_d': 'Dossiers retirés de la barre latérale via l’engrenage d’un projet → Masquer le projet. Réafficher pour en rétablir un.',
      'set.toolbar_hint': 'Glisser pour réordonner. Choisissez si chaque action est dans la barre d’outils ou derrière le popover « plus » (⋯).',
      'set.shortcut_hint': 'Cliquez un raccourci, puis pressez la nouvelle combinaison. Au moins un modificateur ({mod1}, {mod2} ou Maj) est requis. Échap pour annuler, ou recliquez pour réinitialiser.',
      'set.ph_group': 'ex. Clients',
      'set.done': 'Terminé',
      'app.new_session': 'Nouvelle session',
      'app.loading': 'Chargement…',
      'tb.t.grid': 'Vue des sessions',
      'tb.t.collapse': 'Replier / déplier tous les projets',
      'tb.t.bookmarks': 'Favoris (⌘B)',
      'tb.t.more': 'Plus de filtres & actions',
      'tb.pin': 'Épingler / favori',
      'tb.running': 'Actives seulement',
      'tb.overview': 'Vue des sessions (grille)',
      'tb.collapse': 'Replier tous les projets',
      'tb.bookmarks': 'Favoris',
      'tb.today': 'Aujourd’hui seulement',
      'tb.archive': 'Afficher les archivées',
      'tb.resort': 'Retrier les sessions',
      'tb.refresh': 'Rafraîchir les sessions (re-scan)',
      'tb.add_project': 'Ajouter un projet',
      'upd.checking': 'Recherche de mises à jour…',
      'upd.uptodate': 'À jour',
      'upd.failed': 'Échec de la vérification de mise à jour',
      'upd.new_ready': 'Nouvelle version prête',
      'upd.release_notes': 'notes de version',
      'upd.available_msg': 'Une nouvelle version est disponible',
      'upd.download': 'Télécharger',
      'time.just_now': 'à l’instant',
      'time.mins': 'il y a {n} min',
      'time.hours': 'il y a {n} h',
      'time.days': 'il y a {n} j',
      'stats.rate_limits': 'Limites de débit', 'stats.refresh': 'Rafraîchir l’usage',
      'stats.cur_session': 'Session courante', 'stats.week_all': 'Semaine (tous modèles)', 'stats.week_sonnet': 'Semaine (Sonnet)', 'stats.week_opus': 'Semaine (Opus)',
      'stats.resets': 'Réinitialise ', 'stats.last30': '30 derniers jours', 'stats.less': 'Moins', 'stats.more': 'Plus',
      'stats.total_sessions': 'Sessions totales', 'stats.total_messages': 'Messages totaux', 'stats.cur_streak': 'Série actuelle', 'stats.longest_streak': 'Plus longue série',
      'stats.token_usage': 'Usage des tokens', 'stats.total_tokens': 'Tokens totaux', 'stats.input': 'Entrée', 'stats.output': 'Sortie', 'stats.cache_read': 'Lecture cache', 'stats.tool_calls': 'Appels d’outils', 'stats.subagents': 'Sous-agents',
      'file.save': 'Enregistrer les modifications', 'file.close': 'Fermer le panneau', 'file.accept': 'Accepter', 'file.reject': 'Rejeter',
      'file.ide_active': 'L’émulation IDE est active. Allez dans les réglages globaux pour la désactiver.', 'file.ide': 'Émulation IDE',
      'vt.back': 'Retour à l’éditeur', 'vt.md_preview': 'Basculer l’aperçu markdown', 'vt.copy_path': 'Copier le chemin du fichier', 'vt.copy_raw': 'Copier le contenu brut', 'vt.wrap': 'Basculer le retour à la ligne', 'vt.goto_line': 'Aller à la ligne (Cmd+G)',
      'cmd.jump': 'Aller à une session…', 'term.find': 'Rechercher...',
      'bm.tags_ph': 'tags, séparés, par virgules', 'bm.edit_tags': 'Éditer les tags', 'bm.bookmark': 'Marquer ce message', 'bm.remove': 'Retirer le favori',
      'pm.no_plans': 'Aucun plan trouvé dans ~/.claude/plans/', 'pm.no_memory': 'Aucun fichier mémoire trouvé.', 'pm.run_now': 'Lancer maintenant', 'pm.running': 'En cours...', 'pm.launched': 'Lancé !',
      'sc.nav_label': 'Naviguer sessions / grille', 'sc.nav_desc': 'Se déplacer entre sessions (vue simple) ou entre cellules (vue grille)',
      'sc.prevnext_label': 'Session précédente / suivante', 'sc.prevnext_desc': 'Passer à la session précédente ou suivante',
      'sc.grid_label': 'Basculer la vue grille', 'sc.grid_desc': 'Afficher ou masquer la vue grille des sessions',
      'grid.other': 'Autres',
      'jsonl.input': 'Entrée', 'jsonl.content': 'Contenu', 'jsonl.output': 'Sortie', 'jsonl.thinking': 'Réflexion',
    },
  };

  function normalizeLang(l) {
    return SUPPORTED.includes(l) ? l : FALLBACK;
  }

  // Synchronous load-time language from a localStorage mirror, so t() returns the
  // right language even for strings built at script-load time (before the async
  // settings read in initI18n). The settings store is the source of truth;
  // setLanguage() writes both, so they stay in sync.
  let bootLang = FALLBACK;
  try { bootLang = normalizeLang(localStorage.getItem('sb-language')); } catch {}

  const I18N = {
    lang: bootLang,
    supported: SUPPORTED,
    STRINGS,
  };

  // t(key, params?) — resolve + interpolate. Never throws; unknown keys return
  // the key so a missing translation is visible (and greppable) rather than blank.
  function t(key, params) {
    const table = STRINGS[I18N.lang] || STRINGS[FALLBACK];
    let s = (table && table[key]);
    if (s == null) s = STRINGS[FALLBACK][key];
    if (s == null) return key;
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
      }
    }
    return s;
  }
  I18N.t = t;

  // Fill in static HTML strings carrying data-i18n* attributes. Idempotent.
  function applyStaticI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }
  I18N.applyStatic = applyStaticI18n;

  // Reconcile the language from settings (source of truth) into the localStorage
  // mirror and apply static strings. Call once at startup. If settings disagree
  // with the boot (localStorage) language — only possible when the mirror is
  // missing/stale, e.g. first run after upgrade — reload once so load-time
  // strings rebuild in the correct language.
  async function initI18n() {
    let settingsLang = FALLBACK;
    try {
      const global = (await window.api.getSetting('global')) || {};
      settingsLang = normalizeLang(global.language);
    } catch {
      settingsLang = I18N.lang;
    }
    if (settingsLang !== I18N.lang) {
      try { localStorage.setItem('sb-language', settingsLang); } catch {}
      window.location.reload();
      return I18N.lang;
    }
    document.documentElement.setAttribute('lang', I18N.lang);
    applyStaticI18n();
    return I18N.lang;
  }
  I18N.init = initI18n;

  // Persist a new language (settings + localStorage mirror) and reload so the
  // whole UI re-renders translated.
  async function setLanguage(lang) {
    const next = normalizeLang(lang);
    try { localStorage.setItem('sb-language', next); } catch {}
    try {
      const global = (await window.api.getSetting('global')) || {};
      global.language = next;
      await window.api.setSetting('global', global);
    } catch {}
    window.location.reload();
  }
  I18N.setLanguage = setLanguage;

  window.I18N = I18N;
  window.t = t;
})();
