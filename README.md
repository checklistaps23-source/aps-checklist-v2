# A.P.S. Checklist (app séparée de DispatchAI)

Checklist mensuelle, Réappro (O₂, produits des véhicules, remarques), Péremption, Historique.
Données : projet Firebase `check-list-peremption`, collections préfixées `stockapp_*`
(aucun lien avec DispatchAI, dont les collections sont `dispatchai_*`).

## Mise en ligne (une seule fois)
1. Créer un nouveau dépôt GitHub (ex : `aps-checklist`), puis dans le dossier du projet :
   git init && git add . && git commit -m "Première version" && git branch -M main
   git remote add origin https://github.com/<compte>/aps-checklist.git && git push -u origin main
2. Sur Vercel : Add New → Project → choisir ce dépôt → Framework "Create React App" → Deploy.
3. Ouvrir l'adresse Vercel sur le téléphone / la tablette (HTTPS), puis "Ajouter à l'écran d'accueil".

## Premier lancement
- Paramètres → Importer : copie les modèles de checklists, les emails, les lots de péremption, la réserve O₂ et les historiques depuis DispatchAI (à faire une seule fois).
- Paramètres → Emails : vérifier les destinataires (dont l'alerte stock bas).
- Réappro → Réappro véhicules → choisir un véhicule → « Initialiser le stock ».

## Développement
npm install && npm start      (build de contrôle : CI=true npm run build)
