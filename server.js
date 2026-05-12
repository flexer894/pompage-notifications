const admin = require("firebase-admin");
const webpush = require("web-push");
const express = require("express");
const cors = require("cors");

// ─────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// Initialisation Firebase Admin
// ─────────────────────────────────────────
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pompage-91de5-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

// ─────────────────────────────────────────
// Configuration Web Push (VAPID)
// ─────────────────────────────────────────
// Ces clés sont générées une seule fois (voir README)
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  "mailto:votre@email.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ─────────────────────────────────────────
// Stockage des abonnements dans Firebase
// Persiste même après redémarrage du serveur
// ─────────────────────────────────────────
let subscriptions = [];

// Charger les abonnements depuis Firebase au démarrage
async function loadSubscriptions() {
  try {
    const snap = await db.ref("/pushSubscriptions").once("value");
    const data = snap.val();
    if (data) {
      subscriptions = Object.values(data);
      console.log(`✅ ${subscriptions.length} abonnement(s) chargé(s) depuis Firebase`);
    } else {
      subscriptions = [];
      console.log("📭 Aucun abonnement en base");
    }
  } catch (e) {
    console.error("Erreur chargement abonnements Firebase:", e.message);
    subscriptions = [];
  }
}

// Sauvegarder les abonnements dans Firebase
async function saveSubscriptions(subs) {
  try {
    // Convertir en objet avec clé unique par endpoint
    const obj = {};
    subs.forEach((sub, i) => {
      const key = Buffer.from(sub.endpoint).toString("base64").slice(0, 20).replace(/[^a-zA-Z0-9]/g, "");
      obj[key] = sub;
    });
    await db.ref("/pushSubscriptions").set(obj);
  } catch (e) {
    console.error("Erreur sauvegarde abonnements Firebase:", e.message);
  }
}

// ─────────────────────────────────────────
// Fonction d'envoi de notification
// ─────────────────────────────────────────
async function sendNotification(title, body, icon = "💧", tag = "pompage") {
  if (subscriptions.length === 0) {
    console.log("Aucun abonné — notification ignorée");
    return;
  }

  const payload = JSON.stringify({
    title,
    body,
    icon,
    tag,
    timestamp: new Date().toLocaleString("fr-FR")
  });

  console.log(`📤 Envoi notification : ${title} — ${body}`);

  const failedSubs = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      console.log(`✅ Notification envoyée à : ${sub.endpoint.slice(-20)}...`);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Abonnement expiré — supprimer
        console.log(`🗑️ Abonnement expiré supprimé`);
        failedSubs.push(sub.endpoint);
      } else {
        console.error(`❌ Erreur envoi: ${err.message}`);
      }
    }
  }

  // Nettoyer les abonnements expirés
  if (failedSubs.length > 0) {
    subscriptions = subscriptions.filter(s => !failedSubs.includes(s.endpoint));
    saveSubscriptions(subscriptions);
  }
}

// ─────────────────────────────────────────
// État précédent pour éviter les doublons
// ─────────────────────────────────────────
let etatPrecedent = {
  etatPompe:        null,
  etatSysteme:      null,
  niveauHaut:       null,
  niveauMoyen:      null,
  niveauBas:        null,
  niveauSignature:  null, // ← initialisé à null explicitement
};

// ─────────────────────────────────────────
// Surveillance Firebase — niveau complet
// Logique basée sur combinaison des 3 flotteurs
// ─────────────────────────────────────────
db.ref("/niveau").on("value", async (snap) => {
  const d = snap.val() || {};
  const haut  = d.haut  === "ON";
  const moyen = d.moyen === "ON";
  const bas   = d.bas   === "ON";

  // Créer une signature de l'état actuel
  const signature = `${haut}-${moyen}-${bas}`;

  // Sauvegarder la valeur précédente
  const precedent = etatPrecedent.niveauSignature;

  // Ne pas notifier si rien n'a changé
  if (signature === precedent) return;

  // Mettre à jour l'état précédent
  etatPrecedent.niveauSignature = signature;

  // Ne pas notifier au tout premier démarrage
  if (precedent === null) {
    console.log(`📊 Niveaux initialisés : ${signature}`);
    return;
  }

  console.log(`📊 Changement niveau : ${precedent} → ${signature}`);

  // Réservoir plein : haut=ON moyen=ON bas=ON
  if (haut && moyen && bas) {
    await sendNotification(
      "🔵 Réservoir plein",
      "Le réservoir a atteint son niveau maximum — pompe arrêtée",
      "🔵", "niveau-plein"
    );
  }
  // Niveau moyen : haut=OFF moyen=ON bas=ON
  else if (!haut && moyen && bas) {
    await sendNotification(
      "🟡 Niveau moyen",
      "Le réservoir est à moitié plein",
      "🟡", "niveau-moyen"
    );
  }
  // Niveau bas détecté : haut=OFF moyen=OFF bas=ON
  else if (!haut && !moyen && bas) {
    await sendNotification(
      "🟠 Niveau bas détecté",
      "Le réservoir est presque vide — démarrage pompe imminent",
      "🟠", "niveau-bas"
    );
  }
  // Réservoir vide → pompe déclenchée : haut=OFF moyen=OFF bas=OFF
  else if (!haut && !moyen && !bas) {
    await sendNotification(
      "🚀 Démarrage pompe automatique",
      "Le réservoir est vide — la pompe démarre automatiquement",
      "💧", "pompe-auto-start"
    );
  }
});

// ─────────────────────────────────────────
// Surveillance Firebase — etatPompe
// ─────────────────────────────────────────
db.ref("/etatPompe").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.etatPompe) return;
  const precedent = etatPrecedent.etatPompe;
  etatPrecedent.etatPompe = val;
  if (precedent === null) return; // Ignorer au démarrage

  if (val === "OFF") {
    await sendNotification(
      "⏹ Pompe arrêtée",
      "La pompe s'est arrêtée",
      "💧", "pompe-stop"
    );
  }
});

// ─────────────────────────────────────────
// Surveillance Firebase — etatSysteme
// ─────────────────────────────────────────
db.ref("/etatSysteme").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.etatSysteme) return;
  const precedent = etatPrecedent.etatSysteme;
  etatPrecedent.etatSysteme = val;
  if (precedent === null) return;

  if (val === false) {
    await sendNotification(
      "⚠️ Système coupé",
      "Le système de pompage a été désactivé",
      "⚠️", "systeme-off"
    );
  } else if (val === true) {
    await sendNotification(
      "✅ Système activé",
      "Le système de pompage est de nouveau actif",
      "✅", "systeme-on"
    );
  }
});

// ─────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────

// Enregistrer un nouvel abonnement push
app.post("/subscribe", (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Abonnement invalide" });
  }

  // Vérifier si déjà abonné
  const exists = subscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    saveSubscriptions(subscriptions);
    console.log(`✅ Nouvel abonné enregistré (total: ${subscriptions.length})`);
  }

  res.status(201).json({ message: "Abonnement enregistré", total: subscriptions.length });
});

// Désabonner
app.post("/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions(subscriptions);
  console.log(`🗑️ Abonnement supprimé (total: ${subscriptions.length})`);
  res.json({ message: "Désabonnement effectué" });
});

// Test de notification
app.post("/test", async (req, res) => {
  await sendNotification(
    "🧪 Test notification",
    "Le serveur de notifications fonctionne correctement !",
    "🧪",
    "test"
  );
  res.json({ message: "Notification de test envoyée" });
});

// Statut du serveur
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    abonnes: subscriptions.length,
    uptime: Math.floor(process.uptime()) + "s",
    etatPrecedent
  });
});

// Clé publique VAPID (nécessaire côté client)
app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ─────────────────────────────────────────
// Self-ping toutes les 10 min pour éviter la veille Render
// ─────────────────────────────────────────
const https = require("https");
const http  = require("http");

function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = url.startsWith("https") ? https : http;
  client.get(url + "/status", (res) => {
    console.log(`🏓 Keep-alive ping — status: ${res.statusCode}`);
  }).on("error", (err) => {
    console.log(`⚠️ Keep-alive ping échoué: ${err.message}`);
  });
}

// ─────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────
app.listen(PORT, async () => {
  await loadSubscriptions(); // Charger depuis Firebase au démarrage
  console.log(`✅ Serveur notifications démarré sur le port ${PORT}`);
  console.log(`📡 Surveillance Firebase active`);
  console.log(`👥 Abonnés chargés : ${subscriptions.length}`);

  // Démarrer le keep-alive après 1 minute
  setTimeout(() => {
    keepAlive();
    setInterval(keepAlive, 10 * 60 * 1000); // toutes les 10 min
  }, 60000);
});
