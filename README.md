# Bulloterie – N'EPS numérique

PWA de positionnement par thématique : chaque participant fait glisser sa bulle vers
**Inquiet · Débutant · Confirmé · Expert**. Quentin Delisle.

## Mise en ligne
Publier ce dossier sur GitHub Pages (HTTPS obligatoire pour la caméra et l'installation).
iPad : Safari → Partager → « Sur l'écran d'accueil ». Android : Chrome → « Installer l'application ».
Fonctionne ensuite hors-ligne ; les données restent sur chaque appareil (aucun serveur).

## Administrateur (code par défaut 0000)
1. 🏠 Salle : créer une salle / séance (plusieurs salles possibles, duplication sans les réponses).
2. 🧩 Thématiques : une par une ou coller une liste (une par ligne).
3. 👥 Participants : numéro ↔ nom. Coller une liste (« 12 Martin Léa », « 12;Martin Léa » ou juste le nom),
   numérotation 1 → N ou aléatoire, 🖨 étiquettes à découper et distribuer.
   Option : refuser les numéros non inscrits.
4. 📲 QR séance : à scanner par les participants (contient les thématiques et les numéros valides, jamais les noms).
5. 📥 Récupérer : la caméra reste allumée, on scanne les QR des participants à la suite.
6. 🫧 Tableau : une thématique à la fois, les bulles se placent en direct ; glisser-déposer pour corriger ;
   affichage Noms / Numéros / Anonyme ; 🖥 Projeter ; « 📷 Recevoir des QR ici » scanne pendant la projection.
7. 📊 Synthèse (tableau participants × thématiques, toucher une case pour corriger) · ⚙️ Export CSV / sauvegarde.

## Participant
Scanner le QR de la séance → entrer son numéro → glisser sa bulle sur chaque thématique (ou toucher une case)
→ « J'ai terminé : afficher mon QR » → l'administrateur le scanne. On peut modifier et renvoyer : la réponse la plus récente l'emporte.
Appareil partagé : « Participant suivant » ; le QR contient alors les réponses de tous les participants de l'appareil.

## Échange par QR (même système que Biathlon)
JSON compressé (deflate) + base45, découpé en séries de QR qui défilent seuls (préfixe `BU:T` séance, `BU:R` réponses).
Lecture : détecteur natif → ZXing (WebAssembly) → jsQR ; secours « 📷 Photo du QR » ou partage de fichier.

Mise à jour : changer `CACHE` dans `sw.js` (et `APP_VERSION` dans `app.js`).
