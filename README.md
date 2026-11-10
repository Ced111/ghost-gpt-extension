# Ghost GPT Clipboard

Extension Chrome / Edge Manifest V3, version 1.1.1. Envoie du texte ou une image du presse-papiers à l’API OpenAI Responses.

## Utilisation

1. Copier du texte ou une image.
2. Cliquer sur l’icône. Le badge `…` indique une requête en cours.
3. Attendre la coche `✓`, puis cliquer à nouveau pour copier la réponse.
4. Coller la réponse dans l’application souhaitée.

Le clic droit permet d’envoyer une sélection, de recopier la dernière réponse, d’activer/désactiver le contexte ou de démarrer une nouvelle session. Une erreur affiche `ERR`, avec son détail au survol de l’icône et dans les options.

## Installer ou mettre à jour

Chrome / Edge 116 ou ultérieur requis.

1. Télécharger le dépôt avec **Code → Download ZIP**, puis extraire l’archive.
2. Pour une mise à jour, copier les fichiers extraits dans le dossier déjà utilisé pour l’extension, par exemple `C:\Users\cedle\PhpstormProjects\ghost-gpt-extension`. Conserver ce chemin et l’installation existante pour retrouver les réglages.
3. Ouvrir `chrome://extensions` ou `edge://extensions`, activer le mode développeur, puis cliquer sur **Recharger** pour Ghost GPT. Accepter la nouvelle autorisation si le navigateur le demande.
4. Pour une première installation, choisir **Charger l’extension non empaquetée**, puis le dossier contenant `manifest.json`.
5. Ouvrir les options par clic droit sur l’icône. Vérifier la clé, le modèle et le pré-prompt, puis enregistrer.

L’actualisation du dépôt sur GitHub nécessite ensuite de mettre à jour les fichiers locaux et de recharger l’extension dans le navigateur.

## Modèles et configuration

- Les réglages de la version 1.0 sont conservés. Le modèle déjà enregistré reste sélectionné.
- Le champ Modèle propose des suggestions et accepte les identifiants saisis librement. Effacer le champ affiche toute la liste. Les commandes de session sont regroupées dans le menu clic droit de l’icône.
- **Actualiser les modèles** interroge `/v1/models` avec la clé renseignée. Ce chargement n’enregistre pas les modifications. La liste filtre les familles spécialisées audio, embeddings et génération d’images.
- Les modèles listés sont des candidats accessibles avec la clé. L’endpoint ne fournit pas leurs capacités. Le support de Responses et de l’entrée image reste propre à chaque modèle et est vérifié par la réponse de l’API lors de l’envoi.
- `temperature: 0` est conservé pour GPT-4o et GPT-4.1. Les autres modèles utilisent leurs paramètres par défaut pour éviter les incompatibilités avec le raisonnement.
- Le pré-prompt est envoyé comme message developer au premier tour. Les tours suivants utilisent `previous_response_id` lorsque le contexte est activé.
- Changer la clé, le modèle, le pré-prompt ou le mode session réinitialise la session. La dernière réponse reste disponible.
- Un pré-prompt vide est accepté. L’ancien champ `systemPrompt` sert de repli si `prePrompt` n’existe pas.

## Presse-papiers et requêtes longues

Un document interne invisible lit le presse-papiers à chaque envoi et écrit la réponse à la demande. Le site ouvert dans l’onglet actif n’intervient plus dans ces opérations. Le document exploite les commandes de copie/collage de Chrome avec les autorisations de l’extension. Les données collées sont lues depuis l’événement de collage, sans insérer de HTML provenant du presse-papiers.

Les images PNG, JPEG, WebP et GIF sont acceptées. Le navigateur convertit généralement les images copiées en PNG. Un format non pris en charge produit un message explicite.

Les requêtes réseau sont exécutées dans ce document. Des messages périodiques maintiennent le service worker actif pendant l’attente. Le délai maximal est de trois minutes. Les clics supplémentaires et les changements de configuration sont bloqués pendant une opération. Aucune relance API automatique n’est effectuée. Après une erreur, un clic permet de réessayer.

La clé reste dans le stockage local de l’extension. Le contenu envoyé et le pré-prompt sont transmis à OpenAI. Les réponses utilisent `store: true`, comme dans la version précédente, pour permettre les sessions.

## Vérifications

Avec Node.js 18 ou ultérieur, lancer `node --test tests/*.test.cjs`.

Les tests couvrent la compatibilité des paramètres, l’entrée image, les erreurs HTTP, les réponses incomplètes, le cycle envoi/copie, les clics concurrents, la reprise après erreur et la migration des options. Les API Chrome et OpenAI sont simulées.

La version 1.1.1 a passé ces tests et les contrôles de syntaxe. Le navigateur de l’environnement de développement ne pouvant pas démarrer, le test réel Chrome/Edge et l’appel avec une clé OpenAI n’ont pas été exécutés. Pour les vérifier, envoyer un texte court, copier la réponse, puis renouveler avec une capture d’écran. Vérifier également les deux opérations depuis un nouvel onglet et une page interne du navigateur.

## Références

- [API Responses](https://developers.openai.com/api/reference/responses/overview)
- [Liste des modèles](https://developers.openai.com/api/reference/resources/models/methods/list)
- [Modèles récents et paramètres](https://developers.openai.com/api/docs/guides/latest-model)
- [Documents internes Chrome](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
