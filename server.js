require("dotenv").config();
const admin = require("firebase-admin");
const webpush = require("web-push");
const express = require("express");
const cors = require("cors");
const fs = require("fs");

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
// Stockage des abonnements push
// Fichier JSON local (persiste entre redémarrages)
// ─────────────────────────────────────────
const SUBSCRIPTIONS_FILE = "./subscriptions.json";

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Erreur chargement abonnements:", e.message);
  }
  return [];
}

function saveSubscriptions(subs) {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
  } catch (e) {
    console.error("Erreur sauvegarde abonnements:", e.message);
  }
}

let subscriptions = loadSubscriptions();

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
  etatPompe:    null,
  etatSysteme:  null,
  niveauHaut:   null,
  niveauBas:    null,
};

// ─────────────────────────────────────────
// Surveillance Firebase — etatPompe
// ─────────────────────────────────────────
db.ref("/etatPompe").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.etatPompe) return; // Pas de changement
  etatPrecedent.etatPompe = val;

  if (val === "ON") {
    await sendNotification(
      "🚀 Pompe démarrée",
      "La pompe de remplissage est en marche",
      "💧",
      "pompe-start"
    );
  } else if (val === "OFF" && etatPrecedent.etatPompe !== null) {
    await sendNotification(
      "⏹ Pompe arrêtée",
      "La pompe s'est arrêtée",
      "💧",
      "pompe-stop"
    );
  }
});

// ─────────────────────────────────────────
// Surveillance Firebase — etatSysteme
// ─────────────────────────────────────────
db.ref("/etatSysteme").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.etatSysteme) return;
  etatPrecedent.etatSysteme = val;

  if (val === false) {
    await sendNotification(
      "⚠️ Système coupé",
      "Le système de pompage a été désactivé",
      "⚠️",
      "systeme-off"
    );
  } else if (val === true && etatPrecedent.etatSysteme !== null) {
    await sendNotification(
      "✅ Système activé",
      "Le système de pompage est de nouveau actif",
      "✅",
      "systeme-on"
    );
  }
});

// ─────────────────────────────────────────
// Surveillance Firebase — niveau haut
// ─────────────────────────────────────────
db.ref("/niveau/haut").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.niveauHaut) return;
  etatPrecedent.niveauHaut = val;

  if (val === "ON" || val === true) {
    await sendNotification(
      "🔵 Réservoir plein",
      "Le réservoir a atteint son niveau maximum",
      "🔵",
      "niveau-haut"
    );
  }
});

// ─────────────────────────────────────────
// Surveillance Firebase — niveau bas
// ─────────────────────────────────────────
db.ref("/niveau/bas").on("value", async (snap) => {
  const val = snap.val();
  if (val === etatPrecedent.niveauBas) return;
  etatPrecedent.niveauBas = val;

  if (val === "OFF" || val === false) {
    // Le niveau bas est repassé à OFF = réservoir vide
    if (etatPrecedent.niveauBas !== null) {
      await sendNotification(
        "🟡 Réservoir vide",
        "Le niveau bas du réservoir est atteint — démarrage auto possible",
        "🟡",
        "niveau-bas"
      );
    }
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
// Démarrage
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Serveur notifications démarré sur le port ${PORT}`);
  console.log(`📡 Surveillance Firebase active`);
  console.log(`👥 Abonnés chargés : ${subscriptions.length}`);
});
