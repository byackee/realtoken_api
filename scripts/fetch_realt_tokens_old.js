const { Client } = require('pg');
const crypto = require('crypto');

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

// Fonction pour s'assurer que l'index UUID existe
async function ensureUUIDIndex() {
  try {
    // Vérifier si la table real_tokens existe
    const tableCheck = await pgClient.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'real_tokens')`
    );
    
    if (!tableCheck.rows[0].exists) {
      // Créer la table si elle n'existe pas
      await pgClient.query(`
        CREATE TABLE real_tokens (
          uuid UUID PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ Table real_tokens créée avec succès.");
    }
    
    // Vérifier si l'index sur uuid existe
    const indexCheck = await pgClient.query(
      `SELECT EXISTS (SELECT FROM pg_indexes WHERE indexname = 'real_tokens_uuid_idx')`
    );
    
    if (!indexCheck.rows[0].exists) {
      // Créer l'index s'il n'existe pas
      await pgClient.query(`CREATE INDEX real_tokens_uuid_idx ON real_tokens (uuid)`);
      console.log("✅ Index sur UUID créé avec succès.");
    }
  } catch (error) {
    console.error("❌ Erreur lors de la création de l'index UUID:", error);
  }
}

// Fonction pour diviser un tableau en lots
function batchArray(array, batchSize) {
  const batches = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

// Fonction pour sauvegarder un lot de tokens dans PostgreSQL
async function saveBatchToPostgres(batch) {
  try {
    // Créer une transaction
    await pgClient.query('BEGIN');
    
    for (const token of batch) {
      // Utiliser l'UUID du token ou générer un aléatoire si non disponible
      const uuid = token.uuid || crypto.randomUUID();
      
      // Insérer ou mettre à jour le token
      await pgClient.query(
        `INSERT INTO real_tokens (uuid, data) 
         VALUES ($1, $2)
         ON CONFLICT (uuid) 
         DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP`,
        [uuid, JSON.stringify(token)]
      );
    }
    
    // Valider la transaction
    await pgClient.query('COMMIT');
    console.log(`✅ Lot de ${batch.length} tokens sauvegardé avec succès.`);
  } catch (error) {
    // Annuler la transaction en cas d'erreur
    await pgClient.query('ROLLBACK');
    console.error("❌ Erreur lors de la sauvegarde des tokens:", error);
  }
}

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

// Exécuter le script
(async () => {
  await connectToDB();
  await fetchRealTokens();
  await pgClient.end();
})(); 