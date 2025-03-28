const { Client } = require('pg');

// Configuration API RealT
const REALT_API_URL = "https://api.realtoken.community/v1/token";
const REALT_AUTH_TOKEN = "bd627cc6-preprod-1412-a95d-af495a45d4b2"; // Remplace par ton vrai token API RealT

// Configuration PostgreSQL
const pgClient = new Client({
  host: "postgres",
  user: "nocodb",
  password: "nocodbpassword",
  database: "realtoken",
  port: 5432,
});

// Connexion à PostgreSQL
async function connectToDB() {
  try {
    await pgClient.connect();
    console.log("🟢 Connexion PostgreSQL réussie.");
    await ensureUUIDIndex();
  } catch (error) {
    console.error("❌ Erreur de connexion à PostgreSQL:", error);
  }
}

// Récupération des tokens depuis l'API RealT
async function fetchRealTokens() {
  try {
    console.log("🔄 Récupération des données depuis RealTokens...");
    const response = await fetch(REALT_API_URL, {
      method: 'GET',
      headers: {
        "X-AUTH-REALT-TOKEN": REALT_AUTH_TOKEN,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Erreur API RealTokens: ${await response.text()}`);
    }

    const tokens = await response.json();
    console.log(`✅ ${tokens.length} tokens récupérés.`);

    // Filtrer les tokens dont fullName commence par "OLD-"
    const validTokens = tokens.filter(token => !token.fullName.startsWith("OLD-"));
    
    // Découpage en lots (ici, par lots de 1000)
    const batches = batchArray(validTokens, 1000);
    
    for (const batch of batches) {
      await saveBatchToPostgres(batch);
    }

    console.log("✅ Données RealTokens insérées/mises à jour dans PostgreSQL !");
  } catch (error) {
    console.error("❌ Erreur lors de la récupération des tokens:", error);
  }
}

// ... Le reste du code reste identique au fichier original ...
// Nous ne montrons qu'une partie du code pour simplifier, mais en pratique
// vous devriez copier tout le contenu du fichier fetch_realt_tokens.js ici.

// Exécuter le script
(async () => {
  await connectToDB();
  await fetchRealTokens();
  await pgClient.end();
})(); 