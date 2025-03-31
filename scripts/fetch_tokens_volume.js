const { Pool } = require('pg');

// Configuration PostgreSQL
const pool = new Pool({
  host: 'postgres',
  database: 'realtoken',
  user: 'nocodb',
  password: 'nocodbpassword',
  port: 5432,
});

const GRAPHQL_ENDPOINT = "https://gateway-arbitrum.network.thegraph.com/api/ae36a6bfa6af7dfa3487d2cecf583ebe/subgraphs/id/4eJa4rKCR5f8fq48BKbYBPvf7DWHppGZRvfiVUSFXBGR";

const Parameters = {
  yamSubgraphId: '4eJa4rKCR5f8fq48BKbYBPvf7DWHppGZRvfiVUSFXBGR',
  stables: [
    "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
    "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83",
    "0x7349c9eaa538e118725a6130e0f8341509b9f8a0"
  ],
  getGraphUrl: (subgraphId, { useAlternativeKey = false } = {}) => {
    return GRAPHQL_ENDPOINT;
  }
};

async function fetchTokenVolumes({ useAlternativeKey = false } = {}) {
  const daysLimit = 60;
  const limitDate = new Date(Date.now() - daysLimit * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const apiUrl = Parameters.getGraphUrl(Parameters.yamSubgraphId, { useAlternativeKey });

  console.log("🔄 Début de la récupération des volumes de tokens...");
  console.log("📅 Date limite:", limitDate);
  console.log("🔗 URL de l'API:", apiUrl);

  const query = `query GetTokenVolumes($stables: [String!], $limitDate: String!, $skip: Int!) {
    tokens(first: 1000, skip: $skip) {
      id
      decimals
      volumes(where: { token_in: $stables }) {
        token {
          decimals
        }
        volumeDays(orderBy: date, orderDirection: desc, where: { date_gte: $limitDate }) {
          date
          quantity
          volume
        }
      }
    }
  }`;

  let allTokens = [];
  let skip = 0;
  let hasMoreData = true;

  while (hasMoreData) {
    try {
      console.log(`📥 Récupération des tokens (skip: ${skip})...`);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query,
          variables: {
            stables: Parameters.stables,
            limitDate,
            skip
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Réponse non OK:", response.status, response.statusText);
        console.error("Détails de l'erreur:", errorText);
        throw new Error(`Échec de la requête HTTP: ${response.status} ${response.statusText}`);
      }

      const decodedResponse = await response.json();

      if (decodedResponse.errors) {
        const errorMessage = JSON.stringify(decodedResponse.errors);
        console.error("❌ Erreurs GraphQL:", errorMessage);
        
        if ((errorMessage.includes('spend limit exceeded') || errorMessage.includes('API key not found')) && !useAlternativeKey) {
          console.log("🔄 Limite API dépassée ou clé API introuvable, utilisation de la clé alternative...");
          return fetchTokenVolumes({ useAlternativeKey: true });
        }
        throw new Error(`Erreur API : ${errorMessage}`);
      }

      if (decodedResponse.data && decodedResponse.data.tokens) {
        const tokens = decodedResponse.data.tokens;
        console.log(`✅ ${tokens.length} tokens récupérés`);
        allTokens = allTokens.concat(tokens);
        if (tokens.length < 1000) {
          hasMoreData = false;
        } else {
          skip += 1000;
        }
      } else {
        console.log("⚠️ Pas de données dans la réponse");
        hasMoreData = false;
      }
    } catch (e) {
      console.error("❌ Erreur détaillée:", e);
      if (e.code === 'ECONNREFUSED') {
        console.error("🔌 Impossible de se connecter à l'API. Vérifiez la connexion réseau.");
      } else if (e.code === 'ETIMEDOUT') {
        console.error("⏱️ Délai d'attente dépassé. L'API met trop de temps à répondre.");
      }
      throw new Error(`Échec de la récupération des volumes de tokens : ${e.message}`);
    }
  }

  console.log(`✅ Total des tokens récupérés : ${allTokens.length}`);

  const records = [];
  allTokens.forEach(token => {
    const tokenDecimals = parseInt(token.decimals) || 18;
    if (!token.volumes) return;
    token.volumes.forEach(volumeBlock => {
      const volumeTokenDecimals = parseInt(volumeBlock.token.decimals) || 6;
      if (!volumeBlock.volumeDays) return;
      volumeBlock.volumeDays.forEach(dayEntry => {
        const normalizedQuantity = dayEntry.quantity
          ? (parseFloat(dayEntry.quantity) || 0) / Math.pow(10, tokenDecimals)
          : 0;
        const normalizedVolume = dayEntry.volume
          ? (parseFloat(dayEntry.volume) || 0) / Math.pow(10, volumeTokenDecimals)
          : 0;
        records.push({
          token: token.id.toLowerCase().trim(),
          date: dayEntry.date.trim(),
          quantity: normalizedQuantity,
          volume: normalizedVolume
        });
      });
    });
  });

  await syncTokenVolumeDays(records);
  return records;
}

async function getExistingTokenVolumeDays() {
  const existingRecordsMap = new Map();
  console.log("🔄 Récupération des enregistrements existants depuis PostgreSQL...");

  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM token_volumes');
      
      result.rows.forEach(rec => {
        // Conversion de la date en chaîne ISO pour la clé
        const dateStr = rec.date.toISOString().split('T')[0];
        const key = `${rec.token.toLowerCase().trim()}_${dateStr}`;
        existingRecordsMap.set(key, rec);
      });

      console.log(`✅ ${existingRecordsMap.size} enregistrements existants récupérés`);
      return existingRecordsMap;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des enregistrements existants:", err);
    return new Map();
  }
}

async function updateTokenVolumeDays(records) {
  if (records.length === 0) {
    console.warn("⚠️ Aucun enregistrement à mettre à jour");
    return;
  }

  try {
    const client = await pool.connect();
    try {
      console.log(`🔄 Mise à jour de ${records.length} enregistrements...`);

      // Suppression de la table temporaire si elle existe
      await client.query('DROP TABLE IF EXISTS temp_token_volumes');

      // Création d'une table temporaire pour le batch update
      await client.query(`
        CREATE TEMP TABLE temp_token_volumes (
          id SERIAL PRIMARY KEY,
          token VARCHAR(255),
          date DATE,
          quantity DECIMAL(20,8),
          volume DECIMAL(20,8)
        )
      `);

      // Insertion des données dans la table temporaire
      for (const record of records) {
        await client.query(
          'INSERT INTO temp_token_volumes (id, token, date, quantity, volume) VALUES ($1, $2, $3::DATE, $4, $5)',
          [record.Id, record.token, record.date, record.quantity, record.volume]
        );
      }

      // Mise à jour des enregistrements existants
      await client.query(`
        UPDATE token_volumes tv
        SET quantity = tt.quantity,
            volume = tt.volume
        FROM temp_token_volumes tt
        WHERE tv.id = tt.id
      `);

      // Suppression de la table temporaire
      await client.query('DROP TABLE IF EXISTS temp_token_volumes');

      console.log(`✅ ${records.length} enregistrements mis à jour avec succès`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de la mise à jour des enregistrements:", err);
  }
}

async function insertTokenVolumeDays(records) {
  if (records.length === 0) {
    console.warn("⚠️ Aucun enregistrement à insérer");
    return;
  }

  try {
    const client = await pool.connect();
    try {
      console.log(`📝 Insertion de ${records.length} nouveaux enregistrements...`);

      // Suppression de la table temporaire si elle existe
      await client.query('DROP TABLE IF EXISTS temp_token_volumes');

      // Création d'une table temporaire pour le batch insert
      await client.query(`
        CREATE TEMP TABLE temp_token_volumes (
          token VARCHAR(255),
          date DATE,
          quantity DECIMAL(20,8),
          volume DECIMAL(20,8)
        )
      `);

      // Insertion des données dans la table temporaire
      for (const record of records) {
        await client.query(
          'INSERT INTO temp_token_volumes (token, date, quantity, volume) VALUES ($1, $2::DATE, $3, $4)',
          [record.token, record.date, record.quantity, record.volume]
        );
      }

      // Insertion des données de la table temporaire vers la table principale
      // En utilisant ON CONFLICT pour gérer les doublons
      await client.query(`
        INSERT INTO token_volumes (token, date, quantity, volume)
        SELECT DISTINCT ON (token, date) token, date, quantity, volume
        FROM temp_token_volumes
        ON CONFLICT (token, date) 
        DO UPDATE SET 
          quantity = EXCLUDED.quantity,
          volume = EXCLUDED.volume
      `);

      // Suppression de la table temporaire
      await client.query('DROP TABLE IF EXISTS temp_token_volumes');

      console.log(`✅ ${records.length} nouveaux enregistrements insérés avec succès`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de l'insertion des enregistrements:", err);
  }
}

async function deleteTokenVolumeDays(recordIds) {
  if (recordIds.length === 0) {
    console.warn("⚠️ Aucun enregistrement à supprimer");
    return;
  }

  try {
    const client = await pool.connect();
    try {
      console.log(`🗑️ Suppression de ${recordIds.length} enregistrements...`);
      
      await client.query(
        'DELETE FROM token_volumes WHERE id = ANY($1)',
        [recordIds]
      );

      console.log(`✅ ${recordIds.length} enregistrements supprimés avec succès`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de la suppression des enregistrements:", err);
  }
}

async function syncTokenVolumeDays(newRecords) {
  const newRecordsMap = new Map();
  newRecords.forEach(record => {
    const key = `${record.token}_${record.date}`;
    newRecordsMap.set(key, record);
  });

  const existingRecordsMap = await getExistingTokenVolumeDays();
  console.log("Enregistrements existants récupérés");

  const recordsToUpdate = [];
  const recordsToInsert = [];
  const recordsToDelete = [];

  // Fonction pour normaliser un nombre avec une précision fixe de 4 décimales
  const normalizeNumber = (num) => {
    // Convertir en nombre et arrondir à 4 décimales
    return Number(Number(num).toFixed(4));
  };

  // Fonction pour comparer deux nombres décimaux avec une tolérance relative
  const compareDecimals = (a, b) => {
    const normalizedA = normalizeNumber(a);
    const normalizedB = normalizeNumber(b);
    
    // Si les deux nombres sont très petits, utiliser une tolérance absolue
    if (Math.abs(normalizedA) < 0.0001 && Math.abs(normalizedB) < 0.0001) {
      return Math.abs(normalizedA - normalizedB) < 0.0001;
    }
    
    // Sinon, utiliser une tolérance relative de 0.01%
    const relativeDiff = Math.abs(normalizedA - normalizedB) / Math.max(Math.abs(normalizedA), Math.abs(normalizedB));
    return relativeDiff < 0.0001;
  };

  for (const [key, newRecord] of newRecordsMap.entries()) {
    if (existingRecordsMap.has(key)) {
      const existingRecord = existingRecordsMap.get(key);

      // Normaliser les nombres avant la comparaison
      const normalizedNewRecord = {
        ...newRecord,
        quantity: normalizeNumber(newRecord.quantity),
        volume: normalizeNumber(newRecord.volume)
      };

      const normalizedExistingRecord = {
        ...existingRecord,
        quantity: normalizeNumber(existingRecord.quantity),
        volume: normalizeNumber(existingRecord.volume)
      };

      if (!compareDecimals(normalizedNewRecord.quantity, normalizedExistingRecord.quantity) || 
          !compareDecimals(normalizedNewRecord.volume, normalizedExistingRecord.volume)) {
        console.log("❗ Différence détectée pour la clé", key);
        console.log("  Ancien:", {
          quantity: normalizedExistingRecord.quantity,
          volume: normalizedExistingRecord.volume
        });
        console.log("  Nouveau:", {
          quantity: normalizedNewRecord.quantity,
          volume: normalizedNewRecord.volume
        });
        recordsToUpdate.push({ Id: existingRecord.id, ...normalizedNewRecord });
      }
      existingRecordsMap.delete(key);
    } else {
      recordsToInsert.push(newRecord);
    }
  }

  for (const rec of existingRecordsMap.values()) {
    console.log("🗑️ Enregistrement non trouvé dans les nouvelles données, sera supprimé:", rec);
    recordsToDelete.push(rec.id);
  }

  if (recordsToUpdate.length) {
    await updateTokenVolumeDays(recordsToUpdate);
  }
  if (recordsToInsert.length) {
    await insertTokenVolumeDays(recordsToInsert);
  }
  if (recordsToDelete.length) {
    await deleteTokenVolumeDays(recordsToDelete);
  }
}

async function syncTokenVolumesJob() {
  try {
    await fetchTokenVolumes();
    console.log("✅ Synchronisation des volumes de tokens terminée");
  } catch (err) {
    console.error("❌ Erreur lors de la synchronisation:", err);
  } finally {
    await pool.end();
  }
}

syncTokenVolumesJob();

module.exports = { fetchTokenVolumes };
