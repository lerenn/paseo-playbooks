Playbooks transforme un workflow multi-agents en un fichier YAML que vous gardez dans votre
dépôt : investiguer, implémenter, relire, corriger, livrer, avec une validation humaine là où
vous en voulez une. Un agent Paseo, le Playbook Manager, exécute le playbook : chaque étape
tourne comme un sous-agent dans le même worktree, et l'exécution s'arrête aux points de
validation humaine (gates), que vous approuvez ou rejetez dans Paseo.

Les playbooks sont des fichiers YAML propres à chaque dépôt, sous `.paseo/plugins/playbooks/`
ou `.paseo/playbooks/`, avec des rôles partagés dans `roles/<id>/` (réglages et un prompt
système en Markdown) et des valeurs par défaut pour les agents, facultatives, dans
`defaults/main.yaml`. Les étapes forment un graphe via `needs` : les étapes prêtes en même
temps tournent en parallèle, les boucles sont des retours explicites `goto` avec une limite,
et les entrées et sorties sont typées et associées par nom. Les after-tasks (`after:`, une
rétrospective par exemple) s'exécutent une fois l'exécution terminée ou échouée, ou quand un
humain les lance, sans changer son résultat.

Le plugin fait respecter les règles : il valide les playbooks, refuse les étapes ou
transitions qu'un playbook n'autorise pas, conserve l'état de chaque exécution sur le daemon
pour qu'elle survive à un redémarrage, réveille le manager quand une étape se termine, et
impose les rôles en lecture seule par une vérification git. Le manager ne prend que les
décisions qui demandent du jugement : briefer les étapes, lire les résultats et choisir les
issues.

Le panneau Playbooks, dans la barre latérale droite d'un workspace, affiche chaque playbook
sous forme de graphe. Pendant une exécution, les nœuds montrent leur statut en direct,
l'étape en cours pulse, et un clic sur un nœud ouvre la conversation de cette étape. Les
gates affichent les boutons Approve et Reject. Start ouvre un formulaire construit à partir
des entrées du playbook et lance le playbook avec l'agent le plus récent du workspace comme
manager, sur sa branche courante. La flèche à côté de Start propose "Start on a new agent",
qui lance un nouvel agent manager dans le même workspace, et "Start in a new workspace", qui
crée un worktree sur une nouvelle branche et y lance un manager. Depuis le panneau, une
exécution peut être mise en pause, reprise ou annulée, et une exécution terminée peut être
relancée depuis n'importe quelle étape dont les dépendances sont terminées.

Des exemples de playbooks, prêts à copier dans `.paseo/plugins/playbooks/`, sont sur la
[page d'exemples](https://louisfradin.com/paseo-playbooks/examples.html) et dans le dépôt :
un workflow de pull request (investiguer, implémenter, ouvrir la PR et la surveiller jusqu'à
ce qu'elle soit au vert), une livraison sur un environnement de développement avec recette,
un playbook de fonctionnalité qui enchaîne les deux en passant par une validation humaine,
et la vérification de documentation que ce dépôt exécute sur lui-même, avec des relecteurs
en parallèle et une boucle de réécriture.

Modes d'agent : les playbooks peuvent utiliser n'importe quel mode, `bypassPermissions`
compris, pour que les étapes qui lancent des commandes shell tournent sans surveillance. Ne
lancez que des playbooks de dépôts en lesquels vous avez confiance.

Les agents reçoivent des outils du plugin : tous les agents sauf ceux des étapes reçoivent
`validate_playbooks`, `list_runs`, `cancel_run` et `restart_run` (pour arrêter une exécution,
ou relancer une exécution terminée depuis une étape, depuis n'importe quelle conversation) ;
les agents d'un workspace qui contient des playbooks reçoivent les outils du manager ; les
agents des étapes reçoivent `report_step_result`. Le dépôt fournit aussi un skill pour
agents, `skills/paseo-playbooks/SKILL.md`, qui leur apprend à écrire des playbooks.

Nécessite Paseo 0.14 ou plus récent. L'état des exécutions est stocké dans
`$PASEO_HOME/plugin-data/paseo-playbooks/runs/` et supprimé quand le worktree de l'exécution
est archivé. Le code serveur exécute `git` dans les dossiers des workspaces.
